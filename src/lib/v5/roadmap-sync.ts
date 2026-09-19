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
 *   both moved, only the   → MERGED: timeline events are append-only facts
 *   timeline differs         keyed by (task, kind, author, note, time), so the
 *                            two sides are unioned and re-published
 *   both moved otherwise   → DIVERGED: warn, touch nothing; the operator picks
 *                            `task import --replace` (take the file) or
 *                            `task export --write` (keep the db)
 *
 * The diverged branch is the whole point: a stale local db can never silently
 * overwrite the committed roadmap, and a pull can never silently destroy
 * unpublished local board state.
 *
 * The marker records the hash algorithm that produced its pair (`hashVersion`).
 * A marker without one predates the key-sorted hash and is compared with the
 * legacy algorithm, so upgrading genie never by itself reads as "both sides
 * changed"; the next successful sync rewrites it in the current version.
 *
 * Sync also owns the snapshot's BYTE form, not just its content: whenever the
 * file's content is the agreed content it is rewritten in canonical key order
 * (see normalizeSnapshotFile) so a legacy-ordered snapshot is normalized once,
 * on its own, instead of turning the next one-card change into a whole-file
 * rewrite nobody can review.
 */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertLocalLifecycleEnabled } from '../orchestration-mode.js';
import { resolveRepoRoot, resolveRoadmapPath } from './genie-db.js';
import { SnapshotFormatError, type StateExport, exportState, hasOperationalState, importState } from './task-state.js';

export type SyncAction = 'none' | 'imported' | 'exported' | 'merged' | 'diverged';

export interface SyncResult {
  action: SyncAction;
  /** Human-readable detail; always set for `diverged`. */
  message?: string;
}

/** Machine-local sync baseline. Lives next to genie.db; never git-tracked. */
export function resolveSyncMarkerPath(cwd?: string): string {
  return join(resolveRepoRoot(cwd), '.genie', 'roadmap-sync');
}

/** The `.genie/` directory that owns both sides of the sync (genie.db + roadmap.json). */
export function resolveWorkspaceDir(cwd?: string): string {
  return join(resolveRepoRoot(cwd), '.genie');
}

/**
 * Is there a `.genie` workspace to reconcile at all?
 *
 * Callers MUST ask before opening the database: `openDb` creates
 * `<root>/.genie/genie.db` (and the directory) on the way in, so a check made
 * afterwards always answers yes. Without it `genie task sync` in a directory
 * that was never `genie init`-ed materializes an empty database, finds no
 * snapshot and no state, and reports `Board and snapshot are in sync (none).`
 * with exit 0 — a clean bill indistinguishable from a genuinely reconciled
 * workspace (dogfood r7).
 */
