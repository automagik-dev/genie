"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runContinue = runContinue;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const session_store_1 = require("../session-store");
const session_helpers_1 = require("../lib/session-helpers");
const run_1 = require("./run");
const background_launcher_1 = require("../lib/background-launcher");
const executor_config_1 = require("../lib/executor-config");
const utils_1 = require("../lib/utils");
const config_defaults_1 = require("../lib/config-defaults");
const agent_resolver_1 = require("../lib/agent-resolver");
const executor_registry_1 = require("../lib/executor-registry");
async function runContinue(parsed, config, paths) {
    const cmdArgs = parsed.commandArgs;
    if (cmdArgs.length < 2) {
        throw new Error('Usage: genie resume <sessionId> "<prompt>"');
    }
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG);
    const sessionIdArg = cmdArgs[0];
    const prompt = cmdArgs.slice(1).join(' ').trim();
    const found = (0, session_helpers_1.findSessionEntry)(store, sessionIdArg, paths);
    if (!found) {
        const executorKey = config.defaults?.executor || executor_registry_1.DEFAULT_EXECUTOR_KEY;
        const executor = (0, executor_config_1.requireExecutor)(executorKey);
        if (executor.tryLocateSessionFileBySessionId && executor.resolvePaths) {
            const executorConfig = config.executors?.[executorKey] || {};
            const executorPaths = executor.resolvePaths({
                config: executorConfig,
                baseDir: paths.baseDir,
                resolvePath: (target, base) => path_1.default.isAbsolute(target) ? target : path_1.default.resolve(base || paths.baseDir || '.', target)
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
    const agentSpec = (0, agent_resolver_1.loadAgentSpec)(agentName);
    const agentMeta = agentSpec.meta || {};
    const agentGenie = agentMeta.genie || {};
    if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
        parsed.options.background = agentGenie.background;
    }
    const defaultMode = config.defaults?.executionMode || config.defaults?.preset || 'default';
    const storedMode = session.mode || session.preset;
    const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
    const modeName = typeof storedMode === 'string' && storedMode.trim().length
        ? storedMode.trim()
        : typeof agentMode === 'string' && agentMode.trim().length
            ? agentMode.trim()
            : defaultMode;
    session.mode = modeName;
    session.preset = modeName;
    const executorKey = session.executor || agentGenie.executor || (0, executor_config_1.resolveExecutorKey)(config, modeName);
    const executor = (0, executor_config_1.requireExecutor)(executorKey);
    const executorOverrides = (0, executor_config_1.extractExecutorOverrides)(agentGenie, executorKey);
    const executorConfig = (0, executor_config_1.buildExecutorConfig)(config, modeName, executorKey, executorOverrides);
    const executorPaths = (0, executor_config_1.resolveExecutorPaths)(paths, executorKey);
    const command = executor.buildResumeCommand({
        config: executorConfig,
        sessionId: session.sessionId || undefined,
        prompt
    });
    const startTime = (0, utils_1.deriveStartTime)();
    const logFile = (0, utils_1.deriveLogFile)(agentName, startTime, paths);
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
    (0, session_store_1.saveSessions)(paths, store);
    const handledBackground = await (0, background_launcher_1.maybeHandleBackgroundLaunch)({
        parsed,
        config,
        paths,
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
    await (0, run_1.executeRun)({
        agentName,
        command,
        executorKey,
        executor,
        executorConfig,
        executorPaths,
        prompt,
        store,
        entry: session,
        paths,
        config,
        startTime,
        logFile,
        background: parsed.options.background,
        runnerPid: parsed.options.backgroundRunner ? process.pid : null,
        cliOptions: parsed.options,
        executionMode: modeName
    });
}
