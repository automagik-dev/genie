import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';

export function createStopHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [sessionName] = parsed.commandArgs;
    if (!sessionName) {
      throw new Error('Usage: genie stop <session-name>');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const entry = store.sessions[sessionName];

    if (!entry || !entry.sessionId) {
      throw new Error(`Session '${sessionName}' not found. Use 'genie list' to see available sessions.`);
    }

    const forgeExecutor = createForgeExecutor();
    try {
      await forgeExecutor.stopSession(entry.sessionId);
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge stop failed: ${reason}`);
      throw new Error(`Forge backend unavailable while stopping '${sessionName}'. ${FORGE_RECOVERY_HINT}`);
    }

    entry.status = 'stopped';
    entry.lastUsed = new Date().toISOString();
    store.sessions[sessionName] = entry;
    await ctx.sessionService.save(store);

    process.stdout.write(`✓ Session ${sessionName} stopped via Forge\n`);
  };
}
