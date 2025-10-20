"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunHandler = createRunHandler;
const agent_resolver_1 = require("../../lib/agent-resolver");
const session_store_1 = require("../../session-store");
const forge_executor_1 = require("../../lib/forge-executor");
function createRunHandler(ctx) {
    return async (parsed) => {
        const [agentName, ...promptParts] = parsed.commandArgs;
        if (!agentName) {
            throw new Error('Usage: genie run <agent> "<prompt>"');
        }
        const prompt = promptParts.join(' ').trim();
        const resolvedAgentName = (0, agent_resolver_1.resolveAgentIdentifier)(agentName);
        const agentSpec = (0, agent_resolver_1.loadAgentSpec)(resolvedAgentName);
        const agentGenie = agentSpec.meta?.genie || {};
        const { executorKey, executorVariant, modeName } = resolveExecutionSelection(ctx.config, parsed, agentGenie);
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
        const attemptId = await forgeExecutor.createSession({
            agentName: resolvedAgentName,
            prompt,
            executorKey,
            executorVariant,
            executionMode: modeName
        });
        const sessionName = parsed.options.name || (0, session_store_1.generateSessionName)(resolvedAgentName);
        const now = new Date().toISOString();
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        store.sessions[sessionName] = {
            agent: resolvedAgentName,
            name: sessionName,
            executor: executorKey,
            executorVariant,
            status: 'running',
            created: now,
            lastUsed: now,
            lastPrompt: prompt.slice(0, 200),
            mode: modeName,
            sessionId: attemptId,
            background: parsed.options.background
        };
        await ctx.sessionService.save(store);
        process.stdout.write(`✓ Started ${resolvedAgentName} via Forge (executor=${executorKey}/${executorVariant})\n`);
        process.stdout.write(`  Session name: ${sessionName}\n`);
        process.stdout.write(`  View: genie view ${sessionName}\n`);
    };
}
function resolveExecutionSelection(config, parsed, agentGenie) {
    let executor = (config.defaults?.executor || 'opencode').toLowerCase();
    let variant = (config.defaults?.executorVariant || 'DEFAULT').toUpperCase();
    let modeName = parsed.options.mode?.trim() || config.defaults?.executionMode || 'default';
    if (parsed.options.mode) {
        const modeConfig = config.executionModes?.[parsed.options.mode];
        if (!modeConfig) {
            throw new Error(`Execution mode '${parsed.options.mode}' not found.`);
        }
        if (modeConfig.executor)
            executor = modeConfig.executor.toLowerCase();
        if (modeConfig.executorVariant)
            variant = modeConfig.executorVariant.toUpperCase();
        modeName = parsed.options.mode;
    }
    if (typeof agentGenie.executionMode === 'string' && agentGenie.executionMode.trim().length) {
        modeName = agentGenie.executionMode.trim();
    }
    if (typeof agentGenie.executor === 'string' && agentGenie.executor.trim().length) {
        executor = agentGenie.executor.trim().toLowerCase();
    }
    const agentVariant = agentGenie.executorProfile || agentGenie.executor_variant || agentGenie.executorVariant || agentGenie.variant;
    if (typeof agentVariant === 'string' && agentVariant.trim().length) {
        variant = agentVariant.trim().toUpperCase();
    }
    if (typeof parsed.options.executor === 'string' && parsed.options.executor.trim().length) {
        executor = parsed.options.executor.trim().toLowerCase();
    }
    if (!variant.length)
        variant = 'DEFAULT';
    return { executorKey: executor, executorVariant: variant, modeName };
}
