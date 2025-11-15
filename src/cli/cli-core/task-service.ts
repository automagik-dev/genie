import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import {
  loadTasks,
  TaskStore,
  TaskPathsConfig,
  TaskLoadConfig,
  TaskDefaults
} from '../task-store';

export interface TaskServiceOptions {
  paths: TaskPathsConfig;
  loadConfig?: TaskLoadConfig;
  defaults?: TaskDefaults;
  onWarning?: (message: string) => void;
}

interface SaveResult {
  store: TaskStore;
}

export class TaskService {
  private readonly paths: TaskPathsConfig;
  private readonly loadConfig?: TaskLoadConfig;
  private readonly defaults?: TaskDefaults;
  private readonly onWarning?: (message: string) => void;

  constructor(options: TaskServiceOptions) {
    this.paths = options.paths;
    this.loadConfig = options.loadConfig;
    this.defaults = options.defaults;
    this.onWarning = options.onWarning;
  }

  load(callbacks: { onWarning?: (message: string) => void } = {}): TaskStore {
    const mergedCallbacks = {
      onWarning: callbacks.onWarning || this.onWarning
    };
    return loadTasks(this.paths, this.loadConfig, this.defaults, mergedCallbacks);
  }

  async save(store: TaskStore): Promise<SaveResult> {
    const targetFile = this.paths.tasksFile || this.paths.sessionsFile || this.paths.legacySessionsFile;
    if (!targetFile) {
      return { store };
    }

    await this.ensureFile(targetFile);

    // Native file locking with retry logic
    return await this.retryWithLock(async () => {
      // TWIN FIX #3: Reload fresh disk state immediately before merge to prevent rollback
      const diskStore = loadTasks(this.paths, this.loadConfig, this.defaults, {
        onWarning: this.onWarning
      });
      const merged = this.mergeStores(diskStore, store);

      // TWIN FIX #1: Atomic write via temp file + rename to prevent partial reads
      const tempFile = targetFile + '.tmp';
      await fsPromises.writeFile(tempFile, JSON.stringify(merged, null, 2), 'utf8');

      // Ensure data is flushed to disk before rename
      const fd = await fsPromises.open(tempFile, 'r+');
      await fd.sync();
      await fd.close();

      // Atomic rename - readers will only see complete JSON
      await fsPromises.rename(tempFile, targetFile);

      return { store: merged };
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const baseFile = this.paths.tasksFile || this.paths.sessionsFile || this.paths.legacySessionsFile;
    if (!baseFile) {
      throw new Error('TaskService: No tasks file configured for locking');
    }
    const lockPath = baseFile + '.lock';
    let handle: fsPromises.FileHandle | null = null;

    try {
      // TWIN FIX #2: Detect and reclaim stale locks from crashed processes
      await this.reclaimStaleLock(lockPath);

      // Exclusive lock - will retry if locked (wx = write exclusive, fails if exists)
      handle = await fsPromises.open(lockPath, 'wx');

      // Write PID/timestamp for stale lock detection
      const lockInfo = JSON.stringify({
        pid: process.pid,
        timestamp: Date.now(),
        host: require('os').hostname()
      });
      await fsPromises.writeFile(lockPath, lockInfo, 'utf8');

      const result = await fn();
      return result;
    } finally {
      if (handle) {
        await handle.close();
        await fsPromises.unlink(lockPath).catch(() => {});
      }
    }
  }

  private async reclaimStaleLock(lockPath: string): Promise<void> {
    try {
      const stat = await fsPromises.stat(lockPath);
      const age = Date.now() - stat.mtimeMs;
      const STALE_THRESHOLD = 30000; // 30 seconds

      if (age > STALE_THRESHOLD) {
        // Try to read lock info to identify stale process
        let lockInfo: any = {};
        try {
          const content = await fsPromises.readFile(lockPath, 'utf8');
          lockInfo = JSON.parse(content);
        } catch {
          // Lock file exists but unreadable - likely corrupted, reclaim it
        }

        // Check if process is still running (won't throw on invalid PID)
        if (lockInfo.pid) {
          try {
            process.kill(lockInfo.pid, 0); // Signal 0 = check if process exists
            // Process exists, don't reclaim (false positive on PID reuse)
            return;
          } catch {
            // Process doesn't exist, safe to reclaim
          }
        }

        // Stale lock detected - reclaim it
        await fsPromises.unlink(lockPath);
        if (this.onWarning) {
          this.onWarning(`Reclaimed stale lock file (age: ${Math.round(age/1000)}s, pid: ${lockInfo.pid || 'unknown'})`);
        }
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        // Ignore ENOENT (lock doesn't exist yet), throw other errors
        throw err;
      }
    }
  }

  private async retryWithLock<T>(fn: () => Promise<T>, maxRetries = 10): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.withLock(fn);
      } catch (err: any) {
        if (err.code === 'EEXIST' && i < maxRetries - 1) {
          // Lock file exists, wait and retry
          await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
          continue;
        }
        throw err;
      }
    }
    throw new Error('TaskService: Lock acquisition timeout after ' + maxRetries + ' retries');
  }

  private async ensureFile(target: string): Promise<void> {
    const dir = path.dirname(target);
    await fsPromises.mkdir(dir, { recursive: true });
    if (!fs.existsSync(target)) {
      const initial: TaskStore = { version: 4, sessions: {} };
      await fsPromises.writeFile(target, JSON.stringify(initial, null, 2), 'utf8');
    }
  }

  private mergeStores(base: TaskStore, incoming: TaskStore): TaskStore {
    const merged: TaskStore = {
      version: incoming.version ?? base.version ?? 2,
      sessions: { ...base.sessions }
    };

    Object.entries(incoming.sessions || {}).forEach(([taskId, entry]) => {
      merged.sessions[taskId] = { ...(base.sessions?.[taskId] || {}), ...entry };
    });

    return merged;
  }
}
