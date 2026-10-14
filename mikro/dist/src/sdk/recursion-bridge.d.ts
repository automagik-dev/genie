/**
 * Recursion event bridge — Wish B live-tui Group 2.
 *
 * The `RecurseEvent` type has lived in `events.ts` since Group 1 with ZERO
 * producers. This bridge is that producer: it turns the `onChildStart` /
 * `onChildEnd` hooks fired at the `rlmQuery` child-spawn site (see
 * `src/llm.ts`) into live `AgentEvent`s on a `createEmitter()` bus.
 *
 * It reuses the existing `events.ts` types + `makeEvent` — NO schema fork.
 * Two events per recursive child:
 *   • `RecurseEvent` on spawn — carries the child's freshly minted
 *     `correlationId` and the spawning run's id as `parentRunId` (the
 *     ancestry edge). Siblings of one parent get distinct `uuidv7()`
 *     correlation ids, so the tree is unambiguous where `depth` alone is
 *     not.
 *   • `IterationOutputEvent` on child completion — the child node's
 *     per-node metrics bridged from `RlmChildResult.usage`
 *     (cost / tokens / latency), keyed by the same `correlationId`.
 *     An `ErrorEvent` is additionally emitted when the child failed.
 *
 * Emits are additive, synchronous, and in-memory — they never touch
 * recursion control flow.
 *
 * Level-2 live child-INTERNAL streaming (a child's own iterations
 * surfaced over `src/ipc.ts`) is intentionally OUT of scope here; a
 * child is summarized as a single bridged node. Streaming child-internal
 * events to the parent bus is the documented next step.
 */
import type { EventEmitter } from "./emitter.js";
import type { RlmChildResult } from "../llm.js";
/** Data delivered by the `onChildStart` hook at the spawn site. */
export interface ChildStartData {
    readonly correlationId: string;
    readonly prompt: string;
    readonly depth: number;
}
/** Data delivered by the `onChildEnd` hook when a child settles. */
export interface ChildEndData {
    readonly spanId?: string;
    readonly correlationId?: string;
    readonly depth?: number;
    readonly result: RlmChildResult;
    readonly durationMs: number;
    readonly isError?: boolean;
    readonly errorMessage?: string;
}
export interface RecursionBridge {
    /** Emit a `RecurseEvent` for a spawned child. Returns `undefined` so
     *  it composes cleanly with a langfuse `onChildStart` that owns the
     *  span id — the caller returns langfuse's span id, not the bridge's. */
    onChildStart(data: ChildStartData): void;
    /** Emit the bridged child-completion `IterationOutputEvent` (+ an
     *  `ErrorEvent` when the child failed). */
    onChildEnd(data: ChildEndData): void;
}
export interface RecursionBridgeContext {
    readonly emitter: EventEmitter;
    /** This run's self-correlation id — the parent side of every edge the
     *  bridge emits, and the `sessionId` stamped on bridge events. */
    readonly sessionId: string;
    /** Current parent iteration, read lazily so the number is accurate at
     *  emit time (the spawn happens mid-iteration). */
    readonly currentIteration: () => number;
    /** Preview cap for the child answer carried on the completion event. */
    readonly answerPreviewChars?: number;
}
export declare function createRecursionBridge(ctx: RecursionBridgeContext): RecursionBridge;
//# sourceMappingURL=recursion-bridge.d.ts.map