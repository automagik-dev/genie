"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createResumeHandler = createResumeHandler;
const forge_executor_1 = require("../../lib/forge-executor");
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
        await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
        await forgeExecutor.resumeSession(entry.sessionId, prompt);
        entry.lastPrompt = prompt.slice(0, 200);
        entry.lastUsed = new Date().toISOString();
        entry.status = 'running';
        store.sessions[sessionName] = entry;
        await ctx.sessionService.save(store);
        process.stdout.write(`✓ Resumed ${sessionName} via Forge\n`);
    };
}
