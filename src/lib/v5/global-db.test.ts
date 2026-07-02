import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ForeignDbError,
  GLOBAL_SCHEMA_VERSION,
  MalformedDbError,
  openGlobalDb,
  resolveGlobalDbPath,
} from './global-db.js';

let dir: string;
const originalGenieHome = process.env.GENIE_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-global-'));
  // Point GENIE_HOME at a tmpdir so the real ~/.genie is never touched.
  process.env.GENIE_HOME = dir;
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  if (originalGenieHome === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = originalGenieHome;
  rmSync(dir, { recursive: true, force: true });
});

function userVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}

describe('resolveGlobalDbPath', () => {
  test('honors GENIE_HOME and never reuses per-repo path constants', () => {
    expect(resolveGlobalDbPath()).toBe(join(dir, 'genie.db'));
  });
});

describe('openGlobalDb schema init', () => {
  test('creates the file, stamps user_version, and is idempotent', () => {
    const path = join(dir, 'genie.db');

    const db1 = openGlobalDb();
    db1.close();
    expect(existsSync(path)).toBe(true);
    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);

    // Re-open: must not throw, must not change the version, tables intact.
    const db2 = openGlobalDb();
    const tables = db2
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    db2.close();

    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);
    expect(tables).toEqual(['approvals', 'inbound_messages']);
  });

  test('WAL journal mode is enabled', () => {
    const db = openGlobalDb();
    const mode = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    db.close();
    expect(mode.toLowerCase()).toBe('wal');
  });

  test('creates the parent directory when absent', () => {
    const path = join(dir, 'nested', 'deep', 'genie.db');
    const db = openGlobalDb({ path });
    db.close();
    expect(existsSync(path)).toBe(true);
  });
});

describe('openGlobalDb refusal (typed errors from sqlite-open)', () => {
  test('refuses a malformed (non-sqlite) file with MalformedDbError', () => {
    const path = join(dir, 'garbage.db');
    writeFileSync(path, 'definitely not a sqlite database\n'.repeat(64));
    expect(() => openGlobalDb({ path })).toThrow(MalformedDbError);
  });

  test('refuses a foreign versioned database with ForeignDbError', () => {
    const path = join(dir, 'foreign.db');
    const seed = new Database(path);
    seed.exec('PRAGMA user_version = 9');
    seed.exec('CREATE TABLE widgets (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openGlobalDb({ path })).toThrow(ForeignDbError);
  });

  test('refuses an unversioned database that already holds foreign tables', () => {
    const path = join(dir, 'foreign-unversioned.db');
    const seed = new Database(path);
    seed.exec('CREATE TABLE legacy_stuff (id INTEGER PRIMARY KEY)');
    seed.close();
    expect(() => openGlobalDb({ path })).toThrow(ForeignDbError);
  });

  test('adopts an empty (0-byte) file as a fresh database', () => {
    const path = join(dir, 'empty.db');
    writeFileSync(path, '');
    const db = openGlobalDb({ path });
    db.close();
    expect(userVersion(path)).toBe(GLOBAL_SCHEMA_VERSION);
  });
});
