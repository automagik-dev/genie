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
export interface IterationMetrics {
    /** Recursion depth at which this iteration ran. 0 for top-level. */
    readonly depth: number;
    /** Parent depth — top-level has parentDepth=-1 by convention. */
    readonly parentDepth: number;
    /** Iteration wall-clock latency in milliseconds. */
    readonly latencyMs: number;
    /** Total tool calls issued during this iteration (incl. denies). */
    readonly toolCalls: number;
    /** Optional — cost in USD accumulated this iteration. */
    readonly costUsd?: number;
    /** Optional — token tally (input / output / cached / reasoning). */
    readonly tokens?: {
        readonly input: number;
        readonly output: number;
        readonly cached?: number;
        /** Reasoning/thinking tokens (subset of output), when reported. */
        readonly reasoning?: number;
    };
    /** Optional — cache hit ratio in [0, 1]. Consumer-supplied. */
    readonly cacheHitRatio?: number;
}
export interface MetricsRecorder {
    /** Mark the start of an iteration — resets latency baseline. */
    start(depth: number, parentDepth: number): void;
    incrToolCalls(): void;
    addCost(usd: number): void;
    addTokens(input: number, output: number, cached?: number, reasoning?: number): void;
    setCacheHitRatio(ratio: number): void;
    /** Freeze the recorder's current state as a plain object. Safe to
     *  emit on events; returns a fresh snapshot each call. */
    snapshot(): IterationMetrics;
}
export declare function createMetricsRecorder(): MetricsRecorder;
//# sourceMappingURL=metrics.d.ts.map