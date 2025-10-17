"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runChat = runChat;
exports.executeRun = executeRun;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const agent_resolver_1 = require("../lib/agent-resolver");
const utils_1 = require("../lib/utils");
const session_store_1 = require("../session-store");
const config_defaults_1 = require("../lib/config-defaults");
const view_helpers_1 = require("../lib/view-helpers");
const background_1 = require("../views/background");
const background_launcher_1 = require("../lib/background-launcher");
const executor_config_1 = require("../lib/executor-config");
const session_updater_1 = require("../lib/session-updater");
async function runChat(parsed, config, paths) {
    const [agentName, ...promptParts] = parsed.commandArgs;
    if (!agentName) {
        throw new Error('Usage: genie run <agent> "<prompt>"');
    }
    const prompt = promptParts.join(' ').trim();
    const resolvedAgentName = (0, agent_resolver_1.resolveAgentIdentifier)(agentName);
    const agentSpec = (0, agent_resolver_1.loadAgentSpec)(resolvedAgentName);
    const agentMeta = agentSpec.meta || {};
    const agentGenie = agentMeta.genie || {};
    if (!parsed.options.backgroundExplicit && typeof agentGenie.background === 'boolean') {
        parsed.options.background = agentGenie.background;
    }
    const defaultMode = config.defaults?.executionMode || config.defaults?.preset || 'default';
    const agentMode = agentGenie.mode || agentGenie.executionMode || agentGenie.preset;
    const cliMode = parsed.options.mode;
    const modeName = cliMode || (typeof agentMode === 'string' && agentMode.trim().length ? agentMode.trim() : defaultMode);
    const executorKey = parsed.options.executor || agentGenie.executor || (0, executor_config_1.resolveExecutorKey)(config, modeName);
    const executor = (0, executor_config_1.requireExecutor)(executorKey);
    const executorOverrides = (0, executor_config_1.extractExecutorOverrides)(agentGenie, executorKey);
    const executorConfig = (0, executor_config_1.buildExecutorConfig)(config, modeName, executorKey, executorOverrides);
    const executorPaths = (0, executor_config_1.resolveExecutorPaths)(paths, executorKey);
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG);
    const isBackgroundRunner = parsed.options.backgroundRunner === true;
    const startTime = (0, utils_1.deriveStartTime)(isBackgroundRunner);
    const logFile = (0, utils_1.deriveLogFile)(resolvedAgentName, startTime, paths, isBackgroundRunner);
    // Generate temporary session ID for tracking (will be updated with real sessionId later)
    const tempSessionId = `temp-${resolvedAgentName}-${startTime}`;
    const entry = {
        agent: resolvedAgentName,
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
        sessionId: tempSessionId // Will be updated with real sessionId from executor
    };
    store.sessions[tempSessionId] = entry;
    (0, session_store_1.saveSessions)(paths, store);
    // Show executor info to user
    if (!parsed.options.backgroundRunner) {
        const model = executorConfig.exec?.model || executorConfig.model || 'default';
        const permissionMode = executorConfig.exec?.permissionMode || executorConfig.permissionMode || 'default';
        const executorSource = parsed.options.executor ? 'flag' : (agentGenie.executor ? 'agent' : 'config');
        console.error(`🧞 Starting agent: ${resolvedAgentName}`);
        console.error(`   Executor: ${executorKey} (from ${executorSource})`);
        console.error(`   Mode: ${modeName}`);
        console.error(`   Model: ${model}`);
        console.error(`   Permissions: ${permissionMode}`);
        console.error('');
    }
    const handledBackground = await (0, background_launcher_1.maybeHandleBackgroundLaunch)({
        parsed,
        config,
        paths,
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
    // Pass agent instructions directly (already loaded by loadAgentSpec)
    // This avoids path resolution issues with npm-backed agents
    const command = executor.buildRunCommand({
        config: executorConfig,
        instructions: agentSpec.instructions,
        prompt
    });
    await executeRun({
        agentName,
        command,
        executorKey,
        executor,
        executorConfig,
        executorPaths,
        prompt,
        store,
        entry,
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
function executeRun(args) {
    const { agentName, command, executorKey, executor, executorConfig, executorPaths, store, entry, paths, config, startTime, logFile, background, runnerPid, cliOptions, executionMode } = args;
    if (!command || typeof command.command !== 'string' || !Array.isArray(command.args)) {
        throw new Error(`Executor '${executorKey}' returned an invalid command configuration.`);
    }
    const logDir = path_1.default.dirname(logFile);
    if (!fs_1.default.existsSync(logDir)) {
        fs_1.default.mkdirSync(logDir, { recursive: true });
    }
    // Write version header if log file is new
    const isNewLog = !fs_1.default.existsSync(logFile);
    const logStream = fs_1.default.createWriteStream(logFile, { flags: 'a' });
    if (isNewLog) {
        const pkg = JSON.parse(fs_1.default.readFileSync(path_1.default.join(__dirname, '../../../package.json'), 'utf8'));
        const timestamp = new Date().toISOString();
        logStream.write(`# Genie CLI v${pkg.version} - ${timestamp}\n\n`);
    }
    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(command.spawnOptions || {})
    };
    const proc = (0, child_process_1.spawn)(command.command, command.args, spawnOptions);
    entry.status = 'running';
    entry.executorPid = proc.pid || null;
    if (runnerPid)
        entry.runnerPid = runnerPid;
    (0, session_store_1.saveSessions)(paths, store);
    let filteredStdout = null;
    const updateSessionHandler = (0, session_updater_1.createSessionUpdateHandler)(entry, store, paths);
    let outputSource = null;
    if (proc.stdout) {
        if (executor.createOutputFilter) {
            filteredStdout = executor.createOutputFilter(logStream);
            outputSource = filteredStdout;
            (0, session_updater_1.attachOutputListener)(filteredStdout, updateSessionHandler);
            proc.stdout.pipe(filteredStdout);
        }
        else {
            proc.stdout.pipe(logStream);
            outputSource = proc.stdout;
            (0, session_updater_1.attachOutputListener)(proc.stdout, updateSessionHandler);
        }
    }
    if (proc.stderr)
        proc.stderr.pipe(logStream);
    if (!background) {
        if (filteredStdout) {
            filteredStdout.pipe(process.stdout);
        }
        else if (proc.stdout) {
            proc.stdout.pipe(process.stdout);
        }
        if (proc.stderr)
            proc.stderr.pipe(process.stderr);
    }
    let settled = false;
    let resolvePromise = () => { };
    const settle = () => {
        if (!settled) {
            settled = true;
            logStream.end();
            resolvePromise();
        }
    };
    const promise = new Promise((resolve) => {
        resolvePromise = resolve;
    });
    const logViewer = executor.logViewer;
    if (logViewer?.readSessionIdFromLog) {
        const pollSessionIdFromLog = (0, session_updater_1.createLogPollingHandler)(entry, store, paths, logFile, logViewer);
        setTimeout(pollSessionIdFromLog, 500);
    }
    proc.on('error', (error) => {
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
        entry.lastUsed = new Date().toISOString();
        (0, session_store_1.saveSessions)(paths, store);
        const message = error instanceof Error ? error.message : String(error);
        if (!background) {
            const envelope = (0, background_1.buildRunCompletionView)({
                agentName,
                outcome: 'failure',
                sessionId: entry.sessionId,
                executorKey,
                model: executorConfig.exec?.model || executorConfig.model || null,
                permissionMode: executorConfig.exec?.permissionMode || executorConfig.permissionMode || null,
                sandbox: executorConfig.exec?.sandbox || executorConfig.sandbox || null,
                mode: entry.mode || entry.preset || executionMode,
                background: entry.background,
                exitCode: null,
                durationMs: Date.now() - startTime,
                extraNotes: [`Launch error: ${message}`]
            });
            void (0, view_helpers_1.emitView)(envelope, cliOptions, { stream: process.stderr }).finally(settle);
        }
        else {
            settle();
        }
    });
    proc.on('exit', (code, signal) => {
        if (settled)
            return;
        const finishedAt = new Date().toISOString();
        entry.lastUsed = finishedAt;
        entry.exitCode = code;
        entry.signal = signal;
        entry.status = code === 0 ? 'completed' : 'failed';
        (0, session_store_1.saveSessions)(paths, store);
        logStream.end();
        const sessionFromLog = logViewer?.readSessionIdFromLog?.(logFile) ?? null;
        const resolvedSessionId = sessionFromLog || entry.sessionId || null;
        if (entry.sessionId !== resolvedSessionId) {
            entry.sessionId = resolvedSessionId;
            entry.lastUsed = new Date().toISOString();
            (0, session_store_1.saveSessions)(paths, store);
        }
        if (!background) {
            const outcome = code === 0 ? 'success' : 'failure';
            const notes = signal ? [`Signal: ${signal}`] : [];
            const envelope = (0, background_1.buildRunCompletionView)({
                agentName,
                outcome,
                sessionId: entry.sessionId,
                executorKey,
                model: executorConfig.exec?.model || executorConfig.model || null,
                permissionMode: executorConfig.exec?.permissionMode || executorConfig.permissionMode || null,
                sandbox: executorConfig.exec?.sandbox || executorConfig.sandbox || null,
                mode: entry.mode || entry.preset || executionMode,
                background: entry.background,
                exitCode: code,
                durationMs: Date.now() - startTime,
                extraNotes: notes
            });
            void (0, view_helpers_1.emitView)(envelope, cliOptions).finally(settle);
        }
        else {
            settle();
        }
    });
    const defaultDelay = (config.background && config.background.sessionExtractionDelayMs) || 5000;
    const sessionDelay = executor.getSessionExtractionDelay
        ? executor.getSessionExtractionDelay({ config: executorConfig, defaultDelay })
        : defaultDelay;
    if (executor.extractSessionId) {
        const retryIntervals = [sessionDelay, 2000, 3000, 3000];
        let retryIndex = 0;
        const attemptExtraction = () => {
            if (entry.sessionId)
                return;
            const sessionId = executor.extractSessionId?.({
                startTime,
                config: executorConfig,
                paths: executorPaths
            }) || null;
            if (sessionId) {
                entry.sessionId = sessionId;
                entry.lastUsed = new Date().toISOString();
                (0, session_store_1.saveSessions)(paths, store);
            }
            else if (retryIndex < retryIntervals.length) {
                setTimeout(attemptExtraction, retryIntervals[retryIndex]);
                retryIndex++;
            }
        };
        setTimeout(attemptExtraction, retryIntervals[retryIndex++]);
    }
    return promise;
}
