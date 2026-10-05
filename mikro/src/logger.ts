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

import { createWriteStream, type WriteStream } from "node:fs";
import { randomUUID } from "node:crypto";

/** Supported log event types. */
export type EventType =
  | "run_start"
  | "cache_init"
  | "llm_call"
  | "llm_subcall"
  | "child_start"
  | "child_end"
  | "repl_exec"
  | "run_end";

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
export class Logger {
  private stream: WriteStream | null = null;
  readonly runId: string;
  private _startTime: number;

  constructor(logPath?: string) {
    this.runId = randomUUID();
    this._startTime = Date.now();

    if (logPath) {
      this.stream = createWriteStream(logPath, { flags: "a" });
    }
  }

  /** Get elapsed time since logger creation. */
  get elapsed(): number {
    return Date.now() - this._startTime;
  }

  /** Write a structured event to the JSONL log. */
  log(event: EventType, data: Record<string, unknown> = {}): void {
    if (!this.stream) return;

    const entry: LogEvent = {
      event,
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      ...data,
    };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  /** Emit run_start event. */
  runStart(data: {
    query: string;
    model: string;
    tools_level?: string;
    context_type?: string;
  }): void {
    this.log("run_start", data);
  }

  /** Emit cache_init event when cache mode is enabled. */
  cacheInit(data: {
    contentHash: string;
    sessionId: string;
    estimatedTokens: number;
  }): void {
    this.log("cache_init", {
      content_hash: data.contentHash,
      session_id: data.sessionId,
      estimated_tokens: data.estimatedTokens,
    });
  }

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
  }): void {
    this.log("llm_call", data);
  }

  /** Emit llm_subcall event (IPC-triggered sub-calls). */
  llmSubcall(data: {
    request_type: string;
    prompts_count: number;
    input_tokens: number;
    output_tokens: number;
    cost: number;
    time_ms: number;
  }): void {
    this.log("llm_subcall", data);
  }

  /** Emit child_start for recursive rlm_query child process spawning. */
  childStart(data: {
    child_correlation_id: string;
    prompt_preview: string;
    depth: number;
  }): void {
    this.log("child_start", data);
  }

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
  }): void {
    this.log("child_end", data);
  }

  /** Emit repl_exec event. */
  replExec(data: {
    iteration: number;
    code_length: number;
    time_ms: number;
    has_error: boolean;
    has_final: boolean;
  }): void {
    this.log("repl_exec", data);
  }

  /** Emit run_end event with totals. */
  runEnd(data: {
    iterations: number;
    total_tokens: number;
    total_cost: number;
    time_ms: number;
    budget_hit?: string | null;
    answer_length: number;
  }): void {
    this.log("run_end", data);
  }

  /** Close the underlying write stream. */
  close(): void {
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
export function createLogger(logPath?: string): Logger {
  return new Logger(logPath);
}
