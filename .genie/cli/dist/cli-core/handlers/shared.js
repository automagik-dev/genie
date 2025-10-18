"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyStoreMerge = applyStoreMerge;
exports.persistStore = persistStore;
exports.resolveExecutorKey = resolveExecutorKey;
exports.requireExecutor = requireExecutor;
exports.buildExecutorConfig = buildExecutorConfig;
exports.extractExecutorOverrides = extractExecutorOverrides;
exports.resolveExecutorPaths = resolveExecutorPaths;
exports.deepClone = deepClone;
exports.mergeDeep = mergeDeep;
exports.resolveAgentIdentifier = resolveAgentIdentifier;
exports.listAgents = listAgents;
exports.agentExists = agentExists;
exports.loadAgentSpec = loadAgentSpec;
exports.extractFrontMatter = extractFrontMatter;
exports.deriveStartTime = deriveStartTime;
exports.sanitizeLogFilename = sanitizeLogFilename;
exports.deriveLogFile = deriveLogFile;
exports.maybeHandleBackgroundLaunch = maybeHandleBackgroundLaunch;
exports.executeRun = executeRun;
exports.sleep = sleep;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const background_1 = require("../../views/background");
const display_transform_1 = require("../../lib/display-transform");
function applyStoreMerge(target, next) {
    target.version = next.version;
    target.sessions = next.sessions;
}
async function persistStore(ctx, store) {
    const result = await ctx.sessionService.save(store);
    applyStoreMerge(store, result.store);
}
function resolveExecutorKey(ctx, modeName) {
    const config = ctx.config;
    const modes = config.executionModes || config.presets || {};
    const mode = modes[modeName];
    if (mode && mode.executor)
        return mode.executor;
    if (config.defaults && config.defaults.executor)
        return config.defaults.executor;
    return ctx.defaultExecutorKey;
}
function requireExecutor(ctx, key) {
    const executor = ctx.executors[key];
    if (!executor) {
        const available = Object.keys(ctx.executors).join(', ') || 'none';
        throw new Error(`Executor '${key}' not found. Available executors: ${available}`);
    }
    return executor;
}
function buildExecutorConfig(ctx, modeName, executorKey, agentOverrides) {
    const { config } = ctx;
    const base = deepClone((config.executors && config.executors[executorKey]) || {});
    const modes = config.executionModes || config.presets || {};
    const mode = modes[modeName];
    if (!mode && modeName && modeName !== 'default') {
        const available = Object.keys(modes).join(', ') || 'default';
        throw new Error(`Execution mode '${modeName}' not found. Available modes: ${available}`);
    }
    const overrides = getExecutorOverrides(mode, executorKey);
    let merged = mergeDeep(base, overrides);
    if (agentOverrides && Object.keys(agentOverrides).length) {
        merged = mergeDeep(merged, agentOverrides);
    }
    return merged;
}
function extractExecutorOverrides(ctx, agentGenie, executorKey) {
    if (!agentGenie || typeof agentGenie !== 'object')
        return {};
    const { executor, background: _background, preset: _preset, mode: _mode, executionMode: _executionMode, json: _json, ...rest } = agentGenie;
    const overrides = {};
    const executorDef = ctx.executors[executorKey]?.defaults;
    const topLevelKeys = executorDef ? new Set(Object.keys(executorDef)) : null;
    Object.entries(rest || {}).forEach(([key, value]) => {
        if (key === 'json')
            return;
        if (key === 'exec' || key === 'resume') {
            overrides[key] = mergeDeep(overrides[key], deepClone(value));
            return;
        }
        if (topLevelKeys && topLevelKeys.has(key)) {
            overrides[key] = mergeDeep(overrides[key], deepClone(value));
            return;
        }
        if (!overrides.exec)
            overrides.exec = {};
        overrides.exec[key] = mergeDeep(overrides.exec[key], deepClone(value));
    });
    return overrides;
}
function resolveExecutorPaths(paths, executorKey) {
    if (!paths.executors)
        return {};
    return paths.executors[executorKey] || {};
}
function deepClone(input) {
    return JSON.parse(JSON.stringify(input));
}
function mergeDeep(target, source) {
    if (source === null || source === undefined)
        return target;
    if (Array.isArray(source)) {
        return source.slice();
    }
    if (typeof source !== 'object') {
        return source;
    }
    const base = target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
    Object.entries(source).forEach(([key, value]) => {
        base[key] = mergeDeep(base[key], value);
    });
    return base;
}
function getExecutorOverrides(mode, executorKey) {
    if (!mode || !mode.overrides)
        return {};
    const { overrides } = mode;
    if (overrides.executors && overrides.executors[executorKey]) {
        return overrides.executors[executorKey];
    }
    if (overrides[executorKey]) {
        return overrides[executorKey];
    }
    return overrides;
}
function resolveAgentIdentifier(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) {
        throw new Error('Agent id is required');
    }
    const normalized = trimmed.replace(/\.md$/i, '');
    const normalizedLower = normalized.toLowerCase();
    const directCandidates = [normalized, normalizedLower];
    for (const candidate of directCandidates) {
        if (agentExists(candidate))
            return candidate.replace(/\\/g, '/');
    }
    const agents = listAgents();
    const byExactId = agents.find((agent) => agent.id.toLowerCase() === normalizedLower);
    if (byExactId)
        return byExactId.id;
    const byLabel = agents.find((agent) => agent.label.toLowerCase() === normalizedLower);
    if (byLabel)
        return byLabel.id;
    const legacy = normalizedLower.replace(/^genie-/, '').replace(/^template-/, '');
    const legacyCandidates = [legacy, `core/${legacy}`, `specialized/${legacy}`];
    for (const candidate of legacyCandidates) {
        if (agentExists(candidate))
            return candidate;
    }
    if (normalizedLower === 'forge-master' && agentExists('forge'))
        return 'forge';
    throw new Error(`❌ Agent '${input}' not found. Try 'genie list agents' to see available ids.`);
}
// transformDisplayPath imported from ../../lib/display-transform (single source of truth)
function listAgents() {
    const baseDir = '.genie/agents';
    const records = [];
    if (!fs_1.default.existsSync(baseDir))
        return records;
    const visit = (dirPath, relativePath) => {
        const entries = fs_1.default.readdirSync(dirPath, { withFileTypes: true });
        entries.forEach((entry) => {
            const entryPath = path_1.default.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                visit(entryPath, relativePath ? path_1.default.join(relativePath, entry.name) : entry.name);
                return;
            }
            if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'README.md')
                return;
            const rawId = relativePath ? path_1.default.join(relativePath, entry.name) : entry.name;
            const normalizedId = rawId.replace(/\.md$/i, '').split(path_1.default.sep).join('/');
            const content = fs_1.default.readFileSync(entryPath, 'utf8');
            const { meta } = extractFrontMatter(content, () => { });
            const metaObj = meta || {};
            if (metaObj.hidden === true || metaObj.disabled === true)
                return;
            // Transform display path (strip template/category folders)
            const { displayId, displayFolder } = (0, display_transform_1.transformDisplayPath)(normalizedId);
            const label = (metaObj.name || displayId.split('/').pop() || displayId).trim();
            records.push({ id: normalizedId, displayId, label, meta: metaObj, folder: displayFolder });
        });
    };
    visit(baseDir, null);
    return records;
}
function agentExists(id) {
    if (!id)
        return false;
    const normalized = id.replace(/\\/g, '/');
    const file = path_1.default.join('.genie', 'agents', `${normalized}.md`);
    return fs_1.default.existsSync(file);
}
function loadAgentSpec(ctx, name) {
    const base = name.endsWith('.md') ? name.slice(0, -3) : name;
    const agentPath = path_1.default.join('.genie', 'agents', `${base}.md`);
    if (!fs_1.default.existsSync(agentPath)) {
        throw new Error(`❌ Agent '${name}' not found in .genie/agents`);
    }
    const content = fs_1.default.readFileSync(agentPath, 'utf8');
    const { meta, body } = extractFrontMatter(content, ctx.recordStartupWarning);
    return {
        meta,
        instructions: body.replace(/^(\r?\n)+/, '')
    };
}
function extractFrontMatter(source, onWarning) {
    if (!source.startsWith('---')) {
        return { meta: {}, body: source };
    }
    const end = source.indexOf('\n---', 3);
    if (end === -1) {
        return { meta: {}, body: source };
    }
    const raw = source.slice(3, end).trim();
    const body = source.slice(end + 4);
    try {
        const YAML = require('yaml');
        const parsed = YAML.parse(raw) || {};
        return { meta: parsed, body };
    }
    catch {
        onWarning('[genie] YAML module unavailable or failed to parse; front matter metadata ignored.');
        return { meta: {}, body };
    }
}
function deriveStartTime() {
    const { INTERNAL_START_TIME_ENV } = require('../../background-manager');
    const fromEnv = process.env[INTERNAL_START_TIME_ENV];
    if (!fromEnv)
        return Date.now();
    const parsed = Number(fromEnv);
    if (Number.isFinite(parsed))
        return parsed;
    return Date.now();
}
function sanitizeLogFilename(agentName) {
    const fallback = 'agent';
    if (!agentName || typeof agentName !== 'string')
        return fallback;
    const normalized = agentName
        .trim()
        .replace(/[\\/]+/g, '-')
        .replace(/[^a-z0-9._-]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/\.+/g, '.')
        .replace(/^-+|-+$/g, '')
        .replace(/^\.+|\.+$/g, '');
    return normalized.length ? normalized : fallback;
}
function deriveLogFile(agentName, startTime, paths) {
    const { INTERNAL_LOG_PATH_ENV } = require('../../background-manager');
    const envPath = process.env[INTERNAL_LOG_PATH_ENV];
    if (envPath)
        return envPath;
    const filename = `${sanitizeLogFilename(agentName)}-${startTime}.log`;
    return path_1.default.join(paths.logsDir || '.genie/state/agents/logs', filename);
}
async function maybeHandleBackgroundLaunch(ctx, params) {
    const { backgroundManager } = ctx;
    const { parsed, config, paths, store, entry, agentName, executionMode, startTime, logFile } = params;
    if (!parsed.options.background || parsed.options.backgroundRunner) {
        return false;
    }
    const runnerPid = backgroundManager.launch({
        rawArgs: parsed.options.rawArgs,
        startTime,
        logFile,
        backgroundConfig: config.background,
        scriptPath: __filename
    });
    entry.runnerPid = runnerPid;
    entry.status = 'running';
    entry.background = parsed.options.background;
    // Use sessionId as key (no temp keys)
    if (!entry.sessionId) {
        throw new Error('Session ID must be generated before background launch');
    }
    store.sessions[entry.sessionId] = entry;
    await persistStore(ctx, store);
    process.stdout.write(`▸ Launching ${agentName} in background...\n`);
    process.stdout.write(`▸ Session ID: ${entry.sessionId}\n\n`);
    process.stdout.write('  View output:\n');
    process.stdout.write(`    npx automagik-genie view ${entry.sessionId}\n\n`);
    process.stdout.write('  Continue conversation:\n');
    process.stdout.write(`    npx automagik-genie resume ${entry.sessionId} "<your message>"\n\n`);
    process.stdout.write('  Stop session:\n');
    process.stdout.write(`    npx automagik-genie stop ${entry.sessionId}\n`);
    return true;
}
async function executeRun(ctx, args) {
    const { agentName, command, executorKey, executor, executorConfig, executorPaths, store, entry, paths, config, startTime, logFile, background, runnerPid, cliOptions, executionMode } = args;
    if (!command || typeof command.command !== 'string' || !Array.isArray(command.args)) {
        throw new Error(`Executor '${executorKey}' returned an invalid command configuration.`);
    }
    const logDir = path_1.default.dirname(logFile);
    if (!fs_1.default.existsSync(logDir)) {
        fs_1.default.mkdirSync(logDir, { recursive: true });
    }
    const logStream = fs_1.default.createWriteStream(logFile, { flags: 'a' });
    // Debug: log the command being executed
    const fullCommand = `${command.command} ${command.args.join(' ')}`;
    try {
        fs_1.default.writeFileSync('/home/namastex/spawn-debug-test.txt', `${fullCommand}\n`, { flag: 'a' });
    }
    catch (e) {
        // Ignore errors
    }
    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(command.spawnOptions || {}),
        cwd: paths.baseDir // Use workspace root, not inherited process.cwd()
    };
    const proc = (0, child_process_1.spawn)(command.command, command.args, spawnOptions);
    entry.status = 'running';
    entry.executorPid = proc.pid || null;
    if (runnerPid)
        entry.runnerPid = runnerPid;
    // Use sessionId as key (no temp keys)
    if (!entry.sessionId) {
        throw new Error('Session ID must be generated before execution');
    }
    store.sessions[entry.sessionId] = entry;
    await persistStore(ctx, store);
    let filteredStdout = null;
    if (proc.stdout) {
        if (executor.createOutputFilter) {
            filteredStdout = executor.createOutputFilter(logStream);
            proc.stdout.pipe(filteredStdout);
        }
        else {
            proc.stdout.pipe(logStream);
        }
    }
    if (proc.stderr)
        proc.stderr.pipe(logStream);
    const updateSessionFromLine = (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{'))
            return;
        try {
            const data = JSON.parse(trimmed);
            if (data && typeof data === 'object' && data.type === 'session.created') {
                // MCP might emit session.created event - update lastUsed if needed
                entry.lastUsed = new Date().toISOString();
                void persistStore(ctx, store);
            }
        }
        catch {
            // ignore malformed JSON lines
        }
    };
    if (proc.stdout) {
        let buffer = '';
        proc.stdout.on('data', (chunk) => {
            const text = chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
            buffer += text;
            let index = buffer.indexOf('\n');
            while (index !== -1) {
                const line = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                updateSessionFromLine(line);
                index = buffer.indexOf('\n');
            }
        });
    }
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
    proc.on('error', (error) => {
        entry.status = 'failed';
        entry.error = error instanceof Error ? error.message : String(error);
        entry.lastUsed = new Date().toISOString();
        void persistStore(ctx, store);
        const message = error instanceof Error ? error.message : String(error);
        if (!background) {
            void ctx.emitView((0, background_1.buildRunCompletionView)({
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
                extraNotes: [`Spawn error: ${message}`]
            }), cliOptions);
        }
        settle();
    });
    proc.on('close', (code, signal) => {
        entry.exitCode = typeof code === 'number' ? code : null;
        entry.signal = signal || null;
        entry.lastUsed = new Date().toISOString();
        entry.status = code === 0 ? 'completed' : 'failed';
        void persistStore(ctx, store);
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
            void ctx.emitView(envelope, cliOptions).finally(settle);
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
            // sessionId already assigned at creation time - just update lastUsed
            entry.lastUsed = new Date().toISOString();
            void persistStore(ctx, store);
        };
        setTimeout(attemptExtraction, retryIntervals[retryIndex++]);
    }
    await promise;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
