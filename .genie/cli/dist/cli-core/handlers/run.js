"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunHandler = createRunHandler;
const agent_resolver_1 = require("../../lib/agent-resolver");
const session_store_1 = require("../../session-store");
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
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
        const { executorKey, executorVariant, model, modeName } = resolveExecutionSelection(ctx.config, parsed, agentGenie);
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        try {
            await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
            console.error(`[DEBUG] syncProfiles error:`, error);
            throw new Error(`Forge backend unavailable while starting a session. ${forge_helpers_1.FORGE_RECOVERY_HINT}\nReason: ${reason}`);
        }
        let sessionResult;
        try {
            sessionResult = await forgeExecutor.createSession({
                agentName: resolvedAgentName,
                prompt,
                executorKey,
                executorVariant,
                executionMode: modeName,
                model
            });
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge session creation failed: ${reason}`);
            throw new Error(`Forge backend rejected session creation. ${forge_helpers_1.FORGE_RECOVERY_HINT}`);
        }
        const sessionName = parsed.options.name || (0, session_store_1.generateSessionName)(resolvedAgentName);
        const now = new Date().toISOString();
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        store.sessions[sessionName] = {
            agent: resolvedAgentName,
            name: sessionName,
            executor: executorKey,
            executorVariant,
            model: model || undefined,
            status: 'running',
            created: now,
            lastUsed: now,
            lastPrompt: prompt.slice(0, 200),
            mode: modeName,
            sessionId: sessionResult.attemptId,
            background: parsed.options.background
        };
        await ctx.sessionService.save(store);
        const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
        const modelSuffix = model ? `, model=${model}` : '';
        process.stdout.write(`✓ Started ${resolvedAgentName} via Forge (executor=${executorSummary}${modelSuffix})\n`);
        process.stdout.write(`  Session name: ${sessionName}\n`);
        process.stdout.write(`  Forge URL: ${sessionResult.forgeUrl}\n`);
        process.stdout.write(`\n  Press Enter to open in browser...\n`);
    };
}
function resolveExecutionSelection(config, parsed, agentGenie) {
    let executor = (config.defaults?.executor || 'opencode').trim().toLowerCase();
    let variant = (config.defaults?.executorVariant || 'DEFAULT').trim().toUpperCase();
    let model = typeof config.defaults?.model === 'string' ? config.defaults.model.trim() || undefined : undefined;
    let modeName = 'default';
    if (typeof config.defaults?.executionMode === 'string' && config.defaults.executionMode.trim().length) {
        modeName = config.defaults.executionMode.trim();
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
    if (typeof agentGenie.model === 'string' && agentGenie.model.trim().length) {
        model = agentGenie.model.trim();
    }
    if (typeof parsed.options.executor === 'string' && parsed.options.executor.trim().length) {
        executor = parsed.options.executor.trim().toLowerCase();
    }
    if (typeof parsed.options.model === 'string' && parsed.options.model.trim().length) {
        model = parsed.options.model.trim();
        const matchedVariant = findVariantForModel(config, executor, model);
        if (matchedVariant) {
            variant = matchedVariant;
        }
    }
    if (!variant.length)
        variant = 'DEFAULT';
    return { executorKey: executor, executorVariant: variant, model, modeName };
}
function findVariantForModel(config, executorKey, model) {
    const executors = config.forge?.executors;
    if (!executors)
        return null;
    const normalizedExecutor = executorKey.trim().toUpperCase();
    const executorProfiles = executors[normalizedExecutor];
    if (!executorProfiles || typeof executorProfiles !== 'object')
        return null;
    const desiredModel = model.trim();
    for (const [variantName, profileSpec] of Object.entries(executorProfiles)) {
        if (!profileSpec || typeof profileSpec !== 'object')
            continue;
        for (const profileKey of Object.keys(profileSpec)) {
            const profileConfig = profileSpec[profileKey];
            if (profileConfig && typeof profileConfig === 'object' && typeof profileConfig.model === 'string') {
                if (profileConfig.model.trim() === desiredModel) {
                    return variantName.trim().toUpperCase();
                }
            }
        }
    }
    return null;
}
