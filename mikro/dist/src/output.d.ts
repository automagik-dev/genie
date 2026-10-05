/**
 * Output formatting for RLM results.
 *
 * Supports text, JSON, stream (JSONL), and verbose modes.
 * Stats output: --stats emits JSON to stderr, --output json --stats includes stats in response.
 */
import type { UsageStats, GeminiCallCounts, UsageBreakdown } from "./llm.js";
/** The full result returned by an RLM run. */
export interface RLMResult {
    answer: string;
    references: string[];
    usage: UsageStats;
    usageBreakdown?: UsageBreakdown;
    iterations: number;
    model: string;
    budgetHit?: string | null;
    /** Gemini battery usage and call counts (populated when provider is Google). */
    geminiCounts?: GeminiCallCounts;
    /** Names of Gemini battery functions invoked during the run. */
    geminiBatteriesUsed?: string[];
    /**
     * True when the pack declared a `VALIDATE.md` schema and the answer below
     * still does not match it after the in-band retry ceiling. Absent means
     * either "no schema was declared" or "the answer matched it" — the two are
     * deliberately indistinguishable, since neither is something to act on.
     *
     * Snake_case, unlike its neighbours, because this field is a *wire* name:
     * `--output json` serializes `RLMResult` directly (see `outputResult`), and
     * the flag's consumers are downstream gates reading that JSON.
     *
     * It describes the *model's answer*, not the run: the two designed aborts
     * (empty responses, wall-clock timeout) return runtime-error text rather
     * than a payload and are never flagged. Use `budgetHit` / `iterations` to
     * tell a flagged-because-exhausted run from a flagged-because-wrong one.
     */
    validation_failed?: boolean;
}
/** Cache stats included in --stats output when cache is enabled. */
export interface CacheStats {
    enabled: true;
    hit: boolean;
    tokens_cached: number;
    tokens_read: number;
    cost_savings: number;
}
/** Gemini-specific stats included when provider is Google. */
export interface GeminiStatsData {
    thinking_level: string | null;
    gemini_batteries_used: string[];
    thought_signatures_circulated: number;
    web_search_calls: number;
    fetch_url_calls: number;
    code_executions_server_side: number;
    image_generations: number;
}
/** Stats data emitted via --stats. */
export interface StatsData {
    iterations: number;
    total_tokens: number;
    total_cost: number;
    time_ms: number;
    tools_level: string;
    batteries_used: string[];
    budget_hit: string | null;
    model: string;
    run_id: string;
    usage_split?: {
        root: UsageSplitStats;
        child: UsageSplitStats;
        total: UsageSplitStats;
    };
    cache?: CacheStats;
    gemini?: GeminiStatsData;
}
export interface UsageSplitStats {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    total_cost: number;
    llm_calls: number;
}
/** Stream event emitted during iteration. */
export interface StreamEvent {
    type: "iteration" | "final";
    iteration?: number;
    code?: string;
    stdout?: string;
    answer?: string;
    references?: string[];
    usage?: UsageStats;
    iterations?: number;
    model?: string;
}
export declare function buildStats(result: RLMResult, meta: {
    time_ms: number;
    tools_level?: string;
    batteries_used?: string[];
    budget_hit?: string | null;
    run_id?: string;
    cache_enabled?: boolean;
    thinking_level?: string;
    gemini_batteries_used?: string[];
    thought_signatures_circulated?: number;
    web_search_calls?: number;
    fetch_url_calls?: number;
    code_executions_server_side?: number;
    image_generations?: number;
}): StatsData;
/**
 * Format and output the final RLM result to stdout.
 * When stats is provided and mode is "json", stats are included in the JSON response.
 */
export declare function outputResult(result: RLMResult, mode: "text" | "json" | "stream", stats?: StatsData): void;
/**
 * Emit stats as JSON to stderr.
 * Only called when --stats flag is present.
 */
export declare function emitStats(stats: StatsData): void;
/**
 * Emit a stream event (JSONL) for an iteration.
 */
export declare function emitStreamEvent(event: StreamEvent): void;
/**
 * Log verbose iteration progress to stderr.
 */
export declare function logVerbose(iteration: number, message: string): void;
//# sourceMappingURL=output.d.ts.map