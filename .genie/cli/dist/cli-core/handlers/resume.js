"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResumeHandler = createResumeHandler;
const forge_executor_1 = require("../../lib/forge-executor");
const forge_helpers_1 = require("../../lib/forge-helpers");
function createResumeHandler(ctx) {
    return async (parsed) => {
        const cmdArgs = parsed.commandArgs;
        if (cmdArgs.length < 2) {
            throw new Error('Usage: genie resume <session-name> "<prompt>"');
        }
        const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
        const sessionName = cmdArgs[0];
        const prompt = cmdArgs.slice(1).join(' ').trim();
        const entry = store.sessions[sessionName];
        if (!entry || !entry.sessionId) {
            throw new Error(`❌ No session found with name '${sessionName}'`);
        }
        const forgeExecutor = (0, forge_executor_1.createForgeExecutor)();
        try {
            // Skip config.forge.executors - incompatible format, Forge loads from its own config
            await forgeExecutor.syncProfiles();
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
            throw new Error(`Forge backend unavailable while resuming '${sessionName}'. ${forge_helpers_1.FORGE_RECOVERY_HINT}`);
        }
        try {
            await forgeExecutor.resumeSession(entry.sessionId, prompt);
        }
        catch (error) {
            const reason = (0, forge_helpers_1.describeForgeError)(error);
            ctx.recordRuntimeWarning(`Forge resume failed: ${reason}`);
            throw new Error(`Forge backend rejected resume for '${sessionName}'. ${forge_helpers_1.FORGE_RECOVERY_HINT}`);
        }
        entry.lastPrompt = prompt.slice(0, 200);
        entry.lastUsed = new Date().toISOString();
        entry.status = 'running';
        store.sessions[sessionName] = entry;
        await ctx.sessionService.save(store);
        process.stdout.write(`✓ Resumed ${sessionName} via Forge\n`);
    };
}
