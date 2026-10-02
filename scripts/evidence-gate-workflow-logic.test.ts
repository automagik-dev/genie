import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The script-side decisions of `.claude/workflows/evidence-gate.js` (wish `evidence-gate-cwd-batch`):
// the cwd pin every verifier command must carry, the dispatch plan that sends every declared file
// to ONE `verify:files` agent, and the mapping of that batch's answer back onto its files. No
// module can import them — the runtime executes the script — so, as `wish-workflow-logic.test.ts`
// does, each declaration is lifted out of the shipped source and evaluated here, and the dispatch
// count is also proved by running the whole shipped script against stub runtime hooks.

const ROOT = join(import.meta.dir, '..');
const SCRIPT = readFileSync(join(ROOT, '.claude', 'workflows', 'evidence-gate.js'), 'utf8');

function lift(pattern: RegExp): string {
  const match = pattern.exec(SCRIPT);
  if (!match) throw new Error(`evidence-gate.js: nothing matched ${pattern}`);
  return match[0];
}

const DECLARATIONS = [
  lift(/^const ITEM_STATUSES = .*$/m),
  lift(/^const MAX_VERIFIERS = .*$/m),
  lift(/^const MAX_FILES_PER_BATCH = .*$/m),
  lift(/^const CD_QUOTES = .*$/m),
  lift(/^const list = .*$/m),
  lift(/^const cdPrefix = .*$/m),
  lift(/^function cwdRefusal\([^)]*\) \{[\s\S]*?^\}$/m),
  lift(/^const silentItem = .*$/m),
  lift(/^function readVerifier\([^)]*\) \{[\s\S]*?^\}$/m),
  lift(/^function planDispatch\([^)]*\) \{[\s\S]*?^\}$/m),
  lift(/^function mapFileBatch\([^)]*\) \{[\s\S]*?^\}$/m),
  lift(/^function normalizeInput\([^)]*\) \{[\s\S]*?^\}$/m),
].join('\n');

interface Item {
  id: string;
  kind: 'file' | 'command';
  declared: string;
  path?: string;
  run?: string;
  expectExit?: number;
  malformed?: string;
}
interface Row extends Item {
  status: string;
  command: string;
  exitCode: number;
  reason: string;
}

const api = new Function(
  `${DECLARATIONS}\nreturn { MAX_VERIFIERS, MAX_FILES_PER_BATCH, cwdRefusal, readVerifier, planDispatch, mapFileBatch, normalizeInput }`,
)() as {
  MAX_VERIFIERS: number;
  MAX_FILES_PER_BATCH: number;
  cwdRefusal: (cwd: string, item: Item, command: string) => string;
  readVerifier: (cwd: string, item: Item, result: Record<string, unknown>) => Row;
  planDispatch: (runnable: Item[]) => {
    batch: Item[];
    perCommand: Item[];
    overCeiling: { item: Item; reason: string }[];
    agents: number;
  };
  mapFileBatch: (cwd: string, files: Item[], answer: unknown) => { silent: boolean; logs: string[]; rows: Row[] };
  normalizeInput: (raw: unknown) => { items: Item[] } | null;
};

const CWD = '/work/tree';
const file = (n: number): Item => ({ id: `file#${n}`, kind: 'file', declared: `f${n}`, path: `f${n}` });
const cmd = (n: number, run = 'bun test'): Item => ({
  id: `cmd#${n}`,
  kind: 'command',
  declared: run,
  run,
  expectExit: 0,
});
const pass = (command: string) => ({ status: 'pass', command, exitCode: 0, observedOutput: 'ok', reason: 'ran' });

