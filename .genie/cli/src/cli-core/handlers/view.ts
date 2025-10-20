import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { findSessionEntry } from '../../lib/session-helpers';
import { createForgeExecutor } from '../../lib/forge-executor';

export function createViewHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [sessionName] = parsed.commandArgs;
    if (!sessionName) {
      throw new Error('Usage: genie view <session-name> [--full]');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const found = findSessionEntry(store, sessionName, ctx.paths);

    if (!found || !found.entry.sessionId) {
      throw new Error(`❌ No session found with name '${sessionName}'`);
    }

    const forgeExecutor = createForgeExecutor();
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
