import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AttemptIdentity,
  type HarnessConfiguration,
  type PoolEntry,
  type Quotas,
  type SourceKind,
  type TaskIdentity,
  type TaskManifest,
  hostClock,
  parsePool,
  taskKey,
} from './contracts';
import { appendTransition, campaignStatus } from './ledger';
import { freezeManifest, replaceIneligible, scheduleCampaign } from './pilot';

const PILOT = join(import.meta.dir, 'pilot.ts');
const FROZEN_AT = '2026-10-14T00:00:00.000Z';
const QUOTAS: Quotas = {
  'deepswe/bugfix': 6,
  'deepswe/feature': 4,
  'terminal-bench/build': 2,
  'terminal-bench/security': 2,
  'swe-atlas/qa': 2,
  'skillsbench/office': 4,
};
const SMOKE = ['terminal-bench:tb-1', 'swe-atlas:doc-2'];

interface Row {
  source: SourceKind;
  category: string;
  taskId: string;
  status: 'eligible' | 'ineligible' | 'unresolved';
}

function task(row: Row): TaskIdentity {
  return {
    source: row.source,
    sourceRevision: 'synthetic-rev-1',
    taskId: row.taskId,
    category: row.category,
    cluster: `${row.category}-cluster`,
    artifactTransport: 'committed-patch',
    instruction: { path: `tasks/${row.taskId}/instruction.md`, sha256: 'a'.repeat(64) },
    environment: {
      kind: 'git-checkout',
      repository: { url: 'https://example.invalid/synthetic.git', commit: '0'.repeat(40) },
      image: null,
      provision: null,
      teardown: null,
      resources: null,
      solverPath: '/work',
      artifactPath: '/work',
    },
    verifier: {
      command: ['true'],
      runsIn: 'host-outside-solver',
      rewardFile: null,
      acceptWhen: 'binary-one',
      timeoutSec: null,
      judge: null,
    },
    verifierDigest: 'b'.repeat(64),
    referenceSolution: null,
    timeLimitSec: null,
  };
}

const ELIGIBILITY: Record<Row['status'], PoolEntry['eligibility']> = {
  eligible: {
    status: 'eligible',
    clearance: [{ kind: 'clearance', path: 'clear.md', sha256: 'c'.repeat(64), bytes: 1 }],
  },
  ineligible: { status: 'ineligible', reason: 'synthetic: license hold' },
  unresolved: { status: 'unresolved', blocker: 'synthetic: evaluator semantics' },
};

const ROWS: Row[] = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'pool.fixture.json'), 'utf8')).rows;
const POOL_DOC = {
  schemaVersion: 1,
  entries: ROWS.map((row) => ({ task: task(row), eligibility: ELIGIBILITY[row.status] })),
};

function pool(): PoolEntry[] {
  const parsed = parsePool(structuredClone(POOL_DOC));
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.value;
}

function frozen(quotas: Quotas = QUOTAS): TaskManifest {
  const m = freezeManifest(pool(), quotas, SMOKE, FROZEN_AT);
  if (!m.ok) throw new Error(m.issues.join('\n'));
  return m.value;
}

function config(configId: string, pinned: boolean): HarnessConfiguration {
  return {
    schemaVersion: 1,
    configId,
    harness: 'omp',
    executable: '/opt/synthetic/omp',
    requestedModel: 'synthetic-model',
    requestedEffort: 'medium',
    treatment: pinned ? { contract: 'genie-v6', resources: { 'skills/x.md': 'd'.repeat(64) } } : null,
    epoch: 'e1',
    cohort: 'c1',
  };
}

const CONFIGS: [HarnessConfiguration, HarnessConfiguration] = [config('cfg-zero', false), config('cfg-genie', true)];

let tmp: string;
let savedGenieHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bench-pilot-'));
  savedGenieHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = join(tmp, 'genie-home');
});

