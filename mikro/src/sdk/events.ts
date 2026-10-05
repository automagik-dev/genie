/**
 * SDK event types — Wish B Group 1 skeleton (issue mikro-sdk-upgrade).
 *
 * These 10 events are the contract the SDK exposes to consumers of
 * `runAgent()`. They are yielded in order by an async iterator (see
 * `emitter.ts`) and together form a complete narrative of one agent
 * run: configuration → iteration loop → tool use → recursion →
 * validation → emit_done → error/success.
 *
 * Group 1 defines types and emit infrastructure only. Instrumentation
 * hooks inside `rlm.ts`, the `runAgent()` entry point, and consumer
 * wiring (session, permissions, validate) land in Groups 2-3.
 *
 * Spec source: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L21.
 */
export type AgentEventType =
	| "AgentStart"
	| "IterationStart"
	| "IterationOutput"
	| "ToolCallBefore"
	| "ToolCallAfter"
	| "Recurse"
	| "Validation"
	| "Message"
	| "EmitDone"
	| "Error"
	| "SessionOpen"
	| "SessionClose"
	| "ToolCallObservation";

/** Base shape — every event carries a timestamp + discriminant. */
interface BaseEvent {
	/** ISO-8601 timestamp emitted by `iso()`. */
	readonly timestamp: string;
	/**
	 * Recursion ancestry key (Wish B live-tui G2). Optional, additive —
	 * present once the recursion bridge is wired. This is the STABLE id of
	 * the node the event belongs to: for a spawned child it is the sortable
	 * `uuidv7()` correlation id minted at the spawn site; for a run's own
	 * iterations it is that run's self-correlation id. Consumers build the
	 * recursion tree by keying on `correlationId` + `parentRunId` — NOT on
	 * `depth`, which cannot disambiguate sibling branches at the same level.
	 */
	readonly correlationId?: string;
	/**
	 * The `correlationId` of the parent node — the ancestry edge. Maps to
	 * the child process's `MIKRO_PARENT_RUN_ID`. Absent (undefined) for the
	 * true root run. A `RecurseEvent`'s `parentRunId` is the spawning run's
	 * self-correlation id; the spawned child node's `correlationId` is the
	 * freshly minted id, so two siblings of one parent are always distinct.
	 */
	readonly parentRunId?: string;
}

/** Fired once per `runAgent()` before the first iteration. */
export interface AgentStartEvent extends BaseEvent {
	readonly type: "AgentStart";
	readonly agentId: string;
	readonly sessionId: string;
	/** Opaque snapshot of the config the SDK resolved at spawn time. */
	readonly config: Readonly<Record<string, unknown>>;
}

export interface IterationStartEvent extends BaseEvent {
	readonly type: "IterationStart";
	readonly sessionId: string;
	readonly iteration: number;
}

export interface IterationOutputEvent extends BaseEvent {
	readonly type: "IterationOutput";
	readonly sessionId: string;
	readonly iteration: number;
	readonly output: string;
	/**
	 * Provider-reported model that actually served this iteration
	 * (`AssistantMessage.responseModel`, surfaced by the Group 1 Models
	 * runtime). Optional — present when the producer has it. Lets a live
	 * consumer show which concrete model answered a node.
	 */
	readonly responseModel?: string;
	/**
	 * Per-iteration structured metrics (Wish B G3). Optional — present
	 * when runAgent (or a consumer wrapper) wires a `MetricsRecorder`.
	 * See `metrics.ts` for the shape. Keeps `ALL_AGENT_EVENT_TYPES`
	 * pinned at 12 by riding on an existing event instead of adding
	 * a new `MetricEvent` variant.
	 *
	 * On the recursion path this carries per-node cost/tokens/latency:
	 * a run's own iterations populate it from the wired `MetricsRecorder`;
	 * a bridged child-completion populates it from `RlmChildResult.usage`.
	 */
	readonly metrics?: {
		readonly depth: number;
		readonly parentDepth: number;
		readonly latencyMs: number;
		readonly toolCalls: number;
		readonly costUsd?: number;
		readonly tokens?: {
			readonly input: number;
			readonly output: number;
			readonly cached?: number;
			/** Reasoning/thinking tokens (subset of output), when the
			 *  provider reports them (Group 1 `UsageStats.reasoningTokens`). */
			readonly reasoning?: number;
		};
		readonly cacheHitRatio?: number;
	};
}

export interface ToolCallBeforeEvent extends BaseEvent {
	readonly type: "ToolCallBefore";
	readonly sessionId: string;
	readonly iteration: number;
	readonly tool: string;
	readonly args: unknown;
}

export interface ToolCallAfterEvent extends BaseEvent {
	readonly type: "ToolCallAfter";
	readonly sessionId: string;
	readonly iteration: number;
	readonly tool: string;
	readonly result: unknown;
	readonly durationMs: number;
	readonly ok: boolean;
}

/** Emitted each time the agent recurses via `rlm_query`. */
export interface RecurseEvent extends BaseEvent {
	readonly type: "Recurse";
	readonly sessionId: string;
	readonly iteration: number;
	readonly depth: number;
	readonly parentDepth: number;
	readonly query: string;
}

/**
 * Validation outcome after an `emit_done` payload. `status: "pass"` ends
 * the loop; `status: "fail"` with `attempt: 1` triggers a retry with
 * the schema hint prepended. `attempt: 2` with `"fail"` is terminal
 * and forwarded as a ValidationFailedEvent via the caller.
 */
