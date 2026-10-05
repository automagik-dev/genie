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
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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
];
/** Gemini battery function names — tracked for Gemini stats. */
const GEMINI_BATTERY_FUNCTION_NAMES = [
    "web_search",
    "fetch_url",
    "generate_image",
];
/** Names supplied by the REPL runtime and battery modules. */
export const REPL_RESERVED_NAMES = new Set([
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
export function defaultReplTimeoutMs() {
    const raw = process.env.MIKRO_REPL_TIMEOUT_MS;
    if (!raw)
        return 30_000;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 30_000;
    return parsed;
}
function errorString(value) {
    try {
        if (value instanceof Error)
            return value.message;
        return String(value);
    }
    catch {
        return "Unknown tool bridge error";
    }
}
export class REPL {
    process = null;
    readline = null;
    ready = false;
    pendingResolve = null;
    pendingReject = null;
    llmHandler = null;
    toolHandler = null;
    messageBuffer = [];
    toolSignal = new AbortController().signal;
    // Crash recovery state
    _startOptions = {};
    _recovering = false;
    // Battery tracking
    _batteriesUsed = new Set();
    _geminiBatteriesUsed = new Set();
    _skipTracking = false;
    // Optional logger
    _logger = null;
    /** Set a handler for LLM requests from Python REPL code. */
    onLLMRequest(handler) {
        this.llmHandler = handler;
    }
    /** Set a handler for tool requests from Python REPL code. */
    onToolRequest(handler) {
        this.toolHandler = handler;
    }
    /** Start the Python REPL subprocess. */
    async start(options = {}) {
        this._startOptions = options;
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
        this.readline = createInterface({ input: this.process.stdout });
        // Route each JSON line from Python
        this.readline.on("line", (line) => {
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                // Not JSON — ignore (should not happen with correct server)
                return;
            }
            this._handleMessage(msg);
        });
        // Collect stderr for diagnostics
        this.process.stderr?.on("data", () => {
            // stderr from Python subprocess — swallow silently
        });
        // Detect unexpected subprocess exit for crash recovery
        this.process.on("exit", () => {
            this.ready = false;
            if (this.pendingReject) {
                this.pendingReject(new Error("REPL subprocess exited unexpectedly"));
                this.pendingReject = null;
                this.pendingResolve = null;
            }
        });
        // Wait for the "ready" message
        await this._waitForMessage("ready");
        this.ready = true;
        // Inject context if provided
        if (options.context !== undefined) {
            await this._injectContext(options.context);
        }
        // Inject custom tools if provided
        if (options.tools) {
            for (const [name, code] of Object.entries(options.tools)) {
                try {
                    const result = await this.execute(code);
                    if (result.error)
                        throw new Error(result.error);
                }
                catch (err) {
                    // A partially installed namespace must never look ready, including
                    // when start() is reinstalling tools during crash recovery.
                    await this.stop().catch(() => { });
                    throw new Error(`Failed to install REPL tool ${JSON.stringify(name)}: ${errorString(err)}`);
                }
            }
        }
        // Load batteries for standard/full tool levels
        const level = options.toolsLevel ?? "core";
        if (level === "standard" || level === "full") {
            await this._loadBatteries();
            // Load Gemini batteries when requested (Google provider with standard/full tools)
            if (options.loadGeminiBatteries) {
                await this._loadGeminiBatteries();
            }
        }
        // Load pg_batteries when storage mode is active (independent of tools level)
        if (options.loadPgBatteries) {
            await this._loadPgBatteries();
        }
    }
    /** Execute Python code in the REPL and return the result. */
    async execute(code, timeoutMs = defaultReplTimeoutMs()) {
        // Distinguish "never started" from "started but crashed"
        if (!this.process) {
            throw new Error("REPL not started. Call start() first.");
        }
        // Process was started but has since crashed — attempt recovery
        if (!this.ready && !this._recovering) {
            return this._recoverAndRetry(code, timeoutMs, new Error("REPL subprocess exited unexpectedly"));
        }
        if (!this.ready) {
            throw new Error("REPL not started. Call start() first.");
        }
        // Track battery usage
        this._trackBatteryUsage(code);
        try {
            this._send({ type: "execute", code });
            return await this._waitForExecuteResult(timeoutMs);
        }
        catch (err) {
            // Attempt crash recovery if process died (not during recovery itself)
            if (!this._recovering && !this.isRunning()) {
                return this._recoverAndRetry(code, timeoutMs, err instanceof Error ? err : new Error(String(err)));
            }
            throw err;
        }
    }
    /** Reset the REPL namespace. */
    async reset() {
        if (!this.process || !this.ready)
            return;
        this._send({ type: "reset" });
        await this._waitForMessage("execute_result");
    }
    /** Stop the Python subprocess. */
    async stop() {
        if (!this.process)
            return;
        try {
            this._send({ type: "shutdown" });
        }
        catch {
            // stdin may already be closed
        }
        // Give it 2s to exit gracefully, then kill
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                this.process?.kill("SIGKILL");
                resolve();
            }, 2000);
            this.process.on("exit", () => {
                clearTimeout(timeout);
                resolve();
            });
        });
        this.readline?.close();
        this.process = null;
        this.readline = null;
        this.ready = false;
    }
    /** Check if the REPL subprocess is running. */
    isRunning() {
        return this.ready && this.process !== null && this.process.exitCode === null;
    }
    /** Get list of battery functions that were called during this session. */
    getBatteriesUsed() {
        return [...this._batteriesUsed];
    }
    /** Get list of Gemini battery functions that were called during this session. */
    getGeminiBatteriesUsed() {
        return [...this._geminiBatteriesUsed];
    }
    // ─── Internal ────────────────────────────────────────────
    async _loadBatteries() {
        const code = await readFile(BATTERIES_PATH, "utf-8");
        // Skip battery tracking for the definition code itself
        this._skipTracking = true;
        await this.execute(code);
        this._skipTracking = false;
    }
    async _loadGeminiBatteries() {
        const code = await readFile(GEMINI_BATTERIES_PATH, "utf-8");
        this._skipTracking = true;
        await this.execute(code);
        this._skipTracking = false;
    }
    async _loadPgBatteries() {
        const code = await readFile(PG_BATTERIES_PATH, "utf-8");
        this._skipTracking = true;
        await this.execute(code);
        this._skipTracking = false;
    }
    /** Track which battery functions appear in executed code. */
    _trackBatteryUsage(code) {
        if (this._skipTracking)
            return;
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
    async _recoverAndRetry(code, timeoutMs, originalError) {
        this._recovering = true;
        this._logger?.log("repl_exec", {
            crash_recovery: true,
            code_length: code.length,
            original_error: originalError.message,
        });
        try {
            // Clean up dead process state
            this.readline?.close();
            this.process = null;
            this.readline = null;
            this.ready = false;
            this.messageBuffer = [];
            this.pendingResolve = null;
            this.pendingReject = null;
            // Restart with same options
            await this.start(this._startOptions);
            // Retry execution once
            this._send({ type: "execute", code });
            return await this._waitForExecuteResult(timeoutMs);
        }
        catch (retryErr) {
            throw new Error(`REPL subprocess crashed and recovery failed. ` +
                `Original: ${originalError.message}. ` +
                `Retry: ${retryErr.message}`);
        }
        finally {
            this._recovering = false;
        }
    }
    _send(msg) {
        if (!this.process?.stdin?.writable) {
            throw new Error("REPL subprocess stdin not writable");
        }
        this.process.stdin.write(JSON.stringify(msg) + "\n");
    }
    _handleMessage(msg) {
        if (this.pendingResolve) {
            this.pendingResolve(msg);
            this.pendingResolve = null;
            this.pendingReject = null;
        }
        else {
            this.messageBuffer.push(msg);
        }
    }
    _nextMessage() {
        // Check buffer first
        if (this.messageBuffer.length > 0) {
            return Promise.resolve(this.messageBuffer.shift());
        }
        return new Promise((resolve, reject) => {
            this.pendingResolve = resolve;
            this.pendingReject = reject;
        });
    }
    async _waitForMessage(expectedType, timeoutMs = 10_000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error(`Timeout waiting for "${expectedType}" message`));
            }, timeoutMs);
            const check = async () => {
                const msg = await this._nextMessage();
                if (msg.type === expectedType) {
                    clearTimeout(timeout);
                    resolve(msg);
                }
                else {
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
    async _waitForExecuteResult(timeoutMs) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    // Kill the subprocess on timeout
                    this.process?.kill("SIGKILL");
                    reject(new Error(`REPL execution timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);
            const processMessages = async () => {
                while (!settled) {
                    const msg = await this._nextMessage();
                    if (msg.type === "execute_result") {
                        if (!settled) {
                            settled = true;
                            clearTimeout(timeout);
                            resolve(msg);
                        }
                        return;
                    }
                    if (msg.type === "llm_request") {
                        // Handle LLM request from Python
                        const llmReq = msg;
                        let results;
                        if (this.llmHandler) {
                            try {
                                results = await this.llmHandler(llmReq);
                            }
                            catch (err) {
                                const msg = err instanceof Error ? err.message : String(err);
                                results = llmReq.prompts.map(() => `Error: LLM handler failed — ${msg}`);
                            }
                        }
                        else {
                            results = llmReq.prompts.map(() => "Error: No LLM handler configured");
                        }
                        // Send response back to Python
                        this._send({ type: "llm_response", results });
                    }
                    if (msg.type === "tool_request") {
                        await this._handleToolRequest(msg);
                    }
                    // Other message types during execution — ignore
                }
            };
            processMessages().catch((err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(err);
                }
            });
        });
    }
    /** Handle a tool request without allowing bridge failures to reject execute(). */
    async _handleToolRequest(request) {
        let response;
        try {
            if (!this.toolHandler) {
                throw new Error("No tool handler configured");
            }
            const result = await this.toolHandler(request.tool, request.args, this.toolSignal);
            const serialized = JSON.stringify(result);
            if (serialized === undefined) {
                throw new TypeError("Tool result is not JSON-serializable");
            }
            response = {
                type: "tool_response",
                ok: true,
                result: JSON.parse(serialized),
            };
        }
        catch (err) {
            response = {
                type: "tool_response",
                ok: false,
                error: errorString(err),
            };
        }
        try {
            this._send(response);
        }
        catch (sendErr) {
            // A one-off write failure can still become a protocol-level error when
            // the transport accepts this fallback. No send failure escapes here.
            try {
                this._send({
                    type: "tool_response",
                    ok: false,
                    error: `Tool response send failed: ${errorString(sendErr)}`,
                });
            }
            catch {
                // The execute timeout/crash recovery path owns a dead transport.
            }
        }
    }
    async _injectContext(context) {
        let value;
        let valueType;
        if (typeof context === "string") {
            value = context;
            valueType = "str";
        }
        else if (Array.isArray(context)) {
            value = JSON.stringify(context);
            valueType = "list";
        }
        else {
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
//# sourceMappingURL=repl.js.map