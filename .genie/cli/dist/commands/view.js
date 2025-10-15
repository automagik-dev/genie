"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runView = runView;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const session_store_1 = require("../session-store");
const session_helpers_1 = require("../lib/session-helpers");
const markdown_formatter_js_1 = require("../lib/markdown-formatter.js");
const transcript_utils_1 = require("../executors/transcript-utils");
const executor_registry_1 = require("../lib/executor-registry");
const executor_config_1 = require("../lib/executor-config");
const config_defaults_1 = require("../lib/config-defaults");
async function runView(parsed, config, paths) {
    const [sessionId] = parsed.commandArgs;
    if (!sessionId) {
        console.log('Usage: genie view <sessionId> [--full]');
        return;
    }
    const warnings = [];
    const store = (0, session_store_1.loadSessions)(paths, config, config_defaults_1.DEFAULT_CONFIG, { onWarning: (message) => warnings.push(message) });
    let found = (0, session_helpers_1.findSessionEntry)(store, sessionId, paths);
    let orphanedSession = false;
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
                const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionId, sessionsDir);
                if (sessionFilePath && fs_1.default.existsSync(sessionFilePath)) {
                    orphanedSession = true;
                    warnings.push('⚠️  Session not tracked in CLI state. Displaying from session file.');
                    const sessionFileContent = fs_1.default.readFileSync(sessionFilePath, 'utf8');
                    const jsonl = [];
                    const sourceLines = sessionFileContent.split(/\r?\n/);
                    for (const line of sourceLines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith('{'))
                            continue;
                        try {
                            jsonl.push(JSON.parse(trimmed));
                        }
                        catch { /* skip */ }
                    }
                    const transcript = (0, transcript_utils_1.buildTranscriptFromEvents)(jsonl);
                    const displayTranscript = parsed.options.full
                        ? transcript
                        : parsed.options.live
                            ? (0, transcript_utils_1.sliceForLatest)(transcript)
                            : (0, transcript_utils_1.sliceForRecent)(transcript);
                    // Determine output mode from flags
                    const mode = parsed.options.full ? 'overview' : parsed.options.live ? 'final' : 'recent';
                    const meta = {
                        sessionId: sessionId,
                        agent: 'unknown',
                        status: 'orphaned'
                    };
                    const markdown = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(displayTranscript, meta, mode);
                    console.log(markdown);
                    if (warnings.length) {
                        console.log('\n⚠️  Warnings:');
                        warnings.forEach(w => console.log(`  ${w}`));
                    }
                    return;
                }
            }
        }
        console.error(`Error: No run found with session id '${sessionId}'`);
        process.exitCode = 1;
        return;
    }
    const { entry } = found;
    const executorKey = entry.executor || config.defaults?.executor || executor_registry_1.DEFAULT_EXECUTOR_KEY;
    const executor = (0, executor_config_1.requireExecutor)(executorKey);
    const logViewer = executor.logViewer;
    const logFile = entry.logFile;
    if (!logFile || !fs_1.default.existsSync(logFile)) {
        console.error('Error: Log not found for this run');
        process.exitCode = 1;
        return;
    }
    const raw = fs_1.default.readFileSync(logFile, 'utf8');
    const allLines = raw.split(/\r?\n/);
    if (!entry.sessionId && logViewer?.extractSessionIdFromContent) {
        const sessionFromLog = logViewer.extractSessionIdFromContent(allLines);
        if (sessionFromLog) {
            entry.sessionId = sessionFromLog;
            (0, session_store_1.saveSessions)(paths, store);
        }
    }
    let sessionFileContent = null;
    if (entry.sessionId && entry.startTime && executor.locateSessionFile) {
        const executorConfig = config.executors?.[executorKey] || {};
        const executorPaths = executor.resolvePaths({
            config: executorConfig,
            baseDir: paths.baseDir,
            resolvePath: (target, base) => path_1.default.isAbsolute(target) ? target : path_1.default.resolve(base || paths.baseDir || '.', target)
        });
        const sessionsDir = executorPaths.sessionsDir;
        const startTime = new Date(entry.startTime).getTime();
        if (sessionsDir && !Number.isNaN(startTime)) {
            const sessionFilePath = executor.locateSessionFile({
                sessionId: entry.sessionId,
                startTime,
                sessionsDir
            });
            if (sessionFilePath && fs_1.default.existsSync(sessionFilePath)) {
                try {
                    sessionFileContent = fs_1.default.readFileSync(sessionFilePath, 'utf8');
                }
                catch {
                }
            }
        }
    }
    const jsonl = [];
    const sourceLines = sessionFileContent ? sessionFileContent.split(/\r?\n/) : allLines;
    let hasFilteredFormat = false;
    for (const line of sourceLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('[assistant]') || trimmed.startsWith('[tool]') ||
            trimmed.startsWith('[reasoning]') || trimmed.startsWith('[command]') ||
            trimmed.startsWith('[tool_result]')) {
            hasFilteredFormat = true;
            break;
        }
    }
    if (hasFilteredFormat) {
        let currentBlock = null;
        const flushBlock = () => {
            if (!currentBlock)
                return;
            jsonl.push(createFilteredEvent(currentBlock.type, currentBlock.content));
            currentBlock = null;
        };
        const appendToBlock = (type, line) => {
            if (!currentBlock || currentBlock.type !== type) {
                flushBlock();
                currentBlock = { type, content: [] };
            }
            if (line)
                currentBlock.content.push(line);
        };
        for (const line of sourceLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
                try {
                    const event = JSON.parse(trimmed);
                    if (event.type === 'system' || event.type === 'result') {
                        jsonl.push(event);
                    }
                }
                catch {
                }
                continue;
            }
            if (trimmed.startsWith('[assistant]')) {
                const contentAfterMarker = trimmed.substring('[assistant]'.length).trim();
                appendToBlock('assistant', contentAfterMarker);
            }
            else if (trimmed.startsWith('[tool]')) {
                const contentAfterMarker = trimmed.substring('[tool]'.length).trim();
                appendToBlock('tool', contentAfterMarker);
            }
            else if (trimmed.startsWith('[reasoning]')) {
                const contentAfterMarker = trimmed.substring('[reasoning]'.length).trim();
                appendToBlock('reasoning', contentAfterMarker);
            }
            else if (trimmed.startsWith('[command]')) {
                const contentAfterMarker = trimmed.substring('[command]'.length).trim();
                appendToBlock('command', contentAfterMarker);
            }
            else if (trimmed.startsWith('[tool_result]')) {
                const contentAfterMarker = trimmed.substring('[tool_result]'.length).trim();
                appendToBlock('tool_result', contentAfterMarker);
            }
            else if (trimmed) {
                appendToBlock('assistant', trimmed);
            }
        }
        flushBlock();
    }
    else {
        for (const line of sourceLines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (!trimmed.startsWith('{'))
                continue;
            try {
                jsonl.push(JSON.parse(trimmed));
            }
            catch { /* skip */ }
        }
    }
    function createFilteredEvent(type, content) {
        const text = content.join('\n').trim();
        if (type === 'assistant') {
            return {
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text }]
                }
            };
        }
        else if (type === 'reasoning') {
            return {
                type: 'reasoning',
                message: {
                    content: [{ type: 'text', text }]
                }
            };
        }
        else if (type === 'tool') {
            return {
                type: 'assistant',
                message: {
                    content: [{ type: 'text', text: `[Tool Call]\n${text}` }]
                }
            };
        }
        else if (type === 'tool_result') {
            return {
                type: 'user',
                message: {
                    content: [{ type: 'text', text: `[Tool Result]\n${text}` }]
                }
            };
        }
        else if (type === 'command') {
            return {
                type: 'user',
                message: {
                    content: [{ type: 'text', text: `[Command]\n${text}` }]
                }
            };
        }
        return {
            type: 'assistant',
            message: {
                content: [{ type: 'text', text }]
            }
        };
    }
    // NOTE: Executor-specific buildJsonlView disabled during Ink removal
    // TODO: Restore or convert to markdown if needed
    // if (logViewer?.buildJsonlView) {
    //   ... (commented out)
    // }
    const transcript = (0, transcript_utils_1.buildTranscriptFromEvents)(jsonl);
    if (!parsed.options.full && !parsed.options.live) {
        const lastMessage = transcript.length > 0 ? transcript[transcript.length - 1] : null;
        const lastMessageText = lastMessage
            ? `${lastMessage.title ? lastMessage.title + ': ' : ''}${lastMessage.body.join(' ').substring(0, 200)}`
            : 'No messages yet';
        const conciseOutput = JSON.stringify({
            session: entry.sessionId ?? 'pending',
            status: entry.status ?? 'unknown',
            executor: entry.executor ?? 'unknown',
            lastMessage: lastMessageText
        }, null, 2);
        process.stdout.write(conciseOutput + '\n');
        return;
    }
    const displayTranscript = parsed.options.full
        ? transcript
        : parsed.options.live
            ? (0, transcript_utils_1.sliceForLatest)(transcript)
            : (0, transcript_utils_1.sliceForRecent)(transcript);
    // Determine output mode from flags
    const mode = parsed.options.full ? 'overview' : parsed.options.live ? 'final' : 'recent';
    const meta = {
        sessionId: entry.sessionId ?? null,
        agent: entry.agent ?? 'unknown',
        status: entry.status ?? null,
        executor: entry.executor ? String(entry.executor) : undefined
    };
    const markdown = (0, markdown_formatter_js_1.formatTranscriptMarkdown)(displayTranscript, meta, mode);
    console.log(markdown);
    if (warnings.length) {
        console.log('\n⚠️  Warnings:');
        warnings.forEach(w => console.log(`  ${w}`));
    }
}