export interface ValidationEvent extends BaseEvent {
	readonly type: "Validation";
	readonly sessionId: string;
	readonly status: "pass" | "fail";
	readonly attempt: number;
	readonly errors?: readonly string[];
}

export interface MessageEvent extends BaseEvent {
	readonly type: "Message";
	readonly sessionId: string;
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

export interface EmitDoneEvent extends BaseEvent {
	readonly type: "EmitDone";
	readonly sessionId: string;
	readonly payload: unknown;
}

export interface ErrorEvent extends BaseEvent {
	readonly type: "Error";
	readonly sessionId: string;
	/**
	 * Phase marker — lets consumers attribute the error to a specific
	 * pipeline stage (`"spawn" | "iteration" | "tool" | "validate" | ...`).
	 * Free-form string; consumers should not switch on unknown values.
	 */
	readonly phase: string;
	readonly error: {
		readonly name: string;
		readonly message: string;
		readonly stack?: string;
	};
}

/**
 * Session lifecycle — defined in Group 2 alongside the Session API
 * (`resumeAgent` / `pauseAgent`). These bracket a session; within
 * them the 10 wish-spec events flow as before.
 */
export interface SessionOpenEvent extends BaseEvent {
	readonly type: "SessionOpen";
	readonly sessionId: string;
	/** `true` when `resumeAgent` found an existing snapshot. */
	readonly resumed: boolean;
}

export type SessionCloseReason = "complete" | "pause" | "abort" | "error";

export interface SessionCloseEvent extends BaseEvent {
	readonly type: "SessionClose";
	readonly sessionId: string;
	readonly reason: SessionCloseReason;
}

/**
 * Observation of a tool call whose dispatch happens elsewhere (e.g.
 * inside a wrapped framework like pi-agent or LangChain). runAgent
 * emits this when the driver yields a `tool_call_observation`
 * IterationStep — it does NOT invoke the permission chain or the
 * tool registry for observations (the external framework already
 * handled both). Consumers interested in observation-based policy
 * subscribe to this event directly.
 *
 * `status` lifecycle:
 *   - `"started"` — driver observed the tool call begin
 *   - `"completed"` — tool returned successfully, `result` present
 *   - `"failed"` — tool errored, `error` present
 *
 * Intended for consumer drivers that wrap an external agent
 * framework whose tool dispatch is already complete — e.g. brain's
 * preservation bridge driving pi-agent. Native SDK tool dispatch
 * (`tool_call` IterationStep) stays the primary path for
 * consumers authoring loops inside the SDK.
 */
export type ToolCallObservationStatus = "started" | "completed" | "failed";

export interface ToolCallObservationEvent extends BaseEvent {
	readonly type: "ToolCallObservation";
	readonly sessionId: string;
	readonly iteration: number;
	readonly tool: string;
	readonly args: unknown;
	readonly status: ToolCallObservationStatus;
	readonly result?: unknown;
	readonly error?: {
		readonly name: string;
		readonly message: string;
	};
	/** Wall-clock duration of the external dispatch, when the driver
	 *  can report it. Optional — drivers that only surface completion
	 *  may not have timing. */
	readonly durationMs?: number;
}

/** Discriminated union — the sole surface SDK consumers iterate over. */
export type AgentEvent =
	| AgentStartEvent
	| IterationStartEvent
	| IterationOutputEvent
	| ToolCallBeforeEvent
	| ToolCallAfterEvent
	| RecurseEvent
	| ValidationEvent
	| MessageEvent
	| EmitDoneEvent
	| ErrorEvent
	| SessionOpenEvent
	| SessionCloseEvent
	| ToolCallObservationEvent;

/**
 * Exhaustive sentinel — useful for switch statements so TS flags any
 * consumer that forgets to handle a new variant as the union grows.
 */
export const ALL_AGENT_EVENT_TYPES: readonly AgentEventType[] = [
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
	"SessionOpen",
	"SessionClose",
	"ToolCallObservation",
] as const;

/** The 10 wish-spec event types. Session lifecycle types (SessionOpen /
 *  SessionClose) arrive in Group 2 as additions — `ALL_AGENT_EVENT_TYPES`
 *  above is the full current union, this constant stays frozen at the
 *  WISH.md L21 contract so regression tests can pin it. */
export const WISH_SPEC_EVENT_TYPES: readonly AgentEventType[] = [
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
] as const;

/** ISO-8601 in UTC — identical across machines + easy for downstream parsing. */
export function iso(now: Date = new Date()): string {
	return now.toISOString();
}

/**
 * Build an event from a partial — the SDK internals call this instead
 * of writing object literals, so the timestamp + discriminant land
 * consistently and future additions (e.g. `spanId`) can be filled in
 * here without touching every call site.
 */
export function makeEvent<E extends AgentEvent>(
	type: E["type"],
	fields: Omit<E, "type" | "timestamp"> & { timestamp?: string },
): E {
	const { timestamp, ...rest } = fields as Omit<E, "type" | "timestamp"> & {
		timestamp?: string;
	};
	return { ...(rest as object), type, timestamp: timestamp ?? iso() } as E;
}

/**
 * Round-trip hardness check — used in tests. Every event must
 * serialize to JSON without losing its discriminant or timestamp.
 */
export function isAgentEvent(value: unknown): value is AgentEvent {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.type === "string" &&
		typeof v.timestamp === "string" &&
		(ALL_AGENT_EVENT_TYPES as readonly string[]).includes(v.type as string)
	);
}
