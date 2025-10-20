"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStopHandler = createStopHandler;
const forge_executor_1 = require("../../lib/forge-executor");
function createStopHandler(ctx) {
    return async (parsed) => {
        const [sessionName] = parsed.commandArgs;
        if (!sessionName) {
            throw new Error('Usage: genie stop <session-name>');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const entry = store.sessions[sessionName];
        if (!entry || !entry.sessionId) {
            return {
                success: false,
                name: sessionName,
                message: `No session found with name '${sessionName}'.`
            };
        }
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        await forgeExecutor.stopSession(entry.sessionId);
        entry.status = 'stopped';
        entry.lastUsed = new Date().toISOString();
        store.sessions[sessionName] = entry;
        await ctx.sessionService.save(store);
        return {
            success: true,
            name: sessionName,
            message: `Session ${sessionName} stopped via Forge`
        };
    };
}
