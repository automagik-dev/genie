import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { loadSessions } from '../session-store.js';
export class SessionService {
    constructor(options) {
        this.paths = options.paths;
        this.loadConfig = options.loadConfig;
        this.defaults = options.defaults;
        this.onWarning = options.onWarning;
    }
    load(callbacks = {}) {
        const mergedCallbacks = {
            onWarning: callbacks.onWarning || this.onWarning
        };
        return loadSessions(this.paths, this.loadConfig, this.defaults, mergedCallbacks);
    }
    async save(store) {
        if (!this.paths.sessionsFile) {
            return { store };
        }
        const sessionFile = this.paths.sessionsFile;
        await this.ensureFile(sessionFile);
        // Native file locking with retry logic
        return await this.retryWithLock(async () => {
            // TWIN FIX #3: Reload fresh disk state immediately before merge to prevent rollback
            const diskStore = loadSessions(this.paths, this.loadConfig, this.defaults, {
                onWarning: this.onWarning
            });
            const merged = this.mergeStores(diskStore, store);
            // TWIN FIX #1: Atomic write via temp file + rename to prevent partial reads
            const tempFile = sessionFile + '.tmp';
            await fsPromises.writeFile(tempFile, JSON.stringify(merged, null, 2), 'utf8');
            // Ensure data is flushed to disk before rename
            const fd = await fsPromises.open(tempFile, 'r+');
            await fd.sync();
            await fd.close();
            // Atomic rename - readers will only see complete JSON
            await fsPromises.rename(tempFile, sessionFile);
            return { store: merged };
        });
    }
    async withLock(fn) {
        const lockPath = this.paths.sessionsFile + '.lock';
        let handle = null;
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
        }
        finally {
            if (handle) {
                await handle.close();
                await fsPromises.unlink(lockPath).catch(() => { });
            }
        }
    }
    async reclaimStaleLock(lockPath) {
        try {
            const stat = await fsPromises.stat(lockPath);
            const age = Date.now() - stat.mtimeMs;
            const STALE_THRESHOLD = 30000; // 30 seconds
            if (age > STALE_THRESHOLD) {
                // Try to read lock info to identify stale process
                let lockInfo = {};
                try {
                    const content = await fsPromises.readFile(lockPath, 'utf8');
                    lockInfo = JSON.parse(content);
                }
                catch {
                    // Lock file exists but unreadable - likely corrupted, reclaim it
                }
                // Check if process is still running (won't throw on invalid PID)
                if (lockInfo.pid) {
                    try {
                        process.kill(lockInfo.pid, 0); // Signal 0 = check if process exists
                        // Process exists, don't reclaim (false positive on PID reuse)
                        return;
                    }
                    catch {
                        // Process doesn't exist, safe to reclaim
                    }
                }
                // Stale lock detected - reclaim it
                await fsPromises.unlink(lockPath);
                if (this.onWarning) {
                    this.onWarning(`Reclaimed stale lock file (age: ${Math.round(age / 1000)}s, pid: ${lockInfo.pid || 'unknown'})`);
                }
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                // Ignore ENOENT (lock doesn't exist yet), throw other errors
                throw err;
            }
        }
    }
    async retryWithLock(fn, maxRetries = 10) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await this.withLock(fn);
            }
            catch (err) {
                if (err.code === 'EEXIST' && i < maxRetries - 1) {
                    // Lock file exists, wait and retry
                    await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 100));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('SessionService: Lock acquisition timeout after ' + maxRetries + ' retries');
    }
    async ensureFile(target) {
        const dir = path.dirname(target);
        await fsPromises.mkdir(dir, { recursive: true });
        if (!fs.existsSync(target)) {
            const initial = { version: 2, sessions: {} };
            await fsPromises.writeFile(target, JSON.stringify(initial, null, 2), 'utf8');
        }
    }
    mergeStores(base, incoming) {
        const merged = {
            version: incoming.version ?? base.version ?? 2,
            sessions: { ...base.sessions }
        };
        Object.entries(incoming.sessions || {}).forEach(([sessionId, entry]) => {
            merged.sessions[sessionId] = { ...(base.sessions?.[sessionId] || {}), ...entry };
        });
        return merged;
    }
}
