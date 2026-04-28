/**
 * Session Filewatch — Event-driven JSONL capture via chokidar.
 *
 * Watches ~/.claude/projects/ for JSONL changes.
 * Reacts only when a file is written — zero CPU when idle.
 * Reads incrementally from stored offset, debounced 500ms per file.
 */

import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { type FSWatcher, watch } from 'chokidar';

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
const WATCH_DEPTH = 4;

/**
 * Sessions where ingest raised an unrecoverable (FK) error — logged once,
 * then silenced. offsetCache for these sessions is set to Infinity so
 * subsequent file-change events skip ingest entirely.
 */
const unrecoverableSessions = new Set<string>();

/** Reset unrecoverable-session tracking (exposed for testing). */
export function resetUnrecoverableSessions(): void {
  unrecoverableSessions.clear();
  offsetCache.clear();
}

/**
 * Detect postgres FK constraint violations by error code (`23503`) or
 * message text. FK errors here mean the parent session row doesn't exist
 * (orphan subagent JSONLs, typically SDK-spawned agents not registered
 * with the capture layer). These are unrecoverable at the filewatch layer —
 * retrying on every write event spams logs forever.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  // postgres.js errors expose a `code` field matching SQLSTATE
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code === '23503') return true;
  const message = err instanceof Error ? err.message : String(err);
  return message.toLowerCase().includes('foreign key constraint');
}

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

export function extractSessionInfo(
  filePath: string,
): { sessionId: string; projectPath: string; parentSessionId: string | null; isSubagent: boolean } | null {
  // Main: ~/.claude/projects/<hash>/<id>.jsonl
  // Legacy main: ~/.claude/projects/<hash>/sessions/<id>.jsonl
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
    // Legacy main session
    const projectPath = parts.slice(0, sessionsIdx).join('/');
    return { sessionId, projectPath, parentSessionId: null, isSubagent: false };
  }

  const projectIdx = parts.lastIndexOf('projects');
  if (projectIdx >= 0 && parts.length === projectIdx + 3) {
    // Main session
    const projectPath = parts.slice(0, projectIdx + 2).join('/');
    return { sessionId, projectPath, parentSessionId: null, isSubagent: false };
  }

  return null;
}

/**
 * Dependencies used by handleFileChange — injected for testability so we
 * can exercise FK-skip logic without a real postgres connection.
 */
export interface FilewatchDeps {
  buildWorkerMap: typeof buildWorkerMap;
  ingestFileFull: typeof ingestFileFull;
  setLiveWorkPending: typeof setLiveWorkPending;
  logError: (msg: string) => void;
}

const defaultDeps: FilewatchDeps = {
  buildWorkerMap,
  ingestFileFull,
  setLiveWorkPending,
  logError: (msg) => console.error(msg),
};

export async function handleFileChange(
  filePath: string,
  sql: SqlClient,
  deps: FilewatchDeps = defaultDeps,
): Promise<void> {
  const info = extractSessionInfo(filePath);
  if (!info) return;

  // Session previously hit an unrecoverable error (e.g. FK violation) —
  // offsetCache is pinned to Infinity so we never retry ingest here.
  if (unrecoverableSessions.has(info.sessionId)) return;

  const storedOffset = offsetCache.get(info.sessionId) ?? 0;

  try {
    deps.setLiveWorkPending(true);
    const workerMap = await deps.buildWorkerMap(sql);
    const result = await deps.ingestFileFull(sql, info.sessionId, filePath, info.projectPath, storedOffset, {
      parentSessionId: info.parentSessionId,
      isSubagent: info.isSubagent,
      workerMap,
    });
    offsetCache.set(info.sessionId, result.newOffset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isForeignKeyViolation(err)) {
      // Unrecoverable at this layer — orphan subagent, parent not in sessions
      // table. Pin offset to Infinity and mark the session so subsequent
      // fs.watch events skip ingest entirely. Log once.
      unrecoverableSessions.add(info.sessionId);
      offsetCache.set(info.sessionId, Number.POSITIVE_INFINITY);
      deps.logError(
        `[filewatch] skipping ${filePath} — FK constraint violation (orphan session, parent not registered): ${message}`,
      );
    } else {
      // Transient error (connection reset, deadlock, etc.) — DO NOT advance
      // offset. Retry on next write event preserves at-least-once semantics.
      deps.logError(`[filewatch] error ingesting ${filePath} at offset ${storedOffset}: ${message}`);
    }
  } finally {
    deps.setLiveWorkPending(false);
  }
}

function shouldIgnoreWatchPath(path: string, stats?: { isFile: () => boolean }): boolean {
  return stats?.isFile() === true && !path.endsWith('.jsonl');
}

function normalizeWatchEventPath(claudeDir: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(claudeDir, filePath);
}

function scheduleFileChange(filePath: string, sql: SqlClient): void {
  if (!filePath.endsWith('.jsonl')) return;

  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  debounceTimers.set(
    filePath,
    setTimeout(() => {
      debounceTimers.delete(filePath);
      handleFileChange(filePath, sql).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[filewatch] unhandled error for ${filePath}: ${message}`);
      });
    }, DEBOUNCE_MS),
  );
}

export function createJsonlWatcher(claudeDir: string, onJsonlChange: (filePath: string) => void): FSWatcher {
  const jsonlWatcher = watch(claudeDir, {
    ignoreInitial: true,
    depth: WATCH_DEPTH,
    ignored: shouldIgnoreWatchPath,
    awaitWriteFinish: {
      stabilityThreshold: DEBOUNCE_MS,
      pollInterval: 100,
    },
    atomic: true,
  });

  const emitJsonlChange = (filePath: string): void => {
    if (!filePath.endsWith('.jsonl')) return;
    onJsonlChange(normalizeWatchEventPath(claudeDir, filePath));
  };

  jsonlWatcher.on('add', emitJsonlChange);
  jsonlWatcher.on('change', emitJsonlChange);

  return jsonlWatcher;
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
    watcher = createJsonlWatcher(claudeDir, (fullPath) => scheduleFileChange(fullPath, sql));

    watcher.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[filewatch] watcher error:', message);
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
    void watcher.close();
    watcher = null;
  }
  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
}
