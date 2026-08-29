/**
 * Roadmap snapshot sync — makes the git-tracked `.genie/roadmap.json` the
 * canonical board while `.genie/genie.db` stays the fast local materialization.
 *
 * A machine-local marker (`.genie/roadmap-sync`, gitignored, next to genie.db)
 * remembers the (file, db) content-hash pair from the last synchronized state.
 * Comparing both current hashes against that baseline yields a three-way
 * verdict per side — unchanged or changed — and sync acts only when exactly one
 * side moved:
 *
 *   file moved, db didn't  → git pull delivered a newer board → import
 *   db moved, file didn't  → local mutations → export (published at commit)
 *   both moved             → DIVERGED: warn, touch nothing; the operator picks
 *                            `task import --replace` (take the file) or
 *                            `task export --write` (keep the db)
 *
 * The diverged branch is the whole point: a stale local db can never silently
 * overwrite the committed roadmap, and a pull can never silently destroy
 * unpublished local board state.
 */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalLifecycleEnabled } from '../orchestration-mode.js';
import { resolveRepoRoot, resolveRoadmapPath } from './genie-db.js';
import { SnapshotFormatError, type StateExport, exportState, hasOperationalState, importState } from './task-state.js';

export type SyncAction = 'none' | 'imported' | 'exported' | 'diverged';

export interface SyncResult {
  action: SyncAction;
  /** Human-readable detail; always set for `diverged`. */
  message?: string;
}

/** Machine-local sync baseline. Lives next to genie.db; never git-tracked. */
export function resolveSyncMarkerPath(cwd?: string): string {
  return join(resolveRepoRoot(cwd), '.genie', 'roadmap-sync');
}

/** Content hash over the canonical (whitespace-independent) JSON form. */
function canonicalHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The published slice of the database: everything EXCEPT hire_roster, whose
 * rows carry machine-local worktree paths that must never travel between
 * machines. This is what roadmap.json holds and what sync hashes compare —
 * local hires can neither dirty the snapshot nor be destroyed by an import.
 */
export function roadmapSnapshot(db: Database): StateExport {
  return { ...exportState(db), hire_roster: [] };
}

interface SyncMarker {
  fileHash: string;
  dbHash: string;
}

function readMarker(path: string): SyncMarker | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncMarker>;
    if (typeof parsed.fileHash === 'string' && typeof parsed.dbHash === 'string') {
      return { fileHash: parsed.fileHash, dbHash: parsed.dbHash };
    }
  } catch {
    // Corrupt marker — treat as absent; sync falls back to its safe defaults.
  }
  return null;
}

function writeMarker(path: string, marker: SyncMarker): void {
  assertLocalLifecycleEnabled();
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

function serializeSnapshot(state: unknown): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Write a snapshot to disk atomically (temp file + rename), so an interruption
 * or a full disk can never leave the canonical roadmap.json truncated — a torn
 * canonical board would otherwise read as invalid JSON on the next sync.
 */
export function writeSnapshotFile(target: string, state: unknown): void {
  assertLocalLifecycleEnabled();
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeSnapshot(state));
  renameSync(tmp, target);
}

/**
 * Baseline the pair an explicit `task export --write` just published, where
 * `state` is the snapshot whose bytes were written to roadmap.json. Both hashes
 * come from that ONE snapshot: re-snapshotting the db here (or re-reading the
 * file) could pick up a concurrent worktree's write and stamp a baseline
 * describing state the published file never held — the next `task sync` would
 * then read as in-sync and that mid-window change would never be exported.
 * Callers must therefore run this inside the same immediate transaction that
 * produced `state` and wrote the file.
 */
export function recordExportBaseline(state: StateExport, cwd?: string): void {
  assertLocalLifecycleEnabled();
  // The file holds exactly `serializeSnapshot(state)`, and sync hashes the
  // PARSED file — structurally identical to `state`, so one hash covers both.
  const hash = canonicalHash(state);
  writeMarker(resolveSyncMarkerPath(cwd), { fileHash: hash, dbHash: hash });
}

/**
 * Baseline the pair an explicit `task import` just settled: `snapshot` is the
 * parsed roadmap.json that was applied, and the db side is re-measured because
 * a merge import (no `--replace`) leaves a db that is a superset of the file.
 * Same locking contract as {@link recordExportBaseline} — the re-snapshot must
 * happen under the caller's immediate transaction, alongside the import itself.
 */
