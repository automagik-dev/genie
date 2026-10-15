/**
 * Genie Bench — finite attempt supervisor bound to the original verifier (wish genie-bench, Group 4).
 *
 * One `attempt` run drives one registered attempt through an injected `NativeAdapter`:
 *
 *   registered → running → execution-stopped → verified | terminal-failure
 *
 * and stops there; sealing the capture belongs to later groups. A failure before launch is
 * `registered → terminal-failure/setup-failure`. Every journal mutation goes through the G2
 * ledger (`acquireSupervisor`, `appendTransition`); this file writes no journal bytes and never
 * touches a campaign schedule.
 *
 * Isolation: the adapter receives a `SolverTask` (no verifier, verifier digest or reference
 * solution) and the original instruction bytes read through G9 `readInstruction`. This file never
 * runs a verifier and never edits `task.verifier.command`: acceptance comes only from G9
 * `provisionVerifierCopy` followed by G9 `runSourceVerifier` on the collected artifact, whose
 * sha256 binds the copy to the journaled evidence.
 *
 * Time: setup, execution and verification elapsed are read from the injected `MonotonicClock`
 * and journaled as separate values; wall time appears only as each entry's `at`.
 *
 * CLI (exit 0 ok, 1 not ok, 2 refusal before any side effect):
 *   bun scripts/bench/run.ts preflight --root <dir> --adapter <harness> --config <file> --arm <arm>
 *                                     [--manifest <file> --sources <dir> --task <key>]
 *   bun scripts/bench/run.ts attempt --root <dir> --attempt <id> --manifest <file> --config <file> --sources <dir>
 *   bun scripts/bench/run.ts recover --root <dir> --attempt <id>
 *   bun scripts/bench/run.ts status --root <dir> --experiment <id> [--json]
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type AdapterContext,
  type AdapterMap,
  type ArmId,
  type AttemptIdentity,
  type AttemptState,
  type CapabilityReport,
  type Disposition,
  type EvidenceRef,
  type HarnessConfiguration,
  type LaunchHandle,
  type MonotonicClock,
  type NativeAdapter,
  REQUIRED_CAPABILITIES,
  type Result,
  type SettledResult,
  type SolverTask,
  type StopReceipt,
  type TaskIdentity,
  type TaskManifest,
  hostClock,
  parseCapabilityReport,
  parseConfiguration,
  parseManifest,
  taskKey,
} from './contracts';
import {
  type ProvisionedEnvironment,
  type VerifierCopy,
  type VerifierReceipt,
  provisionEnvironment,
  provisionVerifierCopy,
  readInstruction,
  runSourceVerifier,
  teardownEnvironment,
} from './environment';
import {
  type JournalEntry,
  acquireSupervisor,
  appendTransition,
  campaignStatus,
  planRecovery,
  readJournal,
} from './ledger';

export interface AttemptOutcome {
  state: AttemptState;
  disposition: Disposition;
  receipt: VerifierReceipt | null;
}

export interface AttemptDeps {
  adapter: NativeAdapter;
  manifest: TaskManifest;
  config: HarnessConfiguration;
  sourcesDir: string;
  clock?: MonotonicClock;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const fail = <T>(...issues: string[]): Result<T> => ({ ok: false, issues });
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const elapsed = (from: bigint, to: bigint): string => (to - from).toString();

function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/** The solver's view of a task, built field by field so no verifier key can ride along. */
function solverTaskOf(task: TaskIdentity): SolverTask {
  return {
    source: task.source,
    sourceRevision: task.sourceRevision,
    taskId: task.taskId,
    category: task.category,
    cluster: task.cluster,
    artifactTransport: task.artifactTransport,
    instruction: { path: task.instruction.path, sha256: task.instruction.sha256 },
    environment: task.environment,
    timeLimitSec: task.timeLimitSec,
  };
}

const findTask = (manifest: TaskManifest, key: string): TaskIdentity | undefined =>
  [...manifest.selected, ...manifest.smoke].find((t) => taskKey(t) === key);

// ---------------------------------------------------------------------------
// Journal writes (through the G2 ledger only)
// ---------------------------------------------------------------------------