export function hasGenieWorkspace(cwd?: string): boolean {
  return statSync(resolveWorkspaceDir(cwd), { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * Markers written before the key-sorted hash landed carry no `hashVersion`;
 * their hashes are {@link legacyHash} values. Version 2 is {@link canonicalHash}
 * over the PRE-v6 snapshot shape. Version 3 is the same hash over the shape v6
 * emits, and every marker this build writes is version 3 — so a version 1 or 2
 * marker migrates on the first successful sync, import, or export.
 *
 * The bump is not cosmetic. v6 changed the snapshot's CONTENT twice at once:
 * `hire_roster: []` is gone and `schemaVersion` moved 1 -> 2. A version-2
 * baseline therefore never matches a v6 db hash, so the very first `task sync`
 * after an upgrade read `dbChanged && fileChanged` and wedged the checkout into
 * a permanent `diverged` — on every machine, with no edit by anyone.
 * {@link baselineHolds} answers that by re-deriving the pre-v6 shape.
 */
const LEGACY_HASH_VERSION = 1;
const PRE_V6_HASH_VERSION = 2;
const CURRENT_HASH_VERSION = 3;
type MarkerHashVersion = typeof LEGACY_HASH_VERSION | typeof PRE_V6_HASH_VERSION | typeof CURRENT_HASH_VERSION;

/** The only `user_version` that ever existed before the v1 -> v2 ladder. */
const PRE_V6_SCHEMA_VERSION = 1;

/**
 * The snapshot shape a pre-v6 build would have hashed for this same content:
 * `hire_roster` always published as `[]`, and `schemaVersion` always 1. Applied
 * to a v6 db snapshot it reconstructs exactly what the old baseline recorded;
 * applied to a pre-v6 file it is a no-op, because the file already carries both.
 */
function preV6Shape(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...(value as Record<string, unknown>), hire_roster: [], schemaVersion: PRE_V6_SCHEMA_VERSION };
}

/**
 * Canonical JSON: every object's keys are emitted in sorted order, recursively.
 * ONE rule for both the sync hashes and the bytes written to roadmap.json, so a
 * snapshot's text is a function of its content alone — never of the db's
 * physical column order, which differs between a fresh database and one grown
 * by `ALTER TABLE ADD COLUMN` and would otherwise churn the canonical file on
 * every machine that exports it.
 */
function canonicalJson(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (_key, current: unknown) => {
      if (current === null || Array.isArray(current) || typeof current !== 'object') return current;
      return Object.fromEntries(
        Object.keys(current)
          .sort()
          .map((key) => [key, (current as Record<string, unknown>)[key]]),
      );
    },
    indent,
  );
}

/** Content hash over the canonical JSON form, independent of whitespace and object-key order. */
function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * The pre-`hashVersion` hash: sha256 over plain `JSON.stringify`, so it depends
 * on each object's physical key order. Markers written by those builds are only
 * comparable against hashes computed this same way — see {@link readMarker}.
 */
function legacyHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Is `value` still the content this baseline recorded?
 *
 * A version-3 baseline is a {@link canonicalHash} of today's shape, so the
 * canonical hash settles it. Older baselines recorded the SAME content in an
 * older shape or with an older algorithm, so each accepted form is re-derived
 * and compared:
 *   - version <= 2: the {@link preV6Shape} canonical hash (this is what keeps
 *     an upgrade from reading as a change on its own — see the version block),
 *   - version 1: {@link legacyHash} of either shape, because that era's markers
 *     came from a build that hashed physical key order OR from the intermediate
 *     build that had switched algorithms without yet stamping a version.
 *
 * Every arm is a sha256 statement that the content IS the baseline content, so
 * none of them can invent a false "unchanged" without a collision.
 */
function baselineHolds(version: MarkerHashVersion, recorded: string, canonical: string, value: unknown): boolean {
  if (recorded === canonical) return true;
  if (version > PRE_V6_HASH_VERSION) return false;
  const asPreV6 = preV6Shape(value);
  if (recorded === canonicalHash(asPreV6)) return true;
  if (version !== LEGACY_HASH_VERSION) return false;
  return recorded === legacyHash(value) || recorded === legacyHash(asPreV6);
}

/**
 * The published slice of the database. It is the WHOLE database since v6: the
 * one table this ever excluded was `hire_roster`, whose rows carried
 * machine-local worktree paths, and the v1 -> v2 migration dropped it. The
 * function stays as the named seam roadmap.json and the sync hashes are
 * defined against, so a future machine-local table has one place to be
 * excluded rather than three call sites to remember.
 */
export function roadmapSnapshot(db: Database): StateExport {
  return exportState(db);
}

interface SyncMarker {
  fileHash: string;
  dbHash: string;
  /** Which hash algorithm produced the two hashes above. */
  hashVersion: MarkerHashVersion;
}

function readMarker(path: string): SyncMarker | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SyncMarker>;
    if (typeof parsed.fileHash !== 'string' || typeof parsed.dbHash !== 'string') return null;
    // No `hashVersion` → written before the algorithm changed. A version this
    // build cannot reproduce (a newer genie wrote it) is unusable as a baseline
    // and is treated as absent, exactly like a corrupt marker.
    if (parsed.hashVersion === undefined) {
      return { fileHash: parsed.fileHash, dbHash: parsed.dbHash, hashVersion: LEGACY_HASH_VERSION };
    }
    if (parsed.hashVersion === PRE_V6_HASH_VERSION || parsed.hashVersion === CURRENT_HASH_VERSION) {
      return { fileHash: parsed.fileHash, dbHash: parsed.dbHash, hashVersion: parsed.hashVersion };
    }
  } catch {
    // Corrupt marker — treat as absent; sync falls back to its safe defaults.
  }
  return null;
}

