import { createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { assertLLMCompletion, buildCompletionOptions, createPiModelRuntime, createUsage, LLMCompletionError, mergeUsage, reportedUsage, resolveModel, streamLLMCompletion, } from "../../llm.js";
import { validateAgainstSchema } from "../../sdk/validate.js";
import { BackendRunError } from "../backend.js";
import { checkPiTools, createScopedPiTools, PI_TOOL_NAMES } from "./pi-tools.js";
function checkedRecord(value) {
    // Checked generic record boundary; no claimed external member shape or copy.
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
/** Detect contradictory declared types/enums and required closed-object fields before inference. */
function compatibleSchemas(output, pack, path = "emit_done") {
    if (output.type !== undefined && pack.type !== undefined && output.type !== pack.type &&
        !(output.type === "number" && pack.type === "integer") && !(output.type === "integer" && pack.type === "number")) {
        throw new Error(`pi final schemas conflict at ${path}: output ${String(output.type)} versus VALIDATE ${pack.type}`);
    }
    if (Array.isArray(output.enum) && pack.enum && !output.enum.some((value) => pack.enum?.some((candidate) => Object.is(value, candidate)))) {
        throw new Error(`pi final schemas have disjoint enums at ${path}`);
    }
    const properties = checkedRecord(output.properties);
    if (output.additionalProperties === false && pack.required?.some((name) => !properties || !Object.hasOwn(properties, name))) {
        throw new Error(`pi final schemas conflict at ${path}: output forbids a VALIDATE required field`);
    }
    for (const [name, schema] of Object.entries(pack.properties ?? {})) {
        const other = checkedRecord(properties?.[name]);
        if (other)
            compatibleSchemas(other, schema, `${path}.${name}`);
    }
    const items = checkedRecord(output.items);
    if (items && pack.items)
        compatibleSchemas(items, pack.items, `${path}[]`);
}
/** A protocol-free Pi run, not the RLM driver or an ambient Pi CLI session. */
export class PiBackend {
    async run(agent, request, emit) {
        const incompatible = checkPiTools(agent, request);
        if (incompatible)
            throw new Error(incompatible);
        request.signal?.throwIfAborted();
        const config = request.config;
        const pack = config.validate?.schema;
        const output = config.output.schema;
        if (output && output.type !== "object")
            throw new Error("pi output.schema must describe an object for emit_done parameters");
        if (pack && pack.type !== "object")
            throw new Error("pi VALIDATE schema must describe an object for emit_done parameters");
        if (output && pack)
            compatibleSchemas(output, pack);
        const schema = Type.Unsafe(output ?? pack ?? {
            type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"], additionalProperties: false,
        });
        const validator = Compile(schema);
        const usage = createUsage();
        const runAbort = new AbortController();
        let answer;
        let finalError;
        let providerFailure;
        let missingUsage = false;
        let iterations = 0;
        let budgetHit = null;
        const maximum = request.maxIterations ?? agent?.spec.budget?.maxIterations ?? 16;
        if (!Number.isInteger(maximum) || maximum < 1)
            throw new Error("pi maxIterations must be a positive integer");
        if (config.budget.maxCost !== null && usage.totalCost >= config.budget.maxCost) {
            throw new Error("Pi max-cost exhausted before model work");
        }
        if (config.budget.maxTokens !== null && usage.inputTokens + usage.outputTokens >= config.budget.maxTokens) {
            throw new Error("Pi max-tokens exhausted before model work");
        }
        const timeout = Number(process.env.MIKRO_MCP_RUN_TIMEOUT_MS);
        const deadlineMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 300000;
        const tools = await createScopedPiTools(agent, request);
        tools.push(defineTool({
            name: "emit_done", label: "Final", description: "Submit the complete final result matching this schema. First accepted result wins. No prose fallback.",
            parameters: schema, executionMode: "sequential",
            async execute(_id, params) {
                if (answer !== undefined)
                    throw new Error("emit_done already accepted; the first final result cannot be replaced");
                if (output || pack)
                    answer = `\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``;
                else {
                    const plain = params.answer;
                    if (typeof plain !== "string" || !plain.trim())
                        throw new Error("emit_done requires a non-empty answer");
                    answer = plain;
                }
                return { content: [{ type: "text", text: "Final accepted. This run stops after the current tool batch." }], details: {} };
            },
        }));
        const system = [config.system, config.criteria, "You are a read-only delegated agent. Use only scoped read, grep, glob, git and emit_done. No Python REPL, shell, plugins, filesystem mutation, or ambient project instructions. Complete by calling emit_done; ordinary assistant prose is not a final result.", `Final schema:\n${JSON.stringify(schema)}`].filter(Boolean).join("\n\n");
        const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
        // This implementation satisfies the installed SDK ResourceLoader, without invoking discovery.
        const resources = {
            getExtensions: () => extensions,
            getSkills: () => ({ skills: [], diagnostics: [] }),
            getPrompts: () => ({ prompts: [], diagnostics: [] }),
            getThemes: () => ({ themes: [], diagnostics: [] }),
            getAgentsFiles: () => ({ agentsFiles: [] }),
            getSystemPrompt: () => system,
            getSystemPromptSource: () => undefined,
            getAppendSystemPrompt: () => [],
            getAppendSystemPromptSources: () => [],
            extendResources: () => { throw new Error("Pi resources are fixed for this offload"); },
            reload: async () => { },
        };
        const runtime = await createPiModelRuntime(config.model);
        const model = resolveModel(config.model.provider, config.model.model, config.model.providers, runtime);
        const declared = config.model.providers?.find((provider) => provider.id === model.provider)?.models.find((candidate) => candidate.id === model.id);
        if (declared && (!Number.isFinite(declared.cost?.input) || !Number.isFinite(declared.cost?.output))) {
            throw new Error(`pi requires declared pricing for ${model.provider}/${model.id} before inference; absent input/output rates are unknown, not free. Declare actual rates or explicit zero rates for a free model.`);
        }
        const sessionManager = SessionManager.inMemory(request.cwd);
        const cacheConfig = config.cache.enabled ? {
            enabled: true, retention: config.cache.retention, sessionId: sessionManager.getSessionId(),
        } : undefined;
        // Override only this fresh runtime method. The SDK's public streamFunction keeps its original
        // auth/provider/retry closure; provenance and caller options wrap its downstream stream.
        const originalStream = runtime.streamSimple.bind(runtime);
        runtime.streamSimple = (selected, context, options) => streamLLMCompletion({ streamSimple: originalStream }, selected, context, {
            ...options,
            ...buildCompletionOptions(config.model, {
                maxTokens: request.maxOutputTokens, maxRetries: request.maxRetries,
                signal: options?.signal ? AbortSignal.any([options.signal, runAbort.signal]) : runAbort.signal,
                thinkingLevel: config.gemini.thinkingLevel,
                temperature: config.temperature, cacheConfig, geminiConfig: config.gemini,
            }),
        });
        const { session } = await createAgentSession({
            cwd: request.cwd, agentDir: request.cwd, modelRuntime: runtime, model,
            thinkingLevel: config.gemini.thinkingLevel ?? "off",
            tools: [...PI_TOOL_NAMES], customTools: tools, resourceLoader: resources,
            sessionManager,
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: request.maxRetries ?? 3 } },
                cacheWarming: "off", enableSkillCommands: false, packages: [], extensions: [], skills: [], prompts: [],
                enableAnalytics: false, enableInstallTelemetry: false,
            }),
        });
        let deadline = false;
        let cancelled = false;
        const cancel = () => { cancelled = true; runAbort.abort(); session.agent.abort(); };
        request.signal?.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(() => { deadline = true; runAbort.abort(); session.agent.abort(); }, deadlineMs);
        timer.unref();
        const unsubscribe = session.agent.subscribe((event) => {
            if (event.type === "turn_start") {
                iterations += 1;
                emit(`iteration ${iterations}`);
            }
            if (event.type === "tool_execution_start")
                emit(`tool ${event.toolName}`);
            if (event.type === "tool_execution_end" && event.toolName === "emit_done" && event.isError) {
                const content = checkedRecord(event.result)?.content;
                const errors = [];
                if (Array.isArray(content)) {
                    for (const part of content) {
                        const record = checkedRecord(part);
                        if (record?.type === "text" && typeof record.text === "string")
                            errors.push(record.text);
                    }
                }
                finalError = `invalid emit_done: ${errors.join("; ")}`;
            }
            if (event.type === "message_end" && event.message.role === "assistant") {
                const receipt = reportedUsage(event.message);
                if (receipt)
                    mergeUsage(usage, receipt);
                else
                    missingUsage = true;
                try {
                    assertLLMCompletion(event.message, config.model);
                }
                catch (error) {
                    if (error instanceof LLMCompletionError)
                        providerFailure = error;
                    else
                        throw error;
                }
                if (config.budget.maxCost !== null && usage.totalCost >= config.budget.maxCost)
                    budgetHit = "max-cost";
                if (config.budget.maxTokens !== null && usage.inputTokens + usage.outputTokens >= config.budget.maxTokens)
                    budgetHit = "max-tokens";
            }
        });
        const finishTurn = session.agent.finishTurn;
        session.agent.finishTurn = async (turn, signal) => {
            const decision = await finishTurn?.(turn, signal);
            if (answer !== undefined || providerFailure || budgetHit || iterations >= maximum) {
                if (answer === undefined && !budgetHit && !providerFailure && iterations >= maximum)
                    budgetHit = "max-iterations";
                return { action: "end" };
            }
            return decision || undefined;
        };
        // Deny further tool work after an accepted final, provider failure, cancellation or limits.
        const beforeToolCall = session.agent.beforeToolCall;
        session.agent.beforeToolCall = async (context, signal) => {
            if (providerFailure || budgetHit || deadline || cancelled)
                return { block: true, reason: "Pi run terminated by provider failure, cancellation or budget" };
            if (answer !== undefined)
                return { block: true, reason: "Pi final already accepted; no further tools may execute" };
            if (context.toolCall.name === "emit_done") {
                // Pi coerces a cloned argument object before this hook; validate the original model payload.
                const raw = context.toolCall.arguments;
                const errors = [];
                if (!validator.Check(raw))
                    errors.push(...validator.Errors(raw).map((error) => JSON.stringify(error)));
                if (pack)
                    errors.push(...validateAgainstSchema(raw, pack, config.validate?.rawBlock).errors);
                if (errors.length) {
                    finalError = `invalid emit_done: ${errors.join("; ")}`;
                    return { block: true, reason: finalError };
                }
            }
            return beforeToolCall?.(context, signal);
        };
        try {
            if (request.signal?.aborted) {
                cancelled = true;
                throw new Error("Pi run cancelled before prompt");
            }
            const contextHint = request.contextRoot ? `\n\nExplicit context root: ${request.contextRoot}. Read it only through the scoped tools.` : "";
            await session.prompt(request.query + contextHint, { expandPromptTemplates: false });
            if (deadline || cancelled)
                throw new LLMCompletionError("aborted", deadline ? "Pi run deadline exceeded" : "Pi run cancelled", usage.llmCalls ? usage : undefined, config.model);
            if (providerFailure)
                throw new LLMCompletionError(providerFailure.stopReason, providerFailure.message, usage.llmCalls ? usage : undefined, config.model);
            if (missingUsage)
                throw new Error("Pi provider did not report usage for every model turn; refusing a falsely zero-priced result");
            if (answer === undefined)
                throw new Error(`Pi run has no accepted emit_done final${budgetHit ? ` (${budgetHit})` : ""}${finalError ? `: ${finalError}` : "; assistant prose is not a final result"}`);
            return { answer, iterations, budgetHit, usage };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new BackendRunError(message, usage.llmCalls ? {
                iterations, budgetHit, usage, usageComplete: !missingUsage,
            } : undefined, { cause: error });
        }
        finally {
            clearTimeout(timer);
            request.signal?.removeEventListener("abort", cancel);
            unsubscribe();
            try {
                await session.abort();
            }
            finally {
                session.dispose();
            }
        }
    }
}
//# sourceMappingURL=pi.js.map