interface Journal {
  root: string;
  attemptId: string;
  clock: MonotonicClock;
}

function record(
  j: Journal,
  to: AttemptState,
  fields: { disposition?: Disposition; evidence?: EvidenceRef[]; note: Record<string, unknown> },
): Result<JournalEntry> {
  return appendTransition(j.root, j.attemptId, to, {
    at: j.clock.wall(),
    monotonicNs: j.clock.nowNs().toString(),
    ...(fields.disposition !== undefined ? { disposition: fields.disposition } : {}),
    evidence: fields.evidence ?? [],
    note: JSON.stringify(fields.note),
  });
}

function finish(
  j: Journal,
  to: 'verified' | 'terminal-failure',
  disposition: Disposition,
  receipt: VerifierReceipt | null,
  fields: { evidence?: EvidenceRef[]; note: Record<string, unknown> },
): Result<AttemptOutcome> {
  const entry = record(j, to, { disposition, ...fields });
  return entry.ok ? { ok: true, value: { state: to, disposition, receipt } } : entry;
}

// ---------------------------------------------------------------------------
// Execution: waiting for the native settled signal, stopping, collecting
// ---------------------------------------------------------------------------

type Wait =
  | { kind: 'settled'; result: SettledResult; polls: number }
  | { kind: 'timeout'; last: SettledResult | null; polls: number }
  | { kind: 'error'; error: string; polls: number };

/** Yields one macrotask so a deadline timer can fire between two settled polls. */
const yieldTurn = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

/**
 * Waits for a settled result with no pending actor. A settled result that still names pending
 * actors is not completion. The source's own time limit (null: none declared) aborts the wait.
 */
