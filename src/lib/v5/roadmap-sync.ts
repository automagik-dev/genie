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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, resolveRepoRoot, resolveRoadmapPath } from './genie-db.js';
import { exportState, hasOperationalState, importState } from './task-state.js';

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
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

function serializeSnapshot(state: unknown): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Stamp the CURRENT (roadmap.json, genie.db) pair as the sync baseline.
 * Called after an explicit `task import`/`task export --write` succeeds: the
 * operator has just declared this pair intentional, so future syncs measure
 * drift from here.
 */
export function recordSyncBaseline(db: Database, cwd?: string): void {
  const filePath = resolveRoadmapPath(cwd);
  const dbHash = canonicalHash(exportState(db));
  let fileHash = dbHash;
  if (existsSync(filePath)) {
    try {
      fileHash = canonicalHash(JSON.parse(readFileSync(filePath, 'utf-8')));
    } catch {
      // Unreadable file: baseline the db side only; next sync will flag it.
    }
  }
  writeMarker(resolveSyncMarkerPath(cwd), { fileHash, dbHash });
}

/**
 * Reconcile genie.db with the canonical roadmap.json. Acts only when exactly
 * one side changed since the last baseline (see module doc); never destroys
 * state on divergence. Cheap enough to run before every board/task command:
 * one full-state serialization of a small database plus one file hash.
 */
export function syncRoadmap(db: Database, cwd?: string): SyncResult {
  const filePath = resolveRoadmapPath(cwd);
  const markerPath = resolveSyncMarkerPath(cwd);
  const dbState = exportState(db);
  const dbHash = canonicalHash(dbState);

  if (!existsSync(filePath)) {
    if (!hasOperationalState(db)) return { action: 'none' };
    writeFileSync(filePath, serializeSnapshot(dbState));
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

  if (fileChanged && (!dbChanged || !hasOperationalState(db))) {
    importState(db, parsed, { replace: true });
    writeMarker(markerPath, { fileHash, dbHash: canonicalHash(exportState(db)) });
    return { action: 'imported', message: `Board refreshed from ${filePath}.` };
  }
  if (dbChanged && !fileChanged) {
    writeFileSync(filePath, serializeSnapshot(dbState));
    writeMarker(markerPath, { fileHash: dbHash, dbHash });
    return { action: 'exported', message: `Board snapshot ${filePath} refreshed from the local database.` };
  }
  const resolution =
    'Resolve with `genie task import --replace` (take the snapshot) or `genie task export --write` (keep the local board).';
  return {
    action: 'diverged',
    message: `Both the local board (genie.db) and ${filePath} changed since the last sync. Nothing was overwritten. ${resolution}`,
  };
}

/**
 * Fail-open sync for command preAction hooks: reconcile silently (an import or
 * export that worked needs no announcement, and stdout must stay clean for
 * --json consumers), warn on stderr only when the sides diverged, and never
 * let a sync failure break the board/task command the user actually ran.
 */
export function autoSyncBeforeCommand(): void {
  try {
    const db = openDb();
    try {
      const result = syncRoadmap(db);
      if (result.action === 'diverged' && result.message) {
        process.stderr.write(`warn: ${result.message}\n`);
      }
    } finally {
      db.close();
    }
  } catch {
    // Sync is a convenience layer; the command itself surfaces real db errors.
  }
}
