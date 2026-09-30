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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BusyDbError, ForeignDbError, PendingMigrationError, isBusyError, openSqlite } from './sqlite-open.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'genie-sqlite-open-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

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
          return undefined;
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
