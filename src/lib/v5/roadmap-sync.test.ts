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
  hasGenieWorkspace,
  recordExportBaseline,
  recordImportBaseline,
  resolveWorkspaceDir,
  roadmapSnapshot,
  serializeSnapshot,
  syncRoadmap,
} from './roadmap-sync.js';
import { type StateExport, createBoard, createTask, getTask, importState } from './task-state.js';

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

describe('workspace precondition', () => {
  /**
   * The guard must be asked BEFORE `openDb`, which creates `.genie/genie.db`
   * and with it the directory under test — so the answer has to come from the
   * filesystem, not from a database handle (dogfood r7 W2).
   */
  test('a directory with no .genie/ is not a workspace; the directory alone makes it one', () => {
    expect(resolveWorkspaceDir(dir)).toBe(join(dir, '.genie'));
    expect(hasGenieWorkspace(dir)).toBe(false);

    // A FILE named .genie is not a workspace either.
    writeFileSync(join(dir, '.genie'), 'not a directory\n');
    expect(hasGenieWorkspace(dir)).toBe(false);

    rmSync(join(dir, '.genie'));
    mkdirSync(join(dir, '.genie'));
    expect(hasGenieWorkspace(dir)).toBe(true);
  });
});

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

/**
 * m11 — a snapshot committed before the canonical serializer holds the same
 * content in a different byte order (`origin/main`'s own roadmap.json is one:
 * top-level `schemaVersion, meta, boards, tasks, …` and every row in physical
 * column order). Nothing forces such a file to be rewritten, because both the
 * sync hashes and the import are content-addressed — until the first real board
 * change writes canonical bytes and moves every line at once. The dogfood hop
 * saw exactly that: 1922 insertions / 1902 deletions for ONE new task.
 *
 * Sync therefore owns the file's byte form wherever its content is the agreed
 * content: the reordering lands once, alone, and says so, after which every
 * diff is the size of its change.
 */
describe('legacy-ordered snapshot bytes', () => {
  /** How an older genie (or a hand edit) wrote the same content: physical key order. */
  function legacyBytes(state: unknown): string {
    return `${JSON.stringify(state, null, 2)}\n`;
  }

  /** Does every line of `before` still appear in `after`, in order? A pure insertion. */
  function isSubsequence(before: string[], after: string[]): boolean {
    let cursor = 0;
    for (const line of before) {
      cursor = after.indexOf(line, cursor);
      if (cursor === -1) return false;
      cursor += 1;
    }
    return true;
  }

  /** A board with enough shape that a key reordering really does move every line. */
  function seedBoard(db: Database): void {
    const board = createBoard(db, 'roadmap', [{ name: 'Idea' }, { name: 'Work' }, { name: 'Done' }]);
    for (const title of ['first card', 'second card', 'third card']) {
      createTask(db, { title, boardId: board.id, assignedAgent: 'codex', assignedReason: 'm11 fixture' });
    }
  }

  test('a legacy-ordered file matching the board is normalized in place, and the sync says so', () => {
    const { repo, db, filePath, markerPath } = fixture('legacy-bytes-insync');
    seedBoard(db);
    const state = roadmapSnapshot(db);
    const legacy = legacyBytes(state);
    writeFileSync(filePath, legacy);
    // The premise: same content, different bytes.
    expect(legacy).not.toBe(serializeSnapshot(state));
    expect(JSON.parse(legacy)).toEqual(JSON.parse(serializeSnapshot(state)));

    const result = syncRoadmap(db, repo);
    expect(result.action).toBe('none');
    expect(result.message).toContain('in sync');
    expect(result.message).toContain('canonical key order');
    expect(result.message).toContain('no board content changed');
    // Content is untouched; only the bytes moved.
    expect(readFileSync(filePath, 'utf-8')).toBe(serializeSnapshot(state));
    expect(readMarkerFile(markerPath).hashVersion).toBe(2);
    // Idempotent: a second sync has nothing left to normalize and says nothing.
    const again = syncRoadmap(db, repo);
    expect(again.action).toBe('none');
    expect(again.message).toBeUndefined();
    db.close();
  });

  test('an imported legacy-ordered snapshot is normalized in the same run', () => {
    const { repo, db, filePath } = fixture('legacy-bytes-import');
    seedBoard(db);
    const published = roadmapSnapshot(db);
    writeFileSync(filePath, serializeSnapshot(published));
    expect(syncRoadmap(db, repo).action).toBe('none');

    // A pull lands a newer board — written by a machine still on the old bytes.
    const { snapshot: pulled, id } = snapshotWithExtraCard(published, join(dir, 'legacy-teammate.db'), 'pulled card');
    writeFileSync(filePath, legacyBytes(pulled));

    const result = syncRoadmap(db, repo);
    expect(result.action).toBe('imported');
    expect(result.message).toContain('canonical key order');
    expect(getTask(db, id)?.title).toBe('pulled card');
    expect(readFileSync(filePath, 'utf-8')).toBe(serializeSnapshot(pulled));
    db.close();
  });

  test('a diverged verdict never normalizes: the legacy file stays byte-for-byte', () => {
    const { repo, db, filePath, markerPath } = fixture('legacy-bytes-diverged');
    seedBoard(db);
    const published = roadmapSnapshot(db);
    const baseline = canonicalHash(published);
    const markerBytes = `${JSON.stringify({ fileHash: baseline, dbHash: baseline, hashVersion: 2 }, null, 2)}\n`;
    writeFileSync(markerPath, markerBytes);
    const { snapshot: foreign } = snapshotWithExtraCard(published, join(dir, 'legacy-teammate2.db'), 'their card');
    const fileBytes = legacyBytes(foreign);
    writeFileSync(filePath, fileBytes);
    createTask(db, { title: 'my card' });

    expect(syncRoadmap(db, repo).action).toBe('diverged');
    expect(readFileSync(filePath, 'utf-8')).toBe(fileBytes);
    expect(readFileSync(markerPath, 'utf-8')).toBe(markerBytes);
    db.close();
  });

  test('after the one-off reordering, a one-task change diffs as one task', () => {
    const { repo, db, filePath } = fixture('legacy-bytes-onecard');
    seedBoard(db);
    writeFileSync(filePath, legacyBytes(roadmapSnapshot(db)));
    // The reordering lands here, alone, carrying no content change.
    expect(syncRoadmap(db, repo).action).toBe('none');
    const beforeCard = readFileSync(filePath, 'utf-8').split('\n');

    createTask(db, { title: 'one more card' });
    expect(syncRoadmap(db, repo).action).toBe('exported');
    const afterCard = readFileSync(filePath, 'utf-8').split('\n');

    // A pure insertion: every line that was there is still there, in order.
    expect(isSubsequence(beforeCard, afterCard)).toBe(true);
    expect(afterCard.length - beforeCard.length).toBeLessThan(40);
    db.close();
  });
});
