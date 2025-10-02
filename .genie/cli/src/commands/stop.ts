import type { ParsedCommand, GenieConfig, ConfigPaths } from '../lib/types';
import {
  loadSessions,
  saveSessions,
  SessionLoadConfig,
  SessionPathsConfig
} from '../session-store';
import { findSessionEntry } from '../lib/session-helpers';
import { DEFAULT_CONFIG } from '../lib/config-defaults';
import { buildStopView, StopEvent } from '../views/stop';
import { buildWarningView } from '../views/common';
import { emitView } from '../lib/view-helpers';
import { backgroundManager } from '../lib/background-manager-instance';

export async function runStop(
  parsed: ParsedCommand,
  config: GenieConfig,
  paths: Required<ConfigPaths>
): Promise<void> {
  const [target] = parsed.commandArgs;
  if (!target) {
    throw new Error('Usage: genie stop <sessionId>');
  }

  const warnings: string[] = [];
  const store = loadSessions(
    paths as SessionPathsConfig,
    config as SessionLoadConfig,
    DEFAULT_CONFIG as any,
    { onWarning: (message) => warnings.push(message) }
  );
  const found = findSessionEntry(store, target, paths);
  const events: StopEvent[] = [];
  let summary = '';
  const appendWarningView = async () => {
    if (warnings.length) {
      await emitView(buildWarningView('Session warnings', warnings), parsed.options);
    }
  };

  if (!found) {
    events.push({ label: target, status: 'failed', message: 'Session id not found' });
    summary = `No run found with session id '${target}'.`;
    const envelope = buildStopView({ target, events, summary });
    await emitView(envelope, parsed.options);
    await appendWarningView();
    return;
  }

  const { agentName, entry } = found;
  const identifier = entry.sessionId || agentName;
  const alivePids = [entry.runnerPid, entry.executorPid].filter((pid) => backgroundManager.isAlive(pid)) as number[];

  if (!alivePids.length) {
    events.push({ label: identifier, detail: 'No active process', status: 'pending' });
    summary = `No active process found for ${identifier}.`;
  } else {
    alivePids.forEach((pid) => {
      try {
        const ok = backgroundManager.stop(pid);
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
    summary = `Stop signal handled for ${identifier}`;
    entry.status = 'stopped';
    entry.lastUsed = new Date().toISOString();
    entry.signal = entry.signal || 'SIGTERM';
    if (entry.exitCode === undefined) entry.exitCode = null;
    saveSessions(paths as SessionPathsConfig, store);
  }

  const envelope = buildStopView({ target, events, summary });
  await emitView(envelope, parsed.options);
  await appendWarningView();
}
