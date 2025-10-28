"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunHandler = createRunHandler;
const agent_resolver_1 = require("../../lib/agent-resolver");
const session_store_1 = require("../../session-store");
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
const headless_helpers_1 = require("../../lib/headless-helpers");
const executor_registry_1 = require("../../lib/executor-registry");
const executor_auth_1 = require("../../lib/executor-auth");
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
        // Detect output mode
        // Default: Foreground execution with live output (wait for completion)
        // --background: Start task and exit immediately (return Forge URL)
        // --raw: Foreground execution, output raw text only
        // --quiet: Foreground execution, suppress startup messages
        const isBackground = parsed.options.background;
        const isRawOutput = parsed.options.raw;
        const isQuiet = parsed.options.quiet;
        const isForeground = !isBackground; // Default is foreground
        // Check if executor is authenticated
        if (isExecutorAuthRequired(executorKey)) {
            const isAuthenticated = await (0, executor_auth_1.checkExecutorAuth)(executorKey);
            if (!isAuthenticated) {
                try {
                    await (0, executor_auth_1.promptExecutorLogin)(executorKey);
                }
                catch (error) {
                    throw new Error(`Authentication required for ${executorKey}. Please configure it and try again.`);
                }
            }
        }
        // Ensure Forge is running (silent if quiet mode)
        if (isForeground) {
            await (0, headless_helpers_1.ensureForgeRunning)(isQuiet);
        }
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        try {
            // Skip config.forge.executors - incompatible format, Forge loads from its own config
            await forgeExecutor.syncProfiles();
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
            console.error(`[DEBUG] syncProfiles error:`, error);
            throw new Error(`Forge backend unavailable while starting a session. ${forge_helpers_1.FORGE_RECOVERY_HINT}\nReason: ${reason}`);
        }
        const startTime = Date.now();
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
        // Foreground mode (DEFAULT): wait for completion and show output
        if (isForeground) {
            if (!isQuiet) {
                const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
                const modelSuffix = model ? `, model=${model}` : '';
                process.stdout.write(`✓ Running ${resolvedAgentName} (executor=${executorSummary}${modelSuffix})\n`);
                process.stdout.write(`  Session: ${sessionName}\n`);
                process.stdout.write(`  Waiting for completion...\n\n`);
            }
            const result = await (0, headless_helpers_1.waitForTaskCompletion)(sessionResult.attemptId, forgeExecutor);
            const duration = Date.now() - startTime;
            // Output result based on mode
            if (isRawOutput) {
                // Raw text output only (no JSON wrapper)
                process.stdout.write(result.output + '\n');
            }
            else {
                // Default: show output with metadata
                if (!isQuiet) {
                    process.stdout.write(`\n${'='.repeat(60)}\n`);
                    process.stdout.write(`📊 ${resolvedAgentName} Output\n`);
                    process.stdout.write(`${'='.repeat(60)}\n\n`);
                }
                process.stdout.write(result.output + '\n');
                if (!isQuiet) {
                    process.stdout.write(`\n${'='.repeat(60)}\n`);
                    process.stdout.write(`Status: ${result.status}\n`);
                    process.stdout.write(`Duration: ${(duration / 1000).toFixed(2)}s\n`);
                    process.stdout.write(`${'='.repeat(60)}\n`);
                }
            }
            // Exit with appropriate code
            process.exitCode = result.status === 'completed' ? 0 : 1;
            return;
        }
        // Background mode: just show Forge URL and exit
        const executorSummary = [executorKey, executorVariant].filter(Boolean).join('/');
        const modelSuffix = model ? `, model=${model}` : '';
        process.stdout.write(`✓ Started ${resolvedAgentName} in background (executor=${executorSummary}${modelSuffix})\n`);
        process.stdout.write(`  Session name: ${sessionName}\n`);
        process.stdout.write(`  Forge URL: ${sessionResult.forgeUrl}\n`);
    };
}
function resolveExecutionSelection(config, parsed, agentGenie) {
    let executor = (0, executor_registry_1.normalizeExecutorKeyOrDefault)(config.defaults?.executor);
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
        executor = (0, executor_registry_1.normalizeExecutorKey)(agentGenie.executor) ?? executor;
    }
    const agentVariant = agentGenie.executorProfile || agentGenie.executor_variant || agentGenie.executorVariant || agentGenie.variant;
    if (typeof agentVariant === 'string' && agentVariant.trim().length) {
        variant = agentVariant.trim().toUpperCase();
    }
    if (typeof agentGenie.model === 'string' && agentGenie.model.trim().length) {
        model = agentGenie.model.trim();
    }
    if (typeof parsed.options.executor === 'string' && parsed.options.executor.trim().length) {
        executor = (0, executor_registry_1.normalizeExecutorKey)(parsed.options.executor) ?? executor;
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
    return { executorKey: (0, executor_registry_1.normalizeExecutorKeyOrDefault)(executor), executorVariant: variant, model, modeName };
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
/**
 * Check if executor requires authentication
 */
function isExecutorAuthRequired(executorKey) {
    const authRequiredExecutors = ['OPENCODE', 'CLAUDE_CODE', 'CODEX', 'GEMINI'];
    return authRequiredExecutors.includes(executorKey.toUpperCase());
}
