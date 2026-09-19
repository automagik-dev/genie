/**
 * sqlite-open — the shared open primitive's busy classification, plus the
 * poisoned-WAL-index recovery helper it deliberately does NOT call.
 *
 * `openSqlite` is the fleet hot path (`genie task`, `task sync`, the git-hook
 * sync) and stays churn-free; the recovery is opt-in
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
  ForeignDbError,
  PendingMigrationError,
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

// ---------------------------------------------------------------------------
// The forward-only migration ladder (`OpenSqliteOptions.migrations`).
//
// Driven here against a synthetic schema rather than genie.db, so the contract
// is pinned independently of what the per-repo database happens to declare:
// plan-before-apply, per-step transactional stamping, the decline switch, and
// the two refusals.
// ---------------------------------------------------------------------------
describe('openSqlite migration ladder', () => {
  const ensureSchema = (db: Database): void => {
    db.exec('CREATE TABLE IF NOT EXISTS kept (id INTEGER PRIMARY KEY)');
  };

  /** A database stamped `version` carrying `kept` plus every name in `extra`. */
  function seed(name: string, version: number, extra: string[] = []): string {
    const path = join(base, name);
    const db = new Database(path);
    db.exec('CREATE TABLE kept (id INTEGER PRIMARY KEY)');
    db.query('INSERT INTO kept (id) VALUES (1)').run();
    for (const table of extra) db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY)`);
    db.exec(`PRAGMA user_version = ${version}`);
    db.close();
    return path;
  }

  const userVersion = (path: string): number => {
    const db = new Database(path, { readonly: true });
    try {
      return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
    } finally {
      db.close();
    }
  };

  const tables = (path: string): string[] => {
    const db = new Database(path, { readonly: true });
    try {
      return (
        db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  };

  test('a complete chain climbs every rung and lands on schemaVersion', () => {
    const path = seed('chain.db', 1, ['gone_at_2', 'gone_at_3']);
    const seen: number[] = [];
    const db = openSqlite({
      path,
      schemaVersion: 3,
      ensureSchema,
      migrations: [
        {
          from: 2,
          to: 3,
          apply: (handle) => {
            seen.push(3);
            handle.exec('DROP TABLE gone_at_3');
          },
        },
        {
          from: 1,
          to: 2,
          apply: (handle) => {
            seen.push(2);
            handle.exec('DROP TABLE gone_at_2');
          },
        },
      ],
    });
    db.close();
    // Declared out of order, applied in ascending `from` order.
    expect(seen).toEqual([2, 3]);
    expect(userVersion(path)).toBe(3);
    expect(tables(path)).toEqual(['kept']);
  });

  test('an incomplete chain refuses BEFORE applying any step', () => {
    // The 1 -> 2 rung exists and 2 -> 3 does not. A ladder that applied as it
    // walked would drop `gone_at_2` and leave the file stamped 2 under a build
    // that expects 3 — unrecoverable. Planning first means nothing runs.
    const path = seed('gap.db', 1, ['gone_at_2']);
    let applied = 0;
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 3,
        ensureSchema,
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              applied++;
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      }),
    ).toThrow(ForeignDbError);
    expect(applied).toBe(0);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('a database with no ladder at all still refuses, untouched', () => {
    const path = seed('noladder.db', 1);
    expect(() => openSqlite({ path, schemaVersion: 2, ensureSchema })).toThrow(ForeignDbError);
    expect(userVersion(path)).toBe(1);
  });

  test('each step stamps its own `to` inside its own transaction', () => {
    // Observed from INSIDE the next step: if the stamp were deferred to the end
    // of the chain this reads 1, and a process killed here would leave migrated
    // tables under a stale version.
    const path = seed('stamp.db', 1, ['gone_at_2']);
    let seenFromStep3 = -1;
    const db = openSqlite({
      path,
      schemaVersion: 3,
      ensureSchema,
      migrations: [
        { from: 1, to: 2, apply: (handle) => handle.exec('DROP TABLE gone_at_2') },
        {
          from: 2,
          to: 3,
          apply: (handle) => {
            seenFromStep3 = (handle.query('PRAGMA user_version').get() as { user_version: number }).user_version;
          },
        },
      ],
    });
    db.close();
    expect(seenFromStep3).toBe(2);
    expect(userVersion(path)).toBe(3);
  });

  test('a step that throws rolls back its DDL AND its stamp', () => {
    // The crash-between-DDL-and-stamp window: with the stamp inside the same
    // transaction there is no such window, so the file is exactly as it was.
    const path = seed('rollback.db', 1, ['gone_at_2']);
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              handle.exec('DROP TABLE gone_at_2');
              throw new Error('killed mid-step');
            },
          },
        ],
      }),
    ).toThrow('killed mid-step');
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('two concurrent openers converge: one migration, no corruption, both current', async () => {
    const path = seed('concurrent.db', 1, ['gone_at_2']);
    const worker = join(base, 'migrate-worker.ts');
    writeFileSync(
      worker,
      `