async function awaitCompletion(
  adapter: NativeAdapter,
  handle: LaunchHandle,
  timeLimitSec: number | null,
): Promise<Wait> {
  const controller = new AbortController();
  const aborted = new Promise<'aborted'>((done) => {
    controller.signal.addEventListener('abort', () => done('aborted'), { once: true });
  });
  const timer = timeLimitSec === null ? null : setTimeout(() => controller.abort(), timeLimitSec * 1000);
  let last: SettledResult | null = null;
  let polls = 0;
  try {
    while (!controller.signal.aborted) {
      polls += 1;
      let next: SettledResult | 'aborted';
      try {
        next = await Promise.race([adapter.settled(handle, controller.signal), aborted]);
      } catch (e) {
        return { kind: 'error', error: `settled threw: ${message(e)}`, polls };
      }
      if (next === 'aborted') break;
      last = next;
      if (next.settled && next.pendingActors.length === 0) return { kind: 'settled', result: next, polls };
      await yieldTurn();
    }
    return { kind: 'timeout', last, polls };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function stopAdapter(
  adapter: NativeAdapter,
  handle: LaunchHandle,
  reason: 'settled' | 'timeout' | 'interrupt',
): Promise<Result<StopReceipt>> {
  try {
    return { ok: true, value: await adapter.stop(handle, reason) };
  } catch (e) {
    return fail(`stop(${reason}) threw: ${message(e)}`);
  }
}

const stopNote = (stop: Result<StopReceipt>): Record<string, unknown> =>
  stop.ok
    ? {
        reason: stop.value.reason,
        remainingActors: stop.value.remainingActors,
        usageUncertain: stop.value.usageUncertain,
        stoppedMonotonicNs: stop.value.stoppedMonotonicNs,
      }
    : { error: stop.issues };

// ---------------------------------------------------------------------------
// Verification (G9 only)
// ---------------------------------------------------------------------------

/**
 * Removes a verifier copy (and tears down its fresh source container) through G9
 * `teardownEnvironment`, from a disposal plan recorded beside the copy.
 */
async function disposeVerifierCopy(
  attemptId: string,
  copy: VerifierCopy,
  task: TaskIdentity,
  sourcesDir: string,
): Promise<string[]> {
  const plan = {
    removeDir: copy.cwd,
    teardown: copy.containerId === null ? null : task.environment.teardown,
    teardownCwd: resolve(sourcesDir),
  };
  const path = `${copy.cwd}.dispose.json`;
  try {
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`, { mode: FILE_MODE });
  } catch (e) {
    return [`cannot record the verifier copy disposal plan: ${message(e)}`];
  }
  const bytes = readFileSync(path);
  const env: ProvisionedEnvironment = {
    attemptId,
    solver:
      copy.containerId === null
        ? { kind: 'host', cwd: copy.cwd }
        : { kind: 'container', containerId: copy.containerId, cwd: copy.cwd },
    artifactPath: copy.artifact.path,
    image: null,
    resources: null,
    evidence: [{ kind: 'environment-plan', path, sha256: sha256Of(bytes), bytes: bytes.byteLength }],
  };
  const down = await teardownEnvironment(env);
  return down.ok ? [] : down.issues;
}

async function verifyCollected(
  j: Journal,
  task: TaskIdentity,
  sourcesDir: string,
  collected: EvidenceRef,
  priorIssues: string[],
): Promise<Result<AttemptOutcome>> {
  const started = j.clock.nowNs();
  const copy = await provisionVerifierCopy(j.root, j.attemptId, task, sourcesDir, collected);
  if (!copy.ok) {
    return finish(j, 'terminal-failure', 'infra-failure', null, {
      note: {
        stage: 'verifier-copy',
        issues: [...priorIssues, ...copy.issues],
        verificationElapsedNs: elapsed(started, j.clock.nowNs()),
      },
    });
  }
  let receipt: Result<VerifierReceipt>;
  try {
    receipt = await runSourceVerifier(task, copy.value, collected, j.clock);
  } catch (e) {
    receipt = fail(`runSourceVerifier threw: ${message(e)}`);
  }
  const disposeIssues = await disposeVerifierCopy(j.attemptId, copy.value, task, sourcesDir);
  const verificationElapsedNs = elapsed(started, j.clock.nowNs());
  const issues = [...priorIssues, ...disposeIssues];
  if (!receipt.ok) {
    return finish(j, 'terminal-failure', 'infra-failure', null, {
      note: { stage: 'verifier', issues: [...issues, ...receipt.issues], verificationElapsedNs },
    });
  }
  const r = receipt.value;
  // The verifier's own acceptance, on the copy whose sha256 is the journaled collected artifact.
  const bound = r.artifact.sha256 === collected.sha256;
  const accepted = r.accepted && bound;
  const note = {
    stage: 'verifier',
    verificationElapsedNs,
    verifier: {
      exitCode: r.exitCode,
      reward: r.reward,
      accepted: r.accepted,
      startedMonotonicNs: r.startedMonotonicNs,
      endedMonotonicNs: r.endedMonotonicNs,
    },
    artifactBound: bound,
    issues,
  };
  const evidence = [r.artifact, r.output];
  if (!bound) return finish(j, 'terminal-failure', 'infra-failure', null, { evidence, note });
  return accepted
    ? finish(j, 'verified', 'accepted', r, { evidence, note })
    : finish(j, 'terminal-failure', 'rejected', r, { evidence, note });
}

// ---------------------------------------------------------------------------
// runAttempt
// ---------------------------------------------------------------------------

function admissionIssues(identity: AttemptIdentity, deps: AttemptDeps): string[] {
  const issues: string[] = [];
  if (identity.manifestId !== deps.manifest.manifestId) {
    issues.push(`attempt manifest '${identity.manifestId}' is not manifest '${deps.manifest.manifestId}'`);
  }
  if (identity.configId !== deps.config.configId) {
    issues.push(`attempt configuration '${identity.configId}' is not configuration '${deps.config.configId}'`);
  }
  if (deps.adapter.harness !== deps.config.harness) {
    issues.push(`adapter harness '${deps.adapter.harness}' is not the configured '${deps.config.harness}'`);
  }
  if (findTask(deps.manifest, identity.taskKey) === undefined) {
    issues.push(`task '${identity.taskKey}' is not in manifest '${deps.manifest.manifestId}'`);
  }
  return issues.map((i) => `refused: ${i}`);
}

/** The instruction decodes to exactly the digest-matched bytes, or the prompt would differ from the file. */
function promptIssue(text: string, task: TaskIdentity): string | null {
  const digest = sha256Of(new TextEncoder().encode(text));
  return digest === task.instruction.sha256
    ? null
    : `the decoded instruction re-encodes to ${digest}, not the declared ${task.instruction.sha256}`;
}

interface Setup {
  j: Journal;
  started: bigint;
  env: ProvisionedEnvironment | null;
}

async function teardownOnce(setup: Setup): Promise<string[]> {
  const env = setup.env;
  if (env === null) return [];
  setup.env = null;
  const down = await teardownEnvironment(env);
  return down.ok ? [] : down.issues.map((i) => `teardown: ${i}`);
}

/** registered → terminal-failure/setup-failure: nothing ran, so nothing is relaunched. */
async function failSetup(setup: Setup, reasons: string[], evidence: EvidenceRef[]): Promise<Result<AttemptOutcome>> {
  const teardown = await teardownOnce(setup);
  return finish(setup.j, 'terminal-failure', 'setup-failure', null, {
    evidence,
    note: {
      stage: 'setup',
      issues: [...reasons, ...teardown],
      setupElapsedNs: elapsed(setup.started, setup.j.clock.nowNs()),
    },
  });
}

async function superviseAttempt(
  root: string,
  attemptId: string,
  deps: AttemptDeps,
  clock: MonotonicClock,
): Promise<Result<AttemptOutcome>> {
  const read = readJournal(root, attemptId);
  if (!read.ok) return read;
  const { identity, state } = read.value;
  if (state !== 'registered') {
    return fail(`refused: attempt '${attemptId}' is ${state}, not registered; an attempt is never relaunched`);
  }
  const refusals = admissionIssues(identity, deps);
  if (refusals.length > 0) return fail(...refusals);
  const task = findTask(deps.manifest, identity.taskKey) as TaskIdentity;
  const { adapter, sourcesDir } = deps;
  const setup: Setup = { j: { root, attemptId, clock }, started: clock.nowNs(), env: null };
  const j = setup.j;

  // Setup: the instruction digest gates everything, including provisioning and launch.
  const instruction = readInstruction(task, sourcesDir);
  if (!instruction.ok) return failSetup(setup, instruction.issues, []);
  const decoded = promptIssue(instruction.value.text, task);
  if (decoded !== null) return failSetup(setup, [decoded], [instruction.value.ref]);
  const provisioned = await provisionEnvironment(root, attemptId, task, sourcesDir);
  if (!provisioned.ok) return failSetup(setup, provisioned.issues, [instruction.value.ref]);
  setup.env = provisioned.value;
  const setupEvidence = [instruction.value.ref, ...provisioned.value.evidence];

  try {
    const ctx: AdapterContext = {
      root,
      attempt: identity,
      config: deps.config,
      task: solverTaskOf(task),
      solver: provisioned.value.solver,
      nativeHome: ensureDir(join(resolve(root), 'native', attemptId)),
    };
    const executionStarted = clock.nowNs();
    const setupElapsedNs = elapsed(setup.started, executionStarted);
    let handle: LaunchHandle;
    try {
      handle = await adapter.launch(ctx, instruction.value.text);
    } catch (e) {
      return failSetup(setup, [`launch failed: ${message(e)}`], setupEvidence);
    }
    const running = record(j, 'running', {
      evidence: setupEvidence,
      note: { setupElapsedNs, session: handle.session, adapterStartedMonotonicNs: handle.startedMonotonicNs },
    });
    if (!running.ok) {
      await stopAdapter(adapter, handle, 'interrupt');
      return running;
    }

    // Execution: the native settled signal, bounded by the source's own time limit.
    const wait = await awaitCompletion(adapter, handle, task.timeLimitSec);
    const stop = await stopAdapter(
      adapter,
      handle,
      wait.kind === 'settled' ? 'settled' : wait.kind === 'timeout' ? 'timeout' : 'interrupt',
    );
    const executionElapsedNs = elapsed(executionStarted, clock.nowNs());
    const waitNote =
      wait.kind === 'settled'
        ? { kind: wait.kind, polls: wait.polls, settled: wait.result }
        : wait.kind === 'timeout'
          ? { kind: wait.kind, polls: wait.polls, lastSettled: wait.last, timeLimitSec: task.timeLimitSec }
          : { kind: wait.kind, polls: wait.polls, error: wait.error };
    if (wait.kind !== 'settled' || !stop.ok) {
      const teardown = await teardownOnce(setup);
      return finish(j, 'terminal-failure', wait.kind === 'timeout' ? 'timeout' : 'infra-failure', null, {
        note: { stage: 'execution', executionElapsedNs, wait: waitNote, stop: stopNote(stop), issues: teardown },
      });
    }

    let collected: EvidenceRef;
    try {
      collected = await adapter.collectArtifact(
        handle,
        join(ensureDir(join(resolve(root), 'artifacts', attemptId)), 'artifact'),
      );
    } catch (e) {
      const teardown = await teardownOnce(setup);
      return finish(j, 'terminal-failure', 'infra-failure', null, {
        note: {
          stage: 'collect',
          executionElapsedNs,
          wait: waitNote,
          stop: stopNote(stop),
          issues: [`collectArtifact threw: ${message(e)}`, ...teardown],
        },
      });
    }
    const stopped = record(j, 'execution-stopped', {
      evidence: [collected],
      note: { executionElapsedNs, wait: waitNote, stop: stopNote(stop) },
    });
    if (!stopped.ok) return stopped;

    // The solver environment is gone before a verifier copy exists.
    const teardown = await teardownOnce(setup);
    return await verifyCollected(j, task, sourcesDir, collected, teardown);
  } finally {
    await teardownOnce(setup);
  }
}

/**
 * Runs one registered attempt end to end under the supervisor lock. A refusal (lock held, attempt
 * unregistered or past `registered`, identity not matching the manifest/config) writes nothing.
 * Every failure after admission ends in exactly one terminal journal entry.
 */
export async function runAttempt(root: string, attemptId: string, deps: AttemptDeps): Promise<Result<AttemptOutcome>> {
  const lock = acquireSupervisor(root);
  if (!lock.ok) return lock;
  try {
    return await superviseAttempt(root, attemptId, deps, deps.clock ?? hostClock);
  } finally {
    lock.value.release();
  }
}

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

/**
 * Asks the adapter for its capability report, stores it under `<root>/preflight/`, and fails
 * when any REQUIRED_CAPABILITIES entry is not `proven`.
 */
export async function runPreflight(
  root: string,
  adapter: NativeAdapter,
  ctx: AdapterContext,
): Promise<Result<CapabilityReport>> {
  if (!SAFE_SEGMENT.test(ctx.attempt.attemptId)) {
    return fail(`refused: preflight id '${ctx.attempt.attemptId}' is not a safe path segment`);
  }
  if (adapter.harness !== ctx.config.harness) {
    return fail(`refused: adapter harness '${adapter.harness}' is not the configured '${ctx.config.harness}'`);
  }
  let raw: unknown;
  try {
    raw = await adapter.preflight(ctx);
  } catch (e) {
    return fail(`preflight threw: ${message(e)}`);
  }
  const parsed = parseCapabilityReport(raw);
  if (!parsed.ok) return fail(...parsed.issues.map((i) => `capability report: ${i}`));
  const report = parsed.value;

  const path = join(ensureDir(join(resolve(root), 'preflight')), `${ctx.attempt.attemptId}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });

  const issues: string[] = [];
  if (report.harness !== adapter.harness) issues.push(`report harness '${report.harness}' is not '${adapter.harness}'`);
  if (report.arm !== ctx.attempt.arm) issues.push(`report arm '${report.arm}' is not '${ctx.attempt.arm}'`);
  for (const name of REQUIRED_CAPABILITIES) {
    const entry = report.capabilities[name];
    if (entry === undefined) issues.push(`capability ${name} is not reported`);
    else if (entry.status !== 'proven') {
      const upstream = entry.upstreamRequirement === undefined ? '' : ` (upstream: ${entry.upstreamRequirement})`;
      issues.push(`capability ${name} is ${entry.status}${upstream}`);
    }
  }
  return issues.length > 0 ? fail(...issues.map((i) => `preflight ${path}: ${i}`)) : { ok: true, value: report };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  'usage: bun scripts/bench/run.ts preflight --root <dir> --adapter <harness> --config <file> --arm <arm>',
  '                                [--manifest <file> --sources <dir> --task <key>]',
  '       bun scripts/bench/run.ts attempt --root <dir> --attempt <id> --manifest <file> --config <file> --sources <dir>',
  '       bun scripts/bench/run.ts recover --root <dir> --attempt <id>',
  '       bun scripts/bench/run.ts status --root <dir> --experiment <id> [--json]',
  '',
].join('\n');

interface FlagSpec {
  required: readonly string[];
  optional?: readonly string[];
  booleans?: readonly string[];
}

type Flags = { values: Record<string, string>; switches: Set<string> };

function parseFlags(argv: readonly string[], spec: FlagSpec): Result<Flags> {
  const valued = new Set([...spec.required, ...(spec.optional ?? [])]);
  const booleans = new Set(spec.booleans ?? []);
  const values: Record<string, string> = {};
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (booleans.has(flag)) {
      if (switches.has(flag)) return fail(`${flag} given twice`);
      switches.add(flag);
      continue;
    }
    if (!valued.has(flag)) return fail(`unknown argument ${flag}`);
    if (Object.hasOwn(values, flag)) return fail(`${flag} given twice`);
    const value = argv[i + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) return fail(`${flag} needs a value`);
    values[flag] = value;
    i += 1;
  }
  const missing = spec.required.filter((f) => !Object.hasOwn(values, f));
  if (missing.length > 0) return fail(`missing ${missing.join(', ')}`);
  return { ok: true, value: { values, switches } };
}

