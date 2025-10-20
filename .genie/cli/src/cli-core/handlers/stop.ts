import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { createForgeExecutor } from '../../lib/forge-executor';

export function createStopHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
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

    const forgeExecutor = createForgeExecutor();
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
