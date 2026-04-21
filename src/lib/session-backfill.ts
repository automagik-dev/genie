/**
 * Session Backfill — Lazy one-time ingestion of existing JSONL data.
 *
 * Single worker, one file at a time, newest first.
 * 64KB chunks, 100ms sleep between files.
 * Pauses when filewatch has live work.
 * Resumes from stored offset on restart.
 */

import {
  buildWorkerMap,
  discoverAllJsonlFiles,
  ingestFile,
  liveWorkPending,
  reconcileSubagentParents,
} from './session-capture.js';

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
type SqlClient = any;

// biome-ignore lint/suspicious/noExplicitAny: DiscoveredFile from session-capture, WorkerMap from buildWorkerMap
type BackfillFile = any;
// biome-ignore lint/suspicious/noExplicitAny: WorkerMap from session-capture
type WorkerMap = any;

const CHUNK_SIZE = 64 * 1024;
const SLEEP_BETWEEN_FILES_MS = 100;
const LIVE_YIELD_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Order backfill files so parent sessions ingest before their subagents.
 *
 * The `sessions.parent_session_id` FK (migration `010_session_capture_v2`) is
 * not DEFERRABLE, so inserting a subagent row whose parent hasn't been
 * inserted yet fails with `sessions_parent_session_id_fkey` and that file's
 * data is silently dropped. Sorting by mtime alone mixes parents and
 * subagents arbitrarily — subagents are usually newer than their parents,
 * so they win the race and get inserted first.
 *
 * Fix: sort non-subagents before subagents, then preserve newest-first within
 * each tier. Exported so the comparator can be unit-tested without a DB.
 */
export function compareBackfillFiles(
  a: { isSubagent: boolean; mtime: number },
  b: { isSubagent: boolean; mtime: number },
): number {
  if (a.isSubagent !== b.isSubagent) return a.isSubagent ? 1 : -1;
  return b.mtime - a.mtime;
}

// ============================================================================
// Progress state
// ============================================================================

interface BackfillProgress {
  totalFiles: number;
  processedFiles: number;
  totalBytes: number;
  processedBytes: number;
  errors: number;
  status: 'pending' | 'running' | 'paused' | 'complete' | 'failed';
}

async function updateSyncState(sql: SqlClient, progress: BackfillProgress): Promise<void> {
  await sql`
    INSERT INTO session_sync (id, status, total_files, processed_files, total_bytes, processed_bytes, errors, updated_at)
    VALUES ('backfill', ${progress.status}, ${progress.totalFiles}, ${progress.processedFiles}, ${progress.totalBytes}, ${progress.processedBytes}, ${progress.errors}, now())
    ON CONFLICT (id) DO UPDATE SET
      status = ${progress.status},
      total_files = ${progress.totalFiles},
      processed_files = ${progress.processedFiles},
      total_bytes = ${progress.totalBytes},
      processed_bytes = ${progress.processedBytes},
      errors = ${progress.errors},
      updated_at = now()
  `;
}

// ============================================================================
// Backfill worker
// ============================================================================

let running = false;

async function shouldSkipBackfill(sql: SqlClient): Promise<boolean> {
  try {
    const existing = await sql`SELECT status FROM session_sync WHERE id = 'backfill'`;
    if (existing.length > 0 && existing[0].status === 'complete') return true;
  } catch {
    // table may not exist yet
  }

  try {
    const [{ count }] = await sql`SELECT count(*)::int as count FROM sessions`;
    if (count > 0) {
      const existing = await sql`SELECT status FROM session_sync WHERE id = 'backfill'`;
      if (existing.length === 0 || existing[0].status === 'complete') return true;
    }
  } catch {
    return true;
  }

  return false;
}

async function yieldToLiveWork(): Promise<void> {
  while (liveWorkPending) {
    await sleep(LIVE_YIELD_POLL_MS);
  }
}

async function getFileStartOffset(sql: SqlClient, file: BackfillFile): Promise<number> {
  const existing = await sql`SELECT last_ingested_offset FROM sessions WHERE id = ${file.sessionId}`;
  if (existing.length > 0) return existing[0].last_ingested_offset ?? 0;
  return 0;
}