/** Exit 2: a refusal that cost nothing. Usage errors also print the usage text. */
function refuseCli(issues: string[], usage = true): number {
  process.stderr.write(`${issues.map((i) => `run: ${i}`).join('\n')}\n${usage ? USAGE : ''}`);
  return 2;
}

function readJsonFile(path: string, what: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (e) {
    return fail(`cannot read ${what} ${path}: ${message(e)}`);
  }
}

function loadConfig(path: string): Result<HarnessConfiguration> {
  const raw = readJsonFile(path, 'configuration');
  if (!raw.ok) return raw;
  const parsed = parseConfiguration(raw.value);
  return parsed.ok ? parsed : fail(...parsed.issues.map((i) => `configuration: ${i}`));
}

function loadManifest(path: string): Result<TaskManifest> {
  const raw = readJsonFile(path, 'manifest');
  if (!raw.ok) return raw;
  const parsed = parseManifest(raw.value);
  return parsed.ok ? parsed : fail(...parsed.issues.map((i) => `manifest: ${i}`));
}

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

/** The injected map's own entry for `name`; never a default, never another harness. */
function adapterFor(adapters: AdapterMap, name: string): NativeAdapter | null {
  if (!Object.hasOwn(adapters, name)) return null;
  return adapters[name as keyof AdapterMap] ?? null;
}

