/**
 * REPL manager — Node.js side.
 *
 * Spawns a Python subprocess running repl_server.py, communicates via
 * JSON lines over stdin/stdout, handles lifecycle and per-execution timeout.
 *
 * Features:
 *   - Crash recovery: restarts subprocess and retries once on crash
 *   - Battery tracking: records which battery functions were called
 *   - Tool levels: core / standard (+ batteries) / full (+ package info)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ExecuteResult,
  LLMRequest,
  LLMResponseMessage,
  PythonToNode,
} from "./ipc.js";
import type { ToolsLevel } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolResolver } from "./sdk/agent.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Default paths — __dirname is dist/src/ when compiled, python/ is at repo root (../../python/)
const REPL_SERVER_PATH = join(__dirname, "..", "..", "python", "repl_server.py");
const BATTERIES_PATH = join(__dirname, "..", "..", "python", "batteries.py");
const GEMINI_BATTERIES_PATH = join(__dirname, "..", "..", "python", "gemini_batteries.py");
const PG_BATTERIES_PATH = join(__dirname, "..", "..", "python", "pg_batteries.py");

/** Battery function names — tracked for stats. */
const BATTERY_FUNCTION_NAMES = [
  "describe_context",
  "preview_context",
  "search_context",
  "grep_context",
  "chunk_context",
  "chunk_text",
  "map_query",
  "reduce_query",
] as const;

/** Gemini battery function names — tracked for Gemini stats. */
const GEMINI_BATTERY_FUNCTION_NAMES = [
  "web_search",
  "fetch_url",
  "generate_image",
] as const;

/** Names supplied by the REPL runtime and battery modules. */
export const REPL_RESERVED_NAMES: ReadonlySet<string> = new Set([
  "context",
  "llm_query",
  "rlm_query",
  "llm_query_batched",
  "rlm_query_batched",
  "FINAL_VAR",
  "FINAL",
  "SHOW_VARS",
  "call_tool",
  ...BATTERY_FUNCTION_NAMES,
  "run_cli",
  ...GEMINI_BATTERY_FUNCTION_NAMES,
  "pg_search",
  "pg_slice",
  "pg_sources",
  "pg_time",
  "pg_count",
  "pg_query",
]);

/** Context snapshots are serialized once per subprocess generation. */
export type REPLContext = string | unknown[] | Record<string, unknown>;

/** Options passed to REPL.start() */
export interface REPLStartOptions {
  /** Context to inject (string, list, or dict serialized as JSON string). */
  context?: REPLContext;
  /** Custom tools to inject as Python code strings (name -> code). */
  tools?: Record<string, string>;
  /** Tool level: core (6 paper functions), standard (+ batteries), full (+ package info). */
  toolsLevel?: ToolsLevel;
  /** Whether to load Gemini batteries (web_search, fetch_url, generate_image). */
  loadGeminiBatteries?: boolean;
  /** Whether to load pg_batteries (pg_search, pg_slice, etc.) for storage mode. */
  loadPgBatteries?: boolean;
  /** Python executable path (default: "python3"). */
  pythonPath?: string;
  /** Path to repl_server.py (auto-detected). */
  serverPath?: string;
  /** Optional logger for crash events and diagnostics. */
  logger?: Logger;
  /** Enclosing run cancellation/deadline; remains in force during recovery. */
  signal?: AbortSignal;
}

/** Callback for handling LLM requests from the Python REPL. */
export type LLMRequestHandler = (
  request: LLMRequest,
  signal: AbortSignal
) => Promise<string[]>;

export function defaultReplTimeoutMs(): number {
  const raw = process.env.MIKRO_REPL_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  return parsed;
}

interface ToolRequestMessage {
  type: "tool_request";
  tool: string;
  args: unknown;
}

type ReplMessage = PythonToNode | ToolRequestMessage;

