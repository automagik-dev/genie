import fs from 'fs';
import type { ConfigPaths } from './types';
import type { SessionEntry, SessionStore, SessionPathsConfig } from '../session-store';
import { saveSessions } from '../session-store';

/**
 * Parse a line of output for session ID updates
 */
export function parseSessionUpdate(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const data = JSON.parse(trimmed);
    if (data && typeof data === 'object' && data.type === 'session.created') {
      const sessionId = data.session_id || data.sessionId;
      if (sessionId) {
        return sessionId;
      }
    }
  } catch {
    // ignore malformed JSON lines
  }
  return null;
}

/**
 * Create a session update handler for streaming output
 */
export function createSessionUpdateHandler(
  entry: SessionEntry,
  store: SessionStore,
  paths: Required<ConfigPaths>
): (line: string) => void {
  return (line: string) => {
    const sessionId = parseSessionUpdate(line);
    if (sessionId && entry.sessionId !== sessionId) {
      const oldSessionId = entry.sessionId;
      entry.sessionId = sessionId;
      entry.lastUsed = new Date().toISOString();

      // Re-key session in store (v2 schema: sessions keyed by sessionId)
      if (oldSessionId && store.sessions[oldSessionId]) {
        delete store.sessions[oldSessionId];
        store.sessions[sessionId] = entry;
      }

      saveSessions(paths as SessionPathsConfig, store);
    }
  };
}

/**
 * Attach output listener to a stream for session updates
 */
export function attachOutputListener(
  stream: NodeJS.ReadableStream,
  updateHandler: (line: string) => void
): void {
  let buffer = '';
  stream.on('data', (chunk: Buffer | string) => {
    const text = chunk instanceof Buffer ? chunk.toString('utf8') : chunk;
    buffer += text;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      updateHandler(line);
      index = buffer.indexOf('\n');
    }
  });
}

/**
 * Poll log file for session ID updates (fallback method)
 */
export function createLogPollingHandler(
  entry: SessionEntry,
  store: SessionStore,
  paths: Required<ConfigPaths>,
  logFile: string,
  logViewer?: { readSessionIdFromLog?: (logFile: string) => string | null }
): () => void {
  let pollingActive = Boolean(logViewer?.readSessionIdFromLog);

  const pollSessionIdFromLog = () => {
    if (!pollingActive || entry.sessionId) return;

    try {
      const fromLog = logViewer?.readSessionIdFromLog?.(logFile) ?? null;
      if (fromLog && entry.sessionId !== fromLog) {
        const oldSessionId = entry.sessionId;
        entry.sessionId = fromLog;
        entry.lastUsed = new Date().toISOString();

        // Re-key session in store (v2 schema: sessions keyed by sessionId)
        if (oldSessionId && store.sessions[oldSessionId]) {
          delete store.sessions[oldSessionId];
          store.sessions[fromLog] = entry;
        }

        saveSessions(paths as SessionPathsConfig, store);
        pollingActive = false;
        return;
      }
    } catch {
      // ignore log polling errors
    }

    if (pollingActive && !entry.sessionId) {
      setTimeout(pollSessionIdFromLog, 500);
    }
  };

  return pollSessionIdFromLog;
}