describe('every verifier command is pinned to cwd', () => {
  test('the three quoting forms around the exact cwd are accepted', () => {
    for (const q of ['', "'", '"']) {
      const command = `cd ${q}${CWD}${q} && bun test`;
      expect({ q, refusal: api.cwdRefusal(CWD, cmd(1), command) }).toEqual({ q, refusal: '' });
      expect(api.readVerifier(CWD, cmd(1), pass(command)).status).toBe('pass');
    }
  });

  test('a command without the prefix is insufficient, never a pass', () => {
    for (const command of [
      'bun test',
      'cd /elsewhere && bun test',
      `cd '${CWD}' ; bun test`,
      `cd '${CWD}" && bun test`,
      `cd '${CWD}/sub' && bun test`,
    ]) {
      const row = api.readVerifier(CWD, cmd(1), pass(command));
      expect({ command, status: row.status }).toEqual({ command, status: 'insufficient' });
      expect(row.reason).toContain('does not start with');
    }
    // A `fail` without the prefix is not a proved failure either.
    expect(api.readVerifier(CWD, cmd(1), { ...pass('bun test'), status: 'fail' }).status).toBe('insufficient');
  });

  test('a remainder that is not exactly the declared run is insufficient', () => {
    for (const rest of ['bun test --bail', 'bun  test', 'bun test && true', 'bun tes', ' bun test x']) {
      const row = api.readVerifier(CWD, cmd(1), pass(`cd '${CWD}' && ${rest}`));
      expect({ rest, status: row.status }).toEqual({ rest, status: 'insufficient' });
      expect(row.reason).toContain('not the declared run');
    }
  });

  test('a file check needs the prefix and a check after it', () => {
    expect(api.readVerifier(CWD, file(1), pass(`cd '${CWD}' && test -f f1`)).status).toBe('pass');
    expect(api.readVerifier(CWD, file(1), pass('test -f f1')).status).toBe('insufficient');
    expect(api.readVerifier(CWD, file(1), pass(`cd '${CWD}' && `)).status).toBe('insufficient');
  });

  test('a verifier that already answered insufficient keeps its own reason', () => {
    const row = api.readVerifier(CWD, cmd(1), {
      status: 'insufficient',
      command: '',
      exitCode: -1,
      reason: 'no shell',
    });
    expect(row).toMatchObject({ status: 'insufficient', reason: 'no shell' });
  });
});

describe('the dispatch plan: one agent for all files plus one per command', () => {
  test('k files and m commands dispatch 1 + m agents, and m when k = 0', () => {
    for (const [k, m] of [
      [1, 0],
      [6, 0],
      [6, 3],
      [0, 3],
      [0, 0],
      [64, 63],
    ]) {
      const runnable = [
        ...Array.from({ length: k }, (_, i) => file(i + 1)),
        ...Array.from({ length: m }, (_, i) => cmd(i + 1)),
      ];
      const plan = api.planDispatch(runnable);
      expect({ k, m, agents: plan.agents, over: plan.overCeiling.length }).toEqual({
        k,
        m,
        agents: (k ? 1 : 0) + m,
        over: 0,
      });
      expect(plan.batch).toHaveLength(k);
    }
  });

  test('past the ceilings nothing is dropped: the rest is carried with a ceiling reason', () => {
    const files = Array.from({ length: api.MAX_FILES_PER_BATCH + 2 }, (_, i) => file(i + 1));
    const commands = Array.from({ length: api.MAX_VERIFIERS + 1 }, (_, i) => cmd(i + 1));
    const plan = api.planDispatch([...files, ...commands]);
    expect(plan.batch).toHaveLength(api.MAX_FILES_PER_BATCH);
    // The batch takes one verifier slot, so commands get MAX_VERIFIERS - 1.
    expect(plan.perCommand).toHaveLength(api.MAX_VERIFIERS - 1);
    expect(plan.agents).toBe(api.MAX_VERIFIERS);
    expect(plan.overCeiling.map((entry) => entry.item.id)).toEqual([
      `file#${api.MAX_FILES_PER_BATCH + 1}`,
      `file#${api.MAX_FILES_PER_BATCH + 2}`,
      `cmd#${api.MAX_VERIFIERS}`,
      `cmd#${api.MAX_VERIFIERS + 1}`,
    ]);
    expect(plan.overCeiling[0]?.reason).toContain('file batch ceiling');
    expect(plan.overCeiling[3]?.reason).toContain('verifier ceiling');
    // With no file declared, commands keep every slot.
    expect(api.planDispatch(commands).perCommand).toHaveLength(api.MAX_VERIFIERS);
  });
});

