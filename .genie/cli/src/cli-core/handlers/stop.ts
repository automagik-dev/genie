import fs from 'fs';
import type { Handler, HandlerContext } from '../context';
import type { ParsedCommand } from '../types';
import { findSessionEntry } from '../../lib/session-helpers';
import { persistStore } from './shared';

export function createStopHandler(ctx: HandlerContext): Handler {
  return async (parsed: ParsedCommand) => {
    const [sessionName] = parsed.commandArgs;
    if (!sessionName) {
      throw new Error('Usage: genie stop <session-name>');
    }

    const store = ctx.sessionService.load({ onWarning: ctx.recordRuntimeWarning });
    const found = findSessionEntry(store, sessionName, ctx.paths);

    if (!found) {
      return {
        success: false,
        name: sessionName,
        message: `No session found with name '${sessionName}'.`,
        events: [{ label: sessionName, status: 'failed', message: 'Session not found' }]
      };
    }

    const { agentName, entry } = found;
    const identifier = entry.name || agentName;
    const alivePids = [entry.runnerPid, entry.executorPid]
      .filter((pid) => ctx.backgroundManager.isAlive(pid)) as number[];

    if (!alivePids.length) {
      return {
        success: false,
        name: identifier,
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
      name: identifier,
      message: `Stop signal handled for ${identifier}`,
      events
    };
  };
}
