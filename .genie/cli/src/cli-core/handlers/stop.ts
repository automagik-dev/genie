import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';

export function createStopHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [attemptId] = parsed.commandArgs;
    if (!attemptId) {
      throw new Error('Usage: genie stop <attempt-id>');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const entry = store.sessions[attemptId]; // Direct UUID lookup (issue #407 fix)

    if (!entry) {
      throw new Error(`Session '${attemptId}' not found. Use 'genie list' to see available sessions.`);
    }

    const forgeExecutor = createForgeExecutor();
    try {
      await forgeExecutor.stopSession(attemptId);
    } catch (error) {
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge stop failed: ${reason}`);
      throw new Error(`Forge backend unavailable while stopping session '${attemptId}'. ${FORGE_RECOVERY_HINT}`);
    }

    entry.status = 'stopped';
    entry.lastUsed = new Date().toISOString();
    store.sessions[attemptId] = entry;
    await ctx.sessionService.save(store);

    process.stdout.write(`✓ Session ${attemptId} stopped via Forge\n`);
  };
}
