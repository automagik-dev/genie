"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewHandler = createViewHandler;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const session_helpers_1 = require("../../lib/session-helpers");
function createViewHandler(ctx) {
    return async (parsed) => {
        const [sessionName] = parsed.commandArgs;
        if (!sessionName) {
            throw new Error('Usage: genie view <session-name> [--full]');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        // Try sessions.json first (v3: sessions keyed by name)
        let found = (0, session_helpers_1.findSessionEntry)(store, sessionName, ctx.paths);
        let orphanedSession = false;
        // If not found in sessions.json, try direct session file lookup
        if (!found) {
            const executorKey = ctx.config.defaults?.executor || ctx.defaultExecutorKey;
            const executor = ctx.executors[executorKey];
            if (executor?.tryLocateSessionFileBySessionId && executor.resolvePaths) {
                const executorConfig = ctx.config.executors?.[executorKey] || {};
                const executorPaths = executor.resolvePaths({
                    config: executorConfig,
                    baseDir: ctx.paths.baseDir,
                    resolvePath: (target, base) => path_1.default.isAbsolute(target) ? target : path_1.default.resolve(base || ctx.paths.baseDir || '.', target)
                });
                const sessionsDir = executorPaths.sessionsDir;
                if (sessionsDir) {
                    const sessionFilePath = executor.tryLocateSessionFileBySessionId(sessionName, sessionsDir);
                    if (sessionFilePath && fs_1.default.existsSync(sessionFilePath)) {
                        orphanedSession = true;
                        const sessionFileContent = fs_1.default.readFileSync(sessionFilePath, 'utf8');
                        return {
                            name: sessionName,
                            agent: 'unknown',
                            status: 'orphaned',
                            transcript: sessionFileContent,
                            source: 'orphaned session file',
                            filePath: sessionFilePath
                        };
                    }
                }
            }
            throw new Error(`❌ No session found with name '${sessionName}'`);
        }
        const { agentName, entry } = found;
        const executorKey = entry.executor || ctx.config.defaults?.executor || ctx.defaultExecutorKey;
        const executor = ctx.executors[executorKey];
        const logFile = entry.logFile;
        if (!logFile || !fs_1.default.existsSync(logFile)) {
            throw new Error('❌ Log not found for this run');
        }
        const raw = fs_1.default.readFileSync(logFile, 'utf8');
        const allLines = raw.split(/\r?\n/);
        // Try to locate and read from session file for full conversation history
        let sessionFileContent = null;
        if (entry.sessionId && entry.startTime && executor?.locateSessionFile) {
            const executorConfig = ctx.config.executors?.[executorKey] || {};
            const executorPaths = executor.resolvePaths({
                config: executorConfig,
                baseDir: ctx.paths.baseDir,
                resolvePath: (target, base) => path_1.default.isAbsolute(target) ? target : path_1.default.resolve(base || ctx.paths.baseDir || '.', target)
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
                        // Fall back to CLI log if session file read fails
                    }
                }
            }
        }
        const transcript = sessionFileContent || raw;
        return {
            name: entry.name || sessionName,
            agent: agentName,
            status: entry.status || 'unknown',
            transcript,
            source: sessionFileContent ? 'session file' : 'CLI log',
            mode: entry.mode || entry.preset,
            created: entry.created,
            lastUsed: entry.lastUsed,
            logFile
        };
    };
}
