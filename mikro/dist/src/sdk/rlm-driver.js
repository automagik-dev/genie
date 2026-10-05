/**
 * rlm-driver — Wish B Group 2b/c + mikro#78.
 *
 * Adapts the mikro LLM backend to the `IterationDriver` contract
 * defined in `src/sdk/agent.ts`. Two modes:
 *
 *   1. **Legacy one-shot mode** (no `tools` config) — the original
 *      behavior: one `llmCompleteSimple` call per iteration, whole
 *      response surfaced as `emit_done.payload.answer`. Preserved
 *      byte-compatibly so existing consumers (cli cutover, simple
 *      agents without tools) keep working.
 *
 *   2. **Tool-dispatch mode** (mikro#78, `tools` config present) —
 *      multi-turn conversation loop with native function-calling:
 *      construction throws `NoExposableToolsError` when no tool
 *      remaining after `expose` has a schema.
 *
 *        • ToolRegistry schemas → pi-ai `Tool[]` → provider-native
 *          function declarations (Gemini functionDeclarations,
 *          Anthropic tools, OpenAI functions — pi-ai handles the
 *          per-provider shape).
 *        • Each LLM call is followed by a check for `ToolCall`
 *          content blocks; any that are present are yielded as
 *          `tool_call` steps, their outcomes come back via
 *          `yield`'s return value (runAgent manual-iterates), and
 *          we append a `toolResult` message to the pi-ai history
 *          before the next call.
 *        • Loop terminates when the LLM emits a pure-text
 *          response (stopReason === "stop") OR an explicit
 *          `emit_done` tool call OR the max-tool-iterations cap
 *          is hit.
 *        • runAgent's permission chain, validate retry pipeline,
 *          session/checkpoint primitives all continue to fire —
 *          the driver stays hermetic and the event flow is
 *          identical to the G2b contract.
 *
 * Design constraints:
 *
 *   • Zero touch to `src/rlm.ts` — the existing CLI entry (`rlmLoop`)
 *     stays byte-for-byte unchanged. This module is additive.
 *   • Legacy path still shares `llmCompleteSimple` with rlm.ts, so
 *     any provider / thinking-level / budget work that lands in
 *     `llm.ts` automatically benefits this driver.
 *   • Tool-dispatch path calls pi-ai `completeSimple` directly —
 *     the tool-aware plumbing (Context.tools, ToolResultMessage,
 *     preserving AssistantMessage across turns) is inherent to
 *     pi-ai's transport layer, so we bypass the legacy `llm.ts`
 *     wrapper rather than bolt tool support on there.
 *   • Python REPL tool-call parsing (mikro-specific ```tool_call``` code
 *     blocks) is still NOT done here — that's the rlm.ts CLI's
 *     concern and a separate slice. This driver does NATIVE
 *     function-calling only, which is what Tier 2 brain-consuming
 *     agents need.
 *
 * Consumers compose it via `runAgent({ driver: rlmDriver(cfg),
 * toolRegistry: registry })` — never called directly by user code.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L93 (wave 5
 * dogfood), plus the "prove end-to-end wiring against real LLM"
 * mandate added in the G2b review cycle; mikro#78 for the native
 * tool-dispatch loop that unblocks Tier 2 agents.
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { ensureStationModels, registerStationProvider, STATION_PROVIDER_ID, } from "../station-provider.js";
import { ensureCustomProviders } from "../custom-providers.js";
import { ensureKhalModels, registerKhalProvider, KHAL_PROVIDER_ID, } from "../khal-provider.js";
import { llmCompleteSimple } from "../llm.js";
const DEFAULT_RETRY_FORMATTER = (hint) => `# Retry hint from the validator\n\n${hint}\n\n`;
const DEFAULT_MAX_TOOL_ITERATIONS = 16;
export class NoExposableToolsError extends Error {
    constructor(handlerNames) {
        super(`rlmDriver: tools supplied but no exposed tool has a schema (handlers without schema: ${handlerNames.join(", ")}). Add tools/<name>.schema.json next to each plugin, call register(name, handler, schema), or omit \`tools\` to run one-shot.`);
        this.name = "NoExposableToolsError";
    }
}
/**
 * Render the iteration's prompt. Keeps it intentionally simple — the
 * driver's job is to get a response surface, not to reproduce the
 * full SYSTEM.md / TOOLS.md / CRITERIA.md synthesis rlm.ts does.
 * Callers needing the full rlm.ts prompt stack should wait for the
 * CLI-cutover slice.
 */
