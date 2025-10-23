"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createStopHandler = createStopHandler;
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
function createStopHandler(ctx) {
    return async (parsed) => {
        const [sessionName] = parsed.commandArgs;
        if (!sessionName) {
            throw new Error('Usage: genie stop <session-name>');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const entry = store.sessions[sessionName];
        if (!entry || !entry.sessionId) {
            throw new Error(`Session '${sessionName}' not found. Use 'genie list' to see available sessions.`);
        }
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        try {
            await forgeExecutor.stopSession(entry.sessionId);
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge stop failed: ${reason}`);
            throw new Error(`Forge backend unavailable while stopping '${sessionName}'. ${forge_helpers_1.FORGE_RECOVERY_HINT}`);
        }
        entry.status = 'stopped';
        entry.lastUsed = new Date().toISOString();
        store.sessions[sessionName] = entry;
        await ctx.sessionService.save(store);
        process.stdout.write(`✓ Session ${sessionName} stopped via Forge\n`);
    };
}
