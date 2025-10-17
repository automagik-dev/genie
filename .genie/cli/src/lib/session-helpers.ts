import fs from 'fs';
import type { SessionStore, SessionEntry } from '../session-store';
import type { ConfigPaths } from './types';
import { saveSessions } from '../session-store';
import BackgroundManager from '../background-manager';

const backgroundManager = new BackgroundManager();

const runtimeWarnings: string[] = [];

/**
 * Records a runtime warning message for later retrieval.
 *
 * @param {string} message - Warning message to record
 * @returns {void}
 */
export function recordRuntimeWarning(message: string): void {
  runtimeWarnings.push(message);
}

/**
 * Retrieves all recorded runtime warnings.
 *
 * @returns {string[]} - Copy of all runtime warnings
 */
export function getRuntimeWarnings(): string[] {
  return [...runtimeWarnings];
}

/**
 * Clears all recorded runtime warnings.
 *
 * @returns {void}
 */
export function clearRuntimeWarnings(): void {
  runtimeWarnings.length = 0;
}

/**
 * Finds a session entry by session ID across all agents.
 *
 * First searches by sessionId field, then scans log files for session_id markers.
 * Updates session metadata and saves if found in logs.
 *
 * @param {SessionStore} store - Session store containing agent sessions
 * @param {string} sessionId - Session identifier to search for
 * @param {Required<ConfigPaths>} paths - Configuration paths for saving updates
 * @returns {{ agentName: string; entry: SessionEntry } | null} - Found session or null
 *
 * @example
 * const result = findSessionEntry(store, 'abc-123', paths);
 * if (result) {
 *   console.log(`Found session for agent: ${result.agentName}`);
 * }
 */
export function findSessionEntry(
  store: SessionStore,
  sessionIdOrName: string,
  paths: Required<ConfigPaths>
) {
  if (!sessionIdOrName || typeof sessionIdOrName !== 'string') return null;
  const trimmed = sessionIdOrName.trim();
  if (!trimmed) return null;

  // 1. Direct lookup by sessionId (UUID) or session key
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    if (entry && (entry.sessionId === trimmed || sid === trimmed)) {
      return { agentName: entry.agent, entry };
    }
  }

  // 2. Lookup by friendly name
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    if (entry && entry.name === trimmed) {
      return { agentName: entry.agent, entry };
    }
  }

  // 3. Fallback: scan log files for session_id markers
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    const logFile = entry.logFile;
    if (!logFile || !fs.existsSync(logFile)) continue;
    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const marker = new RegExp(`"session_id":"${trimmed}"`);
      if (marker.test(content)) {
        // Update session entry with discovered sessionId (but keep same key)
        entry.sessionId = trimmed;
        entry.lastUsed = new Date().toISOString();
        saveSessions(paths as any, store);
        return { agentName: entry.agent, entry };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRuntimeWarning(`[genie] Failed to scan log ${logFile}: ${message}`);
    }
  }
  return null;
}

/**
 * Resolves human-readable display status for a session entry.
 *
 * Combines entry status with process liveness checks to determine accurate state.
 * Status progression: running → pending-completion → completed/failed/stopped.
 *
 * @param {SessionEntry} entry - Session entry to evaluate
 * @returns {string} - Display status: 'running', 'pending-completion', 'completed', 'failed (code)', 'stopped', or base status
 *
 * @example
 * const status = resolveDisplayStatus(entry);
 * // Returns: 'running' if executor process alive
 * // Returns: 'pending-completion' if runner still processing
 * // Returns: 'completed' if exit code 0
 * // Returns: 'failed (1)' if exit code non-zero
 */
export function resolveDisplayStatus(entry: SessionEntry): string {
  const baseStatus = entry.status || 'unknown';
  const executorRunning = backgroundManager.isAlive(entry.executorPid);
  const runnerRunning = backgroundManager.isAlive(entry.runnerPid);

  if (baseStatus === 'running') {
    if (executorRunning) return 'running';
    if (!executorRunning && runnerRunning) return 'pending-completion';
    if (entry.exitCode === 0) return 'completed';
    if (typeof entry.exitCode === 'number' && entry.exitCode !== 0) {
      return `failed (${entry.exitCode})`;
    }
    return 'stopped';
  }

  if (baseStatus === 'completed' || baseStatus === 'failed') {
    return baseStatus;
  }

  if (runnerRunning || executorRunning) {
    return 'running';
  }
  return baseStatus;
}