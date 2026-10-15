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
 * Cap on the pre-subscribe backlog. The intended consumers (the headless
 * subscriber + the mikro-acp adapter) attach BEFORE the run starts, so the
 * preBuffer stays empty on the seam path. The default internal-emitter path
 * has NO subscriber, so without a cap every event — including untruncated
 * REPL code/stdout on ToolCall* events — would accumulate for the whole run
 * and never be read. Capping the opening backlog keeps that cost a small
 * bounded constant instead of a silent per-run memory tax. A late subscriber
 * still replays the run's opening events (up to the cap); events beyond it
 * are dropped from the backlog (live delivery once subscribed is unaffected).
 */
const PRE_SUBSCRIBE_BUFFER_LIMIT = 256;

/**
 * Create an emitter with an async-iterator backplane. Broadcasts to
 * every subscriber; each subscriber sees events in emit order. Buffers
 * up to {@link PRE_SUBSCRIBE_BUFFER_LIMIT} events that arrive before any
 * subscriber is attached so a late subscriber still replays the run's
 * opening events.
 */
export function createEmitter(): EmitterAndStream {
	type PendingPull = {
		resolve(result: IteratorResult<AgentEvent>): void;
	};

	const subscribers: {
		pending: PendingPull[];
		buffer: AgentEvent[];
		done: boolean;
	}[] = [];

	let closed = false;
	/** Shared pre-subscribe backlog — forwarded to the first subscriber. */
	const preBuffer: AgentEvent[] = [];

	function flushTo(
		sub: (typeof subscribers)[number],
		events: readonly AgentEvent[],
	): void {
		for (const ev of events) {
			const pull = sub.pending.shift();
			if (pull) pull.resolve({ value: ev, done: false });
			else sub.buffer.push(ev);
		}
	}

	function completeSub(sub: (typeof subscribers)[number]): void {
		if (sub.done) return;
		sub.done = true;
		while (sub.pending.length > 0) {
			const pull = sub.pending.shift();
			pull?.resolve({ value: undefined, done: true });
		}
	}

	function emit(event: AgentEvent): void {
		if (closed) return; // Silently drop post-close emissions.
		if (subscribers.length === 0) {
			// Bounded backlog: retain only the run's opening events for a
			// possible late subscriber. On the default (no-subscriber) path
			// this stops the whole run's events from accumulating unread.
			if (preBuffer.length < PRE_SUBSCRIBE_BUFFER_LIMIT) preBuffer.push(event);
			return;
		}
		for (const sub of subscribers) {
			if (!sub.done) flushTo(sub, [event]);
		}
	}

	function close(): void {
		if (closed) return;
		closed = true;
		for (const sub of subscribers) completeSub(sub);
	}

	function subscribe(): AsyncIterableIterator<AgentEvent> {
		const sub: (typeof subscribers)[number] = {
			pending: [],
			buffer: [],
			done: false,
		};
		subscribers.push(sub);
		// Deliver any pre-subscribe backlog so late subscribers still
		// receive the run's opening events. Only the FIRST subscriber
		// drains the preBuffer to avoid re-broadcasting.
		if (subscribers.length === 1 && preBuffer.length > 0) {
			flushTo(sub, preBuffer);
			preBuffer.length = 0;
		}
		if (closed) completeSub(sub);

		const iter: AsyncIterableIterator<AgentEvent> = {
			next(): Promise<IteratorResult<AgentEvent>> {
				if (sub.buffer.length > 0) {
					const value = sub.buffer.shift() as AgentEvent;
					return Promise.resolve({ value, done: false });
				}
				if (sub.done) {
					return Promise.resolve({
						value: undefined,
						done: true,
					});
				}
				return new Promise<IteratorResult<AgentEvent>>((resolve) => {
					sub.pending.push({ resolve });
				});
			},
			return(): Promise<IteratorResult<AgentEvent>> {
				completeSub(sub);
				return Promise.resolve({ value: undefined, done: true });
			},
			throw(err?: unknown): Promise<IteratorResult<AgentEvent>> {
				completeSub(sub);
				return Promise.reject(err);
			},
			[Symbol.asyncIterator]() {
				return this;
			},
		};
		return iter;
	}

	return {
		emit,
		close,
		get closed() {
			return closed;
		},
		subscribe,
		[Symbol.asyncIterator](): AsyncIterableIterator<AgentEvent> {
			return subscribe();
		},
	};
}
