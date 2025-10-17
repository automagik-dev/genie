import fs from 'fs';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { persistStore } from './shared';

export function createStopHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [target] = parsed.commandArgs;
    if (!target) {
      throw new Error('Usage: genie stop <sessionId>');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const found = findSessionEntry(store, target, ctx.paths);

    if (!found) {
      return {
        success: false,
        sessionId: target,
        message: `No run found with session id '${target}'.`,
        events: [{ label: target, status: 'failed', message: 'Session id not found' }]
      };
    }

    const { agentName, entry } = found;
    const identifier = entry.sessionId || agentName;
    const alivePids = [entry.runnerPid, entry.executorPid]
      .filter((pid) => ctx.backgroundManager.isAlive(pid)) as number[];

    if (!alivePids.length) {
      return {
        success: false,
        sessionId: identifier,
        message: `No active process found for ${identifier}.`,
        events: [{ label: identifier, detail: 'No active process', status: 'pending' }]
      };
    }

    const events: Array<{ label: string; detail: string; status: string; message?: string }> = [];

    alivePids.forEach((pid) => {
      try {
        const ok = ctx.backgroundManager.stop(pid);
        if (ok !== false) {
          events.push({ label: `${identifier}`, detail: `PID ${pid} stopped`, status: 'done' });
        } else {
          events.push({ label: `${identifier}`, detail: `PID ${pid} not running`, status: 'failed' });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        events.push({ label: `${identifier}`, detail: `PID ${pid}`, status: 'failed', message });
      }
    });

    entry.status = 'stopped';
    entry.lastUsed = new Date().toISOString();
    entry.signal = entry.signal || 'SIGTERM';
    if (entry.exitCode === undefined) entry.exitCode = null;
    await persistStore(ctx, store);

    return {
      success: true,
      sessionId: identifier,
      message: `Stop signal handled for ${identifier}`,
      events
    };
  };
}

function findSessionEntry(
  store: any,
  sessionId: string,
  paths: any
): { agentName: string; entry: any } | null {
  if (!sessionId || typeof sessionId !== 'string') return null;
  const trimmed = sessionId.trim();
  if (!trimmed) return null;

  // Direct lookup by sessionId (v2 schema)
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    if (entry && ((entry as any).sessionId === trimmed || sid === trimmed)) {
      return { agentName: (entry as any).agent, entry };
    }
  }

  // Fallback: scan log files for session_id markers
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    const logFile = (entry as any).logFile;
    if (!logFile || !fs.existsSync(logFile)) continue;
    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const marker = new RegExp(`"session_id":"${trimmed}"`);
      if (marker.test(content)) {
        (entry as any).sessionId = trimmed;
        (entry as any).lastUsed = new Date().toISOString();
        return { agentName: (entry as any).agent, entry };
      }
    } catch {
      // skip
    }
  }
  return null;
}
