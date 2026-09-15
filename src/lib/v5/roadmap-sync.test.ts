/**
 * roadmap-sync — the bytes a board snapshot takes on disk.
 *
 * Key order comes from the content, never from the exporting database's
 * physical column order, so a fresh db and one grown by `ALTER TABLE ADD
 * COLUMN` publish byte-identical snapshots instead of rewriting each other's
 * `roadmap.json` with reordered keys and zero content change.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './genie-db.js';
import { roadmapSnapshot, serializeSnapshot, syncRoadmap } from './roadmap-sync.js';
import { type StateExport, createTask, importState } from './task-state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-roadmap-sync-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  repo: string;
  db: Database;
  filePath: string;
  markerPath: string;
}

function fixture(name: string): Fixture {
  const repo = join(dir, name);
  mkdirSync(join(repo, '.genie'), { recursive: true });
  return {
    repo,
    db: openDb({ path: join(repo, '.genie', 'genie.db') }),
    filePath: join(repo, '.genie', 'roadmap.json'),
    markerPath: join(repo, '.genie', 'roadmap-sync'),
  };
}

describe('canonical snapshot bytes', () => {
  /**
   * A database as an older build created it: `tasks` without the columns later
   * builds add, so `ensureSchema`'s `ALTER TABLE ADD COLUMN` backfill appends
   * them and the physical column order differs from a fresh database's.
   */
  function migratedDb(path: string): Database {
    const raw = new Database(path, { create: true });
    raw.exec('PRAGMA user_version = 1');
    raw.exec(`CREATE TABLE tasks (
      id          TEXT PRIMARY KEY,
      board_id    TEXT,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('blocked', 'ready', 'in_progress', 'done')),
      claimed_by  TEXT,
      claimed_at  INTEGER,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );`);
    raw.close();
    return openDb({ path });
  }

  function columnOrder(db: Database): string[] {
    return (db.query('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((column) => column.name);
  }

  test('a fresh db and an ALTER-TABLE-migrated db publish byte-identical snapshots', () => {
    const fresh = openDb({ path: join(dir, 'fresh.db') });
    createTask(fresh, { title: 'shared card', assignedAgent: 'codex', assignedReason: 'dissent on parser' });
    const snapshot = roadmapSnapshot(fresh);

    const migrated = migratedDb(join(dir, 'migrated.db'));
    importState(migrated, snapshot, { replace: true });

    // The premise: the two databases really do hold the columns in a different
    // physical order, which is what `SELECT *` hands the serializer.
    expect(columnOrder(migrated)).not.toEqual(columnOrder(fresh));
    expect(JSON.stringify(roadmapSnapshot(migrated))).not.toBe(JSON.stringify(roadmapSnapshot(fresh)));

    // The contract: the published bytes are a function of the content alone.
    expect(serializeSnapshot(roadmapSnapshot(migrated))).toBe(serializeSnapshot(roadmapSnapshot(fresh)));
    fresh.close();
    migrated.close();
  });

  test('neither db rewrites the other machine`s file: sync settles as a no-op both ways', () => {
    const a = fixture('machine-a');
    createTask(a.db, { title: 'shared card' });
    expect(syncRoadmap(a.db, a.repo).action).toBe('exported');
    const publishedBytes = readFileSync(a.filePath, 'utf-8');

    // Machine B holds the same board in a migrated database and pulls that file.
    const repoB = join(dir, 'machine-b');
    mkdirSync(join(repoB, '.genie'), { recursive: true });
    const fileB = join(repoB, '.genie', 'roadmap.json');
    const migrated = migratedDb(join(repoB, '.genie', 'genie.db'));
    importState(migrated, JSON.parse(publishedBytes) as StateExport, { replace: true });
    writeFileSync(fileB, publishedBytes);

    expect(syncRoadmap(migrated, repoB).action).toBe('none');
    expect(readFileSync(fileB, 'utf-8')).toBe(publishedBytes);
    a.db.close();
    migrated.close();
  });

  test('serializeSnapshot is insensitive to key order and ends with exactly one newline', () => {
    const rowA = { id: 't_1', title: 'card', created_at: 1, assigned_agent: null };
    const rowB = { assigned_agent: null, created_at: 1, title: 'card', id: 't_1' };
    const bytes = serializeSnapshot({ schemaVersion: 1, tasks: [rowA] });
    expect(serializeSnapshot({ tasks: [rowB], schemaVersion: 1 })).toBe(bytes);
    expect(bytes.endsWith('}\n')).toBe(true);
    expect(JSON.parse(bytes)).toEqual({ schemaVersion: 1, tasks: [rowA] });
  });
});
