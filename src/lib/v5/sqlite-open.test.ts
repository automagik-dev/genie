/**
 * sqlite-open — the shared open primitive's busy classification, plus the
 * poisoned-WAL-index recovery helper it deliberately does NOT call.
 *
 * `openSqlite` is the fleet hot path (`genie task`, `task sync`, the git-hook
 * sync, the global omni database) and stays churn-free; the recovery is opt-in
 * and was wired only into the retired MCP write open, the path that created the
 * poison. No shipped caller remains, so these tests are the whole contract:
 * they drive the helper directly — predicates, retry contract, and the
 * live-peer skips that keep it from touching a contended database.
 * genie-db.test.ts pins that the shared path does not heal it.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BusyDbError,
  RECOVERY_LOCK_WAIT_MS,
  WalIndexPoisonError,
  hasStaleReadonlyWalIndex,
  isBusyError,
  openSqlite,
  openWithWalIndexRecovery,
  walSidecarsEmpty,
} from './sqlite-open.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-sqlite-open-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/**
 * The exact read-only WAL-index header macOS/bun leaves in `-shm` when a
 * DEGRADED readonly connection closes while the db file is write-protected:
 * iVersion + isInit still set, iChange (offset 8) and nPage (offset 20) zeroed.
 */
function poisonShmHeader(): Buffer {
  const header = Buffer.alloc(32768);
  header.writeUInt32LE(0x002de218, 0); // iVersion (matches the observed value)
  header.writeUInt32LE(1, 12); // isInit
  return header;
}

/** A live header: same shape, but iChange and nPage nonzero. */
function liveShmHeader(): Buffer {
  const header = poisonShmHeader();
  header.writeUInt32LE(2, 8); // iChange
  header.writeUInt32LE(2, 20); // nPage
  return header;
}

/**
 * bun's SQLiteError cannot be constructed outside bun:sqlite, so the raw failure
 * shapes are simulated by the two fields the classifier reads: `code` and the
 * numeric `errno` whose low byte carries the primary result code.
 */
function sqliteError(message: string, code: string, errno: number): Error {
  return Object.assign(new Error(message), { code, errno });
}

/** A minimal opts bundle for the shared primitive. */
function openOpts(path: string) {
  return {
    path,
    schemaVersion: 1,
    ensureSchema: (db: Database) => db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)'),
  };
}

/** A real, schema-current database at `path`, fully checkpointed and closed. */
function seeded(path: string): string {
  const db = openSqlite(openOpts(path));
  db.exec('INSERT INTO t (id) VALUES (1)');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return path;
}

describe('isBusyError', () => {
  test('classifies the whole SQLITE_BUSY/SQLITE_LOCKED family, including extended codes', () => {
    // A raw `db.query(...)` throw carries the EXTENDED code; only the primary
    // code in the low byte is stable, so the classifier must read that.
    const recovery = Object.assign(new Error('database is busy'), {
      code: 'SQLITE_BUSY_RECOVERY',
      errno: 261, // SQLITE_BUSY | (1 << 8)
    });
    expect(isBusyError(recovery)).toBe(true);
    expect(isBusyError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errno: 5 }))).toBe(true);
    expect(isBusyError(Object.assign(new Error('locked'), { code: 'SQLITE_LOCKED_SHAREDCACHE', errno: 262 }))).toBe(
      true,
    );
    expect(isBusyError(new BusyDbError('/tmp/x.db', new Error('database is locked')))).toBe(true);
    // SQLITE_PROTOCOL (15) is a lost WAL-index lock race under heavy contention,
    // not corruption — it must retry, never surface as "malformed".
    expect(isBusyError(Object.assign(new Error('locking protocol'), { code: 'SQLITE_PROTOCOL', errno: 15 }))).toBe(
      true,
    );
    // The poison's own failure shape must NOT be classified busy — that is what
    // routes it into recovery instead of the busy carve-out.
    expect(isBusyError(Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR_WRITE', errno: 778 }))).toBe(
      false,
    );
    expect(isBusyError(Object.assign(new Error('readonly'), { code: 'SQLITE_READONLY', errno: 8 }))).toBe(false);
    expect(isBusyError(new Error('some other failure'))).toBe(false);
  });
});

