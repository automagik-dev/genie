import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMirror } from './orca.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');

const RUNTIME_ID = '2e8238e3-9667-4bf7-a58b-e25b75fcbed5';
const REPO_ID = '25c9dad7-db54-4f46-bc79-142a560a965a';
const WORKTREE_PATH = '/home/genie/orca/workspaces/genie/orca-plugin-genie';
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`;

/** The card as Orca answers it before genie writes anything. */
const CARD = {
  id: WORKTREE_ID,
  path: WORKTREE_PATH,
  branch: 'namastex888/orca-plugin-genie',
  displayName: 'orca-plugin-genie',
  comment: null,
  workspaceStatus: null,
  createdWithAgent: 'claude',
};

/**
 * A stand-in `orca` on PATH. It records every argv it is handed, keeps the card
 * the way Orca does (a `worktree set` stores what it was told, a `worktree show`
 * reads it back), and answers the documented envelope. A scenario entry may
 * `patch` what `show` reports — that is how a read-back disagreement is staged —
 * or replace the whole answer with `raw` plus an `exitCode`.
 *
 * Deliberately NOT a mock of the adapter: the contract under test includes the
 * exact argv the adapter builds and the exit code the CLI turns each answer
 * into, and neither is observable from inside the process.
 */
const FAKE_ORCA = `#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_ORCA_LOG, JSON.stringify(argv) + '\\n');
const scenario = JSON.parse(readFileSync(process.env.FAKE_ORCA_SCENARIO, 'utf8'));
const key = argv.slice(0, 2).join(' ');
const step = scenario[key];
if (step === undefined) {
  process.stderr.write('fake orca: no scenario for "' + key + '"\\n');
  process.exit(97);
}
if (step.raw !== undefined) {
  process.stdout.write(step.raw);
  process.exit(step.exitCode ?? 0);
}
const statePath = process.env.FAKE_ORCA_STATE;
let card = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : scenario.card;
if (key === 'worktree set') {
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at === -1 ? undefined : argv[at + 1];
  };
  const status = flag('--workspace-status');
  const comment = flag('--comment');
  if (status !== undefined) card = { ...card, workspaceStatus: status };
  if (comment !== undefined) card = { ...card, comment };
  writeFileSync(statePath, JSON.stringify(card));
}
const shown = { ...card, ...(step.patch ?? {}) };
process.stdout.write(
  JSON.stringify({ id: 'req', ok: true, result: { worktree: shown }, _meta: { runtimeId: scenario.runtimeId } }) + '\\n',
);
`;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Every argv the fake `orca` received, in order. */
  log: string[][];
}

let home: string;
let binDir: string;
let logPath: string;
let scenarioPath: string;
let statePath: string;

function stage(scenario: Record<string, unknown>): void {
  writeFileSync(scenarioPath, JSON.stringify({ card: CARD, runtimeId: RUNTIME_ID, ...scenario }), 'utf-8');
}

async function runCli(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    env: {
      ...process.env,
      GENIE_HOME: home,
      NO_COLOR: '1',
      // The adapter resolves `orca` (not `orca-ide`) inside an Orca-managed
      // terminal; the fake is installed under that name.
      TERM_PROGRAM: 'Orca',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
      FAKE_ORCA_LOG: logPath,
      FAKE_ORCA_SCENARIO: scenarioPath,
      FAKE_ORCA_STATE: statePath,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const log = readFileSync(logPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
  return { code, stdout, stderr, log };
}

/** The clock the CLI reads, computed the same way the command does. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'genie-orca-cmd-'));
  binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'orca'), FAKE_ORCA, 'utf-8');
  chmodSync(join(binDir, 'orca'), 0o755);
  logPath = join(home, 'orca-argv.log');
  writeFileSync(logPath, '', 'utf-8');
  scenarioPath = join(home, 'scenario.json');
  statePath = join(home, 'card.json');
  stage({});
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('genie orca mirror — a proven write', () => {
  test('flips the card, prints one JSON line, and reads the write back', async () => {
    stage({ 'worktree set': {}, 'worktree show': {} });
    const expectedComment = `${today()} genie review: FIX-FIRST — group 2, head 0ef761c, 3 gaps`;

    const result = await runCli([
      'orca',
      'mirror',
      '--to',
      'REVIEW',
      '--verdict',
      'FIX-FIRST',
      '--evidence',
      'group 2, head 0ef761c, 3 gaps',
    ]);

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split('\n')).toHaveLength(1);
    const line = JSON.parse(result.stdout) as {
      worktree: { id: string; displayName: string; branch: string | null };
      workspaceStatus: string;
      comment: string;
      receipt: { verb: string; ids: Record<string, string>; runtimeId: string; readbackVerb: string | null };
    };
    expect(line.workspaceStatus).toBe('in-review');
    expect(line.comment).toBe(expectedComment);
    expect(line.worktree).toEqual({
      id: WORKTREE_ID,
      displayName: 'orca-plugin-genie',
      branch: 'namastex888/orca-plugin-genie',
    });
    expect(line.receipt.verb).toBe('worktree-set');
    expect(line.receipt.ids).toEqual({ worktreeId: WORKTREE_ID });
    expect(line.receipt.runtimeId).toBe(RUNTIME_ID);
    expect(line.receipt.readbackVerb).toBe('worktree-show');

    expect(result.log).toEqual([
      [
        'worktree',
        'set',
        '--worktree',
        'current',
        '--workspace-status',
        'in-review',
        '--comment',
        expectedComment,
        '--json',
      ],
      ['worktree', 'show', '--worktree', `id:${WORKTREE_ID}`, '--json'],
    ]);
  });

  test('is idempotent: the same transition twice is two proven writes and one unchanged card', async () => {
    stage({ 'worktree set': {}, 'worktree show': {} });
    const args = [
      'orca',
      'mirror',
      '--to',
      'IN_PROGRESS',
      '--evidence',
      'wish orca-plugin-genie, wave 2, base 2ea6ee9',
    ];
    const first = await runCli(args);
    expect(first.code).toBe(0);
    const cardAfterFirst = readFileSync(statePath, 'utf-8');
    const second = await runCli(args);
    expect(second.code).toBe(0);
    expect(second.stderr).toBe('');
    expect(readFileSync(statePath, 'utf-8')).toBe(cardAfterFirst);
    expect(JSON.parse(second.stdout).comment).toBe(JSON.parse(first.stdout).comment);
    expect(second.log).toHaveLength(4);
    expect(second.log.map((argv) => argv.slice(0, 2))).toEqual([
      ['worktree', 'set'],
      ['worktree', 'show'],
      ['worktree', 'set'],
      ['worktree', 'show'],
    ]);
  });

  test('--json changes nothing: one JSON line is the contract either way', async () => {
    stage({ 'worktree set': {}, 'worktree show': {} });
    const result = await runCli([
      'orca',
      'mirror',
      '--to',
      'IN_PROGRESS',
      '--evidence',
      'group 3 dispatched',
      '--json',
    ]);
    expect(result.code).toBe(0);
    const line = JSON.parse(result.stdout) as { workspaceStatus: string; comment: string };
    expect(line.workspaceStatus).toBe('in-progress');
    expect(line.comment).toBe(`${today()} genie in progress — group 3 dispatched`);
  });

  test('a selector other than the default reaches the CLI verbatim', async () => {
    stage({ 'worktree set': {}, 'worktree show': {} });
    const result = await runCli([
      'orca',
      'mirror',
      '--to',
      'SHIPPED',
      '--evidence',
      'merged 98104af26',
      '--worktree',
      `id:${WORKTREE_ID}`,
    ]);
    expect(result.code).toBe(0);
    expect(result.log[0]?.slice(0, 4)).toEqual(['worktree', 'set', '--worktree', `id:${WORKTREE_ID}`]);
    expect(JSON.parse(result.stdout).workspaceStatus).toBe('completed');
  });
});

describe('genie orca mirror — Orca refused or disagreed (exit 1)', () => {
  test('a read-back that disagrees with the write fails the mirror', async () => {
    stage({ 'worktree set': {}, 'worktree show': { patch: { workspaceStatus: 'todo' } } });
    const result = await runCli(['orca', 'mirror', '--to', 'REVIEW', '--verdict', 'SHIP', '--evidence', 'group 3']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const error = JSON.parse(result.stderr) as Record<string, string>;
    expect(error.error).toBe('readback_mismatch');
    expect(error.operation).toBe('worktree-set');
    expect(error.phase).toBe('readback');
    expect(error.retrySafety).toBe('unsafe');
    expect(error.recovery).toContain('orca worktree show');
    expect(result.log.map((argv) => argv.slice(0, 2))).toEqual([
      ['worktree', 'set'],
      ['worktree', 'show'],
    ]);
  });

  test('a directory that is not an Orca-managed worktree surfaces as the adapter’s typed error', async () => {
    stage({
      'worktree set': {
        exitCode: 1,
        raw: `${JSON.stringify({
          id: 'req',
          ok: false,
          error: { code: 'worktree_not_found', message: 'no worktree matches selector current' },
        })}\n`,
      },
    });
    const result = await runCli(['orca', 'mirror', '--to', 'IN_PROGRESS', '--evidence', 'entry']);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    const error = JSON.parse(result.stderr) as Record<string, string>;
    // A failed MUTATION is ambiguous by the adapter's contract: Orca may have
    // committed before it failed, so the CLI never reports it as a clean refusal
    // and never invites a blind retry.
    expect(error.error).toBe('ambiguous_after_possible_commit');
    expect(error.operation).toBe('worktree-set');
    expect(error.retrySafety).toBe('unrecoverably-ambiguous');
    expect(error.recovery).toContain('Do not retry automatically');
    expect(typeof error.reason).toBe('string');
    expect(result.log).toHaveLength(1);
  });

  test('stderr carries exactly one JSON line and nothing else', async () => {
    stage({ 'worktree set': { exitCode: 3, raw: 'boom\n' } });
    const result = await runCli(['orca', 'mirror', '--to', 'BLOCKED', '--evidence', 'gate g1: merge?']);
    expect(result.code).toBe(1);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(() => JSON.parse(result.stderr)).not.toThrow();
  });
});

describe('genie orca mirror — usage (exit 2, nothing spawned)', () => {
  test('REVIEW without a verdict names the missing verdict and touches no Orca', async () => {
    const result = await runCli(['orca', 'mirror', '--to', 'REVIEW', '--evidence', 'group 3']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe(
      'Error (genie orca mirror): REVIEW requires --verdict (SHIP, FIX-FIRST, BLOCKED)',
    );
    expect(result.log).toEqual([]);
  });

  test('a verdict on a transition that carries none is refused', async () => {
    const result = await runCli(['orca', 'mirror', '--to', 'APPROVED', '--verdict', 'SHIP', '--evidence', 'plan SHIP']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--verdict belongs to REVIEW only');
    expect(result.log).toEqual([]);
  });

  test('multi-line evidence is refused before anything is spawned', async () => {
    const result = await runCli(['orca', 'mirror', '--to', 'SHIPPED', '--evidence', 'merged\nand promoted']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--evidence must be one line');
    expect(result.log).toEqual([]);
  });

  test('an unknown transition is refused', async () => {
    const result = await runCli(['orca', 'mirror', '--to', 'in-review', '--evidence', 'x']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--to must be one of APPROVED, IN_PROGRESS, REVIEW, SHIPPED, BLOCKED');
    expect(result.log).toEqual([]);
  });

  test('a selector outside the adapter’s grammar is usage, not an Orca failure', async () => {
    const result = await runCli([
      'orca',
      'mirror',
      '--to',
      'IN_PROGRESS',
      '--evidence',
      'entry',
      '--worktree',
      'other',
    ]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toStartWith('Error (genie orca mirror): ');
    expect(result.stderr).toContain('worktree selector must be current, active, id:');
    expect(result.log).toEqual([]);
  });

  test('a missing --evidence is Commander’s own refusal, non-zero and named', async () => {
    const result = await runCli(['orca', 'mirror', '--to', 'SHIPPED']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('--evidence');
    expect(result.log).toEqual([]);
  });
});

describe('the runMirror seam', () => {
  // The seam RETURNS the exit code and never touches `process.exitCode`: an
  // in-process usage test used to leave 2 behind and the whole suite exited 2
  // with zero failures (group 3 review, finding 1).
  test('never builds an adapter when validation fails', async () => {
    let built = 0;
    // Other suites in the same runner may have set the process code already;
    // the invariant is that the seam leaves it exactly as it found it.
    const codeBefore = process.exitCode;
    const code = await runMirror(
      { to: 'REVIEW', evidence: 'group 3', worktree: 'current' },
      {
        today: () => '2026-09-19',
        createAdapter: () => {
          built += 1;
          throw new Error('the adapter must not be built on a usage failure');
        },
      },
    );
    expect(built).toBe(0);
    expect(code).toBe(2);
    expect(process.exitCode).toBe(codeBefore);
  });

  test('takes its clock from the seam, never from a hidden global', async () => {
    const calls: unknown[] = [];
    const code = await runMirror(
      { to: 'BLOCKED', evidence: 'gate gate_7f3a: Merge PR #3005 into dev?', worktree: 'active' },
      {
        today: () => '2026-09-19',
        createAdapter: () => ({
          executable: 'orca',
          status: async () => {
            throw new Error('the mirror never probes the runtime');
          },
          execute: (input: unknown) => {
            calls.push(input);
            return Promise.resolve({
              id: 'req',
              ok: true as const,
              result: { worktree: { ...CARD, workspaceStatus: 'in-progress' } },
            });
          },
        }),
      },
    );
    expect(calls).toEqual([
      {
        operation: 'worktree-set',
        worktree: 'active',
        workspaceStatus: 'in-progress',
        comment: '2026-09-19 genie blocked — gate gate_7f3a: Merge PR #3005 into dev?',
      },
    ]);
    expect(code).toBe(0);
  });
});
