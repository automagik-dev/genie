import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface AppServerJsonRpcEnvelope {
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
}

type ErrorKind = 'process' | 'rpc' | 'timeout' | 'cleanup';

interface TransportOptions<E extends Error> {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  initializeParams: unknown;
  initializeTimeoutMs: number;
  cleanupGraceMs: number;
  initialSignal: 'SIGTERM' | 'SIGKILL';
  label: string;
  error: (kind: ErrorKind, message: string, cause?: Error) => E;
  windowsHide?: boolean;
}

interface Pending {
  method: string;
  resolve: (message: AppServerJsonRpcEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Process-owning newline JSON-RPC transport shared by the independent evidence builders. */
export class CodexAppServerTransport<E extends Error = Error> {
  private readonly pending = new Map<number, Pending>();
  private readonly closed: Promise<void>;
  private closing: Promise<E | null> | null = null;
  private nextId = 1;
  private didClose = false;
  private stderr = '';

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: TransportOptions<E>,
  ) {
    this.closed = new Promise((resolve) =>
      child.once('close', () => {
        this.didClose = true;
        resolve();
      }),
    );
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384);
    });
    child.on('error', (error) => this.rejectAll(this.error('process', `process error: ${error.message}`, error)));
    child.on('exit', (code, signal) =>
      this.rejectAll(
        this.error(
          'process',
          `exited before replying (code=${String(code)}, signal=${String(signal)}): ${this.stderr.trim().slice(-2_000)}`,
        ),
      ),
    );
    child.stdin.on('error', (error) => this.rejectAll(this.error('rpc', `stdin error: ${error.message}`, error)));
    createInterface({ input: child.stdout }).on('line', (line) => this.receive(line));
  }

  static async launch<E extends Error>(options: TransportOptions<E>): Promise<CodexAppServerTransport<E>> {
    const child = spawn(options.executable, options.args, {
      detached: process.platform !== 'win32',
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: options.windowsHide,
    }) as ChildProcessWithoutNullStreams;
    child.on('error', () => {}); // prevent a late spawn failure from becoming unhandled
    const transport = new CodexAppServerTransport(child, options);
    try {
      await transport.request('initialize', options.initializeParams, options.initializeTimeoutMs);
      transport.notify('initialized', {});
      return transport;
    } catch (error) {
      const cleanupError = await transport.close();
      if (cleanupError) {
        throw new AggregateError([asError(error), cleanupError], `${options.label} initialize and cleanup both failed`);
      }
      throw error;
    }
  }

  pid(): number {
    const pid = this.child.pid;
    if (pid === undefined) throw this.error('process', 'has no process id');
    return pid;
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<AppServerJsonRpcEnvelope> {
    if (this.closing) return Promise.reject(this.error('process', `${method} requested after close`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.error('timeout', `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (writeError) => {
          if (writeError)
            this.reject(id, this.error('rpc', `${method} write failed: ${writeError.message}`, writeError));
        });
      } catch (error) {
        this.reject(id, this.error('rpc', `${method} write failed`, asError(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closing) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`, () => {});
    } catch {}
  }

  close(candidatePid?: number): Promise<E | null> {
    this.closing ??= this.closeOnce(candidatePid);
    return this.closing;
  }

  private async closeOnce(candidatePid: number | undefined): Promise<E | null> {
    this.rejectAll(this.error('process', 'evidence session closed'));
    const appPid = this.child.pid;
    const treePid = process.platform === 'win32' ? appPid : appPid === undefined ? undefined : -appPid;
    const targets = [candidatePid, appPid, treePid];
    const failures: Error[] = [];
    signal(candidatePid, this.options.initialSignal, failures);
    signal(treePid, this.options.initialSignal, failures);
    await waitStopped(targets, this.options.cleanupGraceMs);
    signal(candidatePid, 'SIGKILL', failures);
    signal(treePid, 'SIGKILL', failures);
    await Promise.race([this.closed, delay(this.options.cleanupGraceMs)]);
    await waitStopped(targets, this.options.cleanupGraceMs);
    if (running(candidatePid)) failures.push(new Error(`candidate process ${String(candidatePid)} survived SIGKILL`));
    if (running(treePid)) failures.push(new Error(`app-server process group ${String(appPid)} survived SIGKILL`));
    if (running(appPid) || !this.didClose)
      failures.push(new Error(`app-server process ${String(appPid)} did not close`));
    if (failures.length === 0) return null;
    const message = `${this.options.label} cleanup failed: ${failures.map((failure) => failure.message).join('; ')}`;
    return this.error('cleanup', message, new AggregateError(failures));
  }

  private receive(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const message = parsed as AppServerJsonRpcEnvelope;
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error === undefined) pending.resolve(message);
    else pending.reject(this.error('rpc', `${pending.method} error: ${truncate(message.error)}`));
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private rejectAll(error: Error): void {
    for (const id of [...this.pending.keys()]) this.reject(id, error);
  }

  private error(kind: ErrorKind, message: string, cause?: Error): E {
    return this.options.error(kind, `codex app-server ${message}`, cause);
  }
}

function signal(pid: number | undefined, value: NodeJS.Signals, failures: Error[]): void {
  if (pid === undefined || Math.abs(pid) <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failures.push(asError(error));
  }
}

function running(pid: number | undefined): boolean {
  if (pid === undefined || Math.abs(pid) <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitStopped(pids: Array<number | undefined>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(running) && Date.now() < deadline) await delay(25);
}

function truncate(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return String(value).slice(0, 1_000);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
