import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import {
  type AdapterContext,
  type AttemptIdentity,
  type CapabilityReport,
  type Disposition,
  type HarnessConfiguration,
  type MonotonicClock,
  type NativeAdapter,
  REQUIRED_CAPABILITIES,
  type TaskIdentity,
  type TaskManifest,
  parseCapabilityReport,
  parseConfiguration,
  parseManifest,
  taskKey,
} from './contracts';
import { type JournalEntry, campaignStatus, readJournal, registerCampaign } from './ledger';
import { runAttempt, runCli, runPreflight } from './run';

const RUN_TS = join(import.meta.dir, 'run.ts');
const EXPERIMENT = 'exp-1';
const ATTEMPT = 'att-1';
const WALL = '2026-10-14T00:00:00.000Z';
const SECOND = 1_000_000_000n;

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');

let tmp: string;
let root: string;
let sources: string;
let savedGenieHome: string | undefined;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'genie-bench-run-')));
  root = join(tmp, 'root');
  sources = join(tmp, 'sources');
  mkdirSync(sources);
  savedGenieHome = process.env.GENIE_HOME;
  process.env.GENIE_HOME = join(tmp, 'genie-home');
});

afterEach(() => {
  if (savedGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
  else process.env.GENIE_HOME = savedGenieHome;
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures: a git-checkout task, the original verifier script, a registered campaign
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(['git', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@example.invalid',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@example.invalid',
    },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

/**
 * The original verifier: prints where it runs and every file it can see, then scores
 * answer.txt into reward.txt. Mode `no-reward` exits 0 without writing a reward.
 */
const VERIFIER = [
  '#!/bin/sh',
  'echo "cwd=$(pwd)"',
  'find . -type f | sort',
  'if [ "$1" = "no-reward" ]; then exit 0; fi',
  'if [ "$(cat answer.txt 2>/dev/null)" = "solved" ]; then printf 1 > reward.txt; else printf 0 > reward.txt; fi',
  'exit 0',
  '',
].join('\n');

const INSTRUCTION = 'Fix the bug and write the word solved into answer.txt.\n';

interface Fixture {
  task: TaskIdentity;
  manifest: TaskManifest;
  config: HarnessConfiguration;
  identity: AttemptIdentity;
  manifestPath: string;
  configPath: string;
}

function fixture(
  opts: { timeLimitSec?: number | null; verifierMode?: 'score' | 'no-reward'; badDigest?: boolean } = {},
): Fixture {
  const repo = join(tmp, 'upstream');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'demo\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'one');
  const commit = git(repo, 'rev-parse', 'HEAD');

  writeFileSync(join(sources, 'instruction.md'), INSTRUCTION);
  writeFileSync(join(sources, 'verify.sh'), VERIFIER);
  const task: TaskIdentity = {
    source: 'terminal-bench',
    sourceRevision: 'rev-1',
    taskId: 'demo-task',
    category: 'demo',
    cluster: 'demo',
    artifactTransport: 'answer',
    instruction: { path: 'instruction.md', sha256: opts.badDigest ? 'f'.repeat(64) : sha256(INSTRUCTION) },
    environment: {
      kind: 'git-checkout',
      repository: { url: repo, commit },
      image: null,
      provision: null,
      teardown: null,
      resources: null,
      solverPath: '.',
      artifactPath: 'answer.txt',
    },
    verifier: {
      command: ['sh', join(sources, 'verify.sh'), opts.verifierMode ?? 'score'],
      runsIn: 'host-outside-solver',
      rewardFile: 'reward.txt',
      acceptWhen: 'binary-one',
      timeoutSec: 30,
      judge: null,
    },
    verifierDigest: sha256(VERIFIER),
    referenceSolution: null,
    timeLimitSec: opts.timeLimitSec === undefined ? 600 : opts.timeLimitSec,
  };
  const manifest = parseManifest({
    schemaVersion: 1,
    manifestId: 'manifest-1',
    poolDigest: 'a'.repeat(64),
    quotas: { 'terminal-bench/demo': 1 },
    selected: [task],
    replacements: [],
    smoke: [],
    frozenAt: WALL,
  });
  const config = parseConfiguration({
    schemaVersion: 1,
    configId: 'cfg-a',
    harness: 'omp',
    executable: '/usr/bin/omp',
    requestedModel: 'model-x',
    requestedEffort: 'medium',
    treatment: null,
    epoch: 'epoch-1',
    cohort: 'cohort-1',
  });
  if (!manifest.ok || !config.ok) throw new Error('fixture documents do not parse');
  const identity: AttemptIdentity = {
    experimentId: EXPERIMENT,
    pairId: 'pair-1',
    manifestId: 'manifest-1',
    taskKey: taskKey(task),
    configId: 'cfg-a',
    arm: 'zero-genie',
    repeat: 0,
    attemptId: ATTEMPT,
    scheduledIndex: 0,
    kind: 'scored',
  };
  const registered = registerCampaign(root, [identity]);
  if (!registered.ok) throw new Error(registered.issues.join('\n'));
  const manifestPath = join(tmp, 'manifest.json');
  const configPath = join(tmp, 'config.json');
  writeFileSync(manifestPath, JSON.stringify(manifest.value));
  writeFileSync(configPath, JSON.stringify(config.value));
  return { task, manifest: manifest.value, config: config.value, identity, manifestPath, configPath };
}

/** A controlled clock: every read moves 1µs; the fake adapter advances it by whole seconds. */
function fakeClock(): MonotonicClock & { advance(ns: bigint): void } {
  let now = 1_000n;
  return {
    nowNs() {
      now += 1_000n;
      return now;
    },
    wall: () => WALL,
    advance(ns: bigint) {
      now += ns;
    },
  };
}

type SettleMode = 'clean' | 'pending' | 'hang' | 'throw';

interface FakeOptions {
  answer?: string;
  settle?: SettleMode;
  launchThrows?: boolean;
  tamper?: boolean;
  clock?: ReturnType<typeof fakeClock>;
  report?: (ctx: AdapterContext) => unknown;
}

/** A test-local native adapter; it runs one real child process so leftovers are observable. */
function fakeAdapter(opts: FakeOptions = {}) {
  const calls = {
    launch: [] as Array<{ ctx: AdapterContext; prompt: string }>,
    settled: 0,
    stop: [] as string[],
    collect: 0,
    preflight: 0,
  };
  let child: Subprocess | null = null;
  let solverCwd = '';
  const adapter: NativeAdapter = {
    harness: 'omp',
    async preflight(ctx) {
      calls.preflight += 1;
      return (opts.report ?? capabilityReport)(ctx) as CapabilityReport;
    },
    async launch(ctx, prompt) {
      calls.launch.push({ ctx, prompt });
      if (opts.launchThrows) throw new Error('the native client did not start');
      if (ctx.solver.kind !== 'host') throw new Error('fixture expects a host solver');
      solverCwd = ctx.solver.cwd;
      writeFileSync(join(solverCwd, 'answer.txt'), opts.answer ?? 'solved');
      writeFileSync(join(solverCwd, 'solver-only.txt'), 'workspace marker\n');
      child = Bun.spawn(['sleep', '30'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      return { attemptId: ctx.attempt.attemptId, session: 'fake-session', startedMonotonicNs: '0' };
    },
    async settled(_h, signal) {
      calls.settled += 1;
      const mode = opts.settle ?? 'clean';
      if (mode === 'throw') throw new Error('adapter crashed');
      if (mode === 'pending') return { settled: true, pendingActors: ['child-1'], basis: 'lead settled, child open' };
      if (mode === 'hang') {
        await new Promise<void>((done) => {
          if (signal.aborted) done();
          else signal.addEventListener('abort', () => done(), { once: true });
        });
        return { settled: false, pendingActors: ['lead'], basis: 'aborted' };
      }
      opts.clock?.advance(60n * SECOND);
      return { settled: true, pendingActors: [], basis: 'native settled' };
    },
    async stop(_h, reason) {
      calls.stop.push(reason);
      const remainingActors = reason === 'settled' ? [] : ['lead'];
      if (child !== null) {
        child.kill();
        await child.exited;
      }
      return { reason, remainingActors, usageUncertain: reason !== 'settled', stoppedMonotonicNs: '1' };
    },
    async collectArtifact(_h, dest) {
      calls.collect += 1;
      const bytes = readFileSync(join(solverCwd, 'answer.txt'));
      writeFileSync(dest, bytes);
      const ref = { kind: 'artifact', path: dest, sha256: sha256(bytes), bytes: bytes.byteLength };
      // Mutated after collection: the journaled digest no longer matches the bytes on disk.
      if (opts.tamper) writeFileSync(dest, 'solved\n');
      return ref;
    },
  };
  return { adapter, calls, childPid: (): number | undefined => (child as Subprocess | null)?.pid };
}

function capabilityReport(ctx: AdapterContext, status: 'proven' | 'unproven' = 'proven'): CapabilityReport {
  const capabilities: CapabilityReport['capabilities'] = {};
  for (const name of REQUIRED_CAPABILITIES) capabilities[name] = { status: 'proven', evidence: [] };
  if (status === 'unproven') capabilities.settledSignal = { status: 'unproven', evidence: [] };
  return {
    schemaVersion: 1,
    harness: 'omp',
    arm: ctx.attempt.arm,
    executable: { path: '/usr/bin/omp', build: null, sha256: 'b'.repeat(64) },
    launchMechanism: 'fake',
    discoveryRoots: [],
    resolved: { model: null, effort: null },
    artifactTransport: 'answer',
    capabilities,
    observedAt: WALL,
  };
}

function journal(): { state: string; entries: JournalEntry[] } {
  const read = readJournal(root, ATTEMPT);
  if (!read.ok) throw new Error(read.issues.join('\n'));
  return read.value;
}

const note = (entry: JournalEntry | undefined): Record<string, unknown> => JSON.parse(entry?.note ?? '{}');
const entryAt = (state: string): JournalEntry | undefined => journal().entries.find((e) => e.state === state);

/** Exactly one terminal entry with the expected disposition, and an unchanged denominator. */
function expectOneTerminal(disposition: Disposition): JournalEntry {
  const terminal = journal().entries.filter((e) => e.state === 'terminal-failure');
  expect(terminal.length).toBe(1);
  expect(terminal[0].disposition).toBe(disposition);
  const status = campaignStatus(root, EXPERIMENT);
  expect(status.ok && status.value.scheduled).toBe(1);
  return terminal[0];
}

/** Child processes of this test process (excluding the `ps` that lists them). */
function childPids(): number[] {
  const ps = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=']);
  return ps.stdout
    .toString()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => ppid === process.pid && pid !== ps.pid)
    .map(([pid]) => pid);
}

function isAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function captureStream(stream: NodeJS.WriteStream): { text: () => string; restore: () => void } {
  let out = '';
  const spy = spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  return { text: () => out, restore: () => spy.mockRestore() };
}

// ---------------------------------------------------------------------------
// Acceptance through the original verifier
// ---------------------------------------------------------------------------

describe('runAttempt', () => {
  test('accepted: the original verifier rewards 1 on the digest-bound collected artifact', async () => {
    const f = fixture();
    const clock = fakeClock();
    const fake = fakeAdapter({ clock });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
      clock,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state).toBe('verified');
    expect(result.value.disposition).toBe('accepted');
    expect(result.value.receipt?.reward).toBe(1);

    const read = journal();
    expect(read.state).toBe('verified');
    expect(read.entries.map((e) => e.state)).toEqual(['running', 'execution-stopped', 'verified']);
    expect(read.entries.every((e) => e.at === WALL)).toBe(true);

    // The verifier copy is bound to the journaled collected artifact by sha256.
    const collected = entryAt('execution-stopped')?.evidence[0];
    expect(collected?.sha256).toBe(sha256('solved'));
    expect(result.value.receipt?.artifact.sha256).toBe(collected?.sha256 as string);
    expect(note(entryAt('verified')).artifactBound).toBe(true);
    expect((note(entryAt('verified')).verifier as { reward: number }).reward).toBe(1);
  });

  test('the adapter receives a SolverTask and exactly the digest-matched instruction bytes', async () => {
    const f = fixture();
    const fake = fakeAdapter();
    await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(fake.calls.launch.length).toBe(1);
    const { ctx, prompt } = fake.calls.launch[0];
    expect(prompt).toBe(INSTRUCTION);
    expect(sha256(prompt)).toBe(f.task.instruction.sha256);
    for (const key of ['verifier', 'verifierDigest', 'referenceSolution'])
      expect(Object.hasOwn(ctx.task, key)).toBe(false);
    const serialized = JSON.stringify(ctx);
    expect(serialized).not.toContain('verify.sh');
    expect(serialized).not.toContain('reward.txt');
    expect(serialized).not.toContain('binary-one');
  });

  test('setup, execution and verification elapsed come from the injected clock as separate values', async () => {
    const f = fixture();
    const clock = fakeClock();
    const fake = fakeAdapter({ clock });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
      clock,
    });
    expect(result.ok).toBe(true);
    const setup = BigInt(note(entryAt('running')).setupElapsedNs as string);
    const execution = BigInt(note(entryAt('execution-stopped')).executionElapsedNs as string);
    const verification = BigInt(note(entryAt('verified')).verificationElapsedNs as string);
    // Only the fake adapter's settled() moves the clock by 60s, so only execution carries it.
    expect(execution >= 60n * SECOND && execution < 61n * SECOND).toBe(true);
    expect(setup > 0n && setup < SECOND).toBe(true);
    expect(verification > 0n && verification < SECOND).toBe(true);
    const v = note(entryAt('verified')).verifier as { startedMonotonicNs: string; endedMonotonicNs: string };
    expect(verification >= BigInt(v.endedMonotonicNs) - BigInt(v.startedMonotonicNs)).toBe(true);
    // No wall clock reads time in the supervisor.
    const source = readFileSync(RUN_TS, 'utf8');
    expect(source).not.toContain('Date.now');
    expect(source).not.toContain('performance.now');
  });

  test('the verifier runs outside the solver workspace and native home, seeing only the artifact', async () => {
    const f = fixture();
    const fake = fakeAdapter();
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('accepted');
    const { ctx } = fake.calls.launch[0];
    const solverCwd = ctx.solver.cwd;
    const output = readFileSync(result.ok ? (result.value.receipt?.output.path as string) : '', 'utf8');
    const cwd = output.split('\n')[0].replace(/^cwd=/, '');
    expect(cwd.startsWith(solverCwd)).toBe(false);
    expect(cwd.startsWith(ctx.nativeHome)).toBe(false);
    expect(output).not.toContain(solverCwd);
    expect(output).not.toContain('solver-only.txt');
    expect(output).toContain('./answer.txt');
  });

  test('a verifier rejection is terminal-failure/rejected', async () => {
    const f = fixture();
    const fake = fakeAdapter({ answer: 'wrong' });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.receipt?.reward).toBe(0);
    expectOneTerminal('rejected');
    expect(entryAt('verified')).toBeUndefined();
  });

  test('verifier exit 0 without a binary reward never accepts', async () => {
    const f = fixture({ verifierMode: 'no-reward' });
    const fake = fakeAdapter();
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.receipt?.exitCode).toBe(0);
    expect(result.value.receipt?.reward).toBeNull();
    expect(result.value.disposition).toBe('rejected');
    expectOneTerminal('rejected');
  });

  test('an artifact mutated after collection fails the digest binding: infra-failure, no acceptance', async () => {
    const f = fixture();
    const fake = fakeAdapter({ tamper: true });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.receipt).toBeNull();
    const terminal = expectOneTerminal('infra-failure');
    expect(JSON.stringify(note(terminal))).toContain('sha256 mismatch');
    expect(entryAt('verified')).toBeUndefined();
  });

  test('timeout: stop(timeout) records remaining actors and usageUncertain; nothing is left running', async () => {
    const f = fixture({ timeLimitSec: 0.2 });
    const fake = fakeAdapter({ settle: 'hang' });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('timeout');
    expect(fake.calls.stop).toEqual(['timeout']);
    expect(fake.calls.collect).toBe(0);
    const terminal = expectOneTerminal('timeout');
    const stop = note(terminal).stop as { remainingActors: string[]; usageUncertain: boolean };
    expect(stop.remainingActors).toEqual(['lead']);
    expect(stop.usageUncertain).toBe(true);
    expect(isAlive(fake.childPid())).toBe(false);
    expect(childPids()).toEqual([]);
  });

  test('a settled result with pending actors is not completion', async () => {
    const f = fixture({ timeLimitSec: 0.3 });
    const fake = fakeAdapter({ settle: 'pending' });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('timeout');
    expect(fake.calls.settled).toBeGreaterThan(1);
    expect(fake.calls.collect).toBe(0);
    expectOneTerminal('timeout');
    expect(childPids()).toEqual([]);
  });

  test('a crashed adapter is terminal-failure/infra-failure after stop(interrupt)', async () => {
    const f = fixture();
    const fake = fakeAdapter({ settle: 'throw' });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('infra-failure');
    expect(fake.calls.stop).toEqual(['interrupt']);
    const terminal = expectOneTerminal('infra-failure');
    expect(JSON.stringify(note(terminal))).toContain('adapter crashed');
    expect(isAlive(fake.childPid())).toBe(false);
    expect(childPids()).toEqual([]);
  });

  test('a launch failure is registered -> terminal-failure/setup-failure and the clone is removed', async () => {
    const f = fixture();
    const fake = fakeAdapter({ launchThrows: true });
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('setup-failure');
    expect(journal().entries.map((e) => e.state)).toEqual(['terminal-failure']);
    expectOneTerminal('setup-failure');
    expect(existsSync(join(root, 'environments', ATTEMPT, 'solver'))).toBe(false);
    expect(childPids()).toEqual([]);
  });

  test('an instruction digest mismatch is setup-failure before launch', async () => {
    const f = fixture({ badDigest: true });
    const fake = fakeAdapter();
    const result = await runAttempt(root, ATTEMPT, {
      adapter: fake.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(result.ok && result.value.disposition).toBe('setup-failure');
    expect(fake.calls.launch.length).toBe(0);
    expect(journal().entries.map((e) => e.state)).toEqual(['terminal-failure']);
    const terminal = expectOneTerminal('setup-failure');
    expect(JSON.stringify(note(terminal))).toContain('sha256 mismatch');
    expect(existsSync(join(root, 'environments', ATTEMPT))).toBe(false);
  });

  test('an attempt past registered is refused and never relaunched', async () => {
    const f = fixture();
    const first = fakeAdapter();
    await runAttempt(root, ATTEMPT, {
      adapter: first.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    const second = fakeAdapter();
    const again = await runAttempt(root, ATTEMPT, {
      adapter: second.adapter,
      manifest: f.manifest,
      config: f.config,
      sourcesDir: sources,
    });
    expect(again.ok).toBe(false);
    expect(second.calls.launch.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

describe('runPreflight', () => {
  function preflightCtx(f: Fixture): AdapterContext {
    const workspace = join(tmp, 'workspace');
    mkdirSync(workspace);
    return {
      root,
      attempt: { ...f.identity, attemptId: 'preflight-1' },
      config: f.config,
      task: {
        source: f.task.source,
        sourceRevision: f.task.sourceRevision,
        taskId: f.task.taskId,
        category: f.task.category,
        cluster: f.task.cluster,
        artifactTransport: f.task.artifactTransport,
        instruction: f.task.instruction,
        environment: f.task.environment,
        timeLimitSec: f.task.timeLimitSec,
      },
      solver: { kind: 'host', cwd: workspace },
      nativeHome: join(tmp, 'native-home'),
    };
  }

  test('all required capabilities proven: the report is stored under <root>/preflight/', async () => {
    const f = fixture();
    const fake = fakeAdapter();
    const result = await runPreflight(root, fake.adapter, preflightCtx(f));
    expect(result.ok).toBe(true);
    const stored = JSON.parse(readFileSync(join(root, 'preflight', 'preflight-1.json'), 'utf8'));
    expect(parseCapabilityReport(stored).ok).toBe(true);
  });

  test('an unproven capability fails preflight; the report is still stored', async () => {
    const f = fixture();
    const fake = fakeAdapter({ report: (ctx) => capabilityReport(ctx, 'unproven') });
    const result = await runPreflight(root, fake.adapter, preflightCtx(f));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join('\n')).toContain('capability settledSignal is unproven');
    expect(existsSync(join(root, 'preflight', 'preflight-1.json'))).toBe(true);
  });

  test('an unsupported capability fails preflight', async () => {
    const f = fixture();
    const fake = fakeAdapter({
      report: (ctx) => {
        const report = capabilityReport(ctx);
        report.capabilities.requestUsage = { status: 'unsupported', evidence: [], upstreamRequirement: 'usage export' };
        return report;
      },
    });
    const result = await runPreflight(root, fake.adapter, preflightCtx(f));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join('\n')).toContain('capability requestUsage is unsupported');
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('runCli', () => {
  test('a harness absent from the injected map exits 2 "unsupported harness" with no fallback', async () => {
    const f = fixture();
    const err = captureStream(process.stderr);
    let code: number;
    try {
      code = await runCli(
        [
          'attempt',
          '--root',
          root,
          '--attempt',
          ATTEMPT,
          '--manifest',
          f.manifestPath,
          '--config',
          f.configPath,
          '--sources',
          sources,
        ],
        {},
      );
    } finally {
      err.restore();
    }
    expect(code).toBe(2);
    expect(err.text()).toContain('unsupported harness');
    expect(journal().entries).toEqual([]);
    expect(existsSync(join(root, 'environments'))).toBe(false);
  });

  test('usage refusals exit 2 before any side effect', async () => {
    const f = fixture();
    const fake = fakeAdapter();
    const fresh = join(tmp, 'fresh-root');
    const err = captureStream(process.stderr);
    const codes: number[] = [];
    try {
      codes.push(await runCli([], { omp: fake.adapter }));
      codes.push(await runCli(['launch'], { omp: fake.adapter }));
      codes.push(
        await runCli(
          [
            'attempt',
            '--attempt',
            ATTEMPT,
            '--manifest',
            f.manifestPath,
            '--config',
            f.configPath,
            '--sources',
            sources,
          ],
          { omp: fake.adapter },
        ),
      );
      codes.push(
        await runCli(
          [
            'attempt',
            '--root',
            fresh,
            '--attempt',
            ATTEMPT,
            '--manifest',
            f.manifestPath,
            '--config',
            f.configPath,
            '--sources',
            sources,
            '--bogus',
            'x',
          ],
          { omp: fake.adapter },
        ),
      );
      codes.push(await runCli(['recover', '--root', fresh, '--attempt'], { omp: fake.adapter }));
      codes.push(await runCli(['status', '--experiment', EXPERIMENT], { omp: fake.adapter }));
      codes.push(
        await runCli(['preflight', '--root', fresh, '--adapter', 'omp', '--config', f.configPath, '--arm', 'neither'], {
          omp: fake.adapter,
        }),
      );
    } finally {
      err.restore();
    }
    expect(codes).toEqual([2, 2, 2, 2, 2, 2, 2]);
    expect(existsSync(fresh)).toBe(false);
    expect(fake.calls.launch.length + fake.calls.preflight).toBe(0);
    expect(journal().entries).toEqual([]);
  });

  test('attempt and status run through the injected map', async () => {
    const f = fixture();
    const fake = fakeAdapter();
    const out = captureStream(process.stdout);
    let attemptCode: number;
    let statusCode: number;
    try {
      attemptCode = await runCli(
        [
          'attempt',
          '--root',
          root,
          '--attempt',
          ATTEMPT,
          '--manifest',
          f.manifestPath,
          '--config',
          f.configPath,
          '--sources',
          sources,
        ],
        { omp: fake.adapter },
      );
      statusCode = await runCli(['status', '--root', root, '--experiment', EXPERIMENT, '--json'], {
        omp: fake.adapter,
      });
    } finally {
      out.restore();
    }
    expect(attemptCode).toBe(0);
    expect(statusCode).toBe(0);
    const status = JSON.parse(out.text().slice(out.text().indexOf('{')));
    expect(status.scheduled).toBe(1);
    expect(status.byDisposition.accepted).toBe(1);
  });

  test('recover after a killed run records terminal-failure/interrupted and never relaunches', async () => {
    const f = fixture();
    const script = join(tmp, 'killed-run.ts');
    writeFileSync(
      script,
      [
        `import { readFileSync } from 'node:fs';`,
        `import { runAttempt } from ${JSON.stringify(RUN_TS)};`,
        'const [root, attemptId, manifestPath, configPath, sources] = process.argv.slice(2);',
        'setInterval(() => {}, 1000);',
        'const adapter = {',
        `  harness: 'omp',`,
        '  preflight: async () => { throw new Error("unused"); },',
        `  launch: async () => ({ attemptId, session: 'killed', startedMonotonicNs: '0' }),`,
        '  settled: () => new Promise(() => {}),',
        `  stop: async (_h, reason) => ({ reason, remainingActors: [], usageUncertain: true, stoppedMonotonicNs: '0' }),`,
        '  collectArtifact: async () => { throw new Error("unused"); },',
        '};',
        'await runAttempt(root, attemptId, {',
        `  adapter, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')),`,
        `  config: JSON.parse(readFileSync(configPath, 'utf8')), sourcesDir: sources,`,
        '});',
        '',
      ].join('\n'),
    );
    const proc = Bun.spawn(['bun', script, root, ATTEMPT, f.manifestPath, f.configPath, sources], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
    });
    for (let i = 0; i < 400 && journal().state !== 'running'; i++) await Bun.sleep(50);
    expect(journal().state).toBe('running');
    proc.kill('SIGKILL');
    await proc.exited;

    const recoverFake = fakeAdapter();
    const err = captureStream(process.stderr);
    const out = captureStream(process.stdout);
    let staleCode: number;
    let code: number;
    try {
      // The dead supervisor's lock is reported, never stolen.
      staleCode = await runCli(['recover', '--root', root, '--attempt', ATTEMPT], { omp: recoverFake.adapter });
      rmSync(join(root, 'supervisor.lock'));
      code = await runCli(['recover', '--root', root, '--attempt', ATTEMPT], { omp: recoverFake.adapter });
    } finally {
      err.restore();
      out.restore();
    }
    expect(staleCode).toBe(2);
    expect(err.text()).toContain('STALE');
    expect(code).toBe(0);
    expect(journal().entries.map((e) => e.state)).toEqual(['running', 'terminal-failure']);
    expectOneTerminal('interrupted');
    expect(recoverFake.calls.launch.length).toBe(0);
  }, 30_000);
});
