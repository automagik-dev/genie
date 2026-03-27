/**
 * Session Backfill — Lazy one-time ingestion of existing JSONL data.
 *
 * Single worker, one file at a time, newest first.
 * 64KB chunks, 100ms sleep between files.
 * Pauses when filewatch has live work.
 * Resumes from stored offset on restart.
 */

import { buildWorkerMap, discoverAllJsonlFiles, ingestFile, liveWorkPending } from './session-capture.js';

// biome-ignore lint/suspicious/noExplicitAny: postgres.js Sql type
type SqlClient = any;

const CHUNK_SIZE = 64 * 1024;
const SLEEP_BETWEEN_FILES_MS = 100;
const LIVE_YIELD_POLL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  status: 'pending' | 'running' | 'paused' | 'complete';
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

export async function startBackfill(sql: SqlClient): Promise<void> {
  if (running) return;

  // Check if backfill already complete
  try {
    const existing = await sql`SELECT status FROM session_sync WHERE id = 'backfill'`;
    if (existing.length > 0 && existing[0].status === 'complete') return;
  } catch {
    // table may not exist yet
  }

  // Check if sessions already exist (not first start)
  try {
    const [{ count }] = await sql`SELECT count(*)::int as count FROM sessions`;
    if (count > 0) {
      // Check if backfill was previously running (resume)
      const existing = await sql`SELECT status FROM session_sync WHERE id = 'backfill'`;
      if (existing.length === 0 || existing[0].status === 'complete') return;
      // If status is 'running' or 'paused', resume below
    }
  } catch {
    return;
  }

  running = true;
  console.log('[backfill] starting session backfill...');

  try {
    // Discover all JSONL files, sort by mtime descending (newest first)
    const allFiles = await discoverAllJsonlFiles();
    allFiles.sort((a, b) => b.mtime - a.mtime);

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

    for (const file of allFiles) {
      if (!running) break;

      // Priority yield: pause when filewatch has live work
      while (liveWorkPending) {
        await sleep(LIVE_YIELD_POLL_MS);
      }

      try {
        let offset = 0;
        // Check if this file was partially ingested
        const existing = await sql`SELECT last_ingested_offset FROM sessions WHERE id = ${file.sessionId}`;
        if (existing.length > 0) {
          offset = existing[0].last_ingested_offset ?? 0;
          if (offset >= file.fileSize) {
            // Already fully ingested
            progress.processedFiles++;
            progress.processedBytes += file.fileSize;
            continue;
          }
        }

        // Ingest in chunks
        let currentOffset = offset;
        while (currentOffset < file.fileSize) {
          // Yield to live work between chunks too
          while (liveWorkPending) {
            await sleep(LIVE_YIELD_POLL_MS);
          }

          const result = await ingestFile(sql, file.sessionId, file.jsonlPath, file.projectPath, currentOffset, {
            chunkSize: CHUNK_SIZE,
            parentSessionId: file.parentSessionId,
            isSubagent: file.isSubagent,
            fileSize: file.fileSize,
            mtime: file.mtime,
            workerMap,
          });

          if (result.newOffset <= currentOffset) break; // No progress — avoid infinite loop
          progress.processedBytes += result.newOffset - currentOffset;
          currentOffset = result.newOffset;
        }

        progress.processedFiles++;
      } catch (err) {
        progress.errors++;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[backfill] error on ${file.jsonlPath}: ${message}`);
      }

      // Update progress every 50 files
      if (progress.processedFiles % 50 === 0) {
        await updateSyncState(sql, progress);
      }

      await sleep(SLEEP_BETWEEN_FILES_MS);
    }

    if (running) {
      progress.status = 'complete';
      console.log(
        `[backfill] complete: ${progress.processedFiles}/${progress.totalFiles} files, ${progress.errors} errors`,
      );
    } else {
      progress.status = 'paused';
      console.log(
        `[backfill] paused: ${progress.processedFiles}/${progress.totalFiles} files (will resume on next daemon start)`,
      );
    }
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
