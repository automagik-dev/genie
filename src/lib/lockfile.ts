/**
 * Lockfile — Simple polling lock for concurrent file writes.
 *
 * PID-based lockfile with stale-lock detection and jittered retry. The holder
 * writes its PID into `<path>.lock`; waiters poll until the lock file is gone
 * OR the holder PID is no longer alive (via `process.kill(pid, 0)`).
 *
 * Extracted from `claude-native-teams.ts` so any module that needs safe
 * filesystem writes to a shared path can share the same lock semantics.
 *
 * Behavior:
 *   - `acquireLock(path)` creates `<path>.lock` atomically (`wx` flag).
 *   - On conflict, reads the holder PID; if the holder is dead, removes the
 *     stale lock and retries immediately.
 *   - If the holder is alive, sleeps `LOCK_POLL_MS + jitter` before retrying.
 *   - After `LOCK_TIMEOUT_MS` elapses, force-acquires with a warning — safety
 *     valve for the pathological case where a holder hangs forever.
 *   - `releaseLock(path)` unlinks `<path>.lock`; missing file is a no-op.
 */

import { readFile, unlink, writeFile } from 'node:fs/promises';

// ============================================================================
// Constants
// ============================================================================

const LOCK_TIMEOUT_MS = 5000;
const LOCK_POLL_MS = 50;

// ============================================================================
// Helpers
// ============================================================================

function lockPath(filePath: string): string {
  return `${filePath}.lock`;
}

/** Check if a PID is still alive using kill -0 (signal 0 = existence check). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Acquire a lock on `<path>.lock`. Blocks until the lock is available or the
 * timeout elapses (in which case the lock is force-acquired with a warning).
 *
 * The caller must pair every successful `acquireLock` with a `releaseLock` in
 * a `try { ... } finally { ... }` block.
 */
export async function acquireLock(path: string): Promise<void> {
  const lock = lockPath(path);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await writeFile(lock, String(process.pid), { flag: 'wx' });
      return; // acquired
    } catch {
      // Lock exists — check if holder PID is still alive
      try {
        const content = await readFile(lock, 'utf-8');
        const holderPid = Number.parseInt(content.trim(), 10);
        if (!Number.isNaN(holderPid) && !isPidAlive(holderPid)) {
          // Holder is dead — remove stale lock and retry immediately
          try {
            await unlink(lock);
          } catch {
            // Another process may have already cleaned it up
          }
          continue;
        }
      } catch {
        // Lock file disappeared between check and read — retry
        continue;
      }

      // Lock holder is alive — wait with jitter and retry
      const jitter = Math.floor(Math.random() * LOCK_POLL_MS);
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS + jitter));
    }
  }

  // Timeout — force acquire (likely stale lock)
  console.warn(`[lockfile] Force-acquiring stale lock: ${lock}`);
  await writeFile(lock, String(process.pid));
}

/** Release a lock acquired via {@link acquireLock}. Missing file is a no-op. */
export async function releaseLock(path: string): Promise<void> {
  try {
    await unlink(lockPath(path));
  } catch {
    // Already released
  }
}
