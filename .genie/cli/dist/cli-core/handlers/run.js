"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunHandler = createRunHandler;
const path_1 = __importDefault(require("path"));
const shared_1 = require("./shared");
function createRunHandler(ctx) {
    return async (parsed) => {
        const [agentName, ...promptParts] = parsed.commandArgs;
        if (!agentName) {
            throw new Error('Usage: genie run <agent> "<prompt>"');
        }
        const prompt = promptParts.join(' ').trim();
        const resolvedAgentName = (0, shared_1.resolveAgentIdentifier)(agentName);
        const agentSpec = (0, shared_1.loadAgentSpec)(ctx, resolvedAgentName);
        const agentMeta = agentSpec.meta || {};
        const agentGenie = agentMeta.genie || {};
        if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
            parsed.options.background = agentGenie.background;
        }
        const defaultMode = ctx.config.defaults?.executionMode || ctx.config.defaults?.preset || 'default';
        const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
        const modeName = typeof agentMode === 'string' && agentMode.trim().length ? agentMode.trim() : defaultMode;
        const executorKey = agentGenie.executor || (0, shared_1.resolveExecutorKey)(ctx, modeName);
        const executor = (0, shared_1.requireExecutor)(ctx, executorKey);
        const executorOverrides = (0, shared_1.extractExecutorOverrides)(ctx, agentGenie, executorKey);
        const executorConfig = (0, shared_1.buildExecutorConfig)(ctx, modeName, executorKey, executorOverrides);
        const executorPaths = (0, shared_1.resolveExecutorPaths)(ctx.paths, executorKey);
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const startTime = (0, shared_1.deriveStartTime)();
        const logFile = (0, shared_1.deriveLogFile)(resolvedAgentName, startTime, ctx.paths);
        const entry = {
            ...(store.agents[resolvedAgentName] || {}),
            agent: resolvedAgentName,
            preset: modeName,
            mode: modeName,
            logFile,
            lastPrompt: prompt.slice(0, 200),
            created: (store.agents[resolvedAgentName] && store.agents[resolvedAgentName].created) || new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            status: 'starting',
            background: parsed.options.background,
            runnerPid: parsed.options.backgroundRunner ? process.pid : null,
            executor: executorKey,
            executorPid: null,
            exitCode: null,
            signal: null,
            startTime: new Date(startTime).toISOString(),
            sessionId: null
        };
        store.agents[resolvedAgentName] = entry;
        await (0, shared_1.persistStore)(ctx, store);
        const handledBackground = await (0, shared_1.maybeHandleBackgroundLaunch)(ctx, {
            parsed,
            config: ctx.config,
            paths: ctx.paths,
            store,
            entry,
            agentName: resolvedAgentName,
            executorKey,
            executionMode: modeName,
            startTime,
            logFile,
            allowResume: true
        });
        if (handledBackground) {
            return;
        }
        const agentPath = path_1.default.join('.genie', 'agents', `${resolvedAgentName}.md`);
        const command = executor.buildRunCommand({
            config: executorConfig,
            agentPath,
            prompt
        });
        await (0, shared_1.executeRun)(ctx, {
            agentName,
            command,
            executorKey,
            executor,
            executorConfig,
            executorPaths,
            prompt,
            store,
            entry,
            paths: ctx.paths,
            config: ctx.config,
            startTime,
            logFile,
            background: parsed.options.background,
            runnerPid: parsed.options.backgroundRunner ? process.pid : null,
            cliOptions: parsed.options,
            executionMode: modeName
        });
    };
}
