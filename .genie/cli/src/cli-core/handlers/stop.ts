import fs from 'fs';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { findSessionEntry } from '../../lib/session-helpers';
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
