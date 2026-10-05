/**
 * Event emitter with async-iterator contract — Wish B Group 1 skeleton.
 *
 * The SDK's async iterator yields `AgentEvent`s as the agent runs. The
 * emitter is a thin broker: producers call `emit()` at state boundaries;
 * consumers iterate via `for await`. Multiple consumers may subscribe
 * to the same emitter — each receives every event.
 *
 * This file ships the contract shape only. Hooking the emitter into
 * `rlm.ts` + exposing `runAgent()` lands in Group 2-3 per WISH.md.
 */
import type { AgentEvent } from "./events.js";
/**
 * Producer API — what the SDK core calls.
 *
 * `emit` is synchronous: events land in an in-memory queue and are
 * delivered to subscribers via the async iterator. `close` signals
 * that no more events will arrive; consumers' iterators return.
 */
export interface EventEmitter {
    emit(event: AgentEvent): void;
    close(): void;
    /** Idempotent. `true` after the first `close()` call. */
    readonly closed: boolean;
}
/**
 * Consumer API — what `runAgent()` hands back to SDK users.
 * The emitter itself IS the iterable; users can also call `subscribe()`
 * for a fresh iterator (useful when wiring multiple consumers to one
 * run).
 */
export interface EventStream extends AsyncIterable<AgentEvent> {
    subscribe(): AsyncIterableIterator<AgentEvent>;
}
/** Combined interface — the default implementation satisfies both. */
export type EmitterAndStream = EventEmitter & EventStream;
/**
 * Create an emitter with an async-iterator backplane. Broadcasts to
 * every subscriber; each subscriber sees events in emit order. Buffers
 * up to {@link PRE_SUBSCRIBE_BUFFER_LIMIT} events that arrive before any
 * subscriber is attached so a late subscriber still replays the run's
 * opening events.
 */
export declare function createEmitter(): EmitterAndStream;
//# sourceMappingURL=emitter.d.ts.map