afterEach(() => {
  if (savedGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedGenieHome;
  rmSync(tmp, { recursive: true, force: true });
});

function cli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const run = Bun.spawnSync([process.execPath, PILOT, ...args], { cwd: tmp, env: { ...process.env } });
  return { code: run.exitCode ?? -1, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
}

function writeJson(name: string, value: unknown): string {
  const path = join(tmp, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

/** The pool, quotas, two configs and a frozen manifest on disk; returns their paths. */
function inputs(): Record<'pool' | 'quotas' | 'configA' | 'configB' | 'manifest', string> {
  return {
    pool: writeJson('pool.json', POOL_DOC),
    quotas: writeJson('quotas.json', QUOTAS),
    configA: writeJson('config-a.json', CONFIGS[0]),
    configB: writeJson('config-b.json', CONFIGS[1]),
    manifest: writeJson('manifest.json', frozen()),
  };
}

const freezeArgs = (p: ReturnType<typeof inputs>, out: string): string[] => [
  'freeze',
  '--pool',
  p.pool,
  '--quotas',
  p.quotas,
  '--smoke',
  SMOKE.join(','),
  '--frozen-at',
  FROZEN_AT,
  '--out',
  out,
];

const scheduleArgs = (p: ReturnType<typeof inputs>, root: string, seed = 'seed-a'): string[] => [
  'schedule',
  '--manifest',
  p.manifest,
  '--config-a',
  p.configA,
  '--config-b',
  p.configB,
  '--repeats',
  '3',
  '--seed',
  seed,
  '--experiment',
  'pilot-1',
  '--root',
  root,
];

const withoutFlag = (args: string[], flag: string): string[] => {
  const at = args.indexOf(flag);
  return [...args.slice(0, at), ...args.slice(at + 2)];
};

const ids = (m: TaskManifest, category: string): string[] =>
  m.selected.filter((t) => `${t.source}/${t.category}` === category).map((t) => t.taskId);

describe('freezeManifest', () => {
  test('selects 20 under quotas 6/4/2/2/2/4, byte-identical across two runs', () => {
    const first = freezeManifest(pool(), QUOTAS, SMOKE, FROZEN_AT);
    const second = freezeManifest(pool(), QUOTAS, SMOKE, FROZEN_AT);
    if (!first.ok || !second.ok) throw new Error('freeze refused');
    expect(Object.values(QUOTAS)).toEqual([6, 4, 2, 2, 2, 4]);
    expect(first.value.selected).toHaveLength(20);
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
    expect(first.value.smoke.map(taskKey)).toEqual(['swe-atlas/docs/doc-2', 'terminal-bench/build/tb-1']);
  });

  test('orders by code unit, skipping the ineligible entry', () => {
    const m = frozen();
    // Bytewise: '1' < '9' < 'Z' < 'a'. Locale order would take bf-a over bf-Z; numeric would put bf-9 first.
    expect(ids(m, 'deepswe/bugfix')).toEqual(['bf-01', 'bf-02', 'bf-03', 'bf-10', 'bf-9', 'bf-Z']);
    expect(m.selected.map(taskKey)).not.toContain('deepswe/bugfix/bf-00');
  });

  test('a category short of its quota refuses and names the category', () => {
    const m = freezeManifest(pool(), { ...QUOTAS, 'deepswe/feature': 5 }, SMOKE, FROZEN_AT);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.issues.join('\n')).toContain('deepswe/feature');
  });

  test('an unresolved entry in a needed category refuses rather than being skipped', () => {
    const m = freezeManifest(pool(), { ...QUOTAS, 'swe-atlas/docs': 1 }, SMOKE, FROZEN_AT);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.issues.join('\n')).toContain('swe-atlas/docs/doc-1');
  });

  test('a smoke selector must name an eligible pool entry', () => {
    const absent = freezeManifest(pool(), QUOTAS, ['deepswe:nope'], FROZEN_AT);
    const ineligible = freezeManifest(pool(), QUOTAS, ['deepswe:bf-00'], FROZEN_AT);
    expect(absent.ok || ineligible.ok).toBe(false);
    if (!absent.ok) expect(absent.issues.join('\n')).toContain('deepswe:nope');
    if (!ineligible.ok) expect(ineligible.issues.join('\n')).toContain('ineligible');
  });
});

describe('replaceIneligible', () => {
  test('takes the next bytewise eligible id of the same category and keeps the quota', () => {
    const once = replaceIneligible(frozen(), pool(), 'deepswe/bugfix/bf-01', 'license hold found', false);
    if (!once.ok) throw new Error(once.issues.join('\n'));
    expect(ids(once.value, 'deepswe/bugfix')).toEqual(['bf-02', 'bf-03', 'bf-10', 'bf-9', 'bf-Z', 'bf-a']);
    expect(once.value.selected).toHaveLength(20);
    expect(once.value.replacements).toMatchObject([
      { replaced: 'deepswe/bugfix/bf-01', by: 'deepswe/bugfix/bf-a', reason: 'license hold found' },
    ]);
    const twice = replaceIneligible(once.value, pool(), 'deepswe/bugfix/bf-02', 'image gone', false);
    if (!twice.ok) throw new Error(twice.issues.join('\n'));
    expect(ids(twice.value, 'deepswe/bugfix')).toContain('bf-b');
    // The category is now exhausted: the earlier replaced bf-01 never comes back.
    const third = replaceIneligible(twice.value, pool(), 'deepswe/bugfix/bf-03', 'x', false);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.issues.join('\n')).toContain('deepswe/bugfix');
  });

  test('refuses once an outcome is recorded', () => {
    const m = replaceIneligible(frozen(), pool(), 'deepswe/bugfix/bf-01', 'late finding', true);
    expect(m.ok).toBe(false);
  });

  test('refuses with the category named when it has no candidate left', () => {
    const m = replaceIneligible(frozen(), pool(), 'terminal-bench/build/tb-1', 'hold', false);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.issues.join('\n')).toContain('terminal-bench/build');
  });
});

