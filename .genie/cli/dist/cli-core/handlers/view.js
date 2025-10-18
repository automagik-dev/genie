"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewHandler = createViewHandler;
const fs_1 = __importDefault(require("fs"));
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
        // If not found in sessions.json, try Forge API lookup
        // CRITICAL: Do NOT access filesystem directly - this violates Forge worktree isolation
        // See: .genie/discovery/filesystem-restrictions-audit.md (Violation #1)
        if (!found) {
            // TODO (Wish #120-A): Use Forge MCP to check if session exists
            // Proposed implementation:
            //   try {
            //     const task = await mcp__automagik_forge__get_task({ task_id: sessionName });
            //     if (task) {
            //       return {
            //         name: sessionName,
            //         agent: task.title.match(/^Genie: ([^\(]+)/)?.[1]?.trim() || 'unknown',
            //         status: 'orphaned',
            //         transcript: await getForgeTaskLogs(sessionName), // TODO: implement
            //         source: 'Forge task',
            //       };
            //     }
            //   } catch (error) {
            //     // Session doesn't exist in Forge either
            //   }
            //
            // For now: Simply throw error (no filesystem violations)
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
        // CRITICAL: Do NOT read session files directly - this violates Forge worktree isolation
        // See: .genie/discovery/filesystem-restrictions-audit.md (Violation #2)
        //
        // OLD CODE (filesystem violation - REMOVED):
        //   - executor.locateSessionFile()
        //   - fs.existsSync(sessionFilePath)
        //   - fs.readFileSync(sessionFilePath, 'utf8')
        //
        // TODO (Wish #120-A): Use Forge MCP to get logs (when Forge integration is complete)
        // Proposed implementation:
        //   let transcript = raw; // Default to CLI log
        //
        //   if (entry.sessionId && entry.executor === 'forge') {
        //     try {
        //       // Always prefer Forge logs over CLI logs (source of truth)
        //       const forgeLogs = await mcp__automagik_forge__get_task_attempt_logs({
        //         attempt_id: entry.sessionId
        //       });
        //       if (forgeLogs) {
        //         transcript = forgeLogs;
        //         source = 'Forge logs';
        //       }
        //     } catch (error) {
        //       // Fallback to CLI log file if Forge API fails
        //       console.warn(`Failed to fetch Forge logs for ${entry.sessionId}, using CLI log`);
        //     }
        //   }
        //
        // For now: Use CLI log only (no filesystem violations)
        const transcript = raw;
        return {
            name: entry.name || sessionName,
            agent: agentName,
            status: entry.status || 'unknown',
            transcript,
            source: 'CLI log', // TODO (Wish #120-A): Change to 'Forge logs' when using Forge API
            mode: entry.mode || entry.preset,
            created: entry.created,
            lastUsed: entry.lastUsed,
            logFile
        };
    };
}