export function recordImportBaseline(db: Database, snapshot: unknown, cwd?: string): void {
  assertLocalLifecycleEnabled();
  writeMarker(resolveSyncMarkerPath(cwd), {
    fileHash: canonicalHash(snapshot),
    dbHash: canonicalHash(roadmapSnapshot(db)),
  });
}

/**
 * Reconcile genie.db with the canonical roadmap.json. Acts only when exactly
 * one side changed since the last baseline (see module doc); never destroys
 * state on divergence. Invoked by `genie task sync`, which the git hooks run
 * on pull (post-merge / post-rewrite) and before commit (pre-commit).
 */
export function syncRoadmap(db: Database, cwd?: string): SyncResult {
  assertLocalLifecycleEnabled();
  // BEGIN IMMEDIATE for the whole compare-and-act sequence: the db-side hash
  // must not go stale between comparison and a replace-import, or a task write
  // committed in that window would be silently destroyed. Holding the write
  // lock up front also serializes two concurrent syncs (git hook vs interactive
  // command) through busy_timeout, so their file read-decide-write sequences
  // cannot interleave. importState's inner transaction nests as a savepoint.
  const locked = db.transaction(() => syncRoadmapLocked(db, cwd));
  return locked.immediate() as SyncResult;
}

function syncRoadmapLocked(db: Database, cwd?: string): SyncResult {
  const filePath = resolveRoadmapPath(cwd);
  const markerPath = resolveSyncMarkerPath(cwd);
  const dbState = roadmapSnapshot(db);
  const dbHash = canonicalHash(dbState);

  if (!existsSync(filePath)) {
    // Roadmap-scoped: hires are machine-local and never publish, so a hire-only
    // db has nothing to publish and must not create an empty snapshot.
    if (!hasOperationalState(db, { includeHireRoster: false })) return { action: 'none' };
    writeSnapshotFile(filePath, dbState);
    writeMarker(markerPath, { fileHash: dbHash, dbHash });
    return { action: 'exported', message: `Published board snapshot to ${filePath}.` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return {
      action: 'diverged',
      message: `${filePath} is not valid JSON. Fix it, or regenerate it from the local board with \`genie task export --write\`.`,
    };
  }
  const fileHash = canonicalHash(parsed);

  if (fileHash === dbHash) {
    writeMarker(markerPath, { fileHash, dbHash });
    return { action: 'none' };
  }

  const marker = readMarker(markerPath);
  const fileChanged = marker === null || fileHash !== marker.fileHash;
  const dbChanged = marker === null || dbHash !== marker.dbHash;
  const resolution =
    'Resolve with `genie task import --replace` (take the snapshot) or `genie task export --write` (keep the local board).';

  // Roadmap-scoped decision: hires never travel in the snapshot, so a local
  // hire alone must not count as unpublished board state — otherwise a fresh
  // clone that hired an agent before its first sync would read as "both moved"
  // and wedge permanently into diverged.
  if (fileChanged && (!dbChanged || !hasOperationalState(db, { includeHireRoster: false }))) {
    try {
      importState(db, parsed, { replace: true, preserveHireRoster: true });
    } catch (err) {
      // Schema skew (or a structurally unimportable snapshot) is exactly the
      // "I cannot reconcile these two" class this function must surface as a
      // diverged verdict with actionable text — never as a throw that the git
      // hooks swallow via `|| true`.
      if (!(err instanceof SnapshotFormatError)) throw err;
      return {
        action: 'diverged',
        message: `${filePath} could not be imported: ${err.message} ${resolution}`,
      };
    }
    writeMarker(markerPath, { fileHash, dbHash: canonicalHash(roadmapSnapshot(db)) });
    return { action: 'imported', message: `Board refreshed from ${filePath}.` };
  }
  if (dbChanged && !fileChanged) {
    writeSnapshotFile(filePath, dbState);
    writeMarker(markerPath, { fileHash: dbHash, dbHash });
    return { action: 'exported', message: `Board snapshot ${filePath} refreshed from the local database.` };
  }
  return {
    action: 'diverged',
    message: `Both the local board (genie.db) and ${filePath} changed since the last sync. Nothing was overwritten. ${resolution}`,
  };
}
