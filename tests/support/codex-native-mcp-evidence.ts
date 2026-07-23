/**
 * Real Codex app-server -> exact candidate `genie mcp` evidence.
 *
 * This support boundary never starts a model turn or asks for account state. It
 * starts one thread with one caller-specified MCP server, calls `genie_board`
 * through `mcpServer/tool/call`, and compares the MCP launch cwd with a
 * Codex-launched `command/exec` control by exact string and OS directory
 * identity. The launcher records its process facts immediately before `exec`,
 * so its PID is also the PID of the direct candidate or native adapter.
 */

import { Database } from 'bun:sqlite';
import { type ChildProcessWithoutNullStreams, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolveProjectContext } from '../../src/lib/v5/genie-db.js';

export type CodexNativeMcpEvidenceErrorCode =
  | 'invalid-options'
  | 'codex-unavailable'
  | 'codex-version-mismatch'
  | 'app-server-failure'
  | 'rpc-error'
  | 'rpc-timeout'
  | 'launcher-timeout'
  | 'launcher-mismatch'
  | 'mcp-inventory-mismatch'
  | 'mcp-tool-failure'
  | 'control-failure'
  | 'cwd-mismatch'
  | 'sentinel-mismatch'
  | 'expected-error-mismatch'
  | 'cleanup-failure';

export class CodexNativeMcpEvidenceError extends Error {
  constructor(
    readonly code: CodexNativeMcpEvidenceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CodexNativeMcpEvidenceError';
  }
}

export interface CodexAppServerPin {
  /** Absolute executable path. The exact path is used for both preflight and app-server. */
  executable: string;
  /** Exact trimmed stdout expected from `<executable> --version`. */
  version: string;
}

export interface NativeMcpCandidate {
  /** Absolute exact candidate executable or script path. */
  executable: string;
  /** Absolute native runtime/adapter, such as Bun, when the candidate is not directly executable. */
  adapter?: string;
  /** Candidate arguments. Defaults to `['mcp']`. */
  args?: string[];
}

export interface NativeMcpTaskSentinel {
  /** Caller-generated token that must occur in at least one exact task identity field. */
  token: string;
  task: {
    id: string;
    title: string;
    wish: string;
    status: string;
    claimedBy?: string;
  };
}

export type NativeMcpExpectedError = 'project-database-unavailable';

export interface CodexNativeMcpEvidenceTimeouts {
  preflightMs: number;
  initializeMs: number;
  threadStartMs: number;
  launcherMs: number;
  inventoryMs: number;
  toolCallMs: number;
  controlMs: number;
  cleanupGraceMs: number;
}

interface CodexNativeMcpEvidenceBaseOptions {
  codex: CodexAppServerPin;
  /** The raw absolute spelling sent as `thread/start.cwd`; it is never normalized here. */
  requestedCwd: string;
  candidate: NativeMcpCandidate;
  /** Absolute path to `codex-native-mcp-launcher.sh`. */
  launcherExecutable: string;
  /** Absolute Node/Bun executable used by the `command/exec` control reporter. */
  controlExecutable: string;
  /**
   * Exact caller-owned environment for app-server and its children. It is not
   * merged with process.env and must contain an absolute CODEX_HOME.
   */
  env: NodeJS.ProcessEnv;
  /** Parent for this helper's removable temp child. Defaults to env.TMPDIR/process tmpdir. */
  tempDir?: string;
  timeouts?: Partial<CodexNativeMcpEvidenceTimeouts>;
}

interface SentinelEvidenceOptions extends CodexNativeMcpEvidenceBaseOptions {
  expectedSentinel: NativeMcpTaskSentinel;
  expectedError?: never;
}

interface ExpectedErrorEvidenceOptions extends CodexNativeMcpEvidenceBaseOptions {
  expectedSentinel?: never;
  expectedError: NativeMcpExpectedError;
}

export type CodexNativeMcpEvidenceOptions = SentinelEvidenceOptions | ExpectedErrorEvidenceOptions;

export interface NativeMcpLauncherObservation {
  /** Launcher PID, preserved by `exec` into the candidate or its native adapter. */
  pid: number;
  effectiveCwd: string;
  /** OS directory identity formatted as `dev:ino`. */
  cwdIdentity: string;
  adapter: string | null;
  candidate: string;
  args: string[];
}

export interface NativeMcpControlEvidence {
  pid: number;
  effectiveCwd: string;
  cwdIdentity: string;
}

export interface NativeMcpToolResponse {
  content: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
}

export type NativeMcpEvidenceOutcome =
  | {
      kind: 'sentinel';
      sentinel: NativeMcpTaskSentinel;
      payload: Record<string, unknown>;
    }
  | {
      kind: 'expected-error';
      error: NativeMcpExpectedError;
      payload: Record<string, unknown>;
    };