import { openSqlite } from ${JSON.stringify(join(import.meta.dir, 'sqlite-open.ts'))};
const db = openSqlite({
  path: process.argv[2],
  schemaVersion: 2,
  ensureSchema: (d) => d.exec('CREATE TABLE IF NOT EXISTS kept (id INTEGER PRIMARY KEY)'),
  migrations: [{ from: 1, to: 2, apply: (d) => d.exec('DROP TABLE IF EXISTS gone_at_2') }],
});
process.stdout.write(String((db.query('PRAGMA user_version').get()).user_version));
db.close();
`,
    );
    const runs = await Promise.allSettled(
      [0, 1].map(async () => {
        const proc = Bun.spawn(['bun', 'run', worker, path], { stdout: 'pipe', stderr: 'pipe' });
        return {
          out: await new Response(proc.stdout).text(),
          err: await new Response(proc.stderr).text(),
          code: await proc.exited,
        };
      }),
    );
    for (const run of runs) {
      expect(run.status).toBe('fulfilled');
      if (run.status !== 'fulfilled') continue;
      expect(run.value.code, run.value.err).toBe(0);
      expect(run.value.out).toBe('2');
    }
    expect(userVersion(path)).toBe(2);
    expect(tables(path)).toEqual(['kept']);
  }, 30_000);

  test('`migrate: false` declines with PendingMigrationError and changes nothing', () => {
    const path = seed('decline.db', 1, ['gone_at_2']);
    let applied = 0;
    let backups = 0;
    try {
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        migrate: false,
        beforeMigrate: () => {
          backups++;
        },
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              applied++;
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      });
      throw new Error('expected PendingMigrationError');
    } catch (error) {
      expect(error).toBeInstanceOf(PendingMigrationError);
      expect((error as PendingMigrationError).foundVersion).toBe(1);
      expect((error as PendingMigrationError).expectedVersion).toBe(2);
      expect((error as Error).message).toContain('after taking a backup');
    }
    // Declined means declined: no step, no backup hook, no version change.
    expect(applied).toBe(0);
    expect(backups).toBe(0);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('`migrate: false` on a database the ladder could NOT bridge still throws ForeignDbError', () => {
    // A foreign file is not a pending migration, whoever is asking.
    const path = seed('decline-foreign.db', 5);
    expect(() => openSqlite({ path, schemaVersion: 2, ensureSchema, migrate: false })).toThrow(ForeignDbError);
  });

  test('`beforeMigrate` runs once, before any step, and a throw there aborts untouched', () => {
    const path = seed('hook.db', 1, ['gone_at_2']);
    const order: string[] = [];
    expect(() =>
      openSqlite({
        path,
        schemaVersion: 2,
        ensureSchema,
        beforeMigrate: () => {
          order.push('backup');
          throw new Error('backup target is read-only');
        },
        migrations: [
          {
            from: 1,
            to: 2,
            apply: (handle) => {
              order.push('step');
              handle.exec('DROP TABLE gone_at_2');
            },
          },
        ],
      }),
    ).toThrow('backup target is read-only');
    expect(order).toEqual(['backup']);
    expect(userVersion(path)).toBe(1);
    expect(tables(path)).toEqual(['gone_at_2', 'kept']);
  });

  test('the newer-build refusal carries the exact documented sentence', () => {
    // The docs quote this string verbatim; an operator greps for it. A v2
    // database opened by a build that expects v1 is the shape that will be hit
    // in the field, because a v6 binary migrates and a 5.x one then meets it.
    const path = seed('newer-exact.db', 2);
    try {
      openSqlite({ path, schemaVersion: 1, ensureSchema });
      throw new Error('expected ForeignDbError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignDbError);
      expect((error as Error).message).toContain(
        'written by a newer genie (schema v2); run `genie update` in this checkout',
      );
    }
    expect(userVersion(path)).toBe(2);
  });

  test('a database from a NEWER build names the remedy, not "unrecognized"', () => {
    const path = seed('newer.db', 9);
    try {
      openSqlite({ path, schemaVersion: 2, ensureSchema });
      throw new Error('expected ForeignDbError');
    } catch (error) {
      expect(error).toBeInstanceOf(ForeignDbError);
      const message = (error as Error).message;
      expect(message).toContain('written by a newer genie (schema v9)');
      expect(message).toContain('`genie update`');
      expect(message).not.toContain('unrecognized schema version');
    }
  });
});
