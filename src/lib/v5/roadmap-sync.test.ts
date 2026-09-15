/**
 * roadmap-sync — the three-way reconcile between `.genie/roadmap.json` (the
 * canonical, git-tracked board) and `.genie/genie.db` (the local
 * materialization), plus the bytes a snapshot takes on disk.
 *
 * Two contracts live here:
 *
 * 1. **The marker records its hash algorithm.** A baseline written before the
 *    key-sorted hash carries no `hashVersion`; comparing it with today's
 *    algorithm alone would report both sides changed, so the first sync after
 *    an upgrade on an already-initialized clone would answer `diverged` — and
 *    the git hooks run `task sync || true`, so that refusal is invisible and
 *    genie.db just stays stale. A legacy marker is therefore compared with the
 *    legacy algorithm too, and rewritten as version 2 on the way out.
 * 2. **Snapshot bytes are canonical.** Key order comes from the content, never
 *    from the exporting database's physical column order, so a fresh db and one
 *    grown by `ALTER TABLE ADD COLUMN` publish byte-identical snapshots.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './genie-db.js';
import {
  recordExportBaseline,
  recordImportBaseline,
  roadmapSnapshot,
  serializeSnapshot,
  syncRoadmap,
} from './roadmap-sync.js';
import { type StateExport, createTask, getTask, importState } from './task-state.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-roadmap-sync-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The pre-`hashVersion` hash: sha256 over the physical key order. */
function legacyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** The current hash: sha256 over the key-sorted canonical form. */
function canonicalHash(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, current: unknown) => {
    if (current === null || Array.isArray(current) || typeof current !== 'object') return current;
    return Object.fromEntries(
      Object.keys(current)
        .sort()
        .map((key) => [key, (current as Record<string, unknown>)[key]]),
    );
  });
  return createHash('sha256').update(canonical).digest('hex');
}

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

/** The snapshot a teammate would push: this board plus one more card. */
function snapshotWithExtraCard(base: StateExport, path: string, title: string): { snapshot: StateExport; id: string } {
  const other = openDb({ path });
  importState(other, base, { replace: true });
  const created = createTask(other, { title });
  const snapshot = roadmapSnapshot(other);
  other.close();
  return { snapshot, id: created.id };
}

