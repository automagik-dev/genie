"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createViewHandler = createViewHandler;
const session_helpers_1 = require("../../lib/session-helpers");
const forge_executor_1 = require("../../lib/forge-executor");
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
        await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
        const status = await forgeExecutor.getSessionStatus(found.entry.sessionId);
        const transcript = await forgeExecutor.fetchLatestLogs(found.entry.sessionId);
        const lines = [
            `Session: ${found.entry.name || sessionName}`,
            `Agent: ${found.agentName}`,
            `Status: ${status.status}`,
            transcript ? '' : '(No logs available)',
            transcript || ''
        ].filter(Boolean);
        await ctx.emitView(lines.join('\n'), parsed.options);
    };
}
