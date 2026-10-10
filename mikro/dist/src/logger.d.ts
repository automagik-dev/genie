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
/** Supported log event types. */
export type EventType = "run_start" | "cache_init" | "llm_call" | "llm_subcall" | "child_start" | "child_end" | "repl_exec" | "run_end";
/** A single structured log event. */
export interface LogEvent {
    event: EventType;
    run_id: string;
    timestamp: string;
    [key: string]: unknown;
}
/**
 * JSONL logger that writes one JSON object per line.
 * If no logPath is provided, all writes are no-ops.
 */
export declare class Logger {
    private stream;
    readonly runId: string;
    private _startTime;
    constructor(logPath?: string);
    /** Get elapsed time since logger creation. */
    get elapsed(): number;
    /** Write a structured event to the JSONL log. */
    log(event: EventType, data?: Record<string, unknown>): void;
    /** Emit run_start event. */
    runStart(data: {
        query: string;
        model: string;
        tools_level?: string;
        context_type?: string;
    }): void;
    /** Emit cache_init event when cache mode is enabled. */
    cacheInit(data: {
        contentHash: string;
        sessionId: string;
        estimatedTokens: number;
    }): void;
    /** Emit llm_call event with per-call metrics. */
    llmCall(data: {
        iteration: number;
        input_tokens: number;
        output_tokens: number;
        cost: number;
        time_ms: number;
        cache_read_tokens?: number;
        cache_write_tokens?: number;
        /** Reasoning/thinking tokens reported by the provider (subset of output_tokens). */
        reasoning_tokens?: number;
        /** Provider-reported model that served the response (AssistantMessage.responseModel). */
        response_model?: string;
    }): void;
    /** Emit llm_subcall event (IPC-triggered sub-calls). */
    llmSubcall(data: {
        request_type: string;
        prompts_count: number;
        input_tokens: number;
        output_tokens: number;
        cost: number;
        time_ms: number;
    }): void;
    /** Emit child_start for recursive rlm_query child process spawning. */
    childStart(data: {
        child_correlation_id: string;
        prompt_preview: string;
        depth: number;
    }): void;
    /** Emit child_end for recursive rlm_query child process completion. */
    childEnd(data: {
        child_correlation_id: string;
        child_run_id?: string | null;
        input_tokens: number;
        output_tokens: number;
        cost: number;
        llm_calls: number;
        time_ms: number;
        is_error?: boolean;
        error_message?: string | null;
    }): void;
    /** Emit repl_exec event. */
    replExec(data: {
        iteration: number;
        code_length: number;
        time_ms: number;
        has_error: boolean;
        has_final: boolean;
    }): void;
    /** Emit run_end event with totals. */
    runEnd(data: {
        iterations: number;
        total_tokens: number;
        total_cost: number;
        time_ms: number;
        budget_hit?: string | null;
        answer_length: number;
    }): void;
    /** Close the underlying write stream. */
    close(): void;
}
/**
 * Create a no-op logger (for when --log is not specified).
 * Shares the same interface but discards everything.
 */
export declare function createLogger(logPath?: string): Logger;
//# sourceMappingURL=logger.d.ts.map