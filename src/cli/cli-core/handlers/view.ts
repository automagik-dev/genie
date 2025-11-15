import fs from 'fs';
import path from 'path';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
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
    const [attemptId] = parsed.commandArgs;
    if (!attemptId) {
      throw new Error('Usage: genie view <attempt-id> [--full]');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const entry = store.sessions[attemptId]; // Direct lookup by UUID (issue #407 fix)

    if (!entry) {
      throw new Error(`❌ No session found with ID '${attemptId}'`);
    }

    const forgeExecutor = createForgeExecutor();

    let forgeAvailable = true;
    // Skip profile sync in view command - not needed for read-only operations
    // Profile sync happens on agent run, not on view

    let status: string | null = null;
    let transcript: string | null = null;

    if (forgeAvailable) {
      try {
        const remoteStatus = await forgeExecutor.getTaskStatus(attemptId);
        status = remoteStatus.status || null;
        transcript = await forgeExecutor.fetchTaskLogs(attemptId);
      } catch (error) {
        forgeAvailable = false;
        const reason = describeForgeError(error);
        ctx.recordRuntimeWarning(`Forge view failed: ${reason}`);
      }
    }

    const localTranscript = readLocalTranscript(entry as Record<string, any>);

    if (!forgeAvailable && !transcript && localTranscript) {
      transcript = localTranscript;
    } else if (forgeAvailable && !transcript && localTranscript) {
      ctx.recordRuntimeWarning('Forge returned no logs; using cached log file.');
      transcript = localTranscript;
    }

    const lines = [
      `Session ID: ${attemptId}`,
      `Agent: ${entry.agent}`,
      `Status: ${status || entry.status || 'unknown'}`
    ];

    if (entry.forgeUrl) {
      lines.push(`Forge URL: ${entry.forgeUrl}`);
    }

    if (entry.model) {
      lines.push(`Model: ${entry.model}`);
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