const ARMS: readonly ArmId[] = ['zero-genie', 'genie'];

async function preflightCli(argv: readonly string[], adapters: AdapterMap): Promise<number> {
  const flags = parseFlags(argv, {
    required: ['--root', '--adapter', '--config', '--arm'],
    optional: ['--manifest', '--sources', '--task'],
  });
  if (!flags.ok) return refuseCli(flags.issues);
  const v = flags.value.values;
  const adapter = adapterFor(adapters, v['--adapter']);
  if (adapter === null) return refuseCli([`unsupported harness '${v['--adapter']}': no adapter is injected for it`]);
  if (!(ARMS as readonly string[]).includes(v['--arm'])) return refuseCli([`unknown arm '${v['--arm']}'`]);
  const config = loadConfig(v['--config']);
  if (!config.ok) return refuseCli(config.issues);
  if (config.value.harness !== v['--adapter']) {
    return refuseCli([`configuration harness '${config.value.harness}' is not --adapter '${v['--adapter']}'`]);
  }
  const taskFlags = ['--manifest', '--sources', '--task'].filter((f) => Object.hasOwn(v, f));
  if (taskFlags.length !== 0 && taskFlags.length !== 3) {
    return refuseCli(['--manifest, --sources and --task are given together or not at all']);
  }
  let manifest: TaskManifest | null = null;
  let task: TaskIdentity | null = null;
  if (taskFlags.length === 3) {
    const loaded = loadManifest(v['--manifest']);
    if (!loaded.ok) return refuseCli(loaded.issues);
    manifest = loaded.value;
    task = findTask(manifest, v['--task']) ?? null;
    if (task === null) return refuseCli([`task '${v['--task']}' is not in the manifest`]);
    if (!isDirectory(v['--sources'])) return refuseCli([`sources directory ${v['--sources']} does not exist`]);
  }

  const root = v['--root'];
  const arm = v['--arm'] as ArmId;
  const preflightId = `preflight-${config.value.harness}-${arm}-${randomUUID()}`;
  const scratch = join(resolve(root), 'preflight', preflightId);
  let env: ProvisionedEnvironment | null = null;
  try {
    let solverTask: SolverTask;
    if (task !== null) {
      const provisioned = await provisionEnvironment(root, preflightId, task, v['--sources']);
      if (!provisioned.ok) {
        process.stderr.write(`${provisioned.issues.map((i) => `run: preflight: ${i}`).join('\n')}\n`);
        return 1;
      }
      env = provisioned.value;
      solverTask = solverTaskOf(task);
    } else {
      solverTask = probeTask(ensureDir(join(scratch, 'workspace')));
    }
    const ctx: AdapterContext = {
      root,
      attempt: {
        experimentId: 'preflight',
        pairId: 'preflight',
        manifestId: manifest?.manifestId ?? 'none',
        taskKey: task === null ? 'preflight-probe' : taskKey(task),
        configId: config.value.configId,
        arm,
        repeat: 0,
        attemptId: preflightId,
        scheduledIndex: 0,
        kind: 'smoke',
      },
      config: config.value,
      task: solverTask,
      solver: env?.solver ?? { kind: 'host', cwd: join(scratch, 'workspace') },
      nativeHome: ensureDir(join(scratch, 'native-home')),
    };
    const report = await runPreflight(root, adapter, ctx);
    if (!report.ok) {
      process.stderr.write(`${report.issues.map((i) => `run: ${i}`).join('\n')}\n`);
      return 1;
    }
    process.stdout.write(`${join(resolve(root), 'preflight', `${preflightId}.json`)}\n`);
    return 0;
  } finally {
    if (env !== null) {
      const down = await teardownEnvironment(env);
      if (!down.ok) process.stderr.write(`${down.issues.map((i) => `run: preflight teardown: ${i}`).join('\n')}\n`);
    }
  }
}

