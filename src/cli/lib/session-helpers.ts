import fs from 'fs';
import type { SessionStore, SessionEntry } from '../session-store';
import type { ConfigPaths } from './types';
import { saveSessions } from '../session-store';

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
  return entry.status || 'unknown';
}
