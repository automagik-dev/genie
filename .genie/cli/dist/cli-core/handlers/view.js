"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewHandler = createViewHandler;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const session_helpers_1 = require("../../lib/session-helpers");
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
function readLocalTranscript(entry) {
    const logPath = typeof entry.logFile === 'string' ? entry.logFile : null;
    if (!logPath)
        return null;
    const absolute = path_1.default.isAbsolute(logPath) ? logPath : path_1.default.join(process.cwd(), logPath);
    if (!fs_1.default.existsSync(absolute))
        return null;
    try {
        return fs_1.default.readFileSync(absolute, 'utf8');
    }
    catch {
        return null;
    }
}
function createViewHandler(ctx) {
    return async (parsed) => {
        const [sessionName] = parsed.commandArgs;
        if (!sessionName) {
            throw new Error('Usage: genie view <session-name> [--full]');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const found = (0, session_helpers_1.findSessionEntry)(store, sessionName, ctx.paths);
        if (!found || !found.entry.sessionId) {
            throw new Error(`❌ No session found with name '${sessionName}'`);
        }
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        let forgeAvailable = true;
        // Skip profile sync in view command - not needed for read-only operations
        // Profile sync happens on agent run, not on view
        let status = null;
        let transcript = null;
        if (forgeAvailable) {
            try {
                const remoteStatus = await forgeExecutor.getSessionStatus(found.entry.sessionId);
                status = remoteStatus.status || null;
                transcript = await forgeExecutor.fetchLatestLogs(found.entry.sessionId);
            }
            catch (error) {
                forgeAvailable = false;
                const reason = (0, forge_helpers_1.describeForgeError)(error);
                ctx.recordRuntimeWarning(`Forge view failed: ${reason}`);
            }
        }
        const localTranscript = readLocalTranscript(found.entry);
        if (!forgeAvailable && !transcript && localTranscript) {
            transcript = localTranscript;
        }
        else if (forgeAvailable && !transcript && localTranscript) {
            ctx.recordRuntimeWarning('Forge returned no logs; using cached log file.');
            transcript = localTranscript;
        }
        const lines = [
            `Session: ${found.entry.name || sessionName}`,
            `Agent: ${found.agentName}`,
            `Status: ${status || found.entry.status || 'unknown'}`
        ];
        if (found.entry.model) {
            lines.push(`Model: ${found.entry.model}`);
        }
        if (!forgeAvailable) {
            lines.push('⚠️ Forge backend unreachable. Displaying cached transcript if available.');
            lines.push(forge_helpers_1.FORGE_RECOVERY_HINT);
        }
        if (transcript) {
            lines.push('', transcript);
        }
        else {
            lines.push('', '(No logs available)');
        }
        await ctx.emitView(lines.join('\n'), parsed.options);
    };
}