function readMarkerFile(path: string): { fileHash: string; dbHash: string; hashVersion?: number } {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('sync-marker hash-algorithm migration', () => {
  test('a legacy marker + a pulled snapshot imports (never diverges) and rewrites the marker as v2', () => {
    const { repo, db, filePath, markerPath } = fixture('legacy-pull');
    createTask(db, { title: 'existing card' });
    const published = roadmapSnapshot(db);
    // Baseline as an older build wrote it: physical-key-order hashes, no version.
    const baseline = legacyHash(published);
    writeFileSync(filePath, `${JSON.stringify(published, null, 2)}\n`);
    writeFileSync(markerPath, `${JSON.stringify({ fileHash: baseline, dbHash: baseline }, null, 2)}\n`);
    // Guard: the two algorithms really do disagree on this snapshot, so the
    // test exercises the migration and not an accidental match.
    expect(canonicalHash(published)).not.toBe(baseline);

    // A pull lands a newer roadmap.json; the local db was not touched.
    const { snapshot: pulled, id: pulledId } = snapshotWithExtraCard(
      published,
      join(dir, 'teammate.db'),
      'pulled card',
    );
    writeFileSync(filePath, `${JSON.stringify(pulled, null, 2)}\n`);

    const result = syncRoadmap(db, repo);
    expect(result.action).toBe('imported');
    expect(getTask(db, pulledId)?.title).toBe('pulled card');

    const marker = readMarkerFile(markerPath);
    expect(marker.hashVersion).toBe(2);
    expect(marker.fileHash).toBe(canonicalHash(pulled));
    expect(marker.dbHash).toBe(canonicalHash(roadmapSnapshot(db)));

    // Migrated: the next sync reads the pair as in-sync, with no second import.
    expect(syncRoadmap(db, repo).action).toBe('none');
    db.close();
  });

  test('an unversioned marker holding CANONICAL hashes (the intermediate build) also imports', () => {
    const { repo, db, filePath, markerPath } = fixture('unversioned-canonical');
    createTask(db, { title: 'existing card' });
    const published = roadmapSnapshot(db);
    const baseline = canonicalHash(published);
    writeFileSync(filePath, `${JSON.stringify(published, null, 2)}\n`);
    writeFileSync(markerPath, `${JSON.stringify({ fileHash: baseline, dbHash: baseline }, null, 2)}\n`);

    const { snapshot: pulled, id: pulledId } = snapshotWithExtraCard(
      published,
      join(dir, 'teammate2.db'),
      'pulled card',
    );
    writeFileSync(filePath, `${JSON.stringify(pulled, null, 2)}\n`);

    expect(syncRoadmap(db, repo).action).toBe('imported');
    expect(getTask(db, pulledId)?.title).toBe('pulled card');
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);
    db.close();
  });

  test('a legacy marker with only local board edits exports, and the file keeps every card', () => {
    const { repo, db, filePath, markerPath } = fixture('legacy-local-edit');
    createTask(db, { title: 'existing card' });
    const published = roadmapSnapshot(db);
    const baseline = legacyHash(published);
    writeFileSync(filePath, `${JSON.stringify(published, null, 2)}\n`);
    writeFileSync(markerPath, `${JSON.stringify({ fileHash: baseline, dbHash: baseline }, null, 2)}\n`);
    const local = createTask(db, { title: 'unpublished card' });

    // The file side still holds the baseline content, so nothing can be lost by
    // publishing: this is the ordinary db-only branch, not a divergence.
    const result = syncRoadmap(db, repo);
    expect(result.action).toBe('exported');
    const snapshot = JSON.parse(readFileSync(filePath, 'utf-8')) as StateExport;
    expect(snapshot.tasks.map((t) => t.title).sort()).toEqual(['existing card', 'unpublished card']);
    expect(getTask(db, local.id)?.title).toBe('unpublished card');
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);
    db.close();
  });

  test('a legacy marker still refuses a REAL divergence and touches neither side', () => {
    const { repo, db, filePath, markerPath } = fixture('legacy-diverged');
    createTask(db, { title: 'existing card' });
    const published = roadmapSnapshot(db);
    const baseline = legacyHash(published);
    const markerBytes = `${JSON.stringify({ fileHash: baseline, dbHash: baseline }, null, 2)}\n`;
    writeFileSync(markerPath, markerBytes);

    // Both sides moved since the baseline: a foreign snapshot landed AND the
    // local board gained a card of its own.
    const { snapshot: foreign } = snapshotWithExtraCard(published, join(dir, 'teammate3.db'), 'their card');
    const fileBytes = `${JSON.stringify(foreign, null, 2)}\n`;
    writeFileSync(filePath, fileBytes);
    const mine = createTask(db, { title: 'my card' });

    const result = syncRoadmap(db, repo);
    expect(result.action).toBe('diverged');
    expect(result.message).toContain('genie task import --replace');
    expect(result.message).toContain('genie task export --write');
    expect(readFileSync(filePath, 'utf-8')).toBe(fileBytes);
    expect(readFileSync(markerPath, 'utf-8')).toBe(markerBytes);
    expect(getTask(db, mine.id)?.title).toBe('my card');
    db.close();
  });

  test('a marker from a NEWER genie (unknown hashVersion) is unusable, never trusted as a baseline', () => {
    const { repo, db, filePath, markerPath } = fixture('future-marker');
    createTask(db, { title: 'existing card' });
    const published = roadmapSnapshot(db);
    writeFileSync(filePath, `${JSON.stringify(published, null, 2)}\n`);
    const future = canonicalHash(published);
    writeFileSync(markerPath, `${JSON.stringify({ fileHash: future, dbHash: future, hashVersion: 99 }, null, 2)}\n`);
    createTask(db, { title: 'local card' });

    // Unusable baseline ⇒ both sides read as changed ⇒ the safe refusal.
    expect(syncRoadmap(db, repo).action).toBe('diverged');
    db.close();
  });

  test('every baseline this build stamps carries hashVersion 2 (sync, export, import)', () => {
    const { repo, db, filePath, markerPath } = fixture('stamped');
    createTask(db, { title: 'first card' });

    expect(syncRoadmap(db, repo).action).toBe('exported');
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);

    rmSync(markerPath);
    recordExportBaseline(roadmapSnapshot(db), repo);
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);

    rmSync(markerPath);
    recordImportBaseline(db, JSON.parse(readFileSync(filePath, 'utf-8')), repo);
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);
    db.close();
  });
});

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
