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

/**
 * Build a StatsData object from an RLMResult and run metadata.
 */
/**
 * Estimate cost savings from cache reads.
 *
 * Cache reads are typically billed at ~10% of normal input token cost.
 * We approximate savings as 90% of what those tokens would have cost at
 * the normal input rate, derived from the run's actual cost data.
 */
function estimateCacheSavings(result: RLMResult): number {
  const { inputTokens, cacheReadTokens, totalCost } = result.usage;
  if (cacheReadTokens <= 0 || inputTokens <= 0) return 0;

  // Derive per-token input cost from the run's totals (input + output)
  const totalTokens = inputTokens + result.usage.outputTokens;
  if (totalTokens <= 0) return 0;

  const costPerToken = totalCost / totalTokens;
  // Cache reads cost ~10% of normal input price, so savings ≈ 90% of full price
  return cacheReadTokens * costPerToken * 0.9;
}

function toUsageSplitStats(usage: UsageStats): UsageSplitStats {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    total_cost: usage.totalCost,
    llm_calls: usage.llmCalls,
  };
}

export function buildStats(
  result: RLMResult,
  meta: {
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
  }
): StatsData {
  const stats: StatsData = {
    iterations: result.iterations,
    total_tokens: result.usage.inputTokens + result.usage.outputTokens,
    total_cost: result.usage.totalCost,
    time_ms: meta.time_ms,
    tools_level: meta.tools_level ?? "core",
    batteries_used: meta.batteries_used ?? [],
    budget_hit: meta.budget_hit ?? null,
    model: result.model,
    run_id: meta.run_id ?? "",
  };

  if (result.usageBreakdown) {
    stats.usage_split = {
      root: toUsageSplitStats(result.usageBreakdown.root),
      child: toUsageSplitStats(result.usageBreakdown.child),
      total: toUsageSplitStats(result.usageBreakdown.total),
    };
  }

  if (meta.cache_enabled) {
    stats.cache = {
      enabled: true,
      hit: result.usage.cacheReadTokens > 0,
      tokens_cached: result.usage.cacheWriteTokens,
      tokens_read: result.usage.cacheReadTokens,
      cost_savings: estimateCacheSavings(result),
    };
  }

  // Include Gemini stats when any Gemini features were used
  const hasGeminiActivity =
    meta.thinking_level ||
    (meta.gemini_batteries_used && meta.gemini_batteries_used.length > 0) ||
    (meta.thought_signatures_circulated && meta.thought_signatures_circulated > 0) ||
    (meta.web_search_calls && meta.web_search_calls > 0) ||
    (meta.fetch_url_calls && meta.fetch_url_calls > 0) ||
    (meta.code_executions_server_side && meta.code_executions_server_side > 0) ||
    (meta.image_generations && meta.image_generations > 0);
  if (hasGeminiActivity) {
    stats.gemini = {
      thinking_level: meta.thinking_level ?? null,
      gemini_batteries_used: meta.gemini_batteries_used ?? [],
      thought_signatures_circulated: meta.thought_signatures_circulated ?? 0,
      web_search_calls: meta.web_search_calls ?? 0,
      fetch_url_calls: meta.fetch_url_calls ?? 0,
      code_executions_server_side: meta.code_executions_server_side ?? 0,
      image_generations: meta.image_generations ?? 0,
    };
  }

  return stats;
}

/**
 * Format and output the final RLM result to stdout.
 * When stats is provided and mode is "json", stats are included in the JSON response.
 */
export function outputResult(
  result: RLMResult,
  mode: "text" | "json" | "stream",
  stats?: StatsData
): void {
  switch (mode) {
    case "json":
      if (stats) {
        console.log(JSON.stringify({ ...result, stats }));
      } else {
        console.log(JSON.stringify(result));
      }
      break;

    case "stream":
      // In stream mode, the final event is emitted here
      console.log(
        JSON.stringify({
          type: "final",
          answer: result.answer,
          references: result.references,
          usage: result.usage,
          iterations: result.iterations,
          model: result.model,
        })
      );
      break;

    case "text":
    default:
      console.log(result.answer);
      break;
  }
}

/**
 * Emit stats as JSON to stderr.
 * Only called when --stats flag is present.
 */
export function emitStats(stats: StatsData): void {
  process.stderr.write(JSON.stringify(stats) + "\n");
}

/**
 * Emit a stream event (JSONL) for an iteration.
 */
export function emitStreamEvent(event: StreamEvent): void {
  console.log(JSON.stringify(event));
}

/**
 * Log verbose iteration progress to stderr.
 */
export function logVerbose(iteration: number, message: string): void {
  process.stderr.write(`mikro [iter ${iteration}]: ${message}\n`);
}
