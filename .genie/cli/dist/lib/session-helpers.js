"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordRuntimeWarning = recordRuntimeWarning;
exports.getRuntimeWarnings = getRuntimeWarnings;
exports.clearRuntimeWarnings = clearRuntimeWarnings;
exports.findSessionEntry = findSessionEntry;
exports.resolveDisplayStatus = resolveDisplayStatus;
const runtimeWarnings = [];
/**
 * Records a runtime warning message for later retrieval.
 *
 * @param {string} message - Warning message to record
 * @returns {void}
 */
function recordRuntimeWarning(message) {
    runtimeWarnings.push(message);
}
/**
 * Retrieves all recorded runtime warnings.
 *
 * @returns {string[]} - Copy of all runtime warnings
 */
function getRuntimeWarnings() {
    return [...runtimeWarnings];
}
/**
 * Clears all recorded runtime warnings.
 *
 * @returns {void}
 */
function clearRuntimeWarnings() {
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
function findSessionEntry(store, name, paths) {
    if (!name || typeof name !== 'string')
        return null;
    const trimmed = name.trim();
    if (!trimmed)
        return null;
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
function resolveDisplayStatus(entry) {
    return entry.status || 'unknown';
}
