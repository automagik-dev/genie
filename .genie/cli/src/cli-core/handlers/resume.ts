import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';

export function createResumeHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
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

    const forgeExecutor = createForgeExecutor();
    try {
      await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
      throw new Error(`Forge backend unavailable while resuming '${sessionName}'. ${FORGE_RECOVERY_HINT}`);
    }

    try {
      await forgeExecutor.resumeSession(entry.sessionId, prompt);
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge resume failed: ${reason}`);
      throw new Error(`Forge backend rejected resume for '${sessionName}'. ${FORGE_RECOVERY_HINT}`);
    }

    entry.lastPrompt = prompt.slice(0, 200);
    entry.lastUsed = new Date().toISOString();
    entry.status = 'running';
    store.sessions[sessionName] = entry;
    await ctx.sessionService.save(store);

    process.stdout.write(`✓ Resumed ${sessionName} via Forge\n`);
  };
}
