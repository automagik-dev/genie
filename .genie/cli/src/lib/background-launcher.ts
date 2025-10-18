import path from 'path';
import { spawn } from 'child_process';
import type { ParsedCommand, ConfigPaths, GenieConfig } from './types';
import type { SessionStore, SessionEntry, SessionPathsConfig, SessionLoadConfig } from '../session-store';
import { loadSessions, saveSessions } from '../session-store';
import { backgroundManager } from './background-manager-instance';
import { INTERNAL_SESSION_ID_ENV } from '../background-manager';
import { sleep } from './async';
import { DEFAULT_CONFIG } from './config-defaults';

export interface BackgroundLaunchParams {
  parsed: ParsedCommand;
  config: GenieConfig;
  paths: Required<ConfigPaths>;
  store: SessionStore;
  entry: SessionEntry;
  agentName: string;
  executorKey: string;
  executionMode: string;
  startTime: number;
  logFile: string;
  allowResume: boolean;
}

/**
 * Handle background launching of agents
 * @returns true if handled as background, false if should continue as foreground
 */
export async function maybeHandleBackgroundLaunch(params: BackgroundLaunchParams): Promise<boolean> {
  const {
    parsed,
    config,
    paths,
    store,
    entry,
    agentName,
    executorKey,
    executionMode,
    startTime,
    logFile,
    allowResume
  } = params;

  if (!parsed.options.background || parsed.options.backgroundRunner) {
    return false;
  }

  const runnerPid = backgroundManager.launch({
    rawArgs: parsed.options.rawArgs,
    startTime,
    logFile,
    backgroundConfig: config.background,
    scriptPath: path.resolve(__dirname, '..', 'genie.js'),
    env: entry.sessionId ? { [INTERNAL_SESSION_ID_ENV]: entry.sessionId } : undefined
  });

  entry.runnerPid = runnerPid;
  entry.status = 'running';
  entry.background = parsed.options.background;
  saveSessions(paths as SessionPathsConfig, store);

  process.stdout.write(`▸ Launching ${agentName} in background...\n`);
  process.stdout.write(`▸ Waiting for session ID...\n`);

  const pollStart = Date.now();
  // Configurable timeout (default 60s, was 20s) - fixes race condition on slow starts
  const pollTimeout = parseInt(process.env.GENIE_POLL_TIMEOUT || '60000', 10);
  let pollInterval = 500;
  const maxPollInterval = 5000;
  let lastProgressTime = pollStart;

  while (Date.now() - pollStart < pollTimeout) {
    await sleep(pollInterval);
    const liveStore = loadSessions(paths as SessionPathsConfig, config as SessionLoadConfig, DEFAULT_CONFIG as any);
    // Use V2 session store format: sessions keyed by sessionId
    // The foreground process already persisted `entry` under its UUID key.
    // Poll for that specific session record instead of legacy agent-keyed lookup.
    const liveEntry = entry.sessionId ? liveStore.sessions?.[entry.sessionId] : undefined;

    if (liveEntry?.sessionId) {
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
      entry.sessionId = liveEntry.sessionId;
      process.stdout.write(`▸ Session ID: ${liveEntry.sessionId} (${elapsed}s)\n\n`);
      process.stdout.write(`  View output:\n`);
      process.stdout.write(`    npx automagik-genie view ${liveEntry.sessionId}\n\n`);
      process.stdout.write(`  Continue conversation:\n`);

      if (allowResume) {
        process.stdout.write(`    npx automagik-genie resume ${liveEntry.sessionId} "..."\n\n`);
      } else {
        process.stdout.write(`    npx automagik-genie continue ${agentName} "..."\n\n`);
      }

      process.stdout.write(`  Stop the agent:\n`);
      process.stdout.write(`    npx automagik-genie stop ${liveEntry.sessionId}\n\n`);
      return true;
    }

    if (liveEntry?.status === 'failed' || liveEntry?.status === 'completed') {
      process.stdout.write(`\n▸ Agent failed to start (status: ${liveEntry.status})\n`);
      if (liveEntry?.error) {
        process.stdout.write(`▸ Error: ${liveEntry.error}\n`);
      }
      process.stdout.write(`▸ Check log: ${logFile}\n`);
      return true;
    }

    // Progress feedback every 5 seconds
    const now = Date.now();
    if (now - lastProgressTime >= 5000) {
      const elapsed = Math.floor((now - pollStart) / 1000);
      process.stdout.write(`▸ Still waiting... (${elapsed}s elapsed)\n`);
      lastProgressTime = now;
    }

    // Exponential backoff: 500ms → 750ms → 1125ms → 1688ms → 2532ms → 3798ms → 5000ms (max)
    pollInterval = Math.min(Math.floor(pollInterval * 1.5), maxPollInterval);
  }

  process.stdout.write(`\n▸ Timeout waiting for session ID (waited ${Math.floor(pollTimeout / 1000)}s)\n`);
  process.stdout.write(`▸ Increase timeout with: GENIE_POLL_TIMEOUT=120000 (for 120s)\n`);
  process.stdout.write(`▸ Check log: ${logFile}\n`);
  return true;
}