export function formatRlmPrompt(config, req) {
    const parts = [];
    if (config.system) {
        parts.push(config.system.trim());
    }
    if (req.retryHint && req.retryHint.length > 0) {
        const formatter = config.retryHintFormatter ?? DEFAULT_RETRY_FORMATTER;
        parts.push(formatter(req.retryHint));
    }
    // Fold the user's input + any prior assistant turns into the prompt
    // body. First history entry is always the initial user input (runAgent
    // guarantees this); later assistant turns are appended so the model
    // has continuity across iterations.
    for (const turn of req.history) {
        const label = turn.role === "assistant"
            ? "Assistant"
            : turn.role === "system"
                ? "System"
                : "User";
        parts.push(`${label}: ${turn.content}`);
    }
    return parts.join("\n\n");
}
/**
 * Shared pi-ai Models runtime for the tool-dispatch path. `builtinModels()`
 * registers every built-in provider; provider auth resolution (env API keys)
 * replaces the old compat env-key injection the root `completeSimple` gave.
 */
const piModels = builtinModels();
// Register the local Lemonade gateway as a first-class `station/<model>`
// provider at this resolution site (mirrored in src/llm.ts).
registerStationProvider(piModels);
// Same for the khal LiteLLM gateway (`khal/<model>`).
registerKhalProvider(piModels);
/**
 * Resolve a pi-ai Model using the same fallback strategy as llm.ts
 * (try exact id, then strip date suffix). Kept in-sync with `llm.ts`
 * `resolveModel` — when that helper goes public we'll import it.
 */
function resolvePiModel(provider, modelId) {
    let model = piModels.getModel(provider, modelId);
    if (!model) {
        const stripped = modelId.replace(/-\d{8}$/, "");
        if (stripped !== modelId) {
            model = piModels.getModel(provider, stripped);
        }
    }
    if (!model) {
        throw new Error(`rlmDriver: unknown model "${modelId}" for provider "${provider}".`);
    }
    return model;
}
/**
 * Turn a ToolRegistry + optional allowlist into pi-ai `Tool[]`. Tools
 * without schemas are skipped (can't be called by the LLM).
 */
function buildPiTools(cfg) {
    const allowed = cfg.expose ? new Set(cfg.expose) : null;
    const out = [];
    for (const { name, schema } of cfg.registry.listSchemas()) {
        if (allowed && !allowed.has(name))
            continue;
        out.push(toPiTool(name, schema));
    }
    if (allowed) {
        // Preserve declared order from `expose` when it's set.
        out.sort((a, b) => {
            const ia = cfg.expose?.indexOf(a.name) ?? 0;
            const ib = cfg.expose?.indexOf(b.name) ?? 0;
            return ia - ib;
        });
    }
    return out;
}
function toPiTool(name, schema) {
    // pi-ai's `parameters` field expects a TSchema (typebox), but at
    // runtime it just needs a JSON-Schema-shaped object. Cast at the
    // boundary — the schema travels opaquely through pi-ai's
    // per-provider converters (e.g. convertTools in google-shared.ts
    // accepts `parametersJsonSchema`).
    const parameters = (schema.parameters ?? {
        type: "object",
        properties: {},
    });
    return {
        name,
        description: schema.description ?? "",
        parameters,
    };
}
/**
 * Build an `IterationDriver` that drives the LLM. Legacy one-shot
 * mode is used only when `tools` is absent. When `tools` is present,
 * construction throws unless at least one tool remaining after
 * `expose` has a schema; otherwise it uses multi-turn tool dispatch.
 */
