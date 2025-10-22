import fs from 'fs';
import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { findSessionEntry } from '../../lib/session-helpers';
import { createForgeExecutor } from '../../lib/forge-executor';
import { describeForgeError, FORGE_RECOVERY_HINT } from '../../lib/forge-helpers';

function readLocalTranscript(entry: Record<string, any>): string | null {
  const logPath = typeof entry.logFile === 'string' ? entry.logFile : null;
  if (!logPath) return null;
  const absolute = path.isAbsolute(logPath) ? logPath : path.join(process.cwd(), logPath);
  if (!fs.existsSync(absolute)) return null;
  try {
    return fs.readFileSync(absolute, 'utf8');
  } catch {
    return null;
  }
}

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

    let forgeAvailable = true;
    try {
      await forgeExecutor.syncProfiles(ctx.config.forge?.executors);
    } catch (error) {
      forgeAvailable = false;
      const reason = describeForgeError(error);
      ctx.recordRuntimeWarning(`Forge sync failed: ${reason}`);
    }

    let status: string | null = null;
    let transcript: string | null = null;

    if (forgeAvailable) {
      try {
        const remoteStatus = await forgeExecutor.getSessionStatus(found.entry.sessionId);
        status = remoteStatus.status || null;
        transcript = await forgeExecutor.fetchLatestLogs(found.entry.sessionId);
      } catch (error) {
        forgeAvailable = false;
        const reason = describeForgeError(error);
        ctx.recordRuntimeWarning(`Forge view failed: ${reason}`);
      }
    }

    const localTranscript = readLocalTranscript(found.entry as Record<string, any>);

    if (!forgeAvailable && !transcript && localTranscript) {
      transcript = localTranscript;
    } else if (forgeAvailable && !transcript && localTranscript) {
      ctx.recordRuntimeWarning('Forge returned no logs; using cached log file.');
      transcript = localTranscript;
    }

    const lines = [
      `Session: ${found.entry.name || sessionName}`,
      `Agent: ${found.agentName}`,
      `Status: ${status || found.entry.status || 'unknown'}`
    ];

    if (found.entry.model) {
      lines.push(`Model: ${found.entry.model}`);
    }

    if (!forgeAvailable) {
      lines.push('⚠️ Forge backend unreachable. Displaying cached transcript if available.');
      lines.push(FORGE_RECOVERY_HINT);
    }

    if (transcript) {
      lines.push('', transcript);
    } else {
      lines.push('', '(No logs available)');
    }

    await ctx.emitView(lines.join('\n'), parsed.options);
  };
}
