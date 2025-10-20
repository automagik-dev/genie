"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createRunHandler = createRunHandler;
const path_1 = __importDefault(require("path"));
const shared_1 = require("./shared");
const forge_executor_1 = require("../../lib/forge-executor");
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
        // Debug: log executor config
        console.error(`[DEBUG run.ts] agentGenie:`, JSON.stringify(agentGenie));
        console.error(`[DEBUG run.ts] executorOverrides:`, JSON.stringify(executorOverrides));
        console.error(`[DEBUG run.ts] executorConfig:`, JSON.stringify(executorConfig));
        const executorPaths = (0, shared_1.resolveExecutorPaths)(ctx.paths, executorKey);
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const startTime = (0, shared_1.deriveStartTime)();
        const logFile = (0, shared_1.deriveLogFile)(resolvedAgentName, startTime, ctx.paths);
        // Import generateSessionName and generate/reuse UUID
        const { generateSessionName } = require('../../session-store');
        const uuidv4 = () => {
            try {
                const { randomUUID } = require('crypto');
                if (typeof randomUUID === 'function')
                    return randomUUID();
            }
            catch { }
            const { randomBytes } = require('crypto');
            return randomBytes(16).toString('hex');
        };
        const { INTERNAL_SESSION_ID_ENV } = require('../../lib/constants');
        // If running as background runner, reuse propagated sessionId to avoid duplicates
        const envSessionId = process.env[INTERNAL_SESSION_ID_ENV];
        const sessionId = (parsed.options.backgroundRunner && typeof envSessionId === 'string' && envSessionId.trim().length)
            ? envSessionId.trim()
            : uuidv4();
        const entry = {
            agent: resolvedAgentName,
            name: parsed.options.name || generateSessionName(resolvedAgentName),
            preset: modeName,
            mode: modeName,
            logFile,
            lastPrompt: prompt.slice(0, 200),
            created: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            status: 'starting',
            background: parsed.options.background,
            runnerPid: parsed.options.backgroundRunner ? process.pid : null,
            executor: executorKey,
            executorPid: null,
            exitCode: null,
            signal: null,
            startTime: new Date(startTime).toISOString(),
            sessionId: sessionId // UUID assigned immediately
        };
        // Don't persist yet - wait for sessionId extraction
        // Check if background launch requested (and not already background runner)
        if (parsed.options.background && !parsed.options.backgroundRunner && !parsed.options.legacy) {
            const handledBackground = await (0, forge_executor_1.handleForgeBackgroundLaunch)({
                agentName: resolvedAgentName,
                prompt,
                config: ctx.config,
                paths: ctx.paths,
                store,
                entry,
                executorKey,
                executionMode: modeName,
                startTime
            });
            if (handledBackground) {
                return;
            }
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