export function rlmDriver(config) {
    // Pick the branch at driver-construction time so runtime doesn't
    // re-decide per iteration. The returned generator is hermetic:
    // both branches satisfy `AsyncGenerator<IterationStep, void,
    // ToolCallOutcome | undefined>`.
    if (config.tools) {
        const tools = config.tools;
        if (buildPiTools(tools).length === 0) {
            const exposed = tools.expose ? new Set(tools.expose) : null;
            const handlersWithoutSchema = tools.registry
                .list()
                .filter((name) => (!exposed || exposed.has(name)) &&
                tools.registry.describe(name) === undefined);
            throw new NoExposableToolsError(handlersWithoutSchema);
        }
        return buildToolDispatchDriver(config, tools);
    }
    return buildLegacyDriver(config);
}
/**
 * Legacy one-shot driver — preserved byte-compatibly from the pre-mikro#78
 * rlmDriver so existing tests + consumers keep passing. Yields a single
 * `message` step with the full response text followed by an `emit_done`
 * step carrying `{answer, usage, iteration}`.
 */
function buildLegacyDriver(config) {
    const llm = config.llm ?? llmCompleteSimple;
    return async function* (req, signal) {
        const prompt = formatRlmPrompt(config, req);
        let response;
        try {
            response = await llm(prompt, config.model, signal);
        }
        catch (err) {
            yield {
                kind: "error",
                error: err instanceof Error ? err : new Error(String(err)),
            };
            return;
        }
        const text = (response.text ?? "").trim();
        if (text.length === 0) {
            yield {
                kind: "error",
                error: new Error("rlmDriver: LLM returned empty response"),
            };
            return;
        }
        yield { kind: "message", role: "assistant", content: text };
        yield {
            kind: "emit_done",
            payload: {
                answer: text,
                usage: response.usage,
                iteration: req.iteration,
            },
        };
    };
}
/**
 * Tool-dispatch driver (mikro#78). Multi-turn loop that:
 *   1. seeds the pi-ai Context with systemPrompt + user input
 *      (+ any retryHint),
 *   2. calls pi-ai completeSimple with tools=<registry schemas>,
 *   3. inspects the response for ToolCall blocks, yields a
 *      `tool_call` step per block, awaits the outcome from runAgent
 *      via `yield`'s return value,
 *   4. appends ToolResultMessage(s) + the AssistantMessage to the
 *      conversation history,
 *   5. repeats until the model emits a pure-text response
 *      (stopReason === "stop") or the max-tool-iterations cap trips.
 *
 * Final text answer → `message` + `emit_done({answer, usage,
 * iteration, toolCalls})`. When the LLM explicitly invokes an
 * `emit_done` tool (if registered), its args become the payload.
 */