const LLM_REQUEST_TYPES: Record<LLMRequest["request_type"], true> = {
  llm_query: true, llm_query_batched: true, rlm_query: true, rlm_query_batched: true,
  web_search: true, fetch_url: true, generate_image: true,
  pg_search: true, pg_slice: true, pg_time: true, pg_count: true, pg_query: true,
};

/** Validate subprocess records before they enter the bridge message queue. */
function parseReplMessage(value: unknown): ReplMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  // JSON objects have been checked; fields remain unknown until narrowed below.
  const record = value as Record<string, unknown>;
  if (record.type === "ready") return { type: "ready" };
  if (record.type === "tool_request" && typeof record.tool === "string") {
    return { type: "tool_request", tool: record.tool, args: record.args };
  }
  if (record.type === "llm_request" && typeof record.request_type === "string" &&
      Object.hasOwn(LLM_REQUEST_TYPES, record.request_type) && Array.isArray(record.prompts) &&
      record.prompts.every((prompt: unknown) => typeof prompt === "string") &&
      (record.model === undefined || typeof record.model === "string")) {
    // The preceding allowlist checked the IPC request-type enum.
    const requestType = record.request_type as LLMRequest["request_type"];
    return { type: "llm_request", request_type: requestType, prompts: record.prompts, model: record.model };
  }
  if (record.type !== "execute_result" || typeof record.stdout !== "string" ||
      typeof record.stderr !== "string" || !Array.isArray(record.variables) ||
      !record.variables.every((name: unknown) => typeof name === "string") ||
      (record.error !== undefined && typeof record.error !== "string")) return null;
  const result: ExecuteResult = {
    type: "execute_result", stdout: record.stdout, stderr: record.stderr,
    variables: record.variables, error: record.error,
  };
  if (record.final !== undefined) {
    if (typeof record.final !== "object" || record.final === null || Array.isArray(record.final)) return null;
    // Checked object, with type/value still unknown.
    const final = record.final as Record<string, unknown>;
    if ((final.type !== "var" && final.type !== "inline") || typeof final.value !== "string") return null;
    result.final = { type: final.type, value: final.value };
  }
  return result;
}

type ToolResponseMessage =
  | { type: "tool_response"; ok: true; result: unknown }
  | { type: "tool_response"; ok: false; error: string };

function errorString(value: unknown): string {
  try {
    if (value instanceof Error) return value.message;
    return String(value);
  } catch {
    return "Unknown tool bridge error";
  }
}

/** A block ran once, timed out, and lost its namespace; execute never replays it. */
export class REPLTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`REPL execution timed out after ${timeoutMs}ms. The REPL was restarted with original context and tools; all user-created variables were lost. The timed-out block was not replayed.`);
    this.name = "REPLTimeoutError";
  }
}

export class REPL {
  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private ready = false;
  private pendingResolve: ((msg: ReplMessage) => void) | null = null;
  private pendingReject: ((err: Error) => void) | null = null;
  private llmHandler: LLMRequestHandler | null = null;
  private toolHandler: ToolResolver | null = null;
  private messageBuffer: ReplMessage[] = [];
  private generation = 0;
  private lifecycle = 0;
  private childController = new AbortController();
  private removeRunAbort: (() => void) | null = null;

  // Crash recovery state
  private _startOptions: REPLStartOptions = {};
  private _recovering = false;
  private _initializing = false;

  // Battery tracking
  private _batteriesUsed = new Set<string>();
  private _geminiBatteriesUsed = new Set<string>();
  private _skipTracking = false;

  // Optional logger
  private _logger: Logger | null = null;

  /** Set a handler for LLM requests from Python REPL code. */
  onLLMRequest(handler: LLMRequestHandler): void {
    this.llmHandler = handler;
  }

  /** Set a handler for tool requests from Python REPL code. */
  onToolRequest(handler: ToolResolver): void {
    this.toolHandler = handler;
  }

  /** Start the Python REPL subprocess. */
  async start(options: REPLStartOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const lifecycle = ++this.lifecycle;
    this._recovering = false;
    this._initializing = false;
    this._skipTracking = false;
    await this._start(options, lifecycle);
  }

