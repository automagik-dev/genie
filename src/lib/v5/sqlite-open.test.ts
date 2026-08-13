/**
 * sqlite-open — the shared open primitive's busy classification and its
 * poisoned-WAL-index recovery.
 *
 * The recovery lives here (not in the MCP write path) so EVERY writer converges
 * on it: `genie task`, `task sync`, the git-hook sync, `genie mcp`, and the
 * global omni database. These tests drive it two ways: the predicates and the
 * retry contract directly, and the real end-to-end poison through `openDb` in
 * genie-db.test.ts / mcp-tools.test.ts.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BusyDbError,
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

  test('a poisoned index that makes the OPEN throw is rebuilt and the open retried exactly once', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);

    let attempts = 0;
    let retrySawCleanSidecars = false;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      if (attempts === 1) throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
      retrySawCleanSidecars = !hasStaleReadonlyWalIndex(path) && walSidecarsEmpty(path);
      return new Database(path);
    });

    expect(attempts).toBe(2);
    expect(retrySawCleanSidecars).toBe(true);
    db.close();
  });

  test('a poisoned index that survives a SUCCESSFUL open is caught by the write probe, rebuilt, and retried', () => {
    const path = seeded(join(base, 'db.sqlite'));
    poison(path);

    let attempts = 0;
    const db = openWithWalIndexRecovery(path, () => {
      attempts += 1;
      const handle = new Database(path);
      if (attempts === 1) {
        // Stand in for the platform poison: the open succeeds, the wal-index
        // write path fails. The probe is the only thing that can see this.
        handle.query = () => {
          throw sqliteError('disk I/O error', 'SQLITE_IOERR_WRITE', 778);
        };
      }
      return handle;
    });

    expect(attempts).toBe(2);
    expect(hasStaleReadonlyWalIndex(path)).toBe(false);
    db.close();
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