function buildToolDispatchDriver(config, toolsCfg) {
    const maxToolIterations = toolsCfg.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
    const tools = buildPiTools(toolsCfg);
    const llm = config.toolsLlm ??
        (async (ctx, modelCfg, signal) => {
            // Station's catalog is dynamic; apply the overlay before resolving so
            // gateway-only model ids resolve here too (mirrors src/llm.ts).
            if (modelCfg.provider === STATION_PROVIDER_ID) {
                await ensureStationModels(piModels);
            }
            // khal's catalog is entirely dynamic, and the hook throws naming
            // KHAL_API_KEY when the key is missing — before any model lookup, so
            // a keyless run never reads as "unknown model" (mirrors src/llm.ts).
            if (modelCfg.provider === KHAL_PROVIDER_ID) {
                await ensureKhalModels(piModels);
            }
            // Config-declared providers (mikro.yaml / settings.json `providers`)
            // ride on the model config; register them before lookup (mirrors
            // src/llm.ts resolveModel).
            ensureCustomProviders(piModels, modelCfg.providers);
            const model = resolvePiModel(modelCfg.provider, modelCfg.model);
            const opts = { signal };
            return await piModels.completeSimple(model, ctx, opts);
        });
    return async function* (req, signal) {
        // Seed the conversation history from runAgent's `req.history`
        // (user input + any prior assistant turns runAgent already
        // validated) + the retry hint (if present).
        const piMessages = [];
        for (const turn of req.history) {
            if (turn.role === "user" || turn.role === "system") {
                piMessages.push({
                    role: "user",
                    content: turn.content,
                    timestamp: Date.now(),
                });
            }
            else {
                // Assistant turns from history are text-only (runAgent
                // doesn't reconstruct ToolCall blocks across iterations).
                // Replay them as a minimal AssistantMessage so pi-ai's
                // per-provider transforms treat them as valid turns.
                piMessages.push({
                    role: "assistant",
                    content: [{ type: "text", text: turn.content }],
                    api: "anthropic-messages",
                    provider: config.model.provider,
                    model: config.model.model,
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                            input: 0,
                            output: 0,
                            cacheRead: 0,
                            cacheWrite: 0,
                            total: 0,
                        },
                    },
                    stopReason: "stop",
                    timestamp: Date.now(),
                });
            }
        }
        const systemPrompt = buildSystemPrompt(config, req);
        let aggregatedText = "";
        let toolCallsDispatched = 0;
        let lastUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        for (let loopIter = 0; loopIter < maxToolIterations; loopIter++) {
            if (signal.aborted)
                return;
            const ctx = {
                systemPrompt,
                messages: piMessages,
                tools,
            };
            let assistant;
            try {
                assistant = await llm(ctx, config.model, signal);
            }
            catch (err) {
                yield {
                    kind: "error",
                    error: err instanceof Error ? err : new Error(String(err)),
                };
                return;
            }
            // Accumulate usage across tool loop iterations so the final
            // emit_done payload reflects the full turn, not just the
            // last LLM call.
            if (assistant.usage) {
                lastUsage = {
                    input: lastUsage.input + (assistant.usage.input ?? 0),
                    output: lastUsage.output + (assistant.usage.output ?? 0),
                    cacheRead: lastUsage.cacheRead + (assistant.usage.cacheRead ?? 0),
                    cacheWrite: lastUsage.cacheWrite + (assistant.usage.cacheWrite ?? 0),
                    total: lastUsage.total +
                        (assistant.usage.cost?.total ?? 0),
                };
            }
            // Append the assistant turn to history BEFORE yielding tool
            // results — pi-ai's next call expects the toolCall blocks
            // to reference the prior AssistantMessage, not floating
            // ToolResultMessages.
            piMessages.push(assistant);
            const textBlocks = [];
            const toolCalls = [];
            for (const block of assistant.content ?? []) {
                if (block.type === "text") {
                    textBlocks.push(block.text);
                }
                else if (block.type === "toolCall") {
                    toolCalls.push(block);
                }
                // thinking/thoughtSignature blocks are passed through via
                // piMessages (they live on the AssistantMessage we
                // already pushed) — the driver doesn't need to surface
                // them as runAgent events in this PR.
            }
            const text = textBlocks.join("").trim();
            if (text.length > 0) {
                // Surface interim assistant text as a Message event so
                // observers (logs, UI) see reasoning between tool calls.
                yield { kind: "message", role: "assistant", content: text };
                aggregatedText = text;
            }
            if (toolCalls.length === 0) {
                // Pure text response → terminal. stopReason should be
                // "stop" here; "length" / "error" get surfaced as
                // errors.
                if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
                    yield {
                        kind: "error",
                        error: new Error(`rlmDriver: LLM stopped with reason "${assistant.stopReason}": ${assistant.errorMessage ?? "<no message>"}`),
                    };
                    return;
                }
                if (text.length === 0) {
                    yield {
                        kind: "error",
                        error: new Error("rlmDriver: LLM returned empty response (no text, no tool calls)"),
                    };
                    return;
                }
                yield {
                    kind: "emit_done",
                    payload: {
                        answer: aggregatedText,
                        usage: lastUsage,
                        iteration: req.iteration,
                        toolCalls: toolCallsDispatched,
                    },
                };
                return;
            }
            // Dispatch each tool call sequentially. Sequential dispatch
            // is safer than parallel (permission hooks may mutate
            // session state, validate cap assumes ordered replay) and
            // matches the Gemini / Anthropic reference flow.
            const results = [];
            for (const tc of toolCalls) {
                if (signal.aborted)
                    return;
                // Special-case an `emit_done` tool call: when an agent
                // wants to stop with structured output, it calls
                // emit_done(payload) rather than returning free text.
                // We honor this directly — no need to re-loop the
                // LLM.
                if (tc.name === "emit_done") {
                    yield {
                        kind: "emit_done",
                        payload: tc.arguments,
                    };
                    return;
                }
                const outcome = yield {
                    kind: "tool_call",
                    tool: tc.name,
                    args: tc.arguments,
                    id: tc.id,
                };
                toolCallsDispatched++;
                // When runAgent dispatched the call, it returns an
                // outcome via `.next(outcome)` — the return value of
                // the `yield`. When runAgent was invoked without a
                // registry/resolver (unit tests that only check the
                // step sequence), outcome is undefined; substitute a
                // benign "nothing happened" placeholder so the driver
                // can continue gracefully.
                const safeOutcome = outcome ?? {
                    tool: tc.name,
                    ok: true,
                    result: null,
                    durationMs: 0,
                };
                results.push(buildToolResult(tc, safeOutcome));
            }
            // Feed every tool result back in one batch so the next LLM
            // call sees all outcomes at once. pi-ai / Gemini / Anthropic
            // all accept interleaved toolResult messages before the
            // next assistant turn.
            piMessages.push(...results);
        }
        // Fell off the loop → exceeded max-tool-iterations cap. Surface
        // the last accumulated text as an emit_done so consumers don't
        // lose partial progress, but annotate via error so budget /
        // alerting plumbing fires.
        yield {
            kind: "error",
            error: new Error(`rlmDriver: exceeded maxToolIterations=${maxToolIterations} without a terminal response`),
        };
    };
}
/**
 * Build the systemPrompt for tool-dispatch mode. Combines the
 * caller-provided `config.system` with any runAgent-supplied retry
 * hint so the LLM sees both.
 */