  /** Startup and recovery keep ownership across every asynchronous boundary. */
  private async _start(options: REPLStartOptions, lifecycle: number): Promise<void> {
    this._assertLifecycle(lifecycle);
    options.signal?.throwIfAborted();
    if (this.process) await this._detachAndWait(true);
    this._assertLifecycle(lifecycle);
    options.signal?.throwIfAborted();
    this._startOptions = {
      ...options,
      context: options.context === undefined ? undefined : structuredClone(options.context),
      tools: options.tools ? { ...options.tools } : undefined,
    };
    options = this._startOptions;
    this._logger = options.logger ?? null;

    const pythonPath = options.pythonPath ?? "python3";
    const serverPath = options.serverPath ?? REPL_SERVER_PATH;

    this.process = spawn(pythonPath, [serverPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });

    const child = this.process;
    const generation = ++this.generation;
    this.childController = new AbortController();
    this.readline = createInterface({ input: child.stdout! });
    const rejectChild = (error: Error): void => {
      if (this.process !== child || this.generation !== generation) return;
      this.ready = false;
      this._rejectPending(error);
    };
    // Writable errors are asynchronous (not caught by write()); always own EPIPE.
    child.stdin?.on("error", rejectChild);
    child.on("error", rejectChild);
    const onAbort = (): void => {
      rejectChild(new Error("REPL run cancelled", { cause: options.signal?.reason }));
      this.childController.abort(options.signal?.reason);
      child.kill("SIGKILL");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.removeRunAbort = () => options.signal?.removeEventListener("abort", onAbort);

    // Route each JSON line from Python
    this.readline.on("line", (line: string) => {
      let msg: ReplMessage | null;
      try {
        const value: unknown = JSON.parse(line);
        msg = parseReplMessage(value);
      } catch {
        return;
      }
      if (msg && this.process === child && this.generation === generation) this._handleMessage(msg);
    });

    // Collect stderr for diagnostics
    this.process.stderr?.on("data", () => {
      // stderr from Python subprocess — swallow silently
    });

    // Detect unexpected subprocess exit for crash recovery
    child.on("exit", () => {
      rejectChild(new Error("REPL subprocess exited unexpectedly"));
    });

    try {
      await this._waitForMessage("ready");
      this._assertLifecycle(lifecycle);
      options.signal?.throwIfAborted();
      this.ready = true;
    } catch (error) {
      if (lifecycle === this.lifecycle) await this._detachAndWait(true);
      throw error;
    }

    this._initializing = true;
    try {
      if (options.context !== undefined) {
        await this._injectContext(options.context);
        this._assertLifecycle(lifecycle);
      }
      if (options.tools) {
        for (const [name, code] of Object.entries(options.tools)) {
          try {
            const result = await this.execute(code);
            this._assertLifecycle(lifecycle);
            if (result.error) throw new Error(result.error);
          } catch (error: unknown) {
            throw new Error(`Failed to install REPL tool ${JSON.stringify(name)}: ${errorString(error)}`);
          }
        }
      }
      const level = options.toolsLevel ?? "core";
      if (level === "standard" || level === "full") {
        await this._loadBatteries(lifecycle);
        if (options.loadGeminiBatteries) await this._loadGeminiBatteries(lifecycle);
      }
      if (options.loadPgBatteries) await this._loadPgBatteries(lifecycle);
      this._assertLifecycle(lifecycle);
      options.signal?.throwIfAborted();
    } catch (error: unknown) {
      if (lifecycle === this.lifecycle) await this._detachAndWait(true);
      throw error;
    } finally {
      if (lifecycle === this.lifecycle) this._initializing = false;
    }
  }

  /** Execute Python code in the REPL and return the result. */
  async execute(code: string, timeoutMs = defaultReplTimeoutMs()): Promise<ExecuteResult> {
    this._startOptions.signal?.throwIfAborted();
    const lifecycle = this.lifecycle;
    const options = this._startOptions;
    // Distinguish "never started" from "started but crashed"
    if (!this.process) {
      throw new Error("REPL not started. Call start() first.");
    }

    // Process was started but has since crashed — attempt recovery
    if (!this.ready && !this._recovering) {
      return this._recoverAndRetry(
        code,
        timeoutMs,
        new Error("REPL subprocess exited unexpectedly"),
        lifecycle
      );
    }

    if (!this.ready) {
      throw new Error("REPL not started. Call start() first.");
    }

    // Track battery usage
    this._trackBatteryUsage(code);

    try {
      this._send({ type: "execute", code });
      return await this._waitForExecuteResult(timeoutMs);
    } catch (err: unknown) {
      this._assertLifecycle(lifecycle);
      if (err instanceof REPLTimeoutError) {
        // Kill and wait before installing a replacement; never rerun code.
        await this._detachAndWait(true);
        this._assertLifecycle(lifecycle);
        options.signal?.throwIfAborted();
        if (this._recovering || this._initializing) {
          throw new Error("REPL initialization timed out; no code was replayed", { cause: err });
        }
        this._recovering = true;
        try {
          await this._start(options, lifecycle);
        } catch (restartError: unknown) {
          if (lifecycle === this.lifecycle) await this._detachAndWait(true);
          throw new Error(`REPL timeout recovery failed; user-created variables were lost. ${errorString(restartError)}`, { cause: restartError });
        } finally {
          if (lifecycle === this.lifecycle) this._recovering = false;
        }
        throw err;
      }
      this._startOptions.signal?.throwIfAborted();
      if (!this.process) throw err; // stop() owns a detached generation.
      // Attempt crash recovery if process died (not during recovery itself)
      if (!this._recovering && !this._initializing && !this.isRunning()) {
        return this._recoverAndRetry(code, timeoutMs, err instanceof Error ? err : new Error(String(err)), lifecycle);
      }
      throw err;
    }
  }

  /** Reset the REPL namespace. */
  async reset(): Promise<void> {
    if (!this.process || !this.ready) return;
    this._send({ type: "reset" });
    await this._waitForMessage("execute_result");
  }

  /** Stop the Python subprocess. */
  async stop(): Promise<void> {
    this.lifecycle++;
    this._recovering = false;
    this._initializing = false;
    this._skipTracking = false;
    await this._detachAndWait(false);
  }

  /** Check if the REPL subprocess is running. */
  isRunning(): boolean {
    return this.ready && this.process !== null && this.process.exitCode === null && this.process.signalCode === null;
  }

  /** Get list of battery functions that were called during this session. */
  getBatteriesUsed(): string[] {
    return [...this._batteriesUsed];
  }

  /** Get list of Gemini battery functions that were called during this session. */
  getGeminiBatteriesUsed(): string[] {
    return [...this._geminiBatteriesUsed];
  }

  // ─── Internal ────────────────────────────────────────────
  private _assertLifecycle(lifecycle: number): void {
    if (lifecycle !== this.lifecycle) {
      throw new Error("REPL lifecycle cancelled by stop() or a newer start()");
    }
  }

  private _rejectPending(error: Error): void {
    const reject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    reject?.(error);
  }

  /** Retire this generation synchronously, then wait for its actual exit. */
  private async _detachAndWait(kill: boolean): Promise<void> {
    const child = this.process;
    if (!child) return;
    if (!kill && child.exitCode === null && child.signalCode === null) {
      try { this._send({ type: "shutdown" }); } catch { /* Already dead. */ }
    }
    this.process = null;
    this.ready = false;
    this.generation++;
    this.removeRunAbort?.();
    this.removeRunAbort = null;
    this.childController.abort(new Error("REPL generation retired"));
    this.readline?.close();
    this.readline = null;
    this.messageBuffer = [];
    this._rejectPending(new Error("REPL generation retired"));
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        if (kill) child.kill("SIGKILL");
      });
    }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
  }

  private async _loadBatteries(lifecycle: number): Promise<void> {
    const code = await readFile(BATTERIES_PATH, "utf-8");
    this._assertLifecycle(lifecycle);
    // Skip battery tracking for the definition code itself
    this._skipTracking = true;
    await this.execute(code);
    this._assertLifecycle(lifecycle);
    this._skipTracking = false;
  }

  private async _loadGeminiBatteries(lifecycle: number): Promise<void> {
    const code = await readFile(GEMINI_BATTERIES_PATH, "utf-8");
    this._assertLifecycle(lifecycle);
    this._skipTracking = true;
    await this.execute(code);
    this._assertLifecycle(lifecycle);
    this._skipTracking = false;
  }

  private async _loadPgBatteries(lifecycle: number): Promise<void> {
    const code = await readFile(PG_BATTERIES_PATH, "utf-8");
    this._assertLifecycle(lifecycle);
    this._skipTracking = true;
    await this.execute(code);
    this._assertLifecycle(lifecycle);
    this._skipTracking = false;
  }

  /** Track which battery functions appear in executed code. */
  private _trackBatteryUsage(code: string): void {
    if (this._skipTracking) return;
    for (const name of BATTERY_FUNCTION_NAMES) {
      if (code.includes(name)) {
        this._batteriesUsed.add(name);
      }
    }
    for (const name of GEMINI_BATTERY_FUNCTION_NAMES) {
      if (code.includes(name)) {
        this._geminiBatteriesUsed.add(name);
      }
    }
  }

  /** Restart subprocess after a crash and retry the failed code once. */
  private async _recoverAndRetry(
    code: string,
    timeoutMs: number,
    originalError: Error,
    lifecycle: number
  ): Promise<ExecuteResult> {
    this._assertLifecycle(lifecycle);
    const options = this._startOptions;
    this._recovering = true;
    this._logger?.log("repl_exec", {
      crash_recovery: true,
      code_length: code.length,
      original_error: originalError.message,
    });

    try {
      await this._detachAndWait(true);
      this._assertLifecycle(lifecycle);
      options.signal?.throwIfAborted();
      // Restart with same options, unless explicit lifecycle control intervened.
      await this._start(options, lifecycle);
      this._assertLifecycle(lifecycle);

      // Retry execution once
      this._send({ type: "execute", code });
      return await this._waitForExecuteResult(timeoutMs);
    } catch (retryErr) {
      if (lifecycle === this.lifecycle) await this._detachAndWait(true);
      throw new Error(
        `REPL subprocess crashed and recovery failed. ` +
          `Original: ${originalError.message}. ` +
          `Retry: ${errorString(retryErr)}`
      );
    } finally {
      if (lifecycle === this.lifecycle) this._recovering = false;
    }
  }

  private _send(msg: Record<string, unknown>): void {
    const child = this.process;
    if (!child?.stdin?.writable || child.stdin.destroyed || child.exitCode !== null || child.signalCode !== null) {
      throw new Error("REPL subprocess stdin not writable");
    }
    child.stdin.write(JSON.stringify(msg) + "\n", (error) => {
      if (error && this.process === child) this._rejectPending(error);
    });
  }

  private _handleMessage(msg: ReplMessage): void {
    if (this.pendingResolve) {
      this.pendingResolve(msg);
      this.pendingResolve = null;
      this.pendingReject = null;
    } else {
      this.messageBuffer.push(msg);
    }
  }

  private _nextMessage(): Promise<ReplMessage> {
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) {
      return Promise.reject(new Error("REPL subprocess exited unexpectedly"));
    }
    // Check buffer first
    if (this.messageBuffer.length > 0) {
      return Promise.resolve(this.messageBuffer.shift()!);
    }
    return new Promise((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;
    });
  }

  private async _waitForMessage(
    expectedType: string,
    timeoutMs = 10_000
  ): Promise<ReplMessage> {
    return new Promise<ReplMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timeout waiting for "${expectedType}" message`));
        this._rejectPending(new Error(`Timeout waiting for "${expectedType}" message`));
      }, timeoutMs);

      const check = async () => {
        const msg = await this._nextMessage();
        if (msg.type === expectedType) {
          clearTimeout(timeout);
          resolve(msg);
        } else {
          // Unexpected message type — keep waiting
          check().catch((err) => {
            clearTimeout(timeout);
            reject(err);
          });
        }
      };
      check().catch((err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async _waitForExecuteResult(
    timeoutMs: number
  ): Promise<ExecuteResult> {
    return new Promise<ExecuteResult>((resolve, reject) => {
      const generation = this.generation;
      const signal = this.childController.signal;
      let settled = false;
      let llmError: string | undefined;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          const error = new REPLTimeoutError(timeoutMs);
          this.childController.abort(error);
          this._rejectPending(error);
          reject(error);
        }
      }, timeoutMs);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      const processMessages = async () => {
        while (!settled) {
          const msg = await this._nextMessage();
          if (settled || generation !== this.generation) return;

          if (msg.type === "execute_result") {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              signal.removeEventListener("abort", onAbort);
              // A caught Python exception or an earlier FINAL cannot turn a
              // failed child operation into a successful execution.
              resolve(llmError === undefined ? msg : {
                ...msg,
                error: msg.error ?? llmError,
                llmError,
                final: undefined,
              });
            }
            return;
          }

          if (msg.type === "llm_request") {
            // Handle LLM request from Python
            const llmReq = msg;
            let response: LLMResponseMessage;

            try {
              if (!this.llmHandler) throw new Error("No LLM handler configured");
              const results = await this.llmHandler(llmReq, signal);
              response = { type: "llm_response", ok: true, results };
            } catch (err: unknown) {
              const error = `LLM handler failed — ${errorString(err)}`;
              if (llmError === undefined) llmError = error;
              response = { type: "llm_response", ok: false, error };
            }

            if (settled || signal.aborted || generation !== this.generation) return;
            this._send(response);
          }

          if (msg.type === "tool_request") {
            await this._handleToolRequest(msg, generation, signal);
          }
          // Other message types during execution — ignore
        }
      };

      processMessages().catch((err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
          reject(err);
        }
      });
    });
  }

  /** Handle a tool request without allowing bridge failures to reject execute(). */
  private async _handleToolRequest(request: ToolRequestMessage, generation: number, signal: AbortSignal): Promise<void> {
    let response: ToolResponseMessage;

    try {
      if (!this.toolHandler) {
        throw new Error("No tool handler configured");
      }

      const result = await this.toolHandler(
        request.tool,
        request.args,
        signal
      );
      const serialized = JSON.stringify(result);
      if (serialized === undefined) {
        throw new TypeError("Tool result is not JSON-serializable");
      }
      response = {
        type: "tool_response",
        ok: true,
        result: JSON.parse(serialized) as unknown,
      };
    } catch (err: unknown) {
      response = {
        type: "tool_response",
        ok: false,
        error: errorString(err),
      };
    }
    if (signal.aborted || generation !== this.generation) return;

    try {
      this._send(response);
    } catch (sendErr: unknown) {
      // A one-off write failure can still become a protocol-level error when
      // the transport accepts this fallback. No send failure escapes here.
      try {
        this._send({
          type: "tool_response",
          ok: false,
          error: `Tool response send failed: ${errorString(sendErr)}`,
        });
      } catch {
        // The execute timeout/crash recovery path owns a dead transport.
      }
    }
  }

  private async _injectContext(
    context: REPLContext
  ): Promise<void> {
    let value: string;
    let valueType: "str" | "list" | "dict";

    if (typeof context === "string") {
      value = context;
      valueType = "str";
    } else if (Array.isArray(context)) {
      value = JSON.stringify(context);
      valueType = "list";
    } else {
      value = JSON.stringify(context);
      valueType = "dict";
    }

    this._send({
      type: "inject",
      name: "context_0",
      value,
      value_type: valueType,
    });

    await this._waitForMessage("execute_result");
  }
}