/**
 * The context a task-less preflight hands the adapter: an empty workspace and no source task.
 * `SolverTask` requires a source kind; the probe's other fields name it as a probe.
 */
function probeTask(workspace: string): SolverTask {
  return {
    source: 'terminal-bench',
    sourceRevision: 'preflight-probe',
    taskId: 'preflight-probe',
    category: 'preflight',
    cluster: 'preflight',
    artifactTransport: 'answer',
    instruction: { path: 'preflight-probe', sha256: sha256Of(new Uint8Array()) },
    environment: {
      kind: 'git-checkout',
      repository: null,
      image: null,
      provision: null,
      teardown: null,
      resources: null,
      solverPath: workspace,
      artifactPath: 'artifact',
    },
    timeLimitSec: null,
  };
}

async function attemptCli(argv: readonly string[], adapters: AdapterMap): Promise<number> {
  const flags = parseFlags(argv, { required: ['--root', '--attempt', '--manifest', '--config', '--sources'] });
  if (!flags.ok) return refuseCli(flags.issues);
  const v = flags.value.values;
  const config = loadConfig(v['--config']);
  if (!config.ok) return refuseCli(config.issues);
  const adapter = adapterFor(adapters, config.value.harness);
  if (adapter === null) {
    return refuseCli([`unsupported harness '${config.value.harness}': no adapter is injected for it`]);
  }
  const manifest = loadManifest(v['--manifest']);
  if (!manifest.ok) return refuseCli(manifest.issues);
  if (!isDirectory(v['--sources'])) return refuseCli([`sources directory ${v['--sources']} does not exist`]);

  const outcome = await runAttempt(v['--root'], v['--attempt'], {
    adapter,
    manifest: manifest.value,
    config: config.value,
    sourcesDir: v['--sources'],
  });
  if (!outcome.ok) return refuseCli(outcome.issues, false);
  const { state, disposition } = outcome.value;
  process.stdout.write(`${v['--attempt']}: ${state}/${disposition}\n`);
  return disposition === 'accepted' ? 0 : 1;
}