export interface CodexNativeMcpEvidence {
  schemaVersion: 1;
  codex: CodexAppServerPin & { appServerPid: number };
  candidate: {
    executable: string;
    adapter: string | null;
    args: string[];
  };
  rawRequestedCwd: string;
  threadId: string;
  launcher: NativeMcpLauncherObservation;
  control: NativeMcpControlEvidence;
  mcpServer: {
    name: string;
    tools: string[];
  };
  toolResponse: NativeMcpToolResponse;
  toolPayload: Record<string, unknown>;
  outcome: NativeMcpEvidenceOutcome;
}

/** Structural adapter input used by the parameterized dogfood harness. */
export interface DogfoodNativeMcpEvidenceInput {
  tag: string;
  requestedCwd: string;
  candidateBinary: string;
  candidateBinarySha256: string;
  executionAdapter?: string;
  root: string;
  env: Record<string, string>;
}

/** Narrow evidence projection consumed by the parameterized dogfood harness. */
export interface DogfoodNativeMcpEvidence {
  requestedCwd: string;
  effectiveCwd: string;
  cwdIdentity: string;
  controlCwd: string;
  controlCwdIdentity: string;
  childPid: number;
  threadId: string;
  isError: boolean;
  payload: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export type CodexAppServerSupport =
  | { supported: true; reason: 'ok' }
  | { supported: false; reason: string; errorCode: CodexNativeMcpEvidenceErrorCode };

interface PendingRequest {
  method: string;
  resolve: (message: JsonRpcEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcEnvelope {
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
  method?: string;
  params?: unknown;
}

interface McpInventory {
  name: string;
  tools: string[];
}

const DEFAULT_TIMEOUTS: CodexNativeMcpEvidenceTimeouts = {
  preflightMs: 5_000,
  initializeMs: 15_000,
  threadStartMs: 20_000,
  launcherMs: 15_000,
  inventoryMs: 20_000,
  toolCallMs: 20_000,
  controlMs: 15_000,
  cleanupGraceMs: 1_000,
};

// Override the marker-owned project route under its production key. A second
// test-only server name would leave both routes live and make the observation
// ambiguous once setup has converged `.codex/config.toml`.
const MCP_SERVER_NAME = 'genie';
const LAUNCHER_SCHEMA = 'codex-native-mcp-launcher-v1';
const CONTROL_SOURCE =
  "const fs = require('node:fs'); const cwd = process.cwd(); const s = fs.statSync(cwd); " +
  "process.stdout.write(JSON.stringify({ pid: process.pid, cwd, dev: s.dev, ino: s.ino }) + '\\n');";

class AppServerSession {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly closePromise: Promise<void>;
  private nextId = 1;
  private closed = false;
  private didClose = false;
  private stderrTail = '';

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly pin: CodexAppServerPin,
  ) {
    this.closePromise = new Promise((resolve) => {
      child.once('close', () => {
        this.didClose = true;
        resolve();
      });
    });
    this.wireLifecycle();
    this.wireProtocol();
  }

  static async launch(
    pin: CodexAppServerPin,
    env: NodeJS.ProcessEnv,
    timeouts: CodexNativeMcpEvidenceTimeouts,
  ): Promise<AppServerSession> {
    assertCodexPin(pin, env, timeouts.preflightMs);
    const child = spawn(pin.executable, ['app-server', '--stdio'], {
      detached: process.platform !== 'win32',
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => {});
    const session = new AppServerSession(child, pin);
    try {
      await session.request(
        'initialize',
        { clientInfo: { name: 'genie-native-mcp-evidence', version: '1' } },
        timeouts.initializeMs,
      );
      session.notify('initialized', {});
      return session;
    } catch (error) {
      const cleanupError = await session.close(undefined, timeouts.cleanupGraceMs);
      if (cleanupError) {
        throw new AggregateError([asError(error), cleanupError], 'app-server initialize and cleanup both failed');
      }
      throw error;
    }
  }

  pid(): number {
    const pid = this.child.pid;
    if (pid === undefined) {
      throw new CodexNativeMcpEvidenceError('app-server-failure', 'codex app-server has no process id');
    }
    return pid;
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcEnvelope> {
    if (this.closed) {
      throw new CodexNativeMcpEvidenceError('app-server-failure', `${method} requested after app-server close`);
    }
    const id = this.nextId++;
    return new Promise<JsonRpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexNativeMcpEvidenceError('rpc-timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      const message = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      try {
        this.child.stdin.write(message, (error) => {
          if (error) {
            this.rejectRequest(
              id,
              new CodexNativeMcpEvidenceError('rpc-error', `${method} write failed: ${error.message}`),
            );
          }
        });
      } catch (error) {
        this.rejectRequest(
          id,
          new CodexNativeMcpEvidenceError('rpc-error', `${method} write failed`, { cause: asError(error) }),
        );
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, () => {});
  }

  /**
   * TERM then KILL the recorded candidate and the app-server process group.
   * Returns a cleanup error instead of masking the primary evidence failure.
   */
  async close(candidatePid: number | undefined, graceMs: number): Promise<Error | null> {
    if (this.closed) return null;
    this.closed = true;
    this.rejectPending(new CodexNativeMcpEvidenceError('app-server-failure', 'app-server evidence session closed'));
    const failures: Error[] = [];

    signalPid(candidatePid, 'SIGTERM', failures);
    this.signalTree('SIGTERM', failures);
    await waitUntilStopped([candidatePid, this.child.pid], graceMs);

    if (isProcessAlive(candidatePid)) signalPid(candidatePid, 'SIGKILL', failures);
    if (isProcessAlive(this.child.pid)) this.signalTree('SIGKILL', failures);
    await Promise.race([this.closePromise, delay(graceMs)]);
    await waitUntilStopped([candidatePid, this.child.pid], graceMs);

    if (isProcessAlive(candidatePid)) {
      failures.push(new Error(`candidate process ${String(candidatePid)} survived SIGKILL`));
    }
    if (isProcessAlive(this.child.pid) || !this.didClose) {
      failures.push(new Error(`codex app-server process ${String(this.child.pid)} did not close`));
    }
    if (failures.length === 0) return null;
    return new CodexNativeMcpEvidenceError(
      'cleanup-failure',
      `native MCP cleanup failed: ${failures.map((failure) => failure.message).join('; ')}`,
      { cause: new AggregateError(failures) },
    );
  }

  diagnostics(): string {
    return this.stderrTail.trim().slice(-2_000);
  }

  private signalTree(signal: NodeJS.Signals, failures: Error[]): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    if (process.platform !== 'win32') {
      signalPid(-pid, signal, failures);
      return;
    }
    signalPid(pid, signal, failures);
  }

  private wireLifecycle(): void {
    this.child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-16_384);
    });
    this.child.on('error', (error) => {
      this.rejectPending(
        new CodexNativeMcpEvidenceError('app-server-failure', `codex app-server process error: ${error.message}`),
      );
    });
    this.child.on('exit', (code, signal) => {
      this.rejectPending(
        new CodexNativeMcpEvidenceError(
          'app-server-failure',
          `codex app-server exited before reply (code=${String(code)}, signal=${String(signal)}): ${this.diagnostics()}`,
        ),
      );
    });
    this.child.stdin.on('error', (error) => {
      this.rejectPending(
        new CodexNativeMcpEvidenceError('rpc-error', `codex app-server stdin error: ${error.message}`),
      );
    });
  }

