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
import type { ExecuteResult, LLMRequest } from "./ipc.js";
import type { ToolsLevel } from "./config.js";
import type { Logger } from "./logger.js";
import type { ToolResolver } from "./sdk/agent.js";
/** Names supplied by the REPL runtime and battery modules. */
export declare const REPL_RESERVED_NAMES: ReadonlySet<string>;
/** Options passed to REPL.start() */
export interface REPLStartOptions {
    /** Context to inject (string, list, or dict serialized as JSON string). */
    context?: string | string[] | Record<string, unknown>;
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
}
/** Callback for handling LLM requests from the Python REPL. */
export type LLMRequestHandler = (request: LLMRequest) => Promise<string[]>;
export declare function defaultReplTimeoutMs(): number;
export declare class REPL {
    private process;
    private readline;
    private ready;
    private pendingResolve;
    private pendingReject;
    private llmHandler;
    private toolHandler;
    private messageBuffer;
    private readonly toolSignal;
    private _startOptions;
    private _recovering;
    private _batteriesUsed;
    private _geminiBatteriesUsed;
    private _skipTracking;
    private _logger;
    /** Set a handler for LLM requests from Python REPL code. */
    onLLMRequest(handler: LLMRequestHandler): void;
    /** Set a handler for tool requests from Python REPL code. */
    onToolRequest(handler: ToolResolver): void;
    /** Start the Python REPL subprocess. */
    start(options?: REPLStartOptions): Promise<void>;
    /** Execute Python code in the REPL and return the result. */
    execute(code: string, timeoutMs?: number): Promise<ExecuteResult>;
    /** Reset the REPL namespace. */
    reset(): Promise<void>;
    /** Stop the Python subprocess. */
    stop(): Promise<void>;
    /** Check if the REPL subprocess is running. */
    isRunning(): boolean;
    /** Get list of battery functions that were called during this session. */
    getBatteriesUsed(): string[];
    /** Get list of Gemini battery functions that were called during this session. */
    getGeminiBatteriesUsed(): string[];
    private _loadBatteries;
    private _loadGeminiBatteries;
    private _loadPgBatteries;
    /** Track which battery functions appear in executed code. */
    private _trackBatteryUsage;
    /** Restart subprocess after a crash and retry the failed code once. */
    private _recoverAndRetry;
    private _send;
    private _handleMessage;
    private _nextMessage;
    private _waitForMessage;
    private _waitForExecuteResult;
    /** Handle a tool request without allowing bridge failures to reject execute(). */
    private _handleToolRequest;
    private _injectContext;
}
//# sourceMappingURL=repl.d.ts.map