function recoverCli(argv: readonly string[]): number {
  const flags = parseFlags(argv, { required: ['--root', '--attempt'] });
  if (!flags.ok) return refuseCli(flags.issues);
  const { '--root': root, '--attempt': attemptId } = flags.value.values;
  const lock = acquireSupervisor(root);
  if (!lock.ok) return refuseCli(lock.issues, false);
  try {
    const read = readJournal(root, attemptId);
    if (!read.ok) return refuseCli(read.issues, false);
    for (const c of read.value.corrupt) {
      process.stderr.write(`run: journal line ${c.line} is not a good entry (${c.reason}); it was left in place\n`);
    }
    const action = planRecovery(read.value);
    if (action === 'record-interrupted') {
      const entry = record({ root, attemptId, clock: hostClock }, 'terminal-failure', {
        disposition: 'interrupted',
        note: {
          stage: 'recover',
          issues: ['the supervisor stopped while the solver ran; the solver was not relaunched'],
        },
      });
      if (!entry.ok) {
        process.stderr.write(`${entry.issues.map((i) => `run: ${i}`).join('\n')}\n`);
        return 1;
      }
      process.stdout.write(`${attemptId}: running -> terminal-failure/interrupted\n`);
      return 0;
    }
    if (action === 'verify-collected-artifact') {
      process.stderr.write(
        `run: ${attemptId} is execution-stopped with a collected artifact awaiting the original verifier; recover records nothing for it\n`,
      );
      return 1;
    }
    process.stdout.write(`${attemptId}: ${read.value.state}; nothing to recover (${action})\n`);
    return 0;
  } finally {
    lock.value.release();
  }
}