  private wireProtocol(): void {
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      const message = parseJsonEnvelope(line);
      if (!message || typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        pending.reject(
          new CodexNativeMcpEvidenceError(
            'rpc-error',
            `${pending.method} error: ${truncateJson(message.error, 1_000)}`,
          ),
        );
        return;
      }
      pending.resolve(message);
    });
  }

  private rejectRequest(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) this.rejectRequest(id, error);
  }
}

/**
 * Run the no-model app-server initialize handshake against an exact executable
 * and version pin. The caller decides whether an unavailable verdict permits a
 * test skip; evidence failures after this probe must not be converted to skips.
 */
export async function probeCodexAppServer(
  pin: CodexAppServerPin,
  env: NodeJS.ProcessEnv,
  timeoutOverrides: Partial<CodexNativeMcpEvidenceTimeouts> = {},
): Promise<CodexAppServerSupport> {
  const timeouts = mergeTimeouts(timeoutOverrides);
  let session: AppServerSession | null = null;
  try {
    assertEnvironment(env);
    session = await AppServerSession.launch(pin, env, timeouts);
  } catch (error) {
    const typed = toEvidenceError(error, 'codex-unavailable', 'codex app-server is unavailable');
    return { supported: false, reason: typed.message, errorCode: typed.code };
  }
  const cleanupError = await session.close(undefined, timeouts.cleanupGraceMs);
  if (cleanupError) return { supported: false, reason: cleanupError.message, errorCode: cleanupError.code };
  return { supported: true, reason: 'ok' };
}

/**
 * Capture and validate one real app-server -> candidate MCP observation.
 *
 * Every failure path closes the candidate/app-server process tree and removes
 * only this call's private temporary directory before rejecting.
 */