describe('poisoned WAL-index predicates', () => {
  test('hasStaleReadonlyWalIndex: true only for the zeroed read-only header', () => {
    const path = seeded(join(base, 'db.sqlite'));
    const shmPath = `${path}-shm`;

    rmSync(shmPath, { force: true }); // no -shm at all: nothing stale to recover
    expect(hasStaleReadonlyWalIndex(path)).toBe(false);

    writeFileSync(shmPath, poisonShmHeader());
    expect(hasStaleReadonlyWalIndex(path)).toBe(true);

    writeFileSync(shmPath, liveShmHeader()); // both fields nonzero: never stale
    expect(hasStaleReadonlyWalIndex(path)).toBe(false);

    writeFileSync(shmPath, Buffer.alloc(16)); // too short to carry both fields
    expect(hasStaleReadonlyWalIndex(path)).toBe(false);
  });

  test('walSidecarsEmpty: true when the -wal is absent (ENOENT) or empty, false when it holds frames', () => {
    const path = seeded(join(base, 'db.sqlite'));
    const walPath = `${path}-wal`;

    rmSync(walPath, { force: true }); // the state a fully-checkpointed db leaves
    expect(walSidecarsEmpty(path)).toBe(true);

    writeFileSync(walPath, '');
    expect(walSidecarsEmpty(path)).toBe(true);

    writeFileSync(walPath, 'not-a-wal'); // un-checkpointed frames: removal would lose data
    expect(walSidecarsEmpty(path)).toBe(false);
  });
});