function statusCli(argv: readonly string[]): number {
  const flags = parseFlags(argv, { required: ['--root', '--experiment'], booleans: ['--json'] });
  if (!flags.ok) return refuseCli(flags.issues);
  const { '--root': root, '--experiment': experimentId } = flags.value.values;
  const status = campaignStatus(root, experimentId);
  if (!status.ok) {
    process.stderr.write(`${status.issues.map((i) => `run: ${i}`).join('\n')}\n`);
    return 1;
  }
  if (flags.value.switches.has('--json')) {
    process.stdout.write(`${JSON.stringify({ experimentId, ...status.value }, null, 2)}\n`);
    return 0;
  }
  const counts = (r: Record<string, number>): string =>
    Object.entries(r)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
  process.stdout.write(
    `${experimentId}: scheduled ${status.value.scheduled}\nstate: ${counts(status.value.byState)}\ndisposition: ${counts(status.value.byDisposition)}\n`,
  );
  return 0;
}

/** The verbs, over an injected adapter map. Usage refusals exit 2 before any side effect. */
export async function runCli(argv: string[], adapters: AdapterMap): Promise<number> {
  const [verb, ...rest] = argv;
  switch (verb) {
    case 'preflight':
      return preflightCli(rest, adapters);
    case 'attempt':
      return attemptCli(rest, adapters);
    case 'recover':
      return recoverCli(rest);
    case 'status':
      return statusCli(rest);
    default:
      return refuseCli([`unknown verb ${verb ?? '(none)'}`]);
  }
}

if (import.meta.main) {
  import('./adapters/index')
    .then(({ ADAPTERS }) => runCli(process.argv.slice(2), ADAPTERS))
    .then((code) => {
      process.exitCode = code;
    });
}