export async function captureCodexNativeMcpEvidence(
  options: CodexNativeMcpEvidenceOptions,
): Promise<CodexNativeMcpEvidence> {
  const normalized = normalizeOptions(options);
  const tempRoot = mkdtempSync(join(normalized.tempDir, 'genie-native-mcp-evidence-'));
  const launcherRecord = join(tempRoot, 'launcher-record.bin');
  let session: AppServerSession | null = null;
  let launcher: NativeMcpLauncherObservation | null = null;
  let evidence: CodexNativeMcpEvidence | null = null;
  let primaryError: Error | null = null;

  try {
    session = await AppServerSession.launch(normalized.codex, normalized.env, normalized.timeouts);
    const threadId = await startThread(session, normalized, launcherRecord);
    launcher = await waitForLauncherObservation(launcherRecord, normalized.candidate, normalized.timeouts.launcherMs);
    const inventory = await waitForMcpInventory(session, threadId, normalized.timeouts.inventoryMs);
    const toolResponse = await callBoard(session, threadId, normalized.timeouts.toolCallMs);
    const toolPayload = parseToolPayload(toolResponse);
    const control = await runControl(session, normalized, normalized.timeouts.controlMs);
    assertCwdEquality(launcher, control);
    const outcome = validateExpectedOutcome(normalized, toolResponse, toolPayload);
    evidence = {
      schemaVersion: 1,
      codex: { ...normalized.codex, appServerPid: session.pid() },
      candidate: {
        executable: normalized.candidate.executable,
        adapter: normalized.candidate.adapter ?? null,
        args: normalized.candidate.args,
      },
      rawRequestedCwd: normalized.requestedCwd,
      threadId,
      launcher,
      control,
      mcpServer: inventory,
      toolResponse,
      toolPayload,
      outcome,
    };
  } catch (error) {
    primaryError = asError(error);
  }

  if (!launcher) launcher = tryReadLauncherObservation(launcherRecord);
  let cleanupError = await session?.close(launcher?.pid, normalized.timeouts.cleanupGraceMs);
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    const tempError = new CodexNativeMcpEvidenceError(
      'cleanup-failure',
      `failed to remove native MCP evidence temp root ${tempRoot}`,
      { cause: asError(error) },
    );
    cleanupError = cleanupError
      ? new CodexNativeMcpEvidenceError('cleanup-failure', 'process and temp cleanup both failed', {
          cause: new AggregateError([cleanupError, tempError]),
        })
      : tempError;
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], 'native MCP evidence and cleanup both failed');
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!evidence) {
    throw new CodexNativeMcpEvidenceError('app-server-failure', 'native MCP evidence produced no result');
  }
  return evidence;
}

/**
 * Thin adapter for `codex-dogfood-harness.ts`.
 *
 * The real Codex executable is resolved from the host process (or the explicit
 * `GENIE_DOGFOOD_REAL_CODEX` host override), never from the harness's isolated
 * PATH where its lifecycle fake lives. Each known dogfood tag has a required
 * fail-closed or exact-sentinel expectation before app-server starts.
 */
export async function captureCodexNativeMcpEvidenceForDogfood(
  input: DogfoodNativeMcpEvidenceInput,
): Promise<DogfoodNativeMcpEvidence> {
  assertCandidateDigest(input.candidateBinary, input.candidateBinarySha256);
  const codex = resolveHostCodexPin();
  const launcherExecutable = fileURLToPath(new URL('./codex-native-mcp-launcher.sh', import.meta.url));
  const base = {
    codex,
    requestedCwd: input.requestedCwd,
    candidate: {
      executable: input.candidateBinary,
      ...(input.executionAdapter === undefined ? {} : { adapter: input.executionAdapter }),
      args: ['mcp'],
    },
    launcherExecutable,
    controlExecutable: process.execPath,
    env: input.executionAdapter === undefined ? input.env : { ...input.env, DOGFOOD_ROOT: input.root },
    tempDir: input.env.TMPDIR,
  };
  const expectation = dogfoodExpectation(input);
  const evidence =
    expectation.kind === 'expected-error'
      ? await captureCodexNativeMcpEvidence({ ...base, expectedError: expectation.error })
      : await captureCodexNativeMcpEvidence({ ...base, expectedSentinel: expectation.sentinel });
  return {
    requestedCwd: evidence.rawRequestedCwd,
    effectiveCwd: evidence.launcher.effectiveCwd,
    cwdIdentity: evidence.launcher.cwdIdentity,
    controlCwd: evidence.control.effectiveCwd,
    controlCwdIdentity: evidence.control.cwdIdentity,
    childPid: evidence.launcher.pid,
    threadId: evidence.threadId,
    isError: evidence.toolResponse.isError === true,
    payload: evidence.toolPayload,
    raw: evidence as unknown as Record<string, unknown>,
  };
}

/**
 * Pure fail-closed sentinel validator, exported for fixture tests and callers
 * that need to validate a previously captured `genie_board` payload.
 */
