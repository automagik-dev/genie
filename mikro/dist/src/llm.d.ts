/**
 * LLM client wrapper using pi/ai.
 *
 * Provides completeSimple wrapper, batched calls, IPC request handling
 * from the Python REPL, and rlm_query child process spawning.
 */
import type { AssistantMessage as PiAssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { type CustomProviderConfig } from "./custom-providers.js";
import type { MikroConfig, ModelConfig, GeminiConfig } from "./config.js";
import type { LLMRequest } from "./ipc.js";
import type { Logger } from "./logger.js";
import type { PgStorage } from "./storage.js";
import { type ThinkingLevel } from "./gemini.js";
/** Token usage tracking. */
export interface UsageStats {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalCost: number;
    llmCalls: number;
    /** Reasoning/thinking tokens (a subset of outputTokens), when the provider reports them. */
    reasoningTokens?: number;
}
/** Create a fresh usage tracker. */
export declare function createUsage(): UsageStats;
/** Return a - b for usage accounting splits. */
export declare function usageDelta(a: UsageStats, b: UsageStats): UsageStats;
export interface UsageBreakdown {
    root: UsageStats;
    child: UsageStats;
    total: UsageStats;
}
/** Gemini-specific call counts tracked across an RLM run. */
export interface GeminiCallCounts {
    webSearch: number;
    fetchUrl: number;
    generateImage: number;
    codeExecutionsServerSide: number;
    thoughtSignatures: number;
}
/** Create a fresh Gemini call counter. */
export declare function createGeminiCallCounts(): GeminiCallCounts;
/** Merge child usage into parent. */
export declare function mergeUsage(parent: UsageStats, child: UsageStats): void;
/** Message format for the RLM loop. */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
    /** Original pi/ai AssistantMessage — stored for multi-turn fidelity. */
    piMessage?: PiAssistantMessage;
}
/** Cache config passed through to pi/ai completeSimple. */
export interface CacheLLMConfig {
    enabled: boolean;
    retention: "short" | "long";
    sessionId: string;
}
/** Code execution result from Gemini (GROUP 5). */
export interface CodeExecutionResult {
    code: string;
    outcome: "OUTCOME_OK" | "OUTCOME_FAILED" | "OUTCOME_DEADLINE_EXCEEDED";
    output: string;
}
/** Response from a single LLM call. */
export interface LLMResponse {
    text: string;
    usage: UsageStats;
    /** Original pi/ai AssistantMessage for multi-turn conversation fidelity. */
    piMessage?: PiAssistantMessage;
    /** Provider-reported model that actually served the response (AssistantMessage.responseModel). */
    responseModel?: string;
    /** Count of thought signatures in response (GROUP 2: multi-turn quality tracking). */
    thoughtSignatureCount?: number;
    /** Code execution results from Gemini (GROUP 5). */
    codeExecutionResults?: CodeExecutionResult[];
}
export declare function normalizeOpenRouterDeveloperRole(payload: unknown): unknown;
/**
 * Resolve a pi/ai model, trying the exact ID first, then stripping the date suffix.
 */
export declare function normalizeProviderModelId(provider: string, modelId: string): string;
export declare function formatModelRef(provider: string, modelId: string): string;
/**
 * Resolve a pi-ai model for `<provider>/<modelId>`.
 *
 * `providers` are the config-declared providers riding on the model config;
 * they are registered on the shared runtime before lookup so a declared
 * `<id>/<model>` resolves exactly like a built-in. Exported so the MCP server
 * and `mikro doctor` can validate a pin without making a call.
 */
export declare function resolveModel(provider: string, modelId: string, providers?: readonly CustomProviderConfig[]): import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
/**
 * Check that a model config resolves, without calling anything. Returns the
 * failure message, or null when the pin is good.
 *
 * Station and khal carry dynamic catalogs that need a network round-trip to
 * fill; they are reported as resolvable here and checked at call time, as
 * before. Everything else — built-ins and config-declared providers — is
 * static and answers immediately.
 */
export declare function checkModelConfig(modelConfig: ModelConfig): string | null;
/** Per-call options accepted by `llmComplete`. */
export interface LlmCompleteOptions {
    maxTokens?: number;
    maxRetries?: number;
    signal?: AbortSignal;
    logger?: Logger;
    iteration?: number;
    cacheConfig?: CacheLLMConfig;
    thinkingLevel?: ThinkingLevel | null;
    /**
     * Sampling temperature, `0`–`2`. `null`/absent means **unset**, and unset
     * leaves no `temperature` key on the pi-ai options at all — see
     * `buildPiOptions`. Validated at the config surfaces, not here.
     */
    temperature?: number | null;
    outputSchema?: Record<string, unknown> | null;
    geminiConfig?: GeminiConfig;
}
/**
 * Build the pi-ai options for one completion: the sampling and caching half,
 * before any provider payload hooks are attached.
 *
 * Split out of `llmComplete` so the exact object handed to pi-ai is assertable
 * without a network call — which matters most for the fields whose *absence* is
 * the contract. An unset knob must produce no key at all rather than an
 * explicit `undefined`/`null`, so that adding this plumbing left every existing
 * call byte-for-byte as it was.
 */
export declare function buildPiOptions(options?: LlmCompleteOptions): SimpleStreamOptions;
/**
 * Call pi/ai completeSimple with messages.
 * Tracks cost and time_ms per call. Optionally emits to a Logger.
 */