/** Stamp a baseline. Always current-version: writing IS the migration. */
function writeMarker(path: string, hashes: { fileHash: string; dbHash: string }): void {
  assertLocalLifecycleEnabled();
  const marker: SyncMarker = { ...hashes, hashVersion: CURRENT_HASH_VERSION };
  writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`);
}

/**
 * The exact bytes a snapshot takes on disk (and on stdout): canonical JSON, two
 * space indent, trailing newline. Key order is the snapshot's content, not the
 * exporting database's column layout — see {@link canonicalJson}.
 */
export function serializeSnapshot(state: unknown): string {
  return `${canonicalJson(state, 2)}\n`;
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
 * Rewrite a non-canonical snapshot file into canonical bytes WITHOUT changing
 * its content, and report whether it had to. A snapshot committed before the
 * canonical serializer — or reflowed by a hand edit — holds the same content in
 * a different byte form, so EVERY line of it moves the first time genie writes
 * that file.
 *
 * The whole point is separating two things a reviewer cannot separate once they
 * land together. A legacy-ordered `roadmap.json` still reads and hashes fine
 * (both are content-addressed, not byte-addressed), so nothing forces it to be
 * rewritten — until the first real board change does, and then the one-card
 * diff the reviewer needs is buried in a whole-file rewrite (the dogfood hop saw
 * 1922 insertions / 1902 deletions for a single new task). Normalizing as its
 * own no-content-change write makes that rewrite a single legible event, named
 * in the sync message, after which every diff is the size of its change.
 *
 * Only ever called where the file's content is the agreed content (in sync with
 * the db, or just imported into it). A `diverged` verdict touches nothing.
 */
function normalizeSnapshotFile(filePath: string, parsed: unknown): boolean {
  if (readFileSync(filePath, 'utf-8') === serializeSnapshot(parsed)) return false;
  writeSnapshotFile(filePath, parsed);
  return true;
}

/** The one clause that explains a whole-file diff carrying no content change. */
const NORMALIZED_NOTE = 'was rewritten in canonical key order (no board content changed).';
/**
 * The v6 shape migration, stated in the same voice as {@link NORMALIZED_NOTE}
 * because it is the same KIND of event: the bytes move, the board does not.
 */
const RESHAPED_NOTE =
  'was rewritten in the v6 snapshot shape — `hire_roster` retired, schemaVersion 2 (no board content changed).';

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
    if (!hasOperationalState(db)) return { action: 'none' };
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
    const normalized = normalizeSnapshotFile(filePath, parsed);
    writeMarker(markerPath, { fileHash, dbHash });
    return normalized
      ? { action: 'none', message: `Board and snapshot are in sync; ${filePath} ${NORMALIZED_NOTE}` }
      : { action: 'none' };
  }

  // Compare each side against the baseline in the algorithm that baseline was
  // written with (see baselineHolds): a pre-`hashVersion` marker holds hashes
  // of the physical key order, so measuring today's file and db with
  // canonicalHash alone would report BOTH sides changed on the first sync after
  // an upgrade — a false `diverged` that the git hooks swallow via `|| true`,
  // leaving genie.db silently stale on every already-initialized clone.
  const marker = readMarker(markerPath);
  const fileChanged = marker === null || !baselineHolds(marker.hashVersion, marker.fileHash, fileHash, parsed);
  const dbChanged = marker === null || !baselineHolds(marker.hashVersion, marker.dbHash, dbHash, dbState);
  const resolution =
    'Resolve with `genie task import --replace` (take the snapshot) or `genie task export --write` (keep the local board).';

  if (fileChanged && (!dbChanged || !hasOperationalState(db))) {
    try {
      importState(db, parsed, { replace: true });
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
    const normalized = normalizeSnapshotFile(filePath, parsed);
    writeMarker(markerPath, { fileHash, dbHash: canonicalHash(roadmapSnapshot(db)) });
    return {
      action: 'imported',
      message: normalized
        ? `Board refreshed from ${filePath}, which ${NORMALIZED_NOTE}`
        : `Board refreshed from ${filePath}.`,
    };
  }
  if (dbChanged && !fileChanged) {
    writeSnapshotFile(filePath, dbState);
    writeMarker(markerPath, { fileHash: dbHash, dbHash });
    return { action: 'exported', message: `Board snapshot ${filePath} refreshed from the local database.` };
  }
  if (!fileChanged && !dbChanged) {
    // Neither side moved, yet the hashes differ — a state that could not exist
    // before v6, when the baseline shape equalled both sides. It is what an
    // upgraded checkout looks like on its first sync: the committed file is
    // still the pre-v6 shape (`hire_roster: []`, `schemaVersion: 1`) while the
    // database publishes the v6 one, and `baselineHolds` has just proved the
    // CONTENT of both is exactly what the baseline recorded. Falling through
    // from here reached `diverged`, which is how every upgraded checkout wedged
    // — silently, because the git hooks run `task sync || true`.
    //
    // Republish in the current shape, the same way a legacy key order is
    // rewritten: one commit that moves bytes and no cards.
    writeSnapshotFile(filePath, dbState);
    writeMarker(markerPath, { fileHash: dbHash, dbHash });
    return { action: 'exported', message: `Board snapshot ${filePath} ${RESHAPED_NOTE}` };
  }
  // Both sides moved. The card conversation is the one slice that is safe to
  // reconcile automatically: events are append-only facts that never conflict,
  // so when the two sides agree on everything except task_events, union them.
  const merged = mergeTimelines(db, dbState, parsed);
  if (merged !== null) {
    const next = roadmapSnapshot(db);
    writeSnapshotFile(filePath, next);
    const nextHash = canonicalHash(next);
    writeMarker(markerPath, { fileHash: nextHash, dbHash: nextHash });
    return {
      action: 'merged',
      message: `Card timelines merged: ${merged} event(s) from ${filePath} added to the local board and the snapshot republished.`,
    };
  }
  return {
    action: 'diverged',
    message: `Both the local board (genie.db) and ${filePath} changed since the last sync. Nothing was overwritten. ${resolution}`,
  };
}

/** Identity of a timeline event independent of its per-database autoincrement id. */
function eventKey(e: {
  task_id: string;
  kind: string;
  note: string | null;
  author_kind: string | null;
  author: string | null;
  created_at: number;
}): string {
  return JSON.stringify([e.task_id, e.kind, e.note ?? null, e.author_kind ?? null, e.author ?? null, e.created_at]);
}

/**
 * When the db and the file differ only in task_events, insert every file event
 * the db lacks (matched by identity, ids reassigned locally) and return how many
 * were added. Returns null when anything other than the timeline differs, or the
 * file is not a well-formed snapshot — those cases stay diverged.
 */
function mergeTimelines(db: Database, dbState: StateExport, parsed: unknown): number | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const file = parsed as Partial<StateExport>;
  if (!Array.isArray(file.task_events)) return null;
  // `hire_roster` AND `schemaVersion` are dropped from BOTH sides, not zeroed
  // or normalized: a pre-v6 roadmap.json still carries the key (always `[]`)
  // and still says `schemaVersion: 1`, while a v6 database has no such table
  // and reports 2. An absent key does not hash like an empty array, and 1 does
  // not hash like 2 — so without both removals this comparison answered "these
  // differ by more than the timeline" for every upgraded checkout and sent a
  // teammate's ordinary card change to `diverged`.
  const stripped = (state: Partial<StateExport>) => {
    const {
      hire_roster: _retiredInV6,
      schemaVersion: _movedInV6,
      ...rest
    } = state as Partial<StateExport> & {
      hire_roster?: unknown;
    };
    return { ...rest, task_events: [] };
  };
  if (canonicalHash(stripped(dbState)) !== canonicalHash(stripped(file))) return null;
  const known = new Set(dbState.task_events.map(eventKey));
  const knownTasks = new Set(dbState.tasks.map((t) => t.id));
  const missing = file.task_events.filter((e) => {
    if (typeof e !== 'object' || e === null) return false;
    const row = e as StateExport['task_events'][number];
    return (
      typeof row.task_id === 'string' &&
      knownTasks.has(row.task_id) &&
      typeof row.created_at === 'number' &&
      !known.has(eventKey(row))
    );
  }) as StateExport['task_events'];
  if (missing.length === 0) return null;
  const insert = db.query(
    'INSERT INTO task_events (task_id, kind, note, author_kind, author, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const e of missing)
    insert.run(e.task_id, e.kind, e.note ?? null, e.author_kind ?? null, e.author ?? null, e.created_at);
  return missing.length;
}