export function assertUniqueBoardSentinel(
  payload: Record<string, unknown>,
  expected: NativeMcpTaskSentinel,
): NativeMcpTaskSentinel {
  validateSentinel(expected);
  if (!Array.isArray(payload.tasks)) {
    throw new CodexNativeMcpEvidenceError('sentinel-mismatch', 'genie_board payload has no tasks array');
  }
  if (payload.tasks.length !== 1) {
    throw new CodexNativeMcpEvidenceError(
      'sentinel-mismatch',
      `genie_board must return exactly one task, received ${payload.tasks.length}`,
    );
  }
  const observed = payload.tasks[0];
  if (!isRecord(observed)) {
    throw new CodexNativeMcpEvidenceError('sentinel-mismatch', 'genie_board task sentinel is not an object');
  }
  const projected = {
    id: observed.id,
    title: observed.title,
    wish: observed.wish,
    status: observed.status,
    ...(expected.task.claimedBy === undefined ? {} : { claimedBy: observed.claimedBy }),
  };
  if (
    projected.id !== expected.task.id ||
    projected.title !== expected.task.title ||
    projected.wish !== expected.task.wish ||
    projected.status !== expected.task.status ||
    (expected.task.claimedBy !== undefined && projected.claimedBy !== expected.task.claimedBy)
  ) {
    throw new CodexNativeMcpEvidenceError(
      'sentinel-mismatch',
      `genie_board task sentinel differs: ${truncateJson(projected, 1_000)}`,
    );
  }
  return expected;
}

function dogfoodExpectation(
  input: DogfoodNativeMcpEvidenceInput,
):
  | { kind: 'expected-error'; error: 'project-database-unavailable' }
  | { kind: 'sentinel'; sentinel: NativeMcpTaskSentinel } {
  const context = resolveProjectContext(input.requestedCwd);
  if (input.tag === 'b-before-init') {
    if (context.kind !== 'project-database-unavailable') {
      throw new CodexNativeMcpEvidenceError(
        'invalid-options',
        `b-before-init requires project-database-unavailable before launch, got ${context.kind}`,
      );
    }
    return { kind: 'expected-error', error: 'project-database-unavailable' };
  }
  if (input.tag !== 'b-after-init' && input.tag !== 'a-new-thread') {
    throw new CodexNativeMcpEvidenceError('invalid-options', `dogfood native MCP tag has no expectation: ${input.tag}`);
  }
  if (context.kind !== 'ok') {
    throw new CodexNativeMcpEvidenceError(
      'invalid-options',
      `${input.tag} requires an initialized project database, got ${context.kind}`,
    );
  }
  const db = new Database(context.dbPath, { readonly: true, strict: true });
  try {
    const tasks = db
      .query('SELECT id, title, wish, status, claimed_by AS claimedBy FROM tasks ORDER BY created_at, id')
      .all() as Array<Record<string, unknown>>;
    if (tasks.length !== 1) {
      throw new CodexNativeMcpEvidenceError(
        'invalid-options',
        `${input.tag} requires exactly one seeded task before launch, found ${tasks.length}`,
      );
    }
    const task = tasks[0];
    if (
      !task ||
      typeof task.id !== 'string' ||
      typeof task.title !== 'string' ||
      typeof task.wish !== 'string' ||
      typeof task.status !== 'string' ||
      typeof task.claimedBy !== 'string'
    ) {
      throw new CodexNativeMcpEvidenceError(
        'invalid-options',
        `${input.tag} seeded task is missing exact wish/title/status/claimant identity`,
      );
    }
    return {
      kind: 'sentinel',
      sentinel: {
        token: task.title,
        task: {
          id: task.id,
          title: task.title,
          wish: task.wish,
          status: task.status,
          claimedBy: task.claimedBy,
        },
      },
    };
  } finally {
    db.close();
  }
}

