/**
 * `runAgent()` — Wish B Group 2b.
 *
 * Ties the Group 1 event stream and the Group 2 primitives (session,
 * permissions, validate) into a single driving loop. The actual LLM /
 * REPL iteration is supplied by the caller via an `IterationDriver`
 * async generator — this keeps the wiring logic hermetic and
 * testable without needing a live model. When `runAgent` eventually
 * becomes the CLI entry, `rlm.ts` will be adapted into one of these
 * drivers; nothing in this file needs to change for that cutover.
 *
 * Lifecycle:
 *
 *   emit  AgentStart
 *   (if sessionStore)
 *     try resumeAgent → emit SessionOpen{resumed}
 *   loop iteration:
 *     emit IterationStart
 *     consume driver's steps:
 *       "message"     → emit Message; append history
 *       "tool_call"   → permission chain → emit ToolCallBefore/After
 *                       (deny ⇒ emit Error{phase:"tool-denied"})
 *       "emit_done"   → validate if schema supplied:
 *                         pass   → emit Validation{pass} + EmitDone; complete
 *                         fail@1 → emit Validation{fail,1}; loop with hint
 *                         fail@2 → emit Validation{fail,2} + Error; abort
 *                       no schema ⇒ emit EmitDone; complete
 *       "error"       → emit Error; abort
 *     emit IterationOutput (iteration summary)
 *     checkpoint via sessionStore.save
 *   emit SessionClose{reason}
 *   close emitter
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L110-158.
 */
import { type EventStream } from "./emitter.js";
import { type MetricsRecorder } from "./metrics.js";
import type { ToolRegistry } from "./tool-registry.js";
import { type PermissionHook } from "./permissions.js";
import { type BudgetSnapshot, type HistoryTurn, type SessionStore } from "./session.js";
import { type ValidateSchema } from "./validate.js";
/**
 * Outcome of a tool_call dispatch, fed back to the driver via
 * `AsyncGenerator.next(outcome)` so multi-turn drivers (rlmDriver
 * in tool-dispatch mode, mikro#78) can fold the result into the
 * next LLM call as conversation history.
 */
export interface ToolCallOutcome {
    readonly tool: string;
    readonly ok: boolean;
    readonly result: unknown;
    readonly error?: {
        readonly name: string;
        readonly message: string;
    };
    readonly durationMs: number;
    /** True when the permission chain denied the call. `result` is null and
     *  `ok` is false in this case; drivers that want to explain the denial
     *  to the LLM should surface `error.message` as a tool-result note. */
    readonly denied?: boolean;
}
/** One step produced by an `IterationDriver` during a single iteration. */
export type IterationStep = {
    readonly kind: "message";
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
} | {
    readonly kind: "tool_call";
    readonly tool: string;
    readonly args: unknown;
    /** Optional LLM-issued id (e.g. Gemini `functionCall.id`,
     *  Anthropic `tool_use.id`). Drivers that need to pair
     *  outcomes with ToolResultMessage.toolCallId should set
     *  this so the outcome comes back correlated. */
    readonly id?: string;
} | {
    /**
     * Observation of a tool call whose dispatch happened elsewhere
     * — e.g. inside a wrapped agent framework (pi-agent, LangChain).
     * runAgent emits a `ToolCallObservation` event with the carried
     * payload and does NOT invoke the permission chain or the tool
     * registry. Consumers that want observation-based policy should
     * subscribe to the event. See `events.ts`
     * `ToolCallObservationEvent`.
     */
    readonly kind: "tool_call_observation";
    readonly tool: string;
    readonly args: unknown;
    readonly status: "started" | "completed" | "failed";
    readonly result?: unknown;
    readonly error?: {
        readonly name: string;
        readonly message: string;
    };
    readonly durationMs?: number;
} | {
    readonly kind: "emit_done";
    readonly payload: unknown;
} | {
    readonly kind: "error";
    readonly error: Error;
};
export interface IterationRequest {
    readonly sessionId: string;
    readonly iteration: number;
    readonly history: readonly HistoryTurn[];
    /** Present when the previous emit_done failed validation — the
     *  driver should prepend this to its next model turn. */
    readonly retryHint?: string;
}
/**
 * An `IterationDriver` is an async generator that runAgent pumps.
 *
 * runAgent uses manual iteration (`iter.next(value)`) so drivers can
 * receive tool-call outcomes back from runAgent — the generator's
 * `yield` returns the `ToolCallOutcome` when the previously yielded
 * step was a `tool_call` and runAgent finished dispatching it. For
 * any other step kind (message, emit_done, error,
 * tool_call_observation) the yield returns `undefined`.
 *
 * Drivers that don't care about tool outcomes (e.g. the legacy
 * one-shot rlmDriver path) can just `yield step` and ignore the
 * return value — behavior is unchanged from the pre-mikro#78 contract.
 */
export type IterationDriver = (req: IterationRequest, signal: AbortSignal) => AsyncIterable<IterationStep> | AsyncGenerator<IterationStep, void, ToolCallOutcome | undefined>;
/** Resolves a tool invocation. Called after a non-deny permission
 *  decision. When omitted, tool calls are recorded but not executed
 *  (the `ToolCallAfter.result` is `null`). */
export type ToolResolver = (tool: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
export interface AgentConfig {
    readonly agentId: string;
    readonly sessionId: string;
    /** Shown to the first iteration as the user turn; stored in history. */
    readonly input: string;
    readonly driver: IterationDriver;
    readonly toolResolver?: ToolResolver;
    /**
     * Tool registry (Wish B G3a). When supplied, tool-call dispatch
     * prefers the registry: each `tool_call` step looks up `tool` in
     * the registry and invokes the handler. Missing handlers surface
     * as `Error{phase:"tool"}`. Takes precedence over `toolResolver`
     * when both are set; the resolver acts as a fallback for names
     * the registry doesn't know about.
     */
    readonly toolRegistry?: ToolRegistry;
    readonly sessionStore?: SessionStore;
    readonly permissionHooks?: readonly PermissionHook[];
    readonly validateSchema?: ValidateSchema;
    readonly validateSchemaSource?: string;
    readonly budget?: BudgetSnapshot;
    /** Hard ceiling to protect against runaway loops. Default 32. */
    readonly maxIterations?: number;
    readonly signal?: AbortSignal;
    /** Opaque snapshot attached to the AgentStart event for consumers. */
    readonly configSnapshot?: Readonly<Record<string, unknown>>;
    /**
     * Recursion depth this run is executing at. Top-level is 0. A
     * consumer driving nested `rlm_query` recursion should pass the
     * parent's depth + 1 so per-depth metrics carry the correct
     * context (Wish B G3).
     */
    readonly depth?: number;
    /** Parent depth for the per-depth metrics. Default -1 (top-level). */
    readonly parentDepth?: number;
    /** Custom recorder — when omitted, runAgent creates one per run. */
    readonly metricsRecorder?: MetricsRecorder;
}
/** Background driver returned to the caller. Iterate events via `for await`. */
export declare function runAgent(config: AgentConfig): EventStream;
//# sourceMappingURL=agent.d.ts.map