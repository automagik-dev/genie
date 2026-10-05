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
import { createEmitter } from "./emitter.js";
import { createMetricsRecorder } from "./metrics.js";
import { makeEvent, } from "./events.js";
import { runPermissionChain, } from "./permissions.js";
import { iso } from "./events.js";
import { pauseAgent, resumeAgent, } from "./session.js";
import { buildRetryHint, MAX_VALIDATE_ATTEMPTS, shouldRetry, validateAgainstSchema, } from "./validate.js";
const DEFAULT_MAX_ITERATIONS = 32;
/**
 * Default budget — `limit` is set to `Number.MAX_SAFE_INTEGER` rather
 * than `Infinity` so the snapshot survives `JSON.stringify` roundtrip
 * (which coerces `Infinity` to `null` and would fail the `isSessionState`
 * number check on reload).
 */
const DEFAULT_BUDGET = {
    spent: 0,
    limit: Number.MAX_SAFE_INTEGER,
    currency: "usd",
};
/** Background driver returned to the caller. Iterate events via `for await`. */
export function runAgent(config) {
    const em = createEmitter();
    void drive(config, em).catch((err) => {
        if (!em.closed) {
            const ev = makeEvent("Error", {
                sessionId: config.sessionId,
                phase: "runAgent",
                error: {
                    name: err instanceof Error ? err.name : "Error",
                    message: err instanceof Error ? err.message : String(err),
                    stack: err instanceof Error ? err.stack : undefined,
                },
            });
            em.emit(ev);
            em.close();
        }
    });
    return em;
}
async function drive(config, em) {
    const { agentId, sessionId, input, driver, toolResolver, toolRegistry, sessionStore, permissionHooks = [], validateSchema, validateSchemaSource, budget = DEFAULT_BUDGET, maxIterations = DEFAULT_MAX_ITERATIONS, signal, configSnapshot = {}, depth = 0, parentDepth = -1, metricsRecorder = createMetricsRecorder(), } = config;
    /**
     * Resolve a tool call via the registry first, the resolver second.
     * Throws when neither knows the tool so the error plumbing fires a
     * `ToolCallAfter{ok:false}` + `Error{phase:"tool"}` pair.
     */
    async function dispatchTool(tool, args, sig) {
        const handler = toolRegistry?.get(tool);
        if (handler) {
            return handler(args, {
                tool,
                sessionId,
                iteration: currentIteration,
                signal: sig,
            });
        }
        if (toolResolver)
            return toolResolver(tool, args, sig);
        throw new Error(`unknown tool: "${tool}" (no registry/resolver match)`);
    }
    let currentIteration = 0; // captured by dispatchTool for ctx.iteration
    // ── emit AgentStart ──────────────────────────────────────────────
    const startEv = makeEvent("AgentStart", {
        agentId,
        sessionId,
        config: configSnapshot,
    });
    em.emit(startEv);
    // ── resume / open session ────────────────────────────────────────
    let history = [{ role: "user", content: input }];
    let iteration = 0;
    let budgetSnap = budget;
    let closeReason = "complete";
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
        if (signal.aborted)
            linkAbort();
        else
            signal.addEventListener("abort", linkAbort, { once: true });
    }
    let retryHint;
    let validateAttempt = 0;
    let done = false;
    try {
        iterationLoop: while (!done && iteration < maxIterations && !ac.signal.aborted) {
            iteration++;
            currentIteration = iteration;
            metricsRecorder.start(depth, parentDepth);
            const iterStart = makeEvent("IterationStart", {
                sessionId,
                iteration,
            });
            em.emit(iterStart);
            const req = {
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
            const iter = driver(req, ac.signal);
            let nextInput;
            while (true) {
                if (ac.signal.aborted)
                    break iterationLoop;
                const { value: step, done: iterDone } = await iter.next(nextInput);
                nextInput = undefined;
                if (iterDone)
                    break;
                if (!step)
                    continue;
                // Re-check abort AFTER the driver yielded — the driver
                // itself may have triggered the abort in its yield
                // prelude. Matches the pre-mikro#78 `for await` semantics
                // which checked before processing each step.
                if (ac.signal.aborted)
                    break iterationLoop;
                switch (step.kind) {
                    case "message": {
                        const ev = makeEvent("Message", {
                            sessionId,
                            role: step.role,
                            content: step.content,
                        });
                        em.emit(ev);
                        history.push({ role: step.role, content: step.content });
                        iterOutput += step.content;
                        continue;
                    }
                    case "tool_call": {
                        const ctx = {
                            tool: step.tool,
                            args: step.args,
                            sessionId,
                            iteration,
                            history: [...history],
                        };
                        const decision = await runPermissionChain(permissionHooks, ctx);
                        const effectiveArgs = decision.decision === "modify"
                            ? decision.modifiedArgs
                            : step.args;
                        const before = makeEvent("ToolCallBefore", {
                            sessionId,
                            iteration,
                            tool: step.tool,
                            args: effectiveArgs,
                        });
                        em.emit(before);
                        // Count every attempted tool call, including denies — the
                        // metric answers "how many times did the agent TRY to call
                        // a tool this iteration", which denies are a signal for.
                        metricsRecorder.incrToolCalls();
                        if (decision.decision === "deny") {
                            const afterDeny = makeEvent("ToolCallAfter", {
                                sessionId,
                                iteration,
                                tool: step.tool,
                                result: null,
                                durationMs: 0,
                                ok: false,
                            });
                            em.emit(afterDeny);
                            const err = makeEvent("Error", {
                                sessionId,
                                phase: "tool-denied",
                                error: {
                                    name: "PermissionDenied",
                                    message: decision.reason,
                                },
                            });
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
                        let result = null;
                        let ok = true;
                        let toolError;
                        try {
                            if (toolRegistry || toolResolver) {
                                result = await dispatchTool(step.tool, effectiveArgs, ac.signal);
                            }
                        }
                        catch (e) {
                            ok = false;
                            toolError = e instanceof Error ? e : new Error(String(e));
                            result = toolError.message;
                            const err = makeEvent("Error", {
                                sessionId,
                                phase: "tool",
                                error: {
                                    name: toolError.name,
                                    message: toolError.message,
                                },
                            });
                            em.emit(err);
                        }
                        const durationMs = Date.now() - t0;
                        const after = makeEvent("ToolCallAfter", {
                            sessionId,
                            iteration,
                            tool: step.tool,
                            result,
                            durationMs,
                            ok,
                        });
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
                        const obs = makeEvent("ToolCallObservation", {
                            sessionId,
                            iteration,
                            tool: step.tool,
                            args: step.args,
                            status: step.status,
                            result: step.result,
                            error: step.error,
                            durationMs: step.durationMs,
                        });
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
                            const result = validateAgainstSchema(step.payload, validateSchema, validateSchemaSource);
                            if (result.ok) {
                                const v = makeEvent("Validation", {
                                    sessionId,
                                    status: "pass",
                                    attempt: validateAttempt,
                                });
                                em.emit(v);
                                const dn = makeEvent("EmitDone", {
                                    sessionId,
                                    payload: step.payload,
                                });
                                em.emit(dn);
                                done = true;
                                break;
                            }
                            const vf = makeEvent("Validation", {
                                sessionId,
                                status: "fail",
                                attempt: validateAttempt,
                                errors: result.errors,
                            });
                            em.emit(vf);
                            if (shouldRetry(result, validateAttempt)) {
                                retryHint = buildRetryHint(result);
                                // Break out of the inner driver-step loop; the
                                // outer `while` restarts with the hint set. The
                                // next driver request sees the same history.
                                break;
                            }
                            // Terminal failure.
                            const err = makeEvent("Error", {
                                sessionId,
                                phase: "validate",
                                error: {
                                    name: "ValidationFailed",
                                    message: `retry ceiling (${MAX_VALIDATE_ATTEMPTS}) reached`,
                                },
                            });
                            em.emit(err);
                            done = true;
                            closeReason = "error";
                            break;
                        }
                        const dn = makeEvent("EmitDone", {
                            sessionId,
                            payload: step.payload,
                        });
                        em.emit(dn);
                        done = true;
                        break;
                    }
                    case "error": {
                        const err = makeEvent("Error", {
                            sessionId,
                            phase: "driver",
                            error: {
                                name: step.error.name,
                                message: step.error.message,
                                stack: step.error.stack,
                            },
                        });
                        em.emit(err);
                        done = true;
                        closeReason = "error";
                        break;
                    }
                }
            }
            // ── iteration-tail observability + checkpoint ──────────────
            const out = makeEvent("IterationOutput", {
                sessionId,
                iteration,
                output: iterOutput,
                metrics: metricsRecorder.snapshot(),
            });
            em.emit(out);
            if (sessionStore && !ac.signal.aborted) {
                const snapshot = {
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
        if (ac.signal.aborted && closeReason !== "error")
            closeReason = "abort";
    }
    catch (err) {
        closeReason = "error";
        const ev = makeEvent("Error", {
            sessionId,
            phase: "runAgent",
            error: {
                name: err instanceof Error ? err.name : "Error",
                message: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack : undefined,
            },
        });
        em.emit(ev);
    }
    finally {
        // Persist final state + emit SessionClose.
        if (sessionStore) {
            const finalSnapshot = {
                sessionId,
                iteration,
                history: [...history],
                budget: budgetSnap,
                createdAt: iso(),
                updatedAt: iso(),
            };
            await pauseAgent(finalSnapshot, sessionStore, closeReason, em);
        }
        else {
            em.emit(makeEvent("SessionClose", {
                sessionId,
                reason: closeReason,
            }));
        }
        em.close();
    }
}
//# sourceMappingURL=agent.js.map