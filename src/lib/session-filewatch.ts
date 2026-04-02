/**
 * Session Filewatch — Event-driven JSONL capture via fs.watch.
 *
 * Watches ~/.claude/projects/ recursively for JSONL changes.
 * Reacts only when a file is written — zero CPU when idle.
 * Reads incrementally from stored offset, debounced 500ms per file.
 */

import { type FSWatcher, watch } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { buildWorkerMap, ingestFileFull, setLiveWorkPending } from './session-capture.js';

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
type SqlClient = any;

// ============================================================================
// State
// ============================================================================

let watcher: FSWatcher | null = null;
const offsetCache = new Map<string, number>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEBOUNCE_MS = 500;

// ============================================================================
// Offset cache management
// ============================================================================

async function loadOffsets(sql: SqlClient): Promise<void> {
  try {
    const rows = await sql`SELECT id, last_ingested_offset FROM sessions WHERE last_ingested_offset > 0`;
    for (const row of rows) {
      offsetCache.set(row.id, row.last_ingested_offset);
    }
  } catch {
    // best-effort
  }
}

// ============================================================================
// File event handler
// ============================================================================

function extractSessionInfo(
  filePath: string,
): { sessionId: string; projectPath: string; parentSessionId: string | null; isSubagent: boolean } | null {
  // Main: ~/.claude/projects/<hash>/sessions/<id>.jsonl
  // Subagent: ~/.claude/projects/<hash>/<parent-id>/subagents/<id>.jsonl
  if (!filePath.endsWith('.jsonl')) return null;

  const sessionId = basename(filePath, '.jsonl');
  const parts = filePath.split('/');
  const sessionsIdx = parts.lastIndexOf('sessions');
  const subagentsIdx = parts.lastIndexOf('subagents');

  if (subagentsIdx > 0 && parts[subagentsIdx - 1]) {
    // Subagent session
    const parentSessionId = parts[subagentsIdx - 1];
    const projectIdx = parts.indexOf('projects');
    const projectPath = projectIdx >= 0 ? parts.slice(0, projectIdx + 2).join('/') : '';
    return { sessionId, projectPath, parentSessionId, isSubagent: true };
  }

  if (sessionsIdx > 0) {
    // Main session
    const projectPath = parts.slice(0, sessionsIdx).join('/');
    return { sessionId, projectPath, parentSessionId: null, isSubagent: false };
  }

  return null;
}

async function handleFileChange(filePath: string, sql: SqlClient): Promise<void> {
  const info = extractSessionInfo(filePath);
  if (!info) return;

  const storedOffset = offsetCache.get(info.sessionId) ?? 0;

  try {
    setLiveWorkPending(true);
    const workerMap = await buildWorkerMap(sql);
    const result = await ingestFileFull(sql, info.sessionId, filePath, info.projectPath, storedOffset, {
      parentSessionId: info.parentSessionId,
      isSubagent: info.isSubagent,
      workerMap,
    });
    offsetCache.set(info.sessionId, result.newOffset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[filewatch] error ingesting ${filePath} at offset ${storedOffset}: ${message}`);
  } finally {
    setLiveWorkPending(false);
  }
}

// ============================================================================
// Start / Stop
// ============================================================================

export async function startFilewatch(sql: SqlClient): Promise<boolean> {
  if (watcher) return true;

  const claudeDir = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');

  // Load existing offsets from PG
  await loadOffsets(sql);

  try {
    watcher = watch(claudeDir, { recursive: true }, (_eventType, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return;

      const fullPath = join(claudeDir, filename);

      // Debounce per file — Claude writes multiple lines per turn
      const existing = debounceTimers.get(fullPath);
      if (existing) clearTimeout(existing);

      debounceTimers.set(
        fullPath,
        setTimeout(() => {
          debounceTimers.delete(fullPath);
          handleFileChange(fullPath, sql).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[filewatch] unhandled error for ${fullPath}: ${message}`);
          });
        }, DEBOUNCE_MS),
      );
    });

    watcher.on('error', (err) => {
      console.error('[filewatch] watcher error:', err.message);
      // Could fall back to polling here in the future
    });

    console.log(`[filewatch] watching ${claudeDir} (${offsetCache.size} sessions cached)`);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[filewatch] failed to start: ${message}`);
    return false;
  }
}

export function stopFilewatch(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