async function processBackfillFile(
  sql: SqlClient,
  file: BackfillFile,
  progress: BackfillProgress,
  workerMap: WorkerMap,
): Promise<void> {
  const offset = await getFileStartOffset(sql, file);
  if (offset >= file.fileSize) {
    progress.processedFiles++;
    progress.processedBytes += file.fileSize;
    return;
  }

  let currentOffset = offset;
  while (currentOffset < file.fileSize) {
    await yieldToLiveWork();

    const result = await ingestFile(sql, file.sessionId, file.jsonlPath, file.projectPath, currentOffset, {
      chunkSize: CHUNK_SIZE,
      parentSessionId: file.parentSessionId,
      isSubagent: file.isSubagent,
      fileSize: file.fileSize,
      mtime: file.mtime,
      workerMap,
    });

    if (result.newOffset <= currentOffset) break;
    progress.processedBytes += result.newOffset - currentOffset;
    currentOffset = result.newOffset;
  }

  progress.processedFiles++;
}

async function processAllFiles(
  sql: SqlClient,
  allFiles: BackfillFile[],
  progress: BackfillProgress,
  workerMap: WorkerMap,
): Promise<void> {
  for (const file of allFiles) {
    if (!running) break;
    await yieldToLiveWork();

    try {
      await processBackfillFile(sql, file, progress, workerMap);
    } catch (err) {
      progress.errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[backfill] error on ${file.jsonlPath}: ${message}`);
    }

    if (progress.processedFiles % 50 === 0) {
      await updateSyncState(sql, progress);
    }

    await sleep(SLEEP_BETWEEN_FILES_MS);
  }
}

function resolveBackfillStatus(progress: BackfillProgress): void {
  if (!running) {
    progress.status = 'paused';
    console.log(
      `[backfill] paused: ${progress.processedFiles}/${progress.totalFiles} files (will resume on next daemon start)`,
    );
  } else if (progress.errors > 0 && progress.errors >= progress.totalFiles) {
    progress.status = 'failed';
    console.error(
      `[backfill] failed: ${progress.errors}/${progress.totalFiles} files errored — will retry on next daemon start`,
    );
  } else {
    progress.status = 'complete';
    console.log(
      `[backfill] complete: ${progress.processedFiles}/${progress.totalFiles} files, ${progress.errors} errors`,
    );
  }
}

export async function startBackfill(sql: SqlClient): Promise<void> {
  if (running) return;
  if (await shouldSkipBackfill(sql)) return;

  running = true;
  console.log('[backfill] starting session backfill...');

  try {
    const allFiles = await discoverAllJsonlFiles();
    allFiles.sort(compareBackfillFiles);

    const totalBytes = allFiles.reduce((sum, f) => sum + f.fileSize, 0);
    const progress: BackfillProgress = {
      totalFiles: allFiles.length,
      processedFiles: 0,
      totalBytes,
      processedBytes: 0,
      errors: 0,
      status: 'running',
    };

    await updateSyncState(sql, progress);
    console.log(`[backfill] discovered ${allFiles.length} files (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);

    const workerMap = await buildWorkerMap(sql);

    await processAllFiles(sql, allFiles, progress, workerMap);

    // Reconcile any subagent rows whose parent was inserted after they were
    // (e.g. orphan subagents that got parent=NULL earlier but a main jsonl
    // with the matching id has since appeared). Also backfills missing
    // metadata (agent_id/team/wish_slug/...) from the parent for rows that
    // already have a parent link but were captured without worker context.
    try {
      const { linked, metadataFilled } = await reconcileSubagentParents(sql);
      if (linked > 0) console.log(`[backfill] reconciled parent_session_id for ${linked} subagent(s)`);
      if (metadataFilled > 0) console.log(`[backfill] inherited parent metadata for ${metadataFilled} subagent(s)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[backfill] parent reconcile skipped: ${message}`);
    }

    resolveBackfillStatus(progress);
    await updateSyncState(sql, progress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[backfill] fatal error: ${message}`);
  } finally {
    running = false;
  }
}

export function stopBackfill(): void {
  running = false;
}

/**
 * Get current backfill progress for CLI display.
 */
export async function getBackfillStatus(sql: SqlClient): Promise<BackfillProgress | null> {
  try {
    const rows = await sql`SELECT * FROM session_sync WHERE id = 'backfill'`;
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      totalFiles: row.total_files,
      processedFiles: row.processed_files,
      totalBytes: row.total_bytes,
      processedBytes: row.processed_bytes,
      errors: row.errors,
      status: row.status,
    };
  } catch {
    return null;
  }
}
