/**
 * JSONL structured log writer for mikro observability.
 *
 * Writes structured events to a JSONL file when --log is specified.
 * Silently discards events when no log path is configured.
 *
 * Event types:
 *   run_start   — emitted once at the start of a run
 *   llm_call    — emitted for each main-loop LLM call
 *   llm_subcall — emitted for IPC-triggered sub-calls (llm_query, etc.)
 *   repl_exec   — emitted for each REPL code execution
 *   run_end     — emitted once at the end of a run with totals
 */
import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
/**
 * JSONL logger that writes one JSON object per line.
 * If no logPath is provided, all writes are no-ops.
 */
export class Logger {
    stream = null;
    runId;
    _startTime;
    constructor(logPath) {
        this.runId = randomUUID();
        this._startTime = Date.now();
        if (logPath) {
            this.stream = createWriteStream(logPath, { flags: "a" });
        }
    }
    /** Get elapsed time since logger creation. */
    get elapsed() {
        return Date.now() - this._startTime;
    }
    /** Write a structured event to the JSONL log. */
    log(event, data = {}) {
        if (!this.stream)
            return;
        const entry = {
            event,
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            ...data,
        };
        this.stream.write(JSON.stringify(entry) + "\n");
    }
    /** Emit run_start event. */
    runStart(data) {
        this.log("run_start", data);
    }
    /** Emit cache_init event when cache mode is enabled. */
    cacheInit(data) {
        this.log("cache_init", {
            content_hash: data.contentHash,
            session_id: data.sessionId,
            estimated_tokens: data.estimatedTokens,
        });
    }
    /** Emit llm_call event with per-call metrics. */
    llmCall(data) {
        this.log("llm_call", data);
    }
    /** Emit llm_subcall event (IPC-triggered sub-calls). */
    llmSubcall(data) {
        this.log("llm_subcall", data);
    }
    /** Emit child_start for recursive rlm_query child process spawning. */
    childStart(data) {
        this.log("child_start", data);
    }
    /** Emit child_end for recursive rlm_query child process completion. */
    childEnd(data) {
        this.log("child_end", data);
    }
    /** Emit repl_exec event. */
    replExec(data) {
        this.log("repl_exec", data);
    }
    /** Emit run_end event with totals. */
    runEnd(data) {
        this.log("run_end", data);
    }
    /** Close the underlying write stream. */
    close() {
        if (this.stream) {
            this.stream.end();
            this.stream = null;
        }
    }
}
/**
 * Create a no-op logger (for when --log is not specified).
 * Shares the same interface but discards everything.
 */
export function createLogger(logPath) {
    return new Logger(logPath);
}
//# sourceMappingURL=logger.js.map