function buildSystemPrompt(config, req) {
    const parts = [];
    if (config.system)
        parts.push(config.system.trim());
    if (req.retryHint && req.retryHint.length > 0) {
        const formatter = config.retryHintFormatter ?? DEFAULT_RETRY_FORMATTER;
        parts.push(formatter(req.retryHint).trim());
    }
    if (parts.length === 0)
        return undefined;
    return parts.join("\n\n");
}
/**
 * Build a pi-ai ToolResultMessage from a ToolCallOutcome + the
 * original ToolCall. Encodes success results as JSON text so the
 * LLM sees structured data; errors come through as text with an
 * "Error:" prefix and `isError: true` so providers that support
 * tool-error markers (Anthropic) can flag them.
 */
function buildToolResult(tc, outcome) {
    const resultText = outcome.ok
        ? formatResultText(outcome.result)
        : `Error: ${outcome.error?.message ?? String(outcome.result)}`;
    return {
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: [{ type: "text", text: resultText }],
        isError: !outcome.ok,
        timestamp: Date.now(),
    };
}
function formatResultText(result) {
    if (typeof result === "string")
        return result;
    if (result === null || result === undefined)
        return "";
    try {
        return JSON.stringify(result);
    }
    catch {
        return String(result);
    }
}
//# sourceMappingURL=rlm-driver.js.map