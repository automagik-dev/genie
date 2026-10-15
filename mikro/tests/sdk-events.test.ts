import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	ALL_AGENT_EVENT_TYPES,
	type AgentEvent,
	type AgentEventType,
	WISH_SPEC_EVENT_TYPES,
	isAgentEvent,
	iso,
	makeEvent,
} from "../src/sdk/index.js";

describe("SDK events — contract (Wish B Groups 1 + 2)", () => {
	it("WISH_SPEC_EVENT_TYPES stays frozen at the 10 types from WISH.md L21", () => {
		const expected: readonly AgentEventType[] = [
			"AgentStart",
			"IterationStart",
			"IterationOutput",
			"ToolCallBefore",
			"ToolCallAfter",
			"Recurse",
			"Validation",
			"Message",
			"EmitDone",
			"Error",
		];
		assert.deepEqual(
			[...WISH_SPEC_EVENT_TYPES],
			[...expected],
			"WISH_SPEC_EVENT_TYPES must match wish spec exactly",
		);
		assert.equal(WISH_SPEC_EVENT_TYPES.length, 10);
	});

	it("ALL_AGENT_EVENT_TYPES extends the wish spec with session + observation events", () => {
		const extras: readonly AgentEventType[] = [
			"SessionOpen",
			"SessionClose",
			"ToolCallObservation",
		];
		assert.deepEqual(
			[...ALL_AGENT_EVENT_TYPES],
			[...WISH_SPEC_EVENT_TYPES, ...extras],
			"ALL_AGENT_EVENT_TYPES = wish-spec 10 + Session{Open,Close} (G2) + ToolCallObservation (L2a)",
		);
		assert.equal(ALL_AGENT_EVENT_TYPES.length, 13);
	});

	it("makeEvent fills timestamp + type automatically", () => {
		const ev = makeEvent<AgentEvent>("IterationStart", {
			sessionId: "s1",
			iteration: 3,
		} as Omit<AgentEvent, "type" | "timestamp">);
		assert.equal(ev.type, "IterationStart");
		assert.ok(ev.timestamp);
		assert.doesNotThrow(() => new Date(ev.timestamp));
	});

	it("makeEvent preserves caller-supplied timestamp", () => {
		const stamp = "2026-04-22T10:00:00.000Z";
		const ev = makeEvent<AgentEvent>("AgentStart", {
			agentId: "a1",
			sessionId: "s1",
			config: { model: "claude-sonnet-4-6" },
			timestamp: stamp,
		} as Omit<AgentEvent, "type"> & { timestamp?: string });
		assert.equal(ev.timestamp, stamp);
	});

	it("every event type is JSON-round-trippable with its discriminant intact", () => {
		const samples: AgentEvent[] = [
			makeEvent<AgentEvent>("AgentStart", {
				agentId: "a1",
				sessionId: "s1",
				config: {},
			} as never),
			makeEvent<AgentEvent>("IterationStart", {
				sessionId: "s1",
				iteration: 1,
			} as never),
			makeEvent<AgentEvent>("IterationOutput", {
				sessionId: "s1",
				iteration: 1,
				output: "hello",
			} as never),
			makeEvent<AgentEvent>("ToolCallBefore", {
				sessionId: "s1",
				iteration: 1,
				tool: "search",
				args: { q: "x" },
			} as never),
			makeEvent<AgentEvent>("ToolCallAfter", {
				sessionId: "s1",
				iteration: 1,
				tool: "search",
				result: { hits: 3 },
				durationMs: 42,
				ok: true,
			} as never),
			makeEvent<AgentEvent>("Recurse", {
				sessionId: "s1",
				iteration: 1,
				depth: 2,
				parentDepth: 1,
				query: "nested",
			} as never),
			makeEvent<AgentEvent>("Validation", {
				sessionId: "s1",
				status: "pass",
				attempt: 1,
			} as never),
			makeEvent<AgentEvent>("Message", {
				sessionId: "s1",
				role: "assistant",
				content: "ok",
			} as never),
			makeEvent<AgentEvent>("EmitDone", {
				sessionId: "s1",
				payload: { answer: 42 },
			} as never),
			makeEvent<AgentEvent>("Error", {
				sessionId: "s1",
				phase: "tool",
				error: { name: "Error", message: "boom" },
			} as never),
			makeEvent<AgentEvent>("SessionOpen", {
				sessionId: "s1",
				resumed: false,
			} as never),
			makeEvent<AgentEvent>("SessionClose", {
				sessionId: "s1",
				reason: "complete",
			} as never),
			makeEvent<AgentEvent>("ToolCallObservation", {
				sessionId: "s1",
				iteration: 1,
				tool: "external_tool",
				args: { q: "?" },
				status: "completed",
				result: "ok",
			} as never),
		];

		assert.equal(samples.length, 13);
		for (const ev of samples) {
			const round = JSON.parse(JSON.stringify(ev));
			assert.equal(round.type, ev.type);
			assert.equal(round.timestamp, ev.timestamp);
			assert.ok(
				isAgentEvent(round),
				`${ev.type}: round-trip failed isAgentEvent check`,
			);
		}
	});

	it("isAgentEvent rejects non-events", () => {
		assert.equal(isAgentEvent(null), false);
		assert.equal(isAgentEvent(undefined), false);
		assert.equal(isAgentEvent({}), false);
		assert.equal(isAgentEvent({ type: "NotAnEvent", timestamp: iso() }), false);
		assert.equal(isAgentEvent({ type: "AgentStart" }), false); // missing timestamp
		assert.equal(isAgentEvent("AgentStart"), false);
	});

	it("iso() returns a valid ISO-8601 timestamp in UTC", () => {
		const s = iso();
		// Strict ISO-8601 with trailing Z (UTC); accept ms precision.
		assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});
});
