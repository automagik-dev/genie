/**
 * Black-box `CodexCwdEvidence` harness (Group B deliverables 2 + 3) — a
 * HARNESS-ONLY record, never a production observation.
 *
 * It drives ONE pinned long-lived real `codex app-server` over stdio JSON-RPC and,
 * for each case, pairs the RAW `thread/start.cwd` request with the effective
 * `process.cwd()` / OS directory identity / PID / tagged sentinel of the MCP
 * server child that Codex launches for that thread (through an absolute fake MCP
 * command with NO `cwd` override), plus a Codex-launched control process
 * (`command/exec`) run in the same directory.
 *
 * This is the ONLY place the raw requested CWD lives. The production
 * `CodexHostObservation` never receives or infers it. If any invariant here
 * fails, Group B is BLOCKED and Group A may not migrate the plugin route.
 *
 * The proof is hermetic: `initialize`, `thread/start` (which eagerly launches the
 * configured MCP servers), and `command/exec` require no model turn — a missing
 * model credential only fails the async model websocket, never the MCP launch or
 * the control exec that carry the CWD facts.
 */

import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/** Per-case black-box evidence pairing the raw request with observed child facts. */
export interface CwdCaseEvidence {
  tag: string;
  /** The RAW `thread/start.cwd` request string — kept ONLY in this harness record. */
  rawRequestedCwd: string;
  threadId: string;
  /** The MCP server child's observed effective `process.cwd()`. */
  childEffectiveCwd: string;
  /** `dev:ino` of the child's effective CWD. */
  childCwdIdentity: string;
  childPid: number;
  /** The tagged sentinel token the child read from its OWN cwd (null = wrong dir / cache root). */
  sentinelToken: string | null;
}

/** A Codex-launched control process (`command/exec`) in a requested directory. */
export interface ControlEvidence {
  requestedCwd: string;
  /** The control process's effective `process.cwd()`. */
  effectiveCwd: string;
  /** `dev:ino` of the control's effective CWD. */
  cwdIdentity: string;
  pid: number;
}

export interface CodexCwdEvidenceSupport {
  supported: boolean;
  reason: string;
}

const FAKE_MCP_SOURCE = String.raw`
import { appendFileSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const sentinelFile = process.argv[2];
const tag = process.argv[3];
(function record() {
  const cwd = process.cwd();
  let dev = null, ino = null, token = null;
  try { const st = statSync(cwd); dev = st.dev; ino = st.ino; } catch {}
  try { token = readFileSync(join(cwd, '.genie-cwd-sentinel'), 'utf8').trim(); } catch {}
  appendFileSync(sentinelFile, JSON.stringify({ tag, cwd, pid: process.pid, dev, ino, token }) + '\n');
})();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim(); if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'genie-cwd-probe', version: '0.0.0' } } }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }) + '\n');
  } else if (msg.id !== undefined && msg.id !== null) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n');
  }
});
setInterval(() => {}, 1 << 30);
`;

const CONTROL_REPORTER_SOURCE = String.raw`
import { statSync } from 'node:fs';
const c = process.cwd();
const s = statSync(c);
process.stdout.write(JSON.stringify({ cwd: c, dev: s.dev, ino: s.ino, pid: process.pid }) + '\n');
`;