describe('the batch answer mapped back onto its files', () => {
  const files = [file(1), file(2), file(3)];
  const row = (id: unknown, extra: Record<string, unknown> = {}) => ({
    id,
    ...pass(`cd '${CWD}' && test -f ${String(id).replace('file#', 'f')}`),
    ...extra,
  });

  test('a null answer makes every file insufficient and reports the batch silent', () => {
    for (const answer of [null, undefined]) {
      const mapped = api.mapFileBatch(CWD, files, answer);
      expect(mapped.silent).toBe(true);
      expect(mapped.rows.map((r) => r.status)).toEqual(['insufficient', 'insufficient', 'insufficient']);
    }
  });

  test('a missing id is insufficient; the others keep their answers, in declaration order', () => {
    const mapped = api.mapFileBatch(CWD, files, { results: [row('file#3'), row('file#1')] });
    expect(mapped.silent).toBe(false);
    expect(mapped.rows.map((r) => [r.id, r.status])).toEqual([
      ['file#1', 'pass'],
      ['file#2', 'insufficient'],
      ['file#3', 'pass'],
    ]);
    expect(mapped.rows[1]?.reason).toContain('no result for this id');
    // An answer with no results array leaves every file unanswered.
    expect(api.mapFileBatch(CWD, files, {}).rows.every((r) => r.status === 'insufficient')).toBe(true);
  });

  test('a duplicate id: the first answer wins, the later one is ignored and logged', () => {
    const mapped = api.mapFileBatch(CWD, [file(1)], {
      results: [row('file#1', { status: 'fail' }), row('file#1', { status: 'pass' })],
    });
    expect(mapped.rows[0]?.status).toBe('fail');
    expect(mapped.logs).toEqual([expect.stringContaining('more than once')]);
  });

  test('an unknown, empty or non-string id is rejected and logged, never mapped', () => {
    const mapped = api.mapFileBatch(CWD, [file(1)], {
      results: [row('file#9'), row('cmd#1'), row(''), row(7), null, row('file#1')],
    });
    expect(mapped.rows[0]?.status).toBe('pass');
    expect(mapped.logs).toHaveLength(5);
    expect(mapped.logs.every((line) => line.includes('rejected'))).toBe(true);
  });

  test('a batch row whose command left cwd is insufficient', () => {
    const mapped = api.mapFileBatch(CWD, [file(1)], { results: [{ ...row('file#1'), command: 'test -f f1' }] });
    expect(mapped.rows[0]?.status).toBe('insufficient');
  });
});

// The whole shipped script, run against stub runtime hooks: what it actually dispatches.
async function runScript(args: unknown, answer: (prompt: string, opts: { label: string }) => unknown) {
  const labels: string[] = [];
  const logs: string[] = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const body = SCRIPT.replace(/^export const meta/m, 'const meta');
  const run = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', body);
  const result = await run(
    args,
    async (prompt: string, opts: { label: string }) => {
      labels.push(opts.label);
      return answer(prompt, opts);
    },
    (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map((thunk) => thunk())),
    () => {},
    (line: string) => logs.push(line),
  );
  return { labels, logs, result };
}

const synthesis = {
  verdict: 'pass',
  doesNotProve: 'x',
  howAPassingCommandCouldStillBeWrong: 'y',
  items: [],
  claims: [],
  unknowns: [],
  conflicts: [],
};

