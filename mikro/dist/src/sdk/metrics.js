/**
 * Per-depth metrics — Wish B Group 3a.
 *
 * Ship-shape the "per-depth structured metrics JSON" WISH.md L26
 * calls for. The actual emission rides on `IterationOutputEvent.metrics`
 * (see `events.ts`) — this module supplies the type + a lightweight
 * recorder that tracks latency / tool call count / token deltas across
 * an iteration so runAgent can hand a final payload to the event
 * without every call site needing to re-derive it.
 *
 * Cost + cache-hit metrics are consumer-supplied: if the driver knows
 * the token cost it returns it on its `emit_done` step (or via a
 * future per-iteration usage hook). For now the built-in recorder
 * tracks the deterministic pieces (latency, tool-call count, depth)
 * and lets consumers pipe in cost/tokens via `addCost` / `addTokens`.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L26, L169.
 */
export function createMetricsRecorder() {
    let depth = 0;
    let parentDepth = -1;
    let t0 = Date.now();
    let toolCalls = 0;
    let costUsd;
    let inputTokens;
    let outputTokens;
    let cachedTokens;
    let reasoningTokens;
    let cacheHitRatio;
    return {
        start(d, p) {
            depth = d;
            parentDepth = p;
            t0 = Date.now();
            toolCalls = 0;
            costUsd = undefined;
            inputTokens = undefined;
            outputTokens = undefined;
            cachedTokens = undefined;
            reasoningTokens = undefined;
            cacheHitRatio = undefined;
        },
        incrToolCalls() {
            toolCalls++;
        },
        addCost(usd) {
            if (!Number.isFinite(usd))
                return;
            costUsd = (costUsd ?? 0) + usd;
        },
        addTokens(input, output, cached, reasoning) {
            inputTokens = (inputTokens ?? 0) + (Number.isFinite(input) ? input : 0);
            outputTokens = (outputTokens ?? 0) + (Number.isFinite(output) ? output : 0);
            if (cached !== undefined && Number.isFinite(cached)) {
                cachedTokens = (cachedTokens ?? 0) + cached;
            }
            if (reasoning !== undefined && Number.isFinite(reasoning)) {
                reasoningTokens = (reasoningTokens ?? 0) + reasoning;
            }
        },
        setCacheHitRatio(ratio) {
            if (!Number.isFinite(ratio))
                return;
            cacheHitRatio = Math.max(0, Math.min(1, ratio));
        },
        snapshot() {
            const tokens = inputTokens !== undefined || outputTokens !== undefined
                ? {
                    input: inputTokens ?? 0,
                    output: outputTokens ?? 0,
                    ...(cachedTokens !== undefined
                        ? { cached: cachedTokens }
                        : {}),
                    ...(reasoningTokens !== undefined
                        ? { reasoning: reasoningTokens }
                        : {}),
                }
                : undefined;
            return {
                depth,
                parentDepth,
                latencyMs: Date.now() - t0,
                toolCalls,
                ...(costUsd !== undefined ? { costUsd } : {}),
                ...(tokens ? { tokens } : {}),
                ...(cacheHitRatio !== undefined ? { cacheHitRatio } : {}),
            };
        },
    };
}
//# sourceMappingURL=metrics.js.map