export declare function llmComplete(messages: ChatMessage[], modelConfig: ModelConfig, options?: LlmCompleteOptions): Promise<LLMResponse>;
/**
 * Call pi/ai completeSimple for a single prompt (no conversation history).
 * Used for llm_query() sub-calls from the REPL.
 */
export declare function llmCompleteSimple(prompt: string, modelConfig: ModelConfig, signal?: AbortSignal): Promise<LLMResponse>;
/**
 * Run multiple llm_query calls concurrently.
 */
export declare function llmCompleteBatched(prompts: string[], modelConfig: ModelConfig, signal?: AbortSignal): Promise<{
    results: string[];
    usage: UsageStats;
}>;
/** Parsed child RLM process result. */
export interface RlmChildResult {
    answer: string;
    runId?: string;
    usage?: UsageStats;
    raw?: unknown;
}
export interface RlmChildInvocationOptions {
    output?: "json";
    /** `provider/model` (or bare model id) forwarded to the child as --model. */
    model?: string;
    maxIterations?: number;
    timeout?: number;
    maxDepth?: number;
    maxCost?: number | null;
    maxTokens?: number | null;
    logPath?: string | null;
    stats?: boolean;
    noSession?: boolean;
}
/** Build bounded argv for a recursive child process. */
export declare function buildRlmChildArgs(prompt: string, options?: RlmChildInvocationOptions): string[];
/** Build env inheritance for child process with explicit recursive ancestry. */
export declare function buildChildEnv(env: NodeJS.ProcessEnv, parentRunId: string, correlationId: string): NodeJS.ProcessEnv;
/** Parse stdout from a child mikro --output json --stats run. */
export declare function parseRlmChildOutput(stdout: string): RlmChildResult;
/** Last `maxChars` of a child's stderr, whitespace-collapsed, for error text. */
export declare function stderrTail(stderr: string, maxChars?: number): string;
/**
 * Classify a finished child mikro process into the answer the REPL caller sees.
 *
 * A child that cannot reach a model — wrong provider, missing key, empty
 * completion — still exits 0 and still prints `{"answer":""}`. Handing that
 * back as an ordinary result made a dead sub-call indistinguishable from a
 * real one: three recursive spawns in the round-1 parity sweep died this way
 * and nothing in the run recorded it. A zero exit with no answer is therefore
 * reported as an explicit `Error:` string, which is the same shape the REPL
 * already uses for handler throws and which the model can react to.
 *
 * Exit-code semantics of the child CLI itself are untouched — this is purely
 * how the parent reads the result.
 */
export declare function classifyRlmChildResult(code: number | null, stdout: string, stderr: string): {
    result: RlmChildResult;
    isError: boolean;
    errorMessage?: string;
};
/**
 * Spawn a child mikro process for rlm_query() recursive sub-calls.
 * The child inherits the parent's cwd (and thus .md configs).
 */
export declare function rlmQuery(prompt: string, cwd: string, signal?: AbortSignal, options?: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: {
        correlationId: string;
        prompt: string;
        depth: number;
    }) => string | undefined;
    onChildEnd?: (data: {
        spanId?: string;
        correlationId?: string;
        depth?: number;
        result: RlmChildResult;
        durationMs: number;
        isError?: boolean;
        errorMessage?: string;
    }) => void;
}): Promise<RlmChildResult>;
/**
 * Run multiple rlm_query calls concurrently (max 4).
 */
export declare function rlmQueryBatched(prompts: string[], cwd: string, signal?: AbortSignal, options?: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: {
        correlationId: string;
        prompt: string;
        depth: number;
    }) => string | undefined;
    onChildEnd?: (data: {
        spanId?: string;
        correlationId?: string;
        depth?: number;
        result: RlmChildResult;
        durationMs: number;
        isError?: boolean;
        errorMessage?: string;
    }) => void;
}): Promise<RlmChildResult[]>;
/**
 * Resolve the `provider/model` a recursive child should run on.
 *
 * `rlm_query(p, model="X")` used to be a silent no-op: the Python side put the
 * kwarg on the wire and the handler never read it. It is honoured the same way
 * `llm_query` honours its own `model=` — the provider comes from the parent's
 * config, only the model id is swappable.
 *
 * With no kwarg the child is pinned to the parent's *primary* model rather
 * than its sub-call model: a child is a full mikro run, not a single
 * completion, and the sub-call model is chosen to be a cheap one-shot.
 */
export declare function resolveChildModelRef(config: MikroConfig, requestedModel?: string): string;
/**
 * Handle an LLM IPC request from the Python REPL.
 * Routes to the appropriate handler based on request_type.
 * When geminiCounts is provided, increments Gemini-specific call counters.
 */
export declare function handleLLMRequest(request: LLMRequest, config: MikroConfig, usage: UsageStats, signal?: AbortSignal, geminiCounts?: GeminiCallCounts, storage?: PgStorage, childUsage?: UsageStats, recursiveOptions?: RlmChildInvocationOptions & {
    logger?: Logger;
    parentRunId?: string;
    onChildStart?: (data: {
        correlationId: string;
        prompt: string;
        depth: number;
    }) => string | undefined;
    onChildEnd?: (data: {
        spanId?: string;
        correlationId?: string;
        depth?: number;
        result: RlmChildResult;
        durationMs: number;
        isError?: boolean;
        errorMessage?: string;
    }) => void;
}): Promise<string[]>;
//# sourceMappingURL=llm.d.ts.map