/**
 * Legacy backend — the current `rlmLoop` engine wrapped behind `RuntimeBackend`.
 *
 * This is the default backend: every behavior the MCP server has today comes
 * from here, byte for byte. The event-driven progress translation and the
 * `maxIterations`/`timeout` handling that used to live in `runTurn`
 * (`src/mcp/server.ts`) moved here because they are properties of *this*
 * engine, not of the MCP surface — a second backend translates its own
 * events and owns its own stopping semantics.
 */
import { createEmitter } from "../../sdk/emitter.js";
import { defaultReplTimeoutMs } from "../../repl.js";
import { rlmLoop } from "../../rlm.js";
import { loadPythonPlugins } from "../../sdk/python-plugin.js";
import { loadPluginTools } from "../../sdk/tool-loader.js";
import { createToolRegistry, toolRegistryAsResolver, } from "../../sdk/tool-registry.js";
/** Keep Python plugin failure inside the enclosing REPL execute deadline. */
export const PLUGIN_TIMEOUT_MARGIN_MS = 1_000;
export class LegacyMikroBackend {
    loop;
    loaders;
    constructor(options = {}) {
        this.loop = options.loop ?? rlmLoop;
        this.loaders = {
            loadPluginTools: options.loaders?.loadPluginTools ?? loadPluginTools,
            loadPythonPlugins: options.loaders?.loadPythonPlugins ?? loadPythonPlugins,
        };
    }
    async run(agent, request, emit) {
        const registry = createToolRegistry();
        if (agent && agent.spec.tools.length > 0) {
            await this.loaders.loadPluginTools(agent.spec, registry);
            await this.loaders.loadPythonPlugins(agent.spec, registry, {
                timeoutMs: Math.max(1, defaultReplTimeoutMs() - PLUGIN_TIMEOUT_MARGIN_MS),
            });
        }
        const declaredTools = buildDeclaredToolDefs(registry);
        const config = declaredTools.length > 0
            ? { ...request.config, tools: [...request.config.tools, ...declaredTools] }
            : request.config;
        const tools = declaredTools.length > 0
            ? toolRegistryAsResolver(registry)
            : undefined;
        // Subscribe BEFORE the run so no early event is missed; rlmLoop closes the
        // emitter when it finishes, which ends this loop.
        const emitter = createEmitter();
        const stream = emitter;
        void (async () => {
            let iterations = 0;
            let spawns = 0;
            try {
                for await (const ev of stream) {
                    switch (ev.type) {
                        case "IterationStart":
                            iterations += 1;
                            emit(`iteration ${iterations}`);
                            break;
                        case "Recurse":
                            spawns += 1;
                            emit(`iteration ${iterations} · ${spawns} recursive spawn${spawns === 1 ? "" : "s"}`);
                            break;
                        default:
                            break;
                    }
                }
            }
            catch {
                // A broken progress stream must never fail the run itself.
            }
        })();
        // output: "json" keeps rlmLoop off its stream-mode stdout path, which the
        // MCP transport owns — the same contract `src/acp/agent.ts` follows.
        const result = await this.loop(request.query, request.context, config, {
            output: "json",
            emitter,
            ...(tools ? { tools } : {}),
            ...(request.maxIterations !== undefined ? { maxIterations: request.maxIterations } : {}),
            ...(request.maxOutputTokens !== undefined
                ? { maxOutputTokens: request.maxOutputTokens }
                : {}),
            ...(request.maxRetries !== undefined ? { maxRetries: request.maxRetries } : {}),
            ...runTimeout(),
        });
        return {
            answer: result.answer,
            iterations: result.iterations,
            budgetHit: result.budgetHit ?? null,
            // Only forwarded when the loop actually flagged it — an absent field
            // and `false` mean the same thing to `formatFooter`, and omitting it
            // keeps this result byte-identical to before for unvalidated packs.
            ...(result.validation_failed ? { validationFailed: true } : {}),
            usage: {
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
                totalCost: result.usage.totalCost,
            },
        };
    }
}
/** Build the Python `**kwargs` entry point for every loaded declared tool. */
function buildDeclaredToolDefs(registry) {
    return registry.list().map((name) => ({
        name,
        code: [
            `def ${name}(**kwargs):`,
            // A JSON string literal is also a Python string literal: quotes,
            // backslashes, newlines, and control characters stay docstring data.
            `    ${JSON.stringify(toolDocstring(registry.describe(name)))}`,
            `    return call_tool(${JSON.stringify(name)}, kwargs)`,
        ].join("\n"),
    }));
}
function toolDocstring(schema) {
    if (!schema)
        return "(arguments undocumented — pass keyword arguments)";
    const parts = [];
    if (schema.description?.trim())
        parts.push(schema.description.trim());
    const properties = schema.parameters?.properties;
    if (properties && typeof properties === "object" && !Array.isArray(properties)) {
        const names = Object.keys(properties);
        if (names.length > 0)
            parts.push(`Parameters: ${names.join(", ")}.`);
    }
    return parts.join(" ") || "(arguments undocumented — pass keyword arguments)";
}
/**
 * Resolve the run timeout. A delegated task can be long — especially a
 * recursive one — and the host owns cancellation, so allow lifting rlmLoop's
 * default wall-clock cap without touching rlm.ts.
 */
function runTimeout() {
    const ms = Number(process.env.MIKRO_MCP_RUN_TIMEOUT_MS);
    return Number.isFinite(ms) && ms > 0 ? { timeout: ms } : {};
}
//# sourceMappingURL=legacy.js.map