describe('review hardening', () => {
  test('a file check that never names its own path is insufficient', () => {
    expect(api.readVerifier(CWD, file(1), pass(`cd '${CWD}' && test -s f2`)).status).toBe('insufficient');
    expect(api.readVerifier(CWD, file(1), pass(`cd '${CWD}' && test -s f1`)).status).toBe('pass');
  });

  test('a pass whose exit code differs from expectExit is insufficient', () => {
    const run = 'bun test';
    expect(api.readVerifier(CWD, cmd(1, run), { ...pass(`cd '${CWD}' && ${run}`), exitCode: 1 }).status).toBe(
      'insufficient',
    );
    expect(api.readVerifier(CWD, cmd(1, run), { ...pass(`cd '${CWD}' && ${run}`), exitCode: -1 }).status).toBe(
      'insufficient',
    );
    expect(
      api.readVerifier(CWD, { ...cmd(1, run), expectExit: 1 }, { ...pass(`cd '${CWD}' && ${run}`), exitCode: 1 })
        .status,
    ).toBe('pass');
  });
});

describe('the shipped script end to end', () => {
  const contract = { files: ['a', 'b', { path: 'c', mustBeNonEmpty: true }], commands: ['bun test', 'bun run lint'] };

  test('three files and two commands dispatch exactly three verifier agents', async () => {
    const { labels, logs, result } = await runScript({ contract, cwd: CWD }, (prompt, opts) => {
      if (opts.label === 'verify:files')
        return {
          results: [
            ['file#1', 'a'],
            ['file#2', 'b'],
            ['file#3', 'c'],
          ].map(([id, path]) => ({ id, ...pass(`cd '${CWD}' && test -s ${path}`) })),
        };
      if (opts.label.startsWith('verify:cmd#')) {
        const run = opts.label === 'verify:cmd#1' ? 'bun test' : 'bun run lint';
        expect(prompt).toContain(`cd '${CWD}' && ${run}`);
        return pass(`cd "${CWD}" && ${run}`);
      }
      if (opts.label === 'synthesize:verdict') return synthesis;
      return { path: 'r', bytes: 1, written: true };
    });
    expect(labels.filter((label) => label.startsWith('verify:')).sort()).toEqual([
      'verify:cmd#1',
      'verify:cmd#2',
      'verify:files',
    ]);
    expect(result.items.map((item: Row) => [item.id, item.status])).toEqual([
      ['file#1', 'pass'],
      ['file#2', 'pass'],
      ['file#3', 'pass'],
      ['cmd#1', 'pass'],
      ['cmd#2', 'pass'],
    ]);
    // The response log counts agents, not items.
    expect(logs).toContainEqual(expect.stringContaining('3/3 verifier agents responded; 5/5 item(s) passed'));
  });

  test('files only: one agent; commands only: one agent each', async () => {
    const answer = (_: string, opts: { label: string }) => {
      if (opts.label === 'synthesize:verdict') return synthesis;
      return opts.label === 'report:write' ? { path: 'r', bytes: 1, written: true } : null;
    };
    const filesOnly = await runScript({ contract: { files: ['a', 'b', 'c', 'd'] } }, answer);
    expect(filesOnly.labels.filter((label) => label.startsWith('verify:'))).toEqual(['verify:files']);
    // A silent batch is recorded once and makes every file insufficient.
    expect(filesOnly.result.notConvened).toEqual(['verify:files']);
    expect(filesOnly.result.items.every((item: Row) => item.status === 'insufficient')).toBe(true);
    const commandsOnly = await runScript({ contract: { commands: ['a', 'b'] } }, answer);
    expect(commandsOnly.labels.filter((label) => label.startsWith('verify:'))).toEqual([
      'verify:cmd#1',
      'verify:cmd#2',
    ]);
  });

  test('a verifier that reports a command run outside cwd cannot carry the run to pass', async () => {
    const { result } = await runScript({ contract: { commands: ['bun test'] }, cwd: CWD }, (_, opts) => {
      if (opts.label === 'verify:cmd#1') return pass('bun test');
      if (opts.label === 'synthesize:verdict') return synthesis;
      return { path: 'r', bytes: 1, written: true };
    });
    expect(result.items[0].status).toBe('insufficient');
    expect(result.verdict).toBe('insufficient');
    expect(result.ok).toBe(false);
  });
});
