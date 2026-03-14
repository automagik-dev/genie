/**
 * File Lock — Shared file-locking utility for concurrent access protection.
 *
 * Uses exclusive file creation (O_EXCL) as a cross-process mutex.
 * Stale locks (older than LOCK_STALE_MS) are auto-cleaned.
 *
 * Used by: agent-directory, wish-state, agent-registry, mailbox, team-chat.
 */

import { open, stat, unlink } from 'node:fs/promises';

// ============================================================================
// Constants
// ============================================================================

export const LOCK_TIMEOUT_MS = 5000;
export const LOCK_RETRY_MS = 50;
export const LOCK_STALE_MS = 10000;

// ============================================================================
// Internal helpers
// ============================================================================

async function tryCleanStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
      try {
        await unlink(lockPath);
      } catch {
        /* race with other cleanup */
      }
      return true;
    }
  } catch {
    return true; // lock gone, retry
  }
  return false;
}

async function tryCreateLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return async () => {
      try {
        await unlink(lockPath);
      } catch {
        /* already removed */
      }
    };
  } catch (err) {
    const errCode = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (errCode !== 'EEXIST') throw err;
    return null;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Acquire an exclusive file lock at `filePath.lock`.
 *
 * Returns a release function that MUST be called when done.
 * Throws if the lock cannot be acquired within LOCK_TIMEOUT_MS.
 *
 * @param filePath — The file to lock (lock file will be `${filePath}.lock`)
 */
export async function acquireLock(filePath: string): Promise<() => Promise<void>> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (true) {
    const release = await tryCreateLock(lockPath);
    if (release) return release;

    const cleaned = await tryCleanStaleLock(lockPath);
    if (cleaned) continue;

    if (Date.now() > deadline) {
      try {
        await unlink(lockPath);
      } catch {
        throw new Error(`Lock timeout: could not remove stale lock at ${lockPath}`);
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

/**
 * Execute a function while holding a file lock.
 *
 * Acquires the lock, runs `fn`, then releases — even if `fn` throws.
 *
 * @public - used via dynamic namespace import in mailbox.ts and team-chat.ts
 * @param lockPath — The file to lock (lock file will be `${lockPath}.lock`)
 * @param fn — Function to execute under the lock
 */
export async function withLock<T>(lockPath: string, fn: () => T | Promise<T>): Promise<T> {
  const release = await acquireLock(lockPath);
  try {
    return await fn();
  } finally {
    await release();
  }
}
