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

import { createEmitter, type EventStream } from "./emitter.js";
import { createMetricsRecorder, type MetricsRecorder } from "./metrics.js";
import type { ToolRegistry } from "./tool-registry.js";
import {
	type AgentStartEvent,
	type EmitDoneEvent,
	type ErrorEvent,
	type IterationOutputEvent,
	type IterationStartEvent,
	makeEvent,
	type MessageEvent,
	type SessionCloseReason,
	type ToolCallAfterEvent,
	type ToolCallBeforeEvent,
	type ToolCallObservationEvent,
	type ValidationEvent,
} from "./events.js";
import {
	type PermissionHook,
	type PermissionHookContext,
	runPermissionChain,
} from "./permissions.js";
import { iso } from "./events.js";
import {
	type BudgetSnapshot,
	type HistoryTurn,
	pauseAgent,
	resumeAgent,
	type SessionState,
	type SessionStore,
} from "./session.js";
import {
	buildRetryHint,
	MAX_VALIDATE_ATTEMPTS,
	shouldRetry,
	type ValidateResult,
	type ValidateSchema,
	validateAgainstSchema,
} from "./validate.js";

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
	readonly error?: { readonly name: string; readonly message: string };
	readonly durationMs: number;
	/** True when the permission chain denied the call. `result` is null and
	 *  `ok` is false in this case; drivers that want to explain the denial
	 *  to the LLM should surface `error.message` as a tool-result note. */
	readonly denied?: boolean;
}

/** One step produced by an `IterationDriver` during a single iteration. */
export type IterationStep =
	| {
			readonly kind: "message";
			readonly role: "system" | "user" | "assistant";
			readonly content: string;
	  }
	| {
			readonly kind: "tool_call";
			readonly tool: string;
			readonly args: unknown;
			/** Optional LLM-issued id (e.g. Gemini `functionCall.id`,
			 *  Anthropic `tool_use.id`). Drivers that need to pair
			 *  outcomes with ToolResultMessage.toolCallId should set
			 *  this so the outcome comes back correlated. */
			readonly id?: string;
	  }
	| {
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
			readonly error?: { readonly name: string; readonly message: string };
			readonly durationMs?: number;
	  }
	| { readonly kind: "emit_done"; readonly payload: unknown }
	| { readonly kind: "error"; readonly error: Error };

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
export type IterationDriver = (
	req: IterationRequest,
	signal: AbortSignal,
) =>
	| AsyncIterable<IterationStep>
	| AsyncGenerator<IterationStep, void, ToolCallOutcome | undefined>;

/** Resolves a tool invocation. Called after a non-deny permission
 *  decision. When omitted, tool calls are recorded but not executed
 *  (the `ToolCallAfter.result` is `null`). */
export type ToolResolver = (
	tool: string,
	args: unknown,
	signal: AbortSignal,
) => Promise<unknown>;

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

const DEFAULT_MAX_ITERATIONS = 32;
/**
 * Default budget — `limit` is set to `Number.MAX_SAFE_INTEGER` rather
 * than `Infinity` so the snapshot survives `JSON.stringify` roundtrip
 * (which coerces `Infinity` to `null` and would fail the `isSessionState`
 * number check on reload).
 */
const DEFAULT_BUDGET: BudgetSnapshot = {
	spent: 0,
	limit: Number.MAX_SAFE_INTEGER,
	currency: "usd",
};

/** Background driver returned to the caller. Iterate events via `for await`. */
export function runAgent(config: AgentConfig): EventStream {
	const em = createEmitter();
	void drive(config, em).catch((err) => {
		if (!em.closed) {
			const ev: ErrorEvent = makeEvent("Error", {
				sessionId: config.sessionId,
				phase: "runAgent",
				error: {
					name: err instanceof Error ? err.name : "Error",
					message: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				},
			} as Omit<ErrorEvent, "type" | "timestamp">);
			em.emit(ev);
			em.close();
		}
	});
	return em;
}

