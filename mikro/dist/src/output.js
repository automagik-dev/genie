/**
 * Output formatting for RLM results.
 *
 * Supports text, JSON, stream (JSONL), and verbose modes.
 * Stats output: --stats emits JSON to stderr, --output json --stats includes stats in response.
 */
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
function estimateCacheSavings(result) {
    const { inputTokens, cacheReadTokens, totalCost } = result.usage;
    if (cacheReadTokens <= 0 || inputTokens <= 0)
        return 0;
    // Derive per-token input cost from the run's totals (input + output)
    const totalTokens = inputTokens + result.usage.outputTokens;
    if (totalTokens <= 0)
        return 0;
    const costPerToken = totalCost / totalTokens;
    // Cache reads cost ~10% of normal input price, so savings ≈ 90% of full price
    return cacheReadTokens * costPerToken * 0.9;
}
function toUsageSplitStats(usage) {
    return {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
        total_cost: usage.totalCost,
        llm_calls: usage.llmCalls,
    };
}
export function buildStats(result, meta) {
    const stats = {
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
    const hasGeminiActivity = meta.thinking_level ||
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
export function outputResult(result, mode, stats) {
    switch (mode) {
        case "json":
            if (stats) {
                console.log(JSON.stringify({ ...result, stats }));
            }
            else {
                console.log(JSON.stringify(result));
            }
            break;
        case "stream":
            // In stream mode, the final event is emitted here
            console.log(JSON.stringify({
                type: "final",
                answer: result.answer,
                references: result.references,
                usage: result.usage,
                iterations: result.iterations,
                model: result.model,
            }));
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
export function emitStats(stats) {
    process.stderr.write(JSON.stringify(stats) + "\n");
}
/**
 * Emit a stream event (JSONL) for an iteration.
 */
export function emitStreamEvent(event) {
    console.log(JSON.stringify(event));
}
/**
 * Log verbose iteration progress to stderr.
 */
export function logVerbose(iteration, message) {
    process.stderr.write(`mikro [iter ${iteration}]: ${message}\n`);
}
//# sourceMappingURL=output.js.map