describe('openWithWalIndexRecovery', () => {
  /** A poisoned `-shm` plus an empty `-wal`: the recoverable state. */
  function poison(path: string): void {
    writeFileSync(`${path}-shm`, poisonShmHeader());
    writeFileSync(`${path}-wal`, '');
  }

  /**
   * The retried open, as the real `applyPragmas` performs it: re-entering WAL is
   * what reinitializes the wal-index in place and clears the poisoned header.
   * The module itself never unlinks a sidecar (see rebuildSidecarsExclusively).
   */
  function reopenLikeTheRealOpen(path: string): Database {
    const handle = new Database(path);
    handle.exec('PRAGMA busy_timeout = 5000');
    handle.exec('PRAGMA journal_mode = WAL');
    return handle;
  }

  /** The journal mode a fresh handle reports, without disturbing it. */
  function journalMode(path: string): string {
    const probe = new Database(path);
    try {
      const row = probe.query('PRAGMA journal_mode').get() as { journal_mode?: string } | null;
      return String(row?.journal_mode ?? '').toLowerCase();
    } finally {
      probe.close();
    }
  }

  test('a poisoned index that makes the OPEN throw is healed by SQLite and the open retried exactly once', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);

    let attempts = 0;
    let retrySawCheckpointedWal = false;
    let retrySawRollbackMode = false;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      if (attempts === 1) throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
      // SQLite's OWN `journal_mode = DELETE` conversion checkpointed the frames
      // and unlinked the `-wal` under its exclusive locks. Nothing in this
      // module removed it — and nothing removes anything after that handle
      // closes, which is what used to SIGBUS a peer that opened in the gap.
      retrySawCheckpointedWal = walSidecarsEmpty(path) && !existsSync(`${path}-wal`);
      retrySawRollbackMode = journalMode(path) === 'delete';
      return reopenLikeTheRealOpen(path);
    });

    expect(attempts).toBe(2);
    expect(retrySawCheckpointedWal).toBe(true);
    expect(retrySawRollbackMode).toBe(true);
    db.exec('INSERT INTO t (id) VALUES (3)'); // the healed database takes writes
    db.close();
    expect(hasStaleReadonlyWalIndex(path)).toBe(false); // the index was reinitialized
  });

  test('a poisoned index that survives a SUCCESSFUL open is caught by the write probe, rebuilt, and retried', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);

    let attempts = 0;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      if (attempts === 1) {
        // Stand in for the platform poison: the open succeeds, the wal-index
        // write path fails. The probe is the only thing that can see this.
        const handle = new Database(path);
        handle.query = () => {
          throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
        };
        return handle;
      }
      return reopenLikeTheRealOpen(path);
    });

    expect(attempts).toBe(2);
    db.exec('INSERT INTO t (id) VALUES (3)'); // the healed database takes writes
    db.close();
    expect(hasStaleReadonlyWalIndex(path)).toBe(false);
  });

  test('a BUSY probe is served, never recovered: the sidecars belong to a live writer', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);
    const shmBefore = statSync(`${path}-shm`).size;

    let attempts = 0;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      const handle = new Database(path);
      handle.query = () => {
        throw sqliteError('database is busy', 'SQLITE_BUSY_RECOVERY', 261);
      };
      return handle;
    });

    expect(attempts).toBe(1); // no recovery retry
    expect(statSync(`${path}-shm`).size).toBe(shmBefore); // sidecars untouched
    db.close();
  });

  test('a BUSY open failure propagates untouched — never sidecar recovery', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);

    let attempts = 0;
    expect(() =>
      openWithWalIndexRecovery(path, () => {
        attempts += 1;
        throw new BusyDbError(path, new Error('write lock held by another process'));
      }),
    ).toThrow(BusyDbError);
    expect(attempts).toBe(1);
    expect(hasStaleReadonlyWalIndex(path)).toBe(true); // recovery never ran
  });

  test('a poisoned index with un-checkpointed frames fails typed instead of discarding them', () => {
    const path = seeded(join(base, 'db.sqlite'));
    writeFileSync(`${path}-shm`, poisonShmHeader());
    writeFileSync(`${path}-wal`, 'frames-that-must-not-be-lost');

    expect(() =>
      openWithWalIndexRecovery(path, () => {
        const handle = new Database(path);
        handle.query = () => {
          throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
        };
        return handle;
      }),
    ).toThrow(WalIndexPoisonError);
    // Both sidecars survive: the frames are still recoverable by SQLite itself.
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    expect(hasStaleReadonlyWalIndex(path)).toBe(true);
  });

  test('a LIVE PEER blocks the rebuild: the original error propagates and both sidecars survive', () => {
    // The regression this locks: the header predicate and an empty `-wal` are
    // BOTH true for a healthy, fully-current database whose live peers simply
    // have not written yet. Unlinking the sidecars there SIGBUSes every peer
    // holding `-shm` mmapped and cascades SQLITE_PROTOCOL to the rest. Only
    // SQLite can prove exclusivity, so a live peer must skip the heal entirely.
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);
    const peer = new Database(path);
    peer.query('SELECT count(*) AS n FROM t').get(); // maps `-shm`

    let attempts = 0;
    try {
      expect(() =>
        openWithWalIndexRecovery(path, () => {
          attempts += 1;
          throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
        }),
      ).toThrow('disk I/O error'); // the ORIGINAL error, not a heal-and-retry
      expect(attempts).toBe(1);
      expect(existsSync(`${path}-shm`)).toBe(true);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(hasStaleReadonlyWalIndex(path)).toBe(true); // sidecars untouched
    } finally {
      peer.close();
    }
  });

  test('a LIVE PEER blocks the probe-path rebuild too: typed poison error, sidecars intact', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);
    const peer = new Database(path);
    peer.query('SELECT count(*) AS n FROM t').get(); // maps `-shm`

    try {
      expect(() =>
        openWithWalIndexRecovery(path, () => {
          const handle = new Database(path);
          handle.query = () => {
            throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
          };
          return handle;
        }),
      ).toThrow(WalIndexPoisonError);
      expect(existsSync(`${path}-shm`)).toBe(true);
      expect(existsSync(`${path}-wal`)).toBe(true);
      expect(hasStaleReadonlyWalIndex(path)).toBe(true);
    } finally {
      peer.close();
    }
  });

  test('a healthy open is returned as-is (the virgin header self-heals through the probe)', () => {
    const path = seeded(join(base, 'db.sqlite'));
    let attempts = 0;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      return new Database(path);
    });
    expect(attempts).toBe(1);
    db.exec('INSERT INTO t (id) VALUES (2)'); // writable
    db.close();
  });

  /**
   * The cross-process mutex that makes the helper's single-owner assumption
   * true. Two MCP servers on one database used to enter the probe/rebuild
   * concurrently and race on the wal-index mmap, which the kernel resolves by
   * killing a process outright on Linux.
   */
  describe('recovery lock', () => {
    const lockOf = (path: string) => `${path}-recovery-lock`;

    test('the lock is taken for the open and released after it, on success and on throw', () => {
      const path = seeded(join(base, 'db.sqlite'));
      let heldDuringOpen = false;
      const db = openWithWalIndexRecovery(path, () => {
        heldDuringOpen = existsSync(lockOf(path));
        return new Database(path);
      });
      expect(heldDuringOpen).toBe(true); // held before any handle exists
      expect(existsSync(lockOf(path))).toBe(false);
      db.close();

      expect(() =>
        openWithWalIndexRecovery(path, () => {
          throw new Error('unrelated failure');
        }),
      ).toThrow('unrelated failure');
      expect(existsSync(lockOf(path))).toBe(false); // released in `finally`, not only on success
    });

    test('a lock whose holder died is reclaimed at once — a crash mid-recovery bricks nothing', async () => {
      const path = seeded(join(base, 'db.sqlite'));
      const child = Bun.spawn(['true'], { stdout: 'ignore', stderr: 'ignore' });
      const holder = child.pid;
      await child.exited; // reaped: `process.kill(holder, 0)` now raises ESRCH
      writeFileSync(lockOf(path), String(holder));

      const started = Date.now();
      const db = openWithWalIndexRecovery(path, () => new Database(path));
      // Reclaimed on PID evidence, not by waiting out the 30s age fallback.
      expect(Date.now() - started).toBeLessThan(RECOVERY_LOCK_WAIT_MS);
      db.exec('INSERT INTO t (id) VALUES (4)'); // and the open really happened
      db.close();
      expect(existsSync(lockOf(path))).toBe(false);
    });

    test('a lock whose PID is unreadable is reclaimed once it ages out', () => {
      const path = seeded(join(base, 'db.sqlite'));
      writeFileSync(lockOf(path), 'not-a-pid'); // no liveness evidence to go on
      const aged = new Date(Date.now() - 10 * RECOVERY_LOCK_WAIT_MS);
      utimesSync(lockOf(path), aged, aged);

      const db = openWithWalIndexRecovery(path, () => new Database(path));
      db.close();
      expect(existsSync(lockOf(path))).toBe(false);
    });

    test('a lock held by a LIVE holder past the wait budget fails typed-busy, never as corruption', () => {
      const path = seeded(join(base, 'db.sqlite'));
      writeFileSync(lockOf(path), String(process.pid)); // this process is alive by definition

      let attempts = 0;
      expect(() =>
        openWithWalIndexRecovery(path, () => {
          attempts += 1;
          return new Database(path);
        }),
      ).toThrow(BusyDbError); // transient contention — the caller retries, never degrades
      expect(attempts).toBe(0); // no handle was ever created outside the mutex
      rmSync(lockOf(path), { force: true });
    }, 15_000); // deliberately waits out the full RECOVERY_LOCK_WAIT_MS budget
  });

  test('a non-poison open failure propagates unchanged (no sidecars are touched)', () => {
    const path = seeded(join(base, 'db.sqlite'));
    rmSync(`${path}-shm`, { force: true });
    let attempts = 0;
    expect(() =>
      openWithWalIndexRecovery(path, () => {
        attempts += 1;
        throw new Error('unrelated failure');
      }),
    ).toThrow('unrelated failure');
    expect(attempts).toBe(1);
  });
});