async function drive(
	config: AgentConfig,
	em: ReturnType<typeof createEmitter>,
): Promise<void> {
	const {
		agentId,
		sessionId,
		input,
		driver,
		toolResolver,
		toolRegistry,
		sessionStore,
		permissionHooks = [],
		validateSchema,
		validateSchemaSource,
		budget = DEFAULT_BUDGET,
		maxIterations = DEFAULT_MAX_ITERATIONS,
		signal,
		configSnapshot = {},
		depth = 0,
		parentDepth = -1,
		metricsRecorder = createMetricsRecorder(),
	} = config;

	/**
	 * Resolve a tool call via the registry first, the resolver second.
	 * Throws when neither knows the tool so the error plumbing fires a
	 * `ToolCallAfter{ok:false}` + `Error{phase:"tool"}` pair.
	 */
	async function dispatchTool(
		tool: string,
		args: unknown,
		sig: AbortSignal,
	): Promise<unknown> {
		const handler = toolRegistry?.get(tool);
		if (handler) {
			return handler(args, {
				tool,
				sessionId,
				iteration: currentIteration,
				signal: sig,
			});
		}
		if (toolResolver) return toolResolver(tool, args, sig);
		throw new Error(`unknown tool: "${tool}" (no registry/resolver match)`);
	}

	let currentIteration = 0; // captured by dispatchTool for ctx.iteration

	// ── emit AgentStart ──────────────────────────────────────────────
	const startEv: AgentStartEvent = makeEvent("AgentStart", {
		agentId,
		sessionId,
		config: configSnapshot,
	} as Omit<AgentStartEvent, "type" | "timestamp">);
	em.emit(startEv);

	// ── resume / open session ────────────────────────────────────────
	let history: HistoryTurn[] = [{ role: "user", content: input }];
	let iteration = 0;
	let budgetSnap: BudgetSnapshot = budget;
	let closeReason: SessionCloseReason = "complete";

	if (sessionStore) {
		const prior = await resumeAgent(sessionId, sessionStore, em);
		if (prior) {
			history = [...prior.history];
			iteration = prior.iteration;
			budgetSnap = prior.budget;
		}
	}

	// Propagate abort → emit Error{phase:"abort"} and mark reason.
	const ac = new AbortController();
	const linkAbort = () => {
		closeReason = "abort";
		ac.abort();
	};
	if (signal) {
		if (signal.aborted) linkAbort();
		else signal.addEventListener("abort", linkAbort, { once: true });
	}

	let retryHint: string | undefined;
	let validateAttempt = 0;
	let done = false;

	try {
		iterationLoop: while (!done && iteration < maxIterations && !ac.signal.aborted) {
			iteration++;
			currentIteration = iteration;
			metricsRecorder.start(depth, parentDepth);
			const iterStart: IterationStartEvent = makeEvent("IterationStart", {
				sessionId,
				iteration,
			} as Omit<IterationStartEvent, "type" | "timestamp">);
			em.emit(iterStart);

			const req: IterationRequest = {
				sessionId,
				iteration,
				history: [...history],
				retryHint,
			};
			let iterOutput = "";

			// Manual iteration so we can push tool outcomes back into the
			// driver via `.next(outcome)`. Async generators treat a call
			// to `.next(value)` as the return value of the current `yield`,
			// which is how multi-turn drivers (rlmDriver in tool-dispatch
			// mode) fold tool results back into the next LLM call.
			const iter = driver(req, ac.signal) as AsyncGenerator<
				IterationStep,
				void,
				ToolCallOutcome | undefined
			>;
			let nextInput: ToolCallOutcome | undefined;

			while (true) {
				if (ac.signal.aborted) break iterationLoop;
				const { value: step, done: iterDone } = await iter.next(nextInput);
				nextInput = undefined;
				if (iterDone) break;
				if (!step) continue;
				// Re-check abort AFTER the driver yielded — the driver
				// itself may have triggered the abort in its yield
				// prelude. Matches the pre-mikro#78 `for await` semantics
				// which checked before processing each step.
				if (ac.signal.aborted) break iterationLoop;

				switch (step.kind) {
					case "message": {
						const ev: MessageEvent = makeEvent("Message", {
							sessionId,
							role: step.role,
							content: step.content,
						} as Omit<MessageEvent, "type" | "timestamp">);
						em.emit(ev);
						history.push({ role: step.role, content: step.content });
						iterOutput += step.content;
						continue;
					}

					case "tool_call": {
						const ctx: PermissionHookContext = {
							tool: step.tool,
							args: step.args,
							sessionId,
							iteration,
							history: [...history],
						};
						const decision = await runPermissionChain(permissionHooks, ctx);
						const effectiveArgs =
							decision.decision === "modify"
								? decision.modifiedArgs
								: step.args;

						const before: ToolCallBeforeEvent = makeEvent("ToolCallBefore", {
							sessionId,
							iteration,
							tool: step.tool,
							args: effectiveArgs,
						} as Omit<ToolCallBeforeEvent, "type" | "timestamp">);
						em.emit(before);
						// Count every attempted tool call, including denies — the
						// metric answers "how many times did the agent TRY to call
						// a tool this iteration", which denies are a signal for.
						metricsRecorder.incrToolCalls();

						if (decision.decision === "deny") {
							const afterDeny: ToolCallAfterEvent = makeEvent(
								"ToolCallAfter",
								{
									sessionId,
									iteration,
									tool: step.tool,
									result: null,
									durationMs: 0,
									ok: false,
								} as Omit<ToolCallAfterEvent, "type" | "timestamp">,
							);
							em.emit(afterDeny);
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "tool-denied",
								error: {
									name: "PermissionDenied",
									message: decision.reason,
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
							// Surface the denial to the driver so it can
							// explain the failure back to the LLM instead
							// of looping forever re-issuing the call.
							nextInput = {
								tool: step.tool,
								ok: false,
								result: null,
								error: {
									name: "PermissionDenied",
									message: decision.reason,
								},
								durationMs: 0,
								denied: true,
							};
							continue;
						}

						const t0 = Date.now();
						let result: unknown = null;
						let ok = true;
						let toolError: Error | undefined;
						try {
							if (toolRegistry || toolResolver) {
								result = await dispatchTool(
									step.tool,
									effectiveArgs,
									ac.signal,
								);
							}
						} catch (e) {
							ok = false;
							toolError = e instanceof Error ? e : new Error(String(e));
							result = toolError.message;
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "tool",
								error: {
									name: toolError.name,
									message: toolError.message,
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
						}
						const durationMs = Date.now() - t0;
						const after: ToolCallAfterEvent = makeEvent("ToolCallAfter", {
							sessionId,
							iteration,
							tool: step.tool,
							result,
							durationMs,
							ok,
						} as Omit<ToolCallAfterEvent, "type" | "timestamp">);
						em.emit(after);
						nextInput = {
							tool: step.tool,
							ok,
							result,
							error: toolError
								? { name: toolError.name, message: toolError.message }
								: undefined,
							durationMs,
						};
						continue;
					}

					case "tool_call_observation": {
						// Observation: tool dispatch happened OUTSIDE the SDK
						// (typically inside a wrapped framework like pi-agent
						// or LangChain). runAgent does NOT invoke the
						// permission chain or the tool registry. The step
						// surfaces as a dedicated `ToolCallObservation` event
						// so consumers can distinguish from SDK-dispatched
						// tool_call / tool_call_after pairs.
						const obs: ToolCallObservationEvent = makeEvent(
							"ToolCallObservation",
							{
								sessionId,
								iteration,
								tool: step.tool,
								args: step.args,
								status: step.status,
								result: step.result,
								error: step.error,
								durationMs: step.durationMs,
							} as Omit<ToolCallObservationEvent, "type" | "timestamp">,
						);
						em.emit(obs);
						// Count observations distinctly from dispatched tool
						// calls — consumer metrics can diff observed vs
						// dispatched to understand execution topology.
						// (`toolCalls` stays a dispatch-only counter; this
						// is tracked separately when the recorder lands a
						// `incrObservedCalls` helper.)
						continue;
					}

					case "emit_done": {
						if (validateSchema) {
							validateAttempt++;
							const result: ValidateResult = validateAgainstSchema(
								step.payload,
								validateSchema,
								validateSchemaSource,
							);
							if (result.ok) {
								const v: ValidationEvent = makeEvent("Validation", {
									sessionId,
									status: "pass",
									attempt: validateAttempt,
								} as Omit<ValidationEvent, "type" | "timestamp">);
								em.emit(v);
								const dn: EmitDoneEvent = makeEvent("EmitDone", {
									sessionId,
									payload: step.payload,
								} as Omit<EmitDoneEvent, "type" | "timestamp">);
								em.emit(dn);
								done = true;
								break;
							}
							const vf: ValidationEvent = makeEvent("Validation", {
								sessionId,
								status: "fail",
								attempt: validateAttempt,
								errors: result.errors,
							} as Omit<ValidationEvent, "type" | "timestamp">);
							em.emit(vf);
							if (shouldRetry(result, validateAttempt)) {
								retryHint = buildRetryHint(result);
								// Break out of the inner driver-step loop; the
								// outer `while` restarts with the hint set. The
								// next driver request sees the same history.
								break;
							}
							// Terminal failure.
							const err: ErrorEvent = makeEvent("Error", {
								sessionId,
								phase: "validate",
								error: {
									name: "ValidationFailed",
									message: `retry ceiling (${MAX_VALIDATE_ATTEMPTS}) reached`,
								},
							} as Omit<ErrorEvent, "type" | "timestamp">);
							em.emit(err);
							done = true;
							closeReason = "error";
							break;
						}
						const dn: EmitDoneEvent = makeEvent("EmitDone", {
							sessionId,
							payload: step.payload,
						} as Omit<EmitDoneEvent, "type" | "timestamp">);
						em.emit(dn);
						done = true;
						break;
					}

					case "error": {
						const err: ErrorEvent = makeEvent("Error", {
							sessionId,
							phase: "driver",
							error: {
								name: step.error.name,
								message: step.error.message,
								stack: step.error.stack,
							},
						} as Omit<ErrorEvent, "type" | "timestamp">);
						em.emit(err);
						done = true;
						closeReason = "error";
						break;
					}
				}
			}

			// ── iteration-tail observability + checkpoint ──────────────
			const out: IterationOutputEvent = makeEvent("IterationOutput", {
				sessionId,
				iteration,
				output: iterOutput,
				metrics: metricsRecorder.snapshot(),
			} as Omit<IterationOutputEvent, "type" | "timestamp">);
			em.emit(out);

			if (sessionStore && !ac.signal.aborted) {
				const snapshot: SessionState = {
					sessionId,
					iteration,
					history: [...history],
					budget: budgetSnap,
					createdAt: iso(),
					updatedAt: iso(),
				};
				await sessionStore.save(snapshot);
			}

			if (!done && retryHint) {
				// Consume the hint on the next turn's driver call.
				// (retryHint is set in the emit_done branch; leave it set so
				// the next loop iteration sees it, then the driver decides
				// whether to clear or retain.)
				// Driver authors can inspect req.retryHint themselves.
			}
		}

		if (ac.signal.aborted && closeReason !== "error") closeReason = "abort";
	} catch (err) {
		closeReason = "error";
		const ev: ErrorEvent = makeEvent("Error", {
			sessionId,
			phase: "runAgent",
			error: {
				name: err instanceof Error ? err.name : "Error",
				message: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			},
		} as Omit<ErrorEvent, "type" | "timestamp">);
		em.emit(ev);
	} finally {
		// Persist final state + emit SessionClose.
		if (sessionStore) {
			const finalSnapshot: SessionState = {
				sessionId,
				iteration,
				history: [...history],
				budget: budgetSnap,
				createdAt: iso(),
				updatedAt: iso(),
			};
			await pauseAgent(finalSnapshot, sessionStore, closeReason, em);
		} else {
			em.emit(
				makeEvent("SessionClose", {
					sessionId,
					reason: closeReason,
				} as never),
			);
		}
		em.close();
	}
}
