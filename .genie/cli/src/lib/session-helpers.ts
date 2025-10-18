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
 * Finds a session entry by name.
 *
 * In v3, sessions are keyed by name. This does a direct lookup.
 *
 * @param {SessionStore} store - Session store containing sessions (name-keyed in v3)
 * @param {string} name - Session name to search for
 * @param {Required<ConfigPaths>} paths - Configuration paths (unused in v3)
 * @returns {{ agentName: string; entry: SessionEntry } | null} - Found session or null
 *
 * @example
 * const result = findSessionEntry(store, '115-session-architecture', paths);
 * if (result) {
 *   console.log(`Found session for agent: ${result.agentName}`);
 * }
 */
export function findSessionEntry(
  store: SessionStore,
  name: string,
  paths: Required<ConfigPaths>
) {
  if (!name || typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;

  // v3: Direct lookup by name (sessions are name-keyed)
  const entry = store.sessions[trimmed];
  if (entry) {
    return { agentName: entry.agent, entry };
  }

  // Not found - provide helpful error message
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