interface PendingRequest {
  resolve: (message: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexCwdEvidence {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private childClosed = false;
  private readonly childClosePromise: Promise<void>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly harnessRoot: string,
    private readonly sentinelFile: string,
    private readonly fakeMcpScript: string,
    private readonly controlReporter: string,
    private readonly nodeExecutable: string,
  ) {
    this.childClosePromise = new Promise((resolve) => {
      child.once('close', () => {
        this.childClosed = true;
        resolve();
      });
    });
  }

  /** Start the pinned app-server and complete the `initialize` handshake. */
  static async launch(
    codexCommand = 'codex',
    initializeTimeoutMs = 15_000,
    beforeSpawnForTest?: (harnessRoot: string) => void,
  ): Promise<CodexCwdEvidence> {
    // Deterministic preflight: an absent/unrunnable codex must fail as a caught
    // rejection HERE so callers skip honestly. Without it, spawn() below emits an
    // async 'error' (ENOENT) with no listener, which Node throws unhandled at
    // module load — escaping the caller's try/catch and aborting the whole file
    // (observed on CI: "Executable not found in $PATH" + afterAll-after-complete).
    try {
      execFileSync(codexCommand, ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`codex binary not runnable in this environment: ${codexCommand}`);
    }
    const harnessRoot = mkdtempSync(join(tmpdir(), 'genie-cwd-evidence-'));
    let harness: CodexCwdEvidence | null = null;
    try {
      const codexHome = join(harnessRoot, 'codex-home');
      mkdirSync(codexHome, { recursive: true });
      writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5-codex"\n', 'utf8');
      const sentinelFile = join(harnessRoot, 'sentinel.jsonl');
      writeFileSync(sentinelFile, '', 'utf8');
      const fakeMcpScript = join(harnessRoot, 'fake-mcp.mjs');
      writeFileSync(fakeMcpScript, FAKE_MCP_SOURCE, 'utf8');
      const controlReporter = join(harnessRoot, 'control-reporter.mjs');
      writeFileSync(controlReporter, CONTROL_REPORTER_SOURCE, 'utf8');
      const nodeExecutable = process.execPath;
      beforeSpawnForTest?.(harnessRoot);

      const child = spawn(codexCommand, ['app-server'], {
        env: { ...process.env, CODEX_HOME: codexHome, RUST_LOG: 'error' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
      // A late spawn/runtime failure must surface as a rejected initialize (caught by
      // callers), never as an unhandled 'error' event that throws and aborts the file.
      child.on('error', () => {});
      harness = new CodexCwdEvidence(child, harnessRoot, sentinelFile, fakeMcpScript, controlReporter, nodeExecutable);
      harness.wireLifecycle();
      harness.wireStdout();
      await harness.request(
        'initialize',
        { clientInfo: { name: 'genie-cwd-evidence', version: '0.0.0' } },
        initializeTimeoutMs,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
      return harness;
    } catch (error) {
      if (harness === null) rmSync(harnessRoot, { recursive: true, force: true });
      else await harness.close();
      throw error;
    }
  }

  /**
   * Probe whether this environment can run the black-box proof: start the server,
   * open a thread, and observe the MCP child land its sentinel. Returns a typed
   * support verdict so the test skips honestly (never fakes) when the environment
   * cannot host it, and cleans up either way.
   */
  static async probeSupport(codexCommand = 'codex'): Promise<CodexCwdEvidenceSupport> {
    let harness: CodexCwdEvidence | null = null;
    try {
      harness = await CodexCwdEvidence.launch(codexCommand);
      const probeDir = harness.makeRepo('probe', 'PROBE_TOKEN');
      const evidence = await harness.startThreadCase('probe', probeDir);
      if (evidence.sentinelToken !== 'PROBE_TOKEN') {
        return { supported: false, reason: 'MCP child did not land in the thread cwd sentinel' };
      }
      return { supported: true, reason: 'ok' };
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      await harness?.close();
    }
  }

  /** Create an isolated repo dir under the harness root with a unique tagged sentinel token. */
  makeRepo(name: string, token: string): string {
    const dir = join(this.harnessRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.genie-cwd-sentinel'), token, 'utf8');
    return dir;
  }

  harnessRootDir(): string {
    return this.harnessRoot;
  }

  /**
   * Start a thread whose only MCP server is the absolute fake command with NO cwd
   * override, then collect the child's effective-CWD/PID/identity/sentinel evidence
   * paired with the raw requested cwd.
   */
  async startThreadCase(tag: string, requestedCwd: string, timeoutMs = 25_000): Promise<CwdCaseEvidence> {
    const threadId = await this.openThread(tag, requestedCwd, timeoutMs);
    const line = await this.waitForSentinel(tag, timeoutMs);
    return {
      tag,
      rawRequestedCwd: requestedCwd,
      threadId,
      childEffectiveCwd: line.cwd,
      childCwdIdentity: `${line.dev}:${line.ino}`,
      childPid: line.pid,
      sentinelToken: line.token,
    };
  }

  /** Start several thread cases concurrently (fire all `thread/start` before awaiting sentinels). */
  async startThreadCasesConcurrent(
    cases: Array<{ tag: string; requestedCwd: string }>,
    timeoutMs = 25_000,
  ): Promise<CwdCaseEvidence[]> {
    // Fire every thread/start first, THEN await each sentinel, so the children run
    // concurrently rather than strictly sequentially.
    const opened = await Promise.all(cases.map((c) => this.openThread(c.tag, c.requestedCwd, timeoutMs)));
    return Promise.all(
      cases.map(async (c, index) => {
        const line = await this.waitForSentinel(c.tag, timeoutMs);
        return {
          tag: c.tag,
          rawRequestedCwd: c.requestedCwd,
          threadId: opened[index] as string,
          childEffectiveCwd: line.cwd,
          childCwdIdentity: `${line.dev}:${line.ino}`,
          childPid: line.pid,
          sentinelToken: line.token,
        };
      }),
    );
  }

  /** Run a Codex-launched control process (`command/exec`) in a directory. */
  async runControl(requestedCwd: string, timeoutMs = 20_000): Promise<ControlEvidence> {
    const response = await this.request(
      'command/exec',
      { command: [this.nodeExecutable, this.controlReporter], cwd: requestedCwd },
      timeoutMs,
    );
    const result = response.result as { exitCode?: number; stdout?: string } | undefined;
    if (!result || result.exitCode !== 0 || typeof result.stdout !== 'string') {
      throw new Error(`control command/exec failed: ${JSON.stringify(response).slice(0, 300)}`);
    }
    const parsed = JSON.parse(result.stdout.trim()) as { cwd: string; dev: number; ino: number; pid: number };
    return {
      requestedCwd,
      effectiveCwd: parsed.cwd,
      cwdIdentity: `${parsed.dev}:${parsed.ino}`,
      pid: parsed.pid,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectPending(new Error('codex app-server harness closed'));
    try {
      this.child.kill('SIGKILL');
    } catch {
      // already gone
    }
    await this.waitForChildClose();
    rmSync(this.harnessRoot, { recursive: true, force: true });
  }

  // --------------------------------------------------------------------------

  private async openThread(tag: string, requestedCwd: string, timeoutMs: number): Promise<string> {
    const params = {
      cwd: requestedCwd,
      config: {
        mcp_servers: { probe: { command: this.nodeExecutable, args: [this.fakeMcpScript, this.sentinelFile, tag] } },
      },
    };
    const response = await this.request('thread/start', params, timeoutMs);
    const thread = (response.result as { thread?: { id?: string } } | undefined)?.thread;
    if (!thread?.id) throw new Error(`thread/start returned no thread id: ${JSON.stringify(response).slice(0, 300)}`);
    return thread.id;
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (error) this.rejectRequest(id, new Error(`${method} write failed: ${error.message}`));
      });
    });
  }

  private wireLifecycle(): void {
    this.child.on('error', (error) => {
      this.rejectPending(new Error(`codex app-server process error: ${error.message}`));
    });
    this.child.on('exit', (code, signal) => {
      this.rejectPending(
        new Error(`codex app-server exited before replying (code=${String(code)}, signal=${String(signal)})`),
      );
    });
    this.child.stdin.on('error', (error) => {
      this.rejectPending(new Error(`codex app-server stdin error: ${error.message}`));
    });
  }

  private wireStdout(): void {
    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }
      const id = message.id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const request = this.pending.get(id);
        this.pending.delete(id);
        if (!request) return;
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(`request error: ${JSON.stringify(message.error).slice(0, 300)}`));
        else request.resolve(message);
      }
    });
  }

  private rejectRequest(id: number, error: Error): void {
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    request.reject(error);
  }

  private rejectPending(error: Error): void {
    for (const id of [...this.pending.keys()]) {
      this.rejectRequest(id, error);
    }
  }

  private async waitForChildClose(): Promise<void> {
    if (this.childClosed) return;
    await this.childClosePromise;
  }

  private async waitForSentinel(
    tag: string,
    timeoutMs: number,
  ): Promise<{ cwd: string; pid: number; dev: number; ino: number; token: string | null }> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const lines = readFileSync(this.sentinelFile, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line) as {
          tag: string;
          cwd: string;
          pid: number;
          dev: number;
          ino: number;
          token: string | null;
        };
        if (parsed.tag === tag) return parsed;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`MCP child sentinel for tag=${tag} never appeared within ${timeoutMs}ms`);
  }
}

/**
 * Enforce the PID-reuse invariant across a set of cases: a child PID may be reused
 * ONLY when the effective-CWD string AND the OS directory identity both match.
 * Differing effective CWD (string or identity) with a shared PID is a hard failure;
 * repository/case labels alone do not permit reuse. Returns the offending pair on
 * violation, or null when the invariant holds.
 */
export function findPidCrossingDifferingCwd(
  cases: CwdCaseEvidence[],
): { a: CwdCaseEvidence; b: CwdCaseEvidence } | null {
  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      const a = cases[i] as CwdCaseEvidence;
      const b = cases[j] as CwdCaseEvidence;
      if (a.childPid !== b.childPid) continue;
      if (a.childEffectiveCwd !== b.childEffectiveCwd || a.childCwdIdentity !== b.childCwdIdentity) {
        return { a, b };
      }
    }
  }
  return null;
}
