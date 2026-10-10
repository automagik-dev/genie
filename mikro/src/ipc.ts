// IPC protocol types for Node.js <-> Python REPL subprocess communication.
// All messages are JSON lines (one JSON object per line) over stdin/stdout.

// === Node -> Python (stdin) ===

export interface ExecuteCommand {
  type: "execute";
  code: string;
}

export type LLMResponseMessage =
  | { type: "llm_response"; ok: true; results: string[] }
  | { type: "llm_response"; ok: false; error: string };

export interface InjectCommand {
  type: "inject";
  name: string;
  value: string;
  value_type: "str" | "list" | "dict";
}

export interface ResetCommand {
  type: "reset";
}

export interface ShutdownCommand {
  type: "shutdown";
}

export type NodeToPython =
  | ExecuteCommand
  | LLMResponseMessage
  | InjectCommand
  | ResetCommand
  | ShutdownCommand;

// === Python -> Node (stdout) ===

export interface FinalSignal {
  type: "var" | "inline";
  value: string;
}

export interface ExecuteResult {
  type: "execute_result";
  stdout: string;
  stderr: string;
  variables: string[];
  final?: FinalSignal;
  error?: string;
  /** Node-owned marker: a failed child request invalidates this execution's FINAL. */
  llmError?: string;
}

export interface LLMRequest {
  type: "llm_request";
  request_type:
    | "llm_query"
    | "llm_query_batched"
    | "rlm_query"
    | "rlm_query_batched"
    | "web_search"
    | "fetch_url"
    | "generate_image"
    | "pg_search"
    | "pg_slice"
    | "pg_time"
    | "pg_count"
    | "pg_query";
  prompts: string[];
  model?: string;
}

export interface ReadyMessage {
  type: "ready";
}

export type PythonToNode = ExecuteResult | LLMRequest | ReadyMessage;