function assertCandidateDigest(candidate: string, expectedSha256: string): void {
  assertAbsolute('candidateBinary', candidate);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new CodexNativeMcpEvidenceError('invalid-options', 'candidateBinarySha256 must be lowercase SHA-256');
  }
  const actual = createHash('sha256').update(readFileSync(candidate)).digest('hex');
  if (actual !== expectedSha256) {
    throw new CodexNativeMcpEvidenceError(
      'invalid-options',
      `candidate binary digest mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
}

function resolveHostCodexPin(): CodexAppServerPin {
  const executable = process.env.GENIE_DOGFOOD_REAL_CODEX ?? Bun.which('codex');
  if (!executable || !isAbsolute(executable)) {
    throw new CodexNativeMcpEvidenceError(
      'codex-unavailable',
      'real Codex not found on host PATH; set GENIE_DOGFOOD_REAL_CODEX to an absolute executable',
    );
  }
  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024,
    timeout: DEFAULT_TIMEOUTS.preflightMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout.trim()) {
    throw new CodexNativeMcpEvidenceError(
      'codex-unavailable',
      `real Codex preflight failed for ${executable}: ${String(result.stderr).trim().slice(0, 1_000)}`,
      { cause: result.error },
    );
  }
  return { executable, version: result.stdout.trim() };
}

function normalizeOptions(options: CodexNativeMcpEvidenceOptions): CodexNativeMcpEvidenceOptions & {
  candidate: NativeMcpCandidate & { args: string[] };
  tempDir: string;
  timeouts: CodexNativeMcpEvidenceTimeouts;
} {
  assertEnvironment(options.env);
  assertAbsolute('requestedCwd', options.requestedCwd);
  assertAbsolute('candidate.executable', options.candidate.executable);
  if (options.candidate.adapter) assertAbsolute('candidate.adapter', options.candidate.adapter);
  assertAbsolute('launcherExecutable', options.launcherExecutable);
  assertAbsolute('controlExecutable', options.controlExecutable);
  if (!existsSync(options.launcherExecutable)) {
    throw new CodexNativeMcpEvidenceError(
      'invalid-options',
      `launcherExecutable does not exist: ${options.launcherExecutable}`,
    );
  }
  const tempDir = options.tempDir ?? options.env.TMPDIR ?? tmpdir();
  assertAbsolute('tempDir', tempDir);
  const expectationCount = Number(options.expectedSentinel !== undefined) + Number(options.expectedError !== undefined);
  if (expectationCount !== 1) {
    throw new CodexNativeMcpEvidenceError(
      'invalid-options',
      'exactly one of expectedSentinel or expectedError is required',
    );
  }
  if (options.expectedSentinel) validateSentinel(options.expectedSentinel);
  return {
    ...options,
    candidate: { ...options.candidate, args: [...(options.candidate.args ?? ['mcp'])] },
    tempDir,
    timeouts: mergeTimeouts(options.timeouts),
  };
}

function validateSentinel(expected: NativeMcpTaskSentinel): void {
  const values = [
    expected.task.id,
    expected.task.title,
    expected.task.wish,
    expected.task.status,
    ...(expected.task.claimedBy === undefined ? [] : [expected.task.claimedBy]),
  ];
  if (!expected.token || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new CodexNativeMcpEvidenceError('invalid-options', 'sentinel token and task identity must be non-empty');
  }
  if (!values.some((value) => value.includes(expected.token))) {
    throw new CodexNativeMcpEvidenceError(
      'invalid-options',
      'sentinel token must occur in at least one exact task identity field',
    );
  }
}

function assertEnvironment(env: NodeJS.ProcessEnv): void {
  const codexHome = env.CODEX_HOME;
  if (!codexHome || !isAbsolute(codexHome)) {
    throw new CodexNativeMcpEvidenceError('invalid-options', 'caller env must contain an absolute CODEX_HOME');
  }
}

function assertCodexPin(pin: CodexAppServerPin, env: NodeJS.ProcessEnv, timeoutMs: number): void {
  assertAbsolute('codex.executable', pin.executable);
  if (!pin.version.trim()) {
    throw new CodexNativeMcpEvidenceError('invalid-options', 'codex.version must be non-empty');
  }
  let result: SpawnSyncReturns<string>;
  try {
    result = spawnSync(pin.executable, ['--version'], {
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch (error) {
    throw new CodexNativeMcpEvidenceError('codex-unavailable', `codex preflight failed: ${pin.executable}`, {
      cause: asError(error),
    });
  }
  if (result.error || result.status !== 0) {
    throw new CodexNativeMcpEvidenceError(
      'codex-unavailable',
      `codex preflight failed (status=${String(result.status)}): ${String(result.stderr).trim().slice(0, 1_000)}`,
      { cause: result.error },
    );
  }
  const actualVersion = result.stdout.trim();
  if (actualVersion !== pin.version.trim()) {
    throw new CodexNativeMcpEvidenceError(
      'codex-version-mismatch',
      `codex version mismatch: expected ${JSON.stringify(pin.version.trim())}, got ${JSON.stringify(actualVersion)}`,
    );
  }
}

async function startThread(
  session: AppServerSession,
  options: ReturnType<typeof normalizeOptions>,
  launcherRecord: string,
): Promise<string> {
  const adapter = options.candidate.adapter ?? '-';
  const response = await session.request(
    'thread/start',
    {
      cwd: options.requestedCwd,
      ephemeral: true,
      config: {
        mcp_servers: {
          [MCP_SERVER_NAME]: {
            command: options.launcherExecutable,
            args: [launcherRecord, adapter, options.candidate.executable, ...options.candidate.args],
          },
        },
      },
    },
    options.timeouts.threadStartMs,
  );
  const result = response.result;
  const thread = isRecord(result) && isRecord(result.thread) ? result.thread : null;
  if (!thread || typeof thread.id !== 'string' || !thread.id) {
    throw new CodexNativeMcpEvidenceError(
      'app-server-failure',
      `thread/start returned no thread id: ${truncateJson(response, 1_000)}`,
    );
  }
  return thread.id;
}

async function waitForLauncherObservation(
  recordFile: string,
  candidate: NativeMcpCandidate & { args: string[] },
  timeoutMs: number,
): Promise<NativeMcpLauncherObservation> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const observed = tryReadLauncherObservation(recordFile);
    if (observed) {
      const adapter = candidate.adapter ?? null;
      if (
        observed.adapter !== adapter ||
        observed.candidate !== candidate.executable ||
        !arraysEqual(observed.args, candidate.args)
      ) {
        throw new CodexNativeMcpEvidenceError(
          'launcher-mismatch',
          `launcher target differs from requested candidate: ${truncateJson(observed, 1_000)}`,
        );
      }
      return observed;
    }
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  throw new CodexNativeMcpEvidenceError(
    'launcher-timeout',
    `candidate launcher observation did not appear within ${timeoutMs}ms`,
  );
}

function tryReadLauncherObservation(recordFile: string): NativeMcpLauncherObservation | null {
  if (!existsSync(recordFile)) return null;
  let fields: string[];
  try {
    const bytes = readFileSync(recordFile);
    fields = bytes
      .toString('utf8')
      .split('\0')
      .filter((field, index, all) => !(index === all.length - 1 && field === ''));
  } catch {
    return null;
  }
  if (fields.length < 6 || fields[0] !== LAUNCHER_SCHEMA) return null;
  const pid = Number(fields[1]);
  const cwdIdentity = fields[3] ?? '';
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^\d+:\d+$/.test(cwdIdentity)) return null;
  return {
    pid,
    effectiveCwd: fields[2] ?? '',
    cwdIdentity,
    adapter: fields[4] === '-' ? null : (fields[4] ?? null),
    candidate: fields[5] ?? '',
    args: fields.slice(6),
  };
}

async function waitForMcpInventory(
  session: AppServerSession,
  threadId: string,
  timeoutMs: number,
): Promise<McpInventory> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: unknown;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const response = await session.request('mcpServerStatus/list', { threadId, detail: 'full', limit: 100 }, remaining);
    lastResult = response.result;
    const inventory = parseInventory(response.result);
    if (inventory) return inventory;
    await delay(Math.min(100, Math.max(1, deadline - Date.now())));
  }
  throw new CodexNativeMcpEvidenceError(
    'mcp-inventory-mismatch',
    `thread did not expose exactly one ${MCP_SERVER_NAME} server with genie_board: ${truncateJson(lastResult, 1_000)}`,
  );
}

function parseInventory(result: unknown): McpInventory | null {
  if (!isRecord(result) || !Array.isArray(result.data) || result.data.length !== 1) return null;
  const server = result.data[0];
  if (!isRecord(server) || server.name !== MCP_SERVER_NAME || !isRecord(server.tools)) return null;
  const tools = Object.keys(server.tools).sort();
  if (!tools.includes('genie_board')) return null;
  return { name: MCP_SERVER_NAME, tools };
}

async function callBoard(
  session: AppServerSession,
  threadId: string,
  timeoutMs: number,
): Promise<NativeMcpToolResponse> {
  const response = await session.request(
    'mcpServer/tool/call',
    { threadId, server: MCP_SERVER_NAME, tool: 'genie_board', arguments: {} },
    timeoutMs,
  );
  if (!isRecord(response.result) || !Array.isArray(response.result.content)) {
    throw new CodexNativeMcpEvidenceError(
      'mcp-tool-failure',
      `mcpServer/tool/call returned an invalid result: ${truncateJson(response, 1_000)}`,
    );
  }
  return response.result as unknown as NativeMcpToolResponse;
}

function parseToolPayload(response: NativeMcpToolResponse): Record<string, unknown> {
  if (response.content.length !== 1) {
    throw new CodexNativeMcpEvidenceError(
      'mcp-tool-failure',
      `genie_board must return one content item, received ${response.content.length}`,
    );
  }
  const content = response.content[0];
  if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
    throw new CodexNativeMcpEvidenceError('mcp-tool-failure', 'genie_board content item is not text');
  }
  try {
    const payload = JSON.parse(content.text) as unknown;
    if (!isRecord(payload)) throw new Error('payload is not an object');
    return payload;
  } catch (error) {
    throw new CodexNativeMcpEvidenceError('mcp-tool-failure', 'genie_board text is not one JSON object', {
      cause: asError(error),
    });
  }
}

async function runControl(
  session: AppServerSession,
  options: ReturnType<typeof normalizeOptions>,
  timeoutMs: number,
): Promise<NativeMcpControlEvidence> {
  const response = await session.request(
    'command/exec',
    {
      command: [options.controlExecutable, '-e', CONTROL_SOURCE],
      cwd: options.requestedCwd,
      timeoutMs,
      outputBytesCap: 16_384,
    },
    timeoutMs + 2_000,
  );
  if (!isRecord(response.result)) {
    throw new CodexNativeMcpEvidenceError(
      'control-failure',
      `command/exec returned an invalid result: ${truncateJson(response, 1_000)}`,
    );
  }
  const { exitCode, stdout, stderr } = response.result;
  if (exitCode !== 0 || typeof stdout !== 'string') {
    throw new CodexNativeMcpEvidenceError(
      'control-failure',
      `command/exec failed (exit=${String(exitCode)}): ${typeof stderr === 'string' ? stderr.slice(0, 1_000) : ''}`,
    );
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.cwd !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.dev !== 'number' ||
      typeof parsed.ino !== 'number'
    ) {
      throw new Error('control payload fields are invalid');
    }
    return {
      pid: parsed.pid,
      effectiveCwd: parsed.cwd,
      cwdIdentity: `${parsed.dev}:${parsed.ino}`,
    };
  } catch (error) {
    throw new CodexNativeMcpEvidenceError('control-failure', 'command/exec stdout is not control evidence', {
      cause: asError(error),
    });
  }
}

function assertCwdEquality(launcher: NativeMcpLauncherObservation, control: NativeMcpControlEvidence): void {
  if (launcher.effectiveCwd !== control.effectiveCwd || launcher.cwdIdentity !== control.cwdIdentity) {
    throw new CodexNativeMcpEvidenceError(
      'cwd-mismatch',
      `candidate cwd ${launcher.effectiveCwd} (${launcher.cwdIdentity}) differs from control ` +
        `${control.effectiveCwd} (${control.cwdIdentity})`,
    );
  }
}

function validateExpectedOutcome(
  options: ReturnType<typeof normalizeOptions>,
  response: NativeMcpToolResponse,
  payload: Record<string, unknown>,
): NativeMcpEvidenceOutcome {
  if (options.expectedSentinel) {
    if (response.isError === true) {
      throw new CodexNativeMcpEvidenceError(
        'sentinel-mismatch',
        `genie_board returned an error instead of the sentinel: ${truncateJson(payload, 1_000)}`,
      );
    }
    return { kind: 'sentinel', sentinel: assertUniqueBoardSentinel(payload, options.expectedSentinel), payload };
  }
  if (response.isError !== true || payload.error !== options.expectedError) {
    throw new CodexNativeMcpEvidenceError(
      'expected-error-mismatch',
      `genie_board did not return expected ${String(options.expectedError)}: ${truncateJson(payload, 1_000)}`,
    );
  }
  if (Object.hasOwn(payload, 'tasks') || Object.hasOwn(payload, 'counts')) {
    throw new CodexNativeMcpEvidenceError(
      'expected-error-mismatch',
      'fail-closed genie_board error must not contain tasks or counts',
    );
  }
  return {
    kind: 'expected-error',
    error: options.expectedError as NativeMcpExpectedError,
    payload,
  };
}

function mergeTimeouts(overrides: Partial<CodexNativeMcpEvidenceTimeouts> | undefined): CodexNativeMcpEvidenceTimeouts {
  const merged = { ...DEFAULT_TIMEOUTS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 120_000) {
      throw new CodexNativeMcpEvidenceError('invalid-options', `${name} must be an integer from 1 to 120000`);
    }
  }
  return merged;
}

function assertAbsolute(name: string, path: string): void {
  if (!path || !isAbsolute(path)) {
    throw new CodexNativeMcpEvidenceError('invalid-options', `${name} must be an absolute path`);
  }
}

function parseJsonEnvelope(line: string): JsonRpcEnvelope | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? (parsed as JsonRpcEnvelope) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function truncateJson(value: unknown, maxLength: number): string {
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return String(value).slice(0, maxLength);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toEvidenceError(
  error: unknown,
  fallbackCode: CodexNativeMcpEvidenceErrorCode,
  fallbackMessage: string,
): CodexNativeMcpEvidenceError {
  if (error instanceof CodexNativeMcpEvidenceError) return error;
  return new CodexNativeMcpEvidenceError(fallbackCode, `${fallbackMessage}: ${asError(error).message}`, {
    cause: asError(error),
  });
}

function signalPid(pid: number | undefined, signal: NodeJS.Signals, failures: Error[]): void {
  if (pid === undefined || pid === process.pid || pid === 0) return;
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(asError(error));
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitUntilStopped(pids: Array<number | undefined>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(isProcessAlive) && Date.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