describe('scheduleCampaign', () => {
  const strip = (rows: AttemptIdentity[]): string[] =>
    rows.map(({ scheduledIndex: _, ...rest }) => JSON.stringify(rest)).sort();

  test('20 tasks x 3 repeats x 2 configs yields 120 scored rows plus the smoke rows, arms paired', () => {
    const rows = scheduleCampaign(frozen(), CONFIGS, 3, 'seed-a', 'pilot-1');
    expect(rows.filter((r) => r.kind === 'scored')).toHaveLength(120);
    expect(rows.filter((r) => r.kind === 'smoke')).toHaveLength(SMOKE.length * 2);
    expect(rows.map((r) => r.scheduledIndex)).toEqual(rows.map((_, i) => i));
    for (let i = 0; i < rows.length; i += 2) {
      expect(rows[i].pairId).toBe(rows[i + 1].pairId);
      expect(new Set([rows[i].arm, rows[i + 1].arm])).toEqual(new Set(['zero-genie', 'genie']));
    }
    for (const r of rows) {
      expect(r.attemptId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(r.pairId).not.toContain('/');
      expect(r.attemptId.startsWith(`${r.kind}-`)).toBe(true);
      expect(Object.keys(r).sort()).toEqual(
        [
          'experimentId',
          'pairId',
          'manifestId',
          'taskKey',
          'configId',
          'arm',
          'repeat',
          'attemptId',
          'scheduledIndex',
          'kind',
        ].sort(),
      );
    }
    expect(new Set(rows.map((r) => r.attemptId)).size).toBe(rows.length);
    expect(rows.find((r) => r.configId === 'cfg-genie')?.arm).toBe('genie');
  });

  test('the same seed gives the same order; another seed the same multiset in another order', () => {
    const a1 = scheduleCampaign(frozen(), CONFIGS, 3, 'seed-a', 'pilot-1');
    const a2 = scheduleCampaign(frozen(), CONFIGS, 3, 'seed-a', 'pilot-1');
    const b = scheduleCampaign(frozen(), CONFIGS, 3, 'seed-b', 'pilot-1');
    expect(a2).toEqual(a1);
    expect(strip(b)).toEqual(strip(a1));
    expect(b.map((r) => r.attemptId)).not.toEqual(a1.map((r) => r.attemptId));
  });

  test('two configurations of the same arm are refused', () => {
    expect(() => scheduleCampaign(frozen(), [CONFIGS[0], config('cfg-zero-2', false)], 3, 's', 'pilot-1')).toThrow(
      'zero-genie',
    );
  });
});

describe('CLI', () => {
  test('freeze writes the same bytes twice; verify accepts it and rejects a tampered copy', () => {
    const p = inputs();
    const one = cli(...freezeArgs(p, join(tmp, 'm1.json')));
    const two = cli(...freezeArgs(p, join(tmp, 'm2.json')));
    expect([one.code, two.code]).toEqual([0, 0]);
    const bytes = readFileSync(join(tmp, 'm1.json'), 'utf8');
    expect(readFileSync(join(tmp, 'm2.json'), 'utf8')).toBe(bytes);
    expect(JSON.parse(bytes).selected).toHaveLength(20);
    expect(cli('verify', join(tmp, 'm1.json')).code).toBe(0);
    const tampered = JSON.parse(bytes);
    tampered.selected.pop();
    expect(cli('verify', writeJson('tampered.json', tampered)).code).toBe(1);
  });

  test('freeze refusals exit 2 and write nothing', () => {
    const p = inputs();
    const out = join(tmp, 'out.json');
    const short = writeJson('short.json', { ...QUOTAS, 'deepswe/feature': 5 });
    const cases: Array<{ args: string[]; names: string }> = [
      { args: withoutFlag(freezeArgs(p, out), '--quotas'), names: '--quotas' },
      { args: withoutFlag(freezeArgs(p, out), '--smoke'), names: '--smoke' },
      { args: withoutFlag(freezeArgs(p, out), '--out'), names: '--out' },
      { args: [...withoutFlag(freezeArgs(p, out), '--smoke'), '--smoke', 'deepswe:nope'], names: 'deepswe:nope' },
      { args: [...withoutFlag(freezeArgs(p, out), '--quotas'), '--quotas', short], names: 'deepswe/feature' },
    ];
    for (const c of cases) {
      const run = cli(...c.args);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(c.names);
      expect(existsSync(out)).toBe(false);
    }
  });

  test('schedule registers through the ledger, records the seed and releases the lock', () => {
    const p = inputs();
    const root = join(tmp, 'root');
    const run = cli(...scheduleArgs(p, root));
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('seed seed-a');
    const lines = readFileSync(join(root, 'campaigns', 'pilot-1', 'schedule.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const rows = lines.map((l) => JSON.parse(l) as AttemptIdentity);
    expect(rows.filter((r) => r.kind === 'scored')).toHaveLength(120);
    expect(rows.filter((r) => r.kind === 'smoke')).toHaveLength(4);
    const status = campaignStatus(root, 'pilot-1');
    expect(status.ok && status.value.scheduled).toBe(124);
    const prereg = JSON.parse(readFileSync(join(root, 'campaigns', 'pilot-1', 'preregistration.json'), 'utf8'));
    expect(prereg.seed).toBe('seed-a');
    expect(existsSync(join(root, 'supervisor.lock'))).toBe(false);
    // Re-running the same preregistration is idempotent; another seed for the same campaign is refused.
    expect(cli(...scheduleArgs(p, root)).code).toBe(0);
    expect(cli(...scheduleArgs(p, root, 'seed-b')).code).toBe(2);
  });

  test('a missing --root exits 2 and writes nothing, for replace and for schedule', () => {
    const p = inputs();
    const before = readdirSync(tmp).sort();
    const manifestBytes = readFileSync(p.manifest, 'utf8');
    const schedule = cli(...withoutFlag(scheduleArgs(p, join(tmp, 'root')), '--root'));
    const replace = cli(
      'replace',
      ...['--manifest', p.manifest, '--pool', p.pool, '--task', 'deepswe/bugfix/bf-01', '--reason', 'hold'],
    );
    expect([schedule.code, replace.code]).toEqual([2, 2]);
    expect(schedule.stderr).toContain('--root');
    expect(replace.stderr).toContain('--root');
    expect(readdirSync(tmp).sort()).toEqual(before);
    expect(readFileSync(p.manifest, 'utf8')).toBe(manifestBytes);
  });

  test('replace reads the ledger: allowed while only registered, refused once an outcome is recorded', () => {
    const p = inputs();
    const root = join(tmp, 'root');
    const replace = (key: string, reason: string) =>
      cli('replace', '--manifest', p.manifest, '--pool', p.pool, '--task', key, '--reason', reason, '--root', root);

    mkdirSync(root);
    expect(cli(...scheduleArgs(p, root)).code).toBe(0);
    // Registered journals alone are not outcomes.
    const first = replace('deepswe/bugfix/bf-01', 'license hold');
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('deepswe/bugfix/bf-a');

    // A short category through the CLI exits 2 naming it.
    const short = replace('terminal-bench/build/tb-1', 'hold');
    expect(short.code).toBe(2);
    expect(short.stderr).toContain('terminal-bench/build');

    const rows = readFileSync(join(root, 'campaigns', 'pilot-1', 'schedule.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const attemptId = (JSON.parse(rows[0]) as AttemptIdentity).attemptId;
    const moved = appendTransition(root, attemptId, 'running', {
      at: hostClock.wall(),
      monotonicNs: hostClock.nowNs().toString(),
      evidence: [],
    });
    expect(moved.ok).toBe(true);
    const bytes = readFileSync(p.manifest, 'utf8');
    const refused = replace('deepswe/bugfix/bf-02', 'too late');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('outcome');
    expect(readFileSync(p.manifest, 'utf8')).toBe(bytes);
  });
});
