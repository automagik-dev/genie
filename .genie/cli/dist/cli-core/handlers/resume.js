"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResumeHandler = createResumeHandler;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const shared_1 = require("./shared");
function createResumeHandler(ctx) {
    return async (parsed) => {
        const cmdArgs = parsed.commandArgs;
        if (cmdArgs.length < 2) {
            throw new Error('Usage: genie resume <sessionId> "<prompt>"');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const sessionIdArg = cmdArgs[0];
        const prompt = cmdArgs.slice(1).join(' ').trim();
        const found = findSessionEntry(store, sessionIdArg, ctx.paths);
        if (!found) {
            // Check if session file exists but is orphaned
            const executorKey = ctx.config.defaults?.executor || ctx.defaultExecutorKey;
            const executor = (0, shared_1.requireExecutor)(ctx, executorKey);
            if (executor.tryLocateSessionFileBySessionId && executor.resolvePaths) {
                const executorConfig = ctx.config.executors?.[executorKey] || {};
                const executorPaths = executor.resolvePaths({
                    config: executorConfig,
                    baseDir: ctx.paths.baseDir,
                    resolvePath: (target, base) => path_1.default.isAbsolute(target) ? target : path_1.default.resolve(base || ctx.paths.baseDir || '.', target)
                });
                const sessionsDir = executorPaths.sessionsDir;
                if (sessionsDir) {
                    const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionIdArg, sessionsDir);
                    if (sessionFilePath && fs_1.default.existsSync(sessionFilePath)) {
                        throw new Error(`❌ Session '${sessionIdArg}' is not tracked in CLI state.\n\n` +
                            `Session file exists at:\n  ${sessionFilePath}\n\n` +
                            `This session cannot be resumed because CLI tracking information is missing.\n` +
                            `This may happen if sessions.json was corrupted or deleted.\n\n` +
                            `Options:\n` +
                            `  1. View the session: ./genie view ${sessionIdArg}\n` +
                            `  2. Start a new session: ./genie run <agent> "<prompt>"\n` +
                            `  3. (Advanced) Manually restore sessions.json entry`);
                    }
                }
            }
            throw new Error(`❌ No run found with session id '${sessionIdArg}'`);
        }
        const { agentName, entry: session } = found;
        if (!session || !session.sessionId) {
            throw new Error(`❌ No active session for agent '${agentName}'`);
        }
        const agentSpec = (0, shared_1.loadAgentSpec)(ctx, agentName);
        const agentMeta = agentSpec.meta || {};
        const agentGenie = agentMeta.genie || {};
        if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
            parsed.options.background = agentGenie.background;
        }
        const defaultMode = ctx.config.defaults?.executionMode || ctx.config.defaults?.preset || 'default';
        const storedMode = session.mode || session.preset;
        const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
        const modeName = typeof storedMode === 'string' && storedMode.trim().length
            ? storedMode.trim()
            : typeof agentMode === 'string' && agentMode.trim().length
                ? agentMode.trim()
                : defaultMode;
        session.mode = modeName;
        session.preset = modeName;
        const executorKey = session.executor || agentGenie.executor || (0, shared_1.resolveExecutorKey)(ctx, modeName);
        const executor = (0, shared_1.requireExecutor)(ctx, executorKey);
        const executorOverrides = (0, shared_1.extractExecutorOverrides)(ctx, agentGenie, executorKey);
        const executorConfig = (0, shared_1.buildExecutorConfig)(ctx, modeName, executorKey, executorOverrides);
        const executorPaths = (0, shared_1.resolveExecutorPaths)(ctx.paths, executorKey);
        const command = executor.buildResumeCommand({
            config: executorConfig,
            sessionId: session.sessionId || undefined,
            prompt
        });
        const startTime = (0, shared_1.deriveStartTime)();
        const logFile = (0, shared_1.deriveLogFile)(agentName, startTime, ctx.paths);
        session.lastPrompt = prompt ? prompt.slice(0, 200) : session.lastPrompt;
        session.lastUsed = new Date().toISOString();
        session.logFile = logFile;
        session.status = 'starting';
        session.background = parsed.options.background;
        session.runnerPid = parsed.options.backgroundRunner ? process.pid : null;
        session.executor = executorKey;
        session.executorPid = null;
        session.exitCode = null;
        session.signal = null;
        await (0, shared_1.persistStore)(ctx, store);
        const handledBackground = await (0, shared_1.maybeHandleBackgroundLaunch)(ctx, {
            parsed,
            config: ctx.config,
            paths: ctx.paths,
            store,
            entry: session,
            agentName,
            executorKey,
            executionMode: modeName,
            startTime,
            logFile,
            allowResume: false
        });
        if (handledBackground) {
            return;
        }
        await (0, shared_1.executeRun)(ctx, {
            agentName,
            command,
            executorKey,
            executor,
            executorConfig,
            executorPaths,
            prompt,
            store,
            entry: session,
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
function findSessionEntry(store, sessionId, paths) {
    if (!sessionId || typeof sessionId !== 'string')
        return null;
    const trimmed = sessionId.trim();
    if (!trimmed)
        return null;
    for (const [agentName, entry] of Object.entries(store.agents || {})) {
        if (entry && entry.sessionId === trimmed) {
            return { agentName, entry: entry };
        }
    }
    for (const [agentName, entry] of Object.entries(store.agents || {})) {
        const logFile = entry.logFile;
        if (!logFile || !fs_1.default.existsSync(logFile))
            continue;
        try {
            const content = fs_1.default.readFileSync(logFile, 'utf8');
            const marker = new RegExp(`"session_id":"${trimmed}"`);
            if (marker.test(content)) {
                entry.sessionId = trimmed;
                entry.lastUsed = new Date().toISOString();
                return { agentName, entry: entry };
            }
        }
        catch {
            // skip
        }
    }
    return null;
}
