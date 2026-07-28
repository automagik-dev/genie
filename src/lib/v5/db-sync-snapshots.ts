import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse as parsePath, resolve } from 'node:path';
import {
  MAX_RECONCILIATION_DATABASE_BYTES,
  type ReconciliationApplyEvent,
  type ReconciliationApplyFailure,
  type ReconciliationApplyOptions,
  type ReconciliationApplyReport,
  type ReconciliationDatabaseObservation,
  type ReconciliationInputRole,
  type ReconciliationLockedDatabaseInput,
  ReconciliationLockedOperationError,
  type ReconciliationLockedOperationEvent,
  type ReconciliationPlan,
  type ReconciliationRequest,
  type ReconciliationTargetRole,
  applyDatabaseReconciliation,
  inspectReconciliationDatabase,
  withLockedReconciliationDatabases,
} from './db-reconciliation.js';

const SQLITE_HEADER_BYTES = new TextEncoder().encode('SQLite format 3\0');
const SQLITE_MINIMUM_HEADER_BYTES = 100;
const SQLITE_WRITE_VERSION_OFFSET = 18;
const SQLITE_READ_VERSION_OFFSET = 19;
const SQLITE_ROLLBACK_FORMAT = 1;
const SQLITE_WAL_FORMAT = 2;
const MANIFEST_FORMAT_VERSION = 1 as const;
const RECONCILIATION_OPERATION_VERSION = 1 as const;
const SNAPSHOT_REPORT_VERSION = 1 as const;
const DEFAULT_SNAPSHOT_RETENTION = 3;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SNAPSHOT_FILE_PREFIX = 'snapshot-';
const MANIFEST_FILE = 'manifest.json';
const STAGING_PREFIX = '.staging-';
const GENERATION_SEPARATOR = '--';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const GENERATION_ID_PATTERN = /^[a-f0-9]{64}--[0-9]{16}--[a-f0-9-]{36}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export type SnapshotFailureCode =
  | 'snapshot-invalid-header'
  | 'snapshot-unsupported-header-mode'
  | 'invalid-snapshot-option'
  | 'snapshot-publication-failed'
  | 'manifest-invalid'
  | 'snapshot-hash-mismatch'
  | 'snapshot-image-mismatch'
  | 'generation-not-found'
  | 'recovery-uncertain'
  | 'locked-operation-failed'
  | 'locked-rollback-failed'
  | 'locked-close-failed'
  | 'locked-advisory-release-failed'
  | 'snapshot-cleanup-failed';

export class SnapshotError extends Error {
  readonly code: SnapshotFailureCode;
  readonly cleanupFailures: readonly SnapshotFailureCode[];

  constructor(code: SnapshotFailureCode, message: string, cleanupFailures: readonly SnapshotFailureCode[] = []) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
    this.cleanupFailures = cleanupFailures;
  }
}

/**
 * Return private recovery bytes accepted by sqlite3_deserialize().
 *
 * sqlite3_serialize() returns the complete logical image but preserves the
 * source header's WAL read/write versions. SQLite explicitly requires an
 * in-memory deserialized database to use rollback mode, so normalize only the
 * documented header bytes on a copy. The caller's buffer is never modified.
 */
export function normalizeSerializedSqliteForDeserialize(serialized: Uint8Array): Uint8Array {
  if (serialized.byteLength < SQLITE_MINIMUM_HEADER_BYTES) {
    throw new SnapshotError('snapshot-invalid-header', 'Serialized SQLite snapshot is shorter than its file header.');
  }
  for (let index = 0; index < SQLITE_HEADER_BYTES.length; index++) {
    if (serialized[index] !== SQLITE_HEADER_BYTES[index]) {
      throw new SnapshotError('snapshot-invalid-header', 'Serialized snapshot does not have a SQLite 3 header.');
    }
  }
  const writeVersion = serialized[SQLITE_WRITE_VERSION_OFFSET];
  const readVersion = serialized[SQLITE_READ_VERSION_OFFSET];
  const rollbackMode = writeVersion === SQLITE_ROLLBACK_FORMAT && readVersion === SQLITE_ROLLBACK_FORMAT;
  const walMode = writeVersion === SQLITE_WAL_FORMAT && readVersion === SQLITE_WAL_FORMAT;
  if (!rollbackMode && !walMode) {
    throw new SnapshotError(
      'snapshot-unsupported-header-mode',
      'Serialized SQLite snapshot has unsupported or inconsistent read/write format versions.',
    );
  }

  const normalized = serialized.slice();
  normalized[SQLITE_WRITE_VERSION_OFFSET] = SQLITE_ROLLBACK_FORMAT;
  normalized[SQLITE_READ_VERSION_OFFSET] = SQLITE_ROLLBACK_FORMAT;
  return normalized;
}

export function deserializeSnapshotBytes(serialized: Uint8Array): Database {
  return Database.deserialize(normalizeSerializedSqliteForDeserialize(serialized), {
    readonly: true,
    strict: true,
    safeIntegers: true,
  });
}

export type SnapshotGenerationState =
  | 'provisional'
  | 'complete'
  | 'converged'
  | 'recovered'
  | 'uncertain'
  | 'rolled-back';

export interface SnapshotManifestTarget {
  readonly role: ReconciliationTargetRole;
  readonly identity: string;
  readonly path: string;
  readonly preimage_digest: string;
  readonly postimage_digest: string;
  readonly snapshot_file: string;
  readonly snapshot_sha256: string | null;
}

export interface SnapshotManifestV1 {
  readonly format_version: typeof MANIFEST_FORMAT_VERSION;
  readonly operation_version: typeof RECONCILIATION_OPERATION_VERSION;
  readonly generation_id: string;
  readonly operation_id: string;
  readonly mode: ReconciliationPlan['mode'];
  readonly schema_fingerprint: string;
  readonly created_at: string;
  readonly state: SnapshotGenerationState;
  readonly targets: readonly SnapshotManifestTarget[];
}

export interface SnapshotStoreIdentity {
  readonly operationId: string;
  readonly root: string;
  readonly mode: ReconciliationPlan['mode'];
  readonly canonicalPaths: readonly string[];
}

export type SnapshotLifecyclePhase =
  | 'payload-write'
  | 'provisional-manifest-write'
  | 'payload-fsync'
  | 'complete-manifest-write'
  | 'complete-manifest-fsync'
  | 'staging-fsync'
  | 'generation-rename'
  | 'root-fsync'
  | 'state-rewrite-write'
  | 'state-rewrite-fsync'
  | 'state-rewrite-rename'
  | 'generation-fsync'
  | 'recovery-classify'
  | 'recovery-restore'
  | 'rollback-restore'
  | 'staging-cleanup'
  | 'prune';

export interface SnapshotLifecycleEvent {
  readonly phase: SnapshotLifecyclePhase;
  readonly state: 'before' | 'after';
  readonly generationId?: string;
  readonly role?: ReconciliationTargetRole;
  readonly path?: string;
}

export interface DatabaseSyncSnapshotOptions {
  readonly snapshotRoot?: string;
  readonly keepSnapshots?: number;
  readonly busyTimeoutMs?: number;
  readonly onEvent?: (event: SnapshotLifecycleEvent) => void;
  readonly onApplyEvent?: (event: ReconciliationApplyEvent) => void;
  readonly onLockedOperationEvent?: (event: ReconciliationLockedOperationEvent) => void;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly removeTree?: (path: string) => void;
  readonly applyOptions?: Omit<ReconciliationApplyOptions, 'busyTimeoutMs' | 'onEvent' | 'onLocked'>;
}

export type SnapshotRecoveryStatus = 'none' | 'converged' | 'recovered' | 'uncertain' | 'operational-failure';

export interface SnapshotRecoveryReport {
  readonly reportVersion: typeof SNAPSHOT_REPORT_VERSION;
  readonly operation: 'recovery';
  readonly status: SnapshotRecoveryStatus;
  readonly generationId: string | null;
  readonly restoredPaths: readonly string[];
  readonly failure: SnapshotFailureCode | null;
  readonly cleanupFailures: readonly SnapshotFailureCode[];
}

export interface SnapshotApplyReport {
  readonly reportVersion: typeof SNAPSHOT_REPORT_VERSION;
  readonly operation: 'apply';
  readonly status:
    | ReconciliationApplyReport['status']
    | 'recovered'
    | 'converged'
    | 'uncertain'
    | 'operational-failure';
  readonly generationId: string | null;
  readonly recovery: SnapshotRecoveryReport;
  readonly apply: ReconciliationApplyReport | null;
  readonly failure: SnapshotFailureCode | null;
  readonly cleanupFailures: readonly SnapshotFailureCode[];
}

export interface SnapshotRollbackReport {
  readonly reportVersion: typeof SNAPSHOT_REPORT_VERSION;
  readonly operation: 'rollback';
  readonly status: 'rolled-back' | 'uncertain' | 'operational-failure';
  readonly selectedGenerationId: string;
  readonly safetyGenerationId: string | null;
  readonly failure: SnapshotFailureCode | null;
  readonly cleanupFailures: readonly SnapshotFailureCode[];
}

interface GenerationCapture {
  readonly role: ReconciliationTargetRole;
  readonly canonicalPath: string;
  readonly preimageDigest: string;
  readonly postimageDigest: string;
  readonly normalizedBytes: Uint8Array;
  readonly sha256: string;
}

interface PublishedGeneration {
  readonly manifest: SnapshotManifestV1;
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
  readonly manifestIdentity: FileIdentity;
  readonly privateRoot: string | null;
}

interface GenerationReference {
  readonly manifest: SnapshotManifestV1;
  readonly directory: string;
  readonly directoryIdentity: FileIdentity;
  readonly manifestIdentity: FileIdentity;
}

interface ValidatedGeneration {
  readonly manifest: SnapshotManifestV1;
  readonly directory: string;
  readonly snapshots: ReadonlyMap<string, Database>;
}

interface RecoveryDecision {
  readonly status: Exclude<SnapshotRecoveryStatus, 'operational-failure'>;
  readonly generationId: string | null;
  readonly restoredPaths: string[];
  readonly cleanupFailures: SnapshotFailureCode[];
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface BoundDirectory {
  readonly path: string;
  readonly descriptor: number;
  readonly identity: FileIdentity;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeIdentity(domain: string, values: readonly string[]): string {
  const hash = createHash('sha256').update(`${domain}\0`);
  for (const value of values) {
    const bytes = Buffer.from(value);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function targetIdentity(path: string): string {
  return encodeIdentity('genie-db-sync-target-v1', [path]);
}

function canonicalPathsFromPlan(plan: ReconciliationPlan): string[] {
  return plan.inputs.map((input) => input.canonicalPath);
}

function identityFromCanonical(
  mode: ReconciliationPlan['mode'],
  canonicalPaths: readonly string[],
  snapshotRoot?: string,
): SnapshotStoreIdentity {
  if (canonicalPaths.length !== 2) {
    throw new SnapshotError('invalid-snapshot-option', 'Database snapshot identity requires exactly two inputs.');
  }
  if (mode === 'bidirectional') {
    const sorted = [...canonicalPaths].sort(compareText);
    const operationId = encodeIdentity('genie-db-sync-bidirectional-pair-v1', sorted);
    return {
      operationId,
      root:
        snapshotRoot === undefined ? join(dirname(sorted[0]), 'sync-snapshots', operationId) : resolve(snapshotRoot),
      mode,
      canonicalPaths: sorted,
    };
  }
  const [source, destination] = canonicalPaths;
  const operationId = encodeIdentity('genie-db-sync-directional-pair-v1', [source, destination]);
  return {
    operationId,
    root: snapshotRoot === undefined ? join(dirname(destination), 'sync-snapshots') : resolve(snapshotRoot),
    mode,
    canonicalPaths: [source, destination],
  };
}

export function databaseSyncSnapshotIdentity(
  request: ReconciliationRequest,
  snapshotRoot?: string,
): SnapshotStoreIdentity {
  const paths =
    request.mode === 'bidirectional'
      ? [request.leftPath, request.rightPath]
      : [request.sourcePath, request.destinationPath];
  const canonical = paths.map((path) => {
    const absolute = isAbsolute(path) ? path : resolve(path);
    return realpathSync(absolute);
  });
  return identityFromCanonical(request.mode, canonical, snapshotRoot);
}

function requestFromPlan(plan: ReconciliationPlan): ReconciliationRequest {
  const input = (role: ReconciliationInputRole): string => {
    const found = plan.inputs.find((candidate) => candidate.role === role);
    if (found === undefined) throw new SnapshotError('invalid-snapshot-option', `Plan is missing its ${role} input.`);
    return found.canonicalPath;
  };
  return plan.mode === 'bidirectional'
    ? { mode: 'bidirectional', leftPath: input('left'), rightPath: input('right') }
    : { mode: 'directional', sourcePath: input('source'), destinationPath: input('destination') };
}

function validateRetention(value: number | undefined): number {
  const retention = value ?? DEFAULT_SNAPSHOT_RETENTION;
  if (!Number.isSafeInteger(retention) || retention < 0) {
    throw new SnapshotError('invalid-snapshot-option', 'Snapshot retention must be a nonnegative safe integer.');
  }
  return retention;
}

function emit(options: DatabaseSyncSnapshotOptions, event: SnapshotLifecycleEvent): void {
  options.onEvent?.(event);
}

function around(
  options: DatabaseSyncSnapshotOptions,
  event: Omit<SnapshotLifecycleEvent, 'state'>,
  operation: () => void,
): void {
  emit(options, { ...event, state: 'before' });
  operation();
  emit(options, { ...event, state: 'after' });
}

function fileIdentity(stats: Stats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameFileIdentity(left: FileIdentity, right: Stats | FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function filesystemCode(caught: unknown): unknown {
  return isRecord(caught) ? caught.code : undefined;
}

function assertSafeDirectoryAncestors(path: string): void {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const parts = absolute.slice(root.length).split('/').filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (caught) {
      if (filesystemCode(caught) === 'ENOENT') return;
      throw caught;
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SnapshotError(
        'manifest-invalid',
        'Snapshot root and its existing ancestors must be physical directories.',
      );
    }
  }
}

function assertPathIdentity(path: string, identity: FileIdentity, kind: 'directory' | 'file'): void {
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new SnapshotError('manifest-invalid', `Snapshot ${kind} identity changed during the operation.`);
  }
  const validType = kind === 'directory' ? stats.isDirectory() : stats.isFile();
  if (stats.isSymbolicLink() || !validType || !sameFileIdentity(identity, stats)) {
    throw new SnapshotError('manifest-invalid', `Snapshot ${kind} identity changed during the operation.`);
  }
}

function openBoundDirectory(path: string, create: boolean, requirePrivate = false): BoundDirectory {
  assertSafeDirectoryAncestors(path);
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSafeDirectoryAncestors(path);
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (caught) {
    if (!create && filesystemCode(caught) === 'ENOENT') throw caught;
    throw new SnapshotError('manifest-invalid', 'Snapshot root is not a safe physical directory.');
  }
  try {
    const stats = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
    const mode = stats.mode & 0o777;
    if (!stats.isDirectory() || stats.uid !== currentUid || (requirePrivate ? mode !== 0o700 : (mode & 0o022) !== 0)) {
      throw new SnapshotError('manifest-invalid', 'Snapshot root must be a private directory owned by this user.');
    }
    const identity = fileIdentity(stats);
    assertPathIdentity(path, identity, 'directory');
    return { path, descriptor, identity };
  } catch (caught) {
    closeSync(descriptor);
    throw caught;
  }
}

function closeBoundDirectory(directory: BoundDirectory): void {
  closeSync(directory.descriptor);
}

function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): { readonly bytes: Uint8Array; readonly identity: FileIdentity } {
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    throw new SnapshotError('manifest-invalid', 'Snapshot input must be a no-follow physical regular file.');
  }
  try {
    const initial = fstatSync(descriptor);
    if (!initial.isFile() || initial.size > maximumBytes) {
      throw new SnapshotError('manifest-invalid', 'Snapshot input is not a bounded physical regular file.');
    }
    const identity = fileIdentity(initial);
    const bytes = new Uint8Array(initial.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const final = fstatSync(descriptor);
    if (offset !== bytes.byteLength || final.size !== initial.size || !sameFileIdentity(identity, final)) {
      throw new SnapshotError('manifest-invalid', 'Snapshot input changed while it was read.');
    }
    assertPathIdentity(path, identity, 'file');
    return { bytes, identity };
  } finally {
    closeSync(descriptor);
  }
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeJson(path: string, manifest: SnapshotManifestV1): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function overwriteJson(path: string, manifest: SnapshotManifestV1): void {
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW);
  try {
    writeFileSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    closeSync(descriptor);
  }
}

function generationId(
  identity: SnapshotStoreIdentity,
  options: DatabaseSyncSnapshotOptions,
): {
  id: string;
  createdAt: string;
} {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new SnapshotError('invalid-snapshot-option', 'Snapshot timestamp must be a valid date.');
  }
  const timestamp = String(now.getTime()).padStart(16, '0');
  const random = (options.randomId?.() ?? randomUUID()).toLowerCase();
  const id = `${identity.operationId}${GENERATION_SEPARATOR}${timestamp}${GENERATION_SEPARATOR}${random}`;
  if (!GENERATION_ID_PATTERN.test(id) || !UUID_PATTERN.test(random)) {
    throw new SnapshotError('invalid-snapshot-option', 'Snapshot generation ID contains unsupported characters.');
  }
  return { id, createdAt: now.toISOString() };
}

function validateCapturedImage(
  bytes: Uint8Array,
  schemaFingerprint: string,
  logicalDigest: string,
): { normalizedBytes: Uint8Array; sha256: string } {
  const normalizedBytes = normalizeSerializedSqliteForDeserialize(bytes);
  let db: Database;
  try {
    db = Database.deserialize(normalizedBytes, { readonly: true, strict: true, safeIntegers: true });
  } catch {
    throw new SnapshotError('snapshot-image-mismatch', 'Serialized snapshot cannot be deserialized as SQLite.');
  }
  try {
    let image: ReconciliationDatabaseObservation;
    try {
      image = inspectReconciliationDatabase(db);
    } catch {
      throw new SnapshotError('snapshot-image-mismatch', 'Serialized snapshot failed schema or integrity validation.');
    }
    if (image.schemaFingerprint !== schemaFingerprint || image.logicalDigest !== logicalDigest) {
      throw new SnapshotError(
        'snapshot-image-mismatch',
        'Serialized snapshot does not match its expected logical image.',
      );
    }
  } finally {
    db.close();
  }
  return { normalizedBytes, sha256: sha256(normalizedBytes) };
}

function makeManifest(
  identity: SnapshotStoreIdentity,
  schemaFingerprint: string,
  captures: readonly GenerationCapture[],
  id: string,
  createdAt: string,
  state: SnapshotGenerationState,
  hashes: boolean,
): SnapshotManifestV1 {
  return {
    format_version: MANIFEST_FORMAT_VERSION,
    operation_version: RECONCILIATION_OPERATION_VERSION,
    generation_id: id,
    operation_id: identity.operationId,
    mode: identity.mode,
    schema_fingerprint: schemaFingerprint,
    created_at: createdAt,
    state,
    targets: captures.map((capture, index) => ({
      role: capture.role,
      identity: targetIdentity(capture.canonicalPath),
      path: capture.canonicalPath,
      preimage_digest: capture.preimageDigest,
      postimage_digest: capture.postimageDigest,
      snapshot_file: `${SNAPSHOT_FILE_PREFIX}${index}.sqlite`,
      snapshot_sha256: hashes ? capture.sha256 : null,
    })),
  };
}

function createPrivateRoot(): { readonly path: string; readonly identity: FileIdentity } {
  const root = mkdtempSync(join(tmpdir(), 'genie-db-sync-private-'));
  const mode = statSync(root).mode & 0o777;
  if (mode !== 0o700) {
    rmdirSync(root);
    throw new SnapshotError(
      'snapshot-publication-failed',
      'Private snapshot directory was not created with mode 0700.',
    );
  }
  const binding = openBoundDirectory(root, false, true);
  try {
    return { path: root, identity: binding.identity };
  } finally {
    closeBoundDirectory(binding);
  }
}

function publishGeneration(
  identity: SnapshotStoreIdentity,
  schemaFingerprint: string,
  captures: readonly GenerationCapture[],
  options: DatabaseSyncSnapshotOptions,
  privateRoot: string | null = null,
): PublishedGeneration {
  const root = privateRoot ?? identity.root;
  const rootBinding = openBoundDirectory(root, true, privateRoot !== null);
  const generated = generationId(identity, options);
  const staging = join(root, `${STAGING_PREFIX}${generated.id}-${randomUUID()}`);
  const finalDirectory = join(root, generated.id);
  mkdirSync(staging, { mode: 0o700 });
  const stagingBinding = openBoundDirectory(staging, false, true);
  const provisional = makeManifest(
    identity,
    schemaFingerprint,
    captures,
    generated.id,
    generated.createdAt,
    'provisional',
    false,
  );
  try {
    for (let index = 0; index < captures.length; index++) {
      const capture = captures[index];
      around(options, { phase: 'payload-write', generationId: generated.id, role: capture.role }, () =>
        (() => {
          assertPathIdentity(root, rootBinding.identity, 'directory');
          assertPathIdentity(staging, stagingBinding.identity, 'directory');
          writeFileSync(join(staging, provisional.targets[index].snapshot_file), capture.normalizedBytes, {
            flag: 'wx',
            mode: 0o600,
          });
        })(),
      );
    }
    around(options, { phase: 'provisional-manifest-write', generationId: generated.id }, () =>
      (() => {
        assertPathIdentity(root, rootBinding.identity, 'directory');
        assertPathIdentity(staging, stagingBinding.identity, 'directory');
        writeJson(join(staging, MANIFEST_FILE), provisional);
      })(),
    );
    for (const target of provisional.targets) {
      around(options, { phase: 'payload-fsync', generationId: generated.id, role: target.role }, () =>
        (() => {
          assertPathIdentity(staging, stagingBinding.identity, 'directory');
          fsyncPath(join(staging, target.snapshot_file));
        })(),
      );
    }
    const complete = makeManifest(
      identity,
      schemaFingerprint,
      captures,
      generated.id,
      generated.createdAt,
      'complete',
      true,
    );
    around(options, { phase: 'complete-manifest-write', generationId: generated.id }, () =>
      (() => {
        assertPathIdentity(staging, stagingBinding.identity, 'directory');
        overwriteJson(join(staging, MANIFEST_FILE), complete);
      })(),
    );
    around(options, { phase: 'complete-manifest-fsync', generationId: generated.id }, () =>
      (() => {
        assertPathIdentity(staging, stagingBinding.identity, 'directory');
        fsyncPath(join(staging, MANIFEST_FILE));
      })(),
    );
    around(options, { phase: 'staging-fsync', generationId: generated.id }, () => {
      assertPathIdentity(staging, stagingBinding.identity, 'directory');
      fsyncSync(stagingBinding.descriptor);
    });
    around(options, { phase: 'generation-rename', generationId: generated.id }, () => {
      assertPathIdentity(root, rootBinding.identity, 'directory');
      assertPathIdentity(staging, stagingBinding.identity, 'directory');
      renameSync(staging, finalDirectory);
      assertPathIdentity(finalDirectory, stagingBinding.identity, 'directory');
    });
    around(options, { phase: 'root-fsync', generationId: generated.id }, () => {
      assertPathIdentity(root, rootBinding.identity, 'directory');
      fsyncSync(rootBinding.descriptor);
    });
    const manifestPath = join(finalDirectory, MANIFEST_FILE);
    const manifestIdentity = readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES).identity;
    return {
      manifest: complete,
      directory: finalDirectory,
      directoryIdentity: stagingBinding.identity,
      manifestIdentity,
      privateRoot,
    };
  } catch (caught) {
    if (caught instanceof SnapshotError) throw caught;
    throw new SnapshotError(
      'snapshot-publication-failed',
      caught instanceof Error ? caught.message : 'Snapshot publication failed.',
    );
  } finally {
    closeBoundDirectory(stagingBinding);
    closeBoundDirectory(rootBinding);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  return (
    actual.length === expected.length && actual.every((key, index) => key === [...expected].sort(compareText)[index])
  );
}

function requireString(value: unknown): string {
  if (typeof value !== 'string')
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest field is not a string.');
  return value;
}

function parseTarget(value: unknown): SnapshotManifestTarget {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'role',
      'identity',
      'path',
      'preimage_digest',
      'postimage_digest',
      'snapshot_file',
      'snapshot_sha256',
    ])
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest target shape is invalid.');
  }
  const role = value.role;
  if (role !== 'left' && role !== 'right' && role !== 'destination') {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest target role is invalid.');
  }
  const path = requireString(value.path);
  const identity = requireString(value.identity);
  const preimage = requireString(value.preimage_digest);
  const postimage = requireString(value.postimage_digest);
  const file = requireString(value.snapshot_file);
  const hash = value.snapshot_sha256;
  if (
    !isAbsolute(path) ||
    identity !== targetIdentity(path) ||
    !SHA256_PATTERN.test(preimage) ||
    !SHA256_PATTERN.test(postimage) ||
    basename(file) !== file ||
    !file.startsWith(SNAPSHOT_FILE_PREFIX) ||
    (hash !== null && (typeof hash !== 'string' || !SHA256_PATTERN.test(hash)))
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest target values are invalid.');
  }
  return {
    role,
    identity,
    path,
    preimage_digest: preimage,
    postimage_digest: postimage,
    snapshot_file: file,
    snapshot_sha256: hash,
  };
}

function parseManifest(value: unknown): SnapshotManifestV1 {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'format_version',
      'operation_version',
      'generation_id',
      'operation_id',
      'mode',
      'schema_fingerprint',
      'created_at',
      'state',
      'targets',
    ])
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest shape is invalid.');
  }
  if (
    value.format_version !== MANIFEST_FORMAT_VERSION ||
    value.operation_version !== RECONCILIATION_OPERATION_VERSION
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest version is unsupported.');
  }
  const generation = requireString(value.generation_id);
  const operation = requireString(value.operation_id);
  const mode = value.mode;
  const schema = requireString(value.schema_fingerprint);
  const createdAt = requireString(value.created_at);
  const state = value.state;
  const generationParts = generation.split(GENERATION_SEPARATOR);
  const parsedCreatedAt = Date.parse(createdAt);
  const canonicalCreatedAt = !Number.isNaN(parsedCreatedAt) && new Date(parsedCreatedAt).toISOString() === createdAt;
  if (
    !GENERATION_ID_PATTERN.test(generation) ||
    generationParts.length !== 3 ||
    !UUID_PATTERN.test(generationParts[2]) ||
    String(parsedCreatedAt).padStart(16, '0') !== generationParts[1] ||
    !canonicalCreatedAt ||
    !SHA256_PATTERN.test(operation) ||
    (mode !== 'bidirectional' && mode !== 'directional') ||
    !SHA256_PATTERN.test(schema) ||
    Number.isNaN(parsedCreatedAt) ||
    (state !== 'provisional' &&
      state !== 'complete' &&
      state !== 'converged' &&
      state !== 'recovered' &&
      state !== 'uncertain' &&
      state !== 'rolled-back') ||
    !Array.isArray(value.targets)
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest values are invalid.');
  }
  const targets = value.targets.map(parseTarget);
  const expectedCount = mode === 'bidirectional' ? 2 : 1;
  const roles = targets.map((target) => target.role);
  if (
    targets.length !== expectedCount ||
    new Set(targets.map((target) => target.path)).size !== targets.length ||
    (mode === 'bidirectional' && (!roles.includes('left') || !roles.includes('right'))) ||
    (mode === 'directional' && roles[0] !== 'destination')
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest target inventory is invalid.');
  }
  return {
    format_version: MANIFEST_FORMAT_VERSION,
    operation_version: RECONCILIATION_OPERATION_VERSION,
    generation_id: generation,
    operation_id: operation,
    mode,
    schema_fingerprint: schema,
    created_at: createdAt,
    state,
    targets,
  };
}

function readManifest(directory: string): GenerationReference {
  const manifestPath = join(directory, MANIFEST_FILE);
  const directoryBinding = openBoundDirectory(directory, false, true);
  let parsed: unknown;
  try {
    const loaded = readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES);
    parsed = JSON.parse(new TextDecoder().decode(loaded.bytes)) as unknown;
    const manifest = parseManifest(parsed);
    if (basename(directory) !== manifest.generation_id) {
      throw new SnapshotError('manifest-invalid', 'Snapshot generation directory does not match its manifest.');
    }
    assertPathIdentity(directory, directoryBinding.identity, 'directory');
    return {
      manifest,
      directory,
      directoryIdentity: directoryBinding.identity,
      manifestIdentity: loaded.identity,
    };
  } catch {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest is not valid JSON.');
  } finally {
    closeBoundDirectory(directoryBinding);
  }
}

function validateManifestIdentity(manifest: SnapshotManifestV1, identity: SnapshotStoreIdentity): void {
  const manifestPaths = manifest.targets.map((target) => target.path).sort(compareText);
  const expectedTargets =
    identity.mode === 'bidirectional' ? [...identity.canonicalPaths].sort(compareText) : [identity.canonicalPaths[1]];
  if (
    manifest.operation_id !== identity.operationId ||
    manifest.mode !== identity.mode ||
    manifestPaths.length !== expectedTargets.length ||
    manifestPaths.some((path, index) => path !== expectedTargets[index])
  ) {
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest does not identify the locked database operation.');
  }
}

function matchingGenerationDirectories(identity: SnapshotStoreIdentity): string[] {
  let rootBinding: BoundDirectory;
  try {
    rootBinding = openBoundDirectory(identity.root, false);
  } catch (caught) {
    if (filesystemCode(caught) === 'ENOENT') return [];
    throw caught;
  }
  try {
    const directories = readdirSync(identity.root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          entry.name.startsWith(`${identity.operationId}${GENERATION_SEPARATOR}`),
      )
      .map((entry) => join(identity.root, entry.name))
      .sort((left, right) => compareText(right, left));
    assertPathIdentity(identity.root, rootBinding.identity, 'directory');
    return directories;
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

function newestUnresolved(identity: SnapshotStoreIdentity): GenerationReference | null {
  for (const directory of matchingGenerationDirectories(identity)) {
    const generation = readManifest(directory);
    validateManifestIdentity(generation.manifest, identity);
    if (generation.manifest.state === 'complete' || generation.manifest.state === 'uncertain') return generation;
  }
  return null;
}

function selectedGeneration(identity: SnapshotStoreIdentity, selectedGenerationId: string): GenerationReference {
  if (!GENERATION_ID_PATTERN.test(selectedGenerationId) || !selectedGenerationId.startsWith(identity.operationId)) {
    throw new SnapshotError('generation-not-found', 'Selected snapshot generation does not belong to this operation.');
  }
  const directory = join(identity.root, selectedGenerationId);
  let generation: GenerationReference;
  try {
    generation = readManifest(directory);
  } catch (caught) {
    const code = isRecord(caught) ? caught.code : undefined;
    if (code === 'ENOENT') {
      throw new SnapshotError('generation-not-found', 'Selected snapshot generation does not exist.');
    }
    throw caught;
  }
  validateManifestIdentity(generation.manifest, identity);
  if (
    generation.manifest.state === 'provisional' ||
    generation.manifest.targets.some((target) => target.snapshot_sha256 === null)
  ) {
    throw new SnapshotError('manifest-invalid', 'Selected snapshot generation is incomplete.');
  }
  return generation;
}

function validateGeneration(generation: GenerationReference): ValidatedGeneration {
  const snapshots = new Map<string, Database>();
  try {
    for (const target of generation.manifest.targets) {
      if (target.snapshot_sha256 === null) {
        throw new SnapshotError('manifest-invalid', 'Complete snapshot manifest is missing a payload hash.');
      }
      const payloadPath = join(generation.directory, target.snapshot_file);
      assertPathIdentity(generation.directory, generation.directoryIdentity, 'directory');
      assertPathIdentity(join(generation.directory, MANIFEST_FILE), generation.manifestIdentity, 'file');
      const bytes = readBoundedRegularFile(payloadPath, MAX_RECONCILIATION_DATABASE_BYTES).bytes;
      if (sha256(bytes) !== target.snapshot_sha256) {
        throw new SnapshotError('snapshot-hash-mismatch', 'Snapshot payload hash does not match its manifest.');
      }
      let db: Database;
      try {
        db = deserializeSnapshotBytes(bytes);
      } catch {
        throw new SnapshotError('snapshot-image-mismatch', 'Snapshot payload cannot be deserialized as SQLite.');
      }
      let image: ReconciliationDatabaseObservation;
      try {
        image = inspectReconciliationDatabase(db);
      } catch {
        db.close();
        throw new SnapshotError('snapshot-image-mismatch', 'Snapshot payload failed schema or integrity validation.');
      }
      if (
        image.schemaFingerprint !== generation.manifest.schema_fingerprint ||
        image.logicalDigest !== target.preimage_digest
      ) {
        db.close();
        throw new SnapshotError('snapshot-image-mismatch', 'Snapshot payload does not match its manifest image.');
      }
      snapshots.set(target.path, db);
      assertPathIdentity(generation.directory, generation.directoryIdentity, 'directory');
      assertPathIdentity(join(generation.directory, MANIFEST_FILE), generation.manifestIdentity, 'file');
    }
    return { ...generation, snapshots };
  } catch (caught) {
    for (const snapshot of snapshots.values()) snapshot.close();
    throw caught;
  }
}

function closeValidatedGeneration(generation: ValidatedGeneration): void {
  for (const db of generation.snapshots.values()) db.close();
}

function safeRemoveTree(path: string, expected: FileIdentity): void {
  assertPathIdentity(path, expected, 'directory');
  const directory = openBoundDirectory(path, false);
  try {
    if (!sameFileIdentity(expected, directory.identity)) {
      throw new SnapshotError('snapshot-cleanup-failed', 'Snapshot cleanup target identity changed.');
    }
    const descriptorPath = `/proc/self/fd/${directory.descriptor}`;
    for (const entry of readdirSync(descriptorPath, { withFileTypes: true })) {
      const descriptorChild = join(descriptorPath, entry.name);
      const child = join(path, entry.name);
      const stats = lstatSync(descriptorChild);
      const identity = fileIdentity(stats);
      const current = lstatSync(child);
      if (!sameFileIdentity(identity, current)) {
        throw new SnapshotError('snapshot-cleanup-failed', 'Snapshot cleanup child identity changed.');
      }
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        safeRemoveTree(child, identity);
      } else {
        assertPathIdentity(child, identity, 'file');
        unlinkSync(child);
      }
    }
    fsyncSync(directory.descriptor);
  } finally {
    closeBoundDirectory(directory);
  }
  assertPathIdentity(path, expected, 'directory');
  rmdirSync(path);
}

function removeBoundTree(path: string, expected: FileIdentity, options: DatabaseSyncSnapshotOptions): void {
  assertPathIdentity(path, expected, 'directory');
  if (options.removeTree !== undefined) {
    options.removeTree(path);
    try {
      lstatSync(path);
    } catch (caught) {
      if (filesystemCode(caught) === 'ENOENT') return;
      throw caught;
    }
    throw new SnapshotError('snapshot-cleanup-failed', 'Snapshot cleanup did not remove its exact target.');
  }
  safeRemoveTree(path, expected);
}

function rewriteManifestState(
  generation: GenerationReference,
  state: Exclude<SnapshotGenerationState, 'provisional' | 'complete'>,
  options: DatabaseSyncSnapshotOptions,
): SnapshotManifestV1 {
  const updated = { ...generation.manifest, state };
  const temporary = join(generation.directory, `.manifest-${randomUUID()}.tmp`);
  let temporaryIdentity: FileIdentity | null = null;
  try {
    assertPathIdentity(generation.directory, generation.directoryIdentity, 'directory');
    assertPathIdentity(join(generation.directory, MANIFEST_FILE), generation.manifestIdentity, 'file');
    around(options, { phase: 'state-rewrite-write', generationId: generation.manifest.generation_id }, () =>
      writeJson(temporary, updated),
    );
    temporaryIdentity = readBoundedRegularFile(temporary, MAX_MANIFEST_BYTES).identity;
    around(options, { phase: 'state-rewrite-fsync', generationId: generation.manifest.generation_id }, () => {
      assertPathIdentity(temporary, temporaryIdentity as FileIdentity, 'file');
      fsyncPath(temporary);
    });
    around(options, { phase: 'state-rewrite-rename', generationId: generation.manifest.generation_id }, () => {
      assertPathIdentity(generation.directory, generation.directoryIdentity, 'directory');
      assertPathIdentity(join(generation.directory, MANIFEST_FILE), generation.manifestIdentity, 'file');
      assertPathIdentity(temporary, temporaryIdentity as FileIdentity, 'file');
      renameSync(temporary, join(generation.directory, MANIFEST_FILE));
      assertPathIdentity(join(generation.directory, MANIFEST_FILE), temporaryIdentity as FileIdentity, 'file');
    });
    around(options, { phase: 'generation-fsync', generationId: generation.manifest.generation_id }, () => {
      assertPathIdentity(generation.directory, generation.directoryIdentity, 'directory');
      fsyncPath(generation.directory);
    });
    return updated;
  } catch (caught) {
    const cleanupFailures: SnapshotFailureCode[] = [];
    if (temporaryIdentity !== null) {
      try {
        assertPathIdentity(temporary, temporaryIdentity, 'file');
        unlinkSync(temporary);
      } catch (cleanupCaught) {
        if (filesystemCode(cleanupCaught) !== 'ENOENT') cleanupFailures.push('snapshot-cleanup-failed');
      }
    }
    if (caught instanceof SnapshotError) {
      throw new SnapshotError(caught.code, caught.message, [...caught.cleanupFailures, ...cleanupFailures]);
    }
    throw new SnapshotError('snapshot-publication-failed', 'Snapshot manifest state rewrite failed.', cleanupFailures);
  }
}

function cleanupStaging(
  root: string,
  options: DatabaseSyncSnapshotOptions,
  cleanupFailures: SnapshotFailureCode[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (caught) {
    const code = isRecord(caught) ? caught.code : undefined;
    if (code === 'ENOENT') return;
    cleanupFailures.push('snapshot-cleanup-failed');
    return;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(STAGING_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(root, entry.name);
    try {
      const identity = fileIdentity(lstatSync(path));
      around(options, { phase: 'staging-cleanup', path }, () => removeBoundTree(path, identity, options));
    } catch {
      cleanupFailures.push('snapshot-cleanup-failed');
    }
  }
}

function pruneGenerations(
  identity: SnapshotStoreIdentity,
  retention: number,
  options: DatabaseSyncSnapshotOptions,
  cleanupFailures: SnapshotFailureCode[],
): void {
  const directories = matchingGenerationDirectories(identity);
  const retained = new Set(directories.slice(0, retention));
  let removed = false;
  for (const directory of directories) {
    if (retained.has(directory)) continue;
    try {
      const manifest = readManifest(directory);
      validateManifestIdentity(manifest.manifest, identity);
      if (manifest.manifest.state === 'complete' || manifest.manifest.state === 'uncertain') continue;
      around(options, { phase: 'prune', generationId: manifest.manifest.generation_id, path: directory }, () =>
        removeBoundTree(directory, manifest.directoryIdentity, options),
      );
      removed = true;
    } catch {
      cleanupFailures.push('snapshot-cleanup-failed');
    }
  }
  if (removed) {
    try {
      fsyncPath(identity.root);
    } catch {
      cleanupFailures.push('snapshot-cleanup-failed');
    }
  }
}

function targetInput(
  inputs: readonly ReconciliationLockedDatabaseInput[],
  path: string,
): ReconciliationLockedDatabaseInput {
  const input = inputs.find((candidate) => candidate.canonicalPath === path);
  if (input === undefined) {
    throw new SnapshotError('manifest-invalid', 'Snapshot target is not one of the locked databases.');
  }
  return input;
}

function recoverValidatedGeneration(
  identity: SnapshotStoreIdentity,
  generation: GenerationReference,
  inputs: readonly ReconciliationLockedDatabaseInput[],
  options: DatabaseSyncSnapshotOptions,
  retention: number,
): { value: RecoveryDecision; afterCommit: () => void } {
  if (generation.manifest.state === 'uncertain') {
    return {
      value: {
        status: 'uncertain',
        generationId: generation.manifest.generation_id,
        restoredPaths: [],
        cleanupFailures: [],
      },
      afterCommit: () => {},
    };
  }
  const validated = validateGeneration(generation);
  const observed = new Map(inputs.map((input) => [input.canonicalPath, input.observe().logicalDigest]));
  const classifications = generation.manifest.targets.map((target) => ({
    target,
    current: observed.get(target.path),
    pre: observed.get(target.path) === target.preimage_digest,
    post: observed.get(target.path) === target.postimage_digest,
  }));
  emit(options, { phase: 'recovery-classify', state: 'before', generationId: generation.manifest.generation_id });
  let status: RecoveryDecision['status'];
  const restoreTargets: SnapshotManifestTarget[] = [];
  if (classifications.every((item) => item.post)) {
    status = 'converged';
  } else if (classifications.every((item) => item.pre)) {
    status = 'recovered';
  } else if (
    identity.mode === 'bidirectional' &&
    classifications.length === 2 &&
    classifications.every((item) => item.pre || item.post) &&
    classifications.filter((item) => item.pre).length === 1 &&
    classifications.filter((item) => item.post).length === 1
  ) {
    status = 'recovered';
    restoreTargets.push(...classifications.filter((item) => item.post).map((item) => item.target));
  } else {
    status = 'uncertain';
  }
  emit(options, { phase: 'recovery-classify', state: 'after', generationId: generation.manifest.generation_id });

  const restoredPaths: string[] = [];
  try {
    if (status !== 'uncertain') {
      for (const target of restoreTargets) {
        const snapshot = validated.snapshots.get(target.path);
        if (snapshot === undefined) {
          throw new SnapshotError('manifest-invalid', 'Validated snapshot payload is missing.');
        }
        around(
          options,
          { phase: 'recovery-restore', generationId: generation.manifest.generation_id, role: target.role },
          () => {
            const restored = targetInput(inputs, target.path).restoreFrom(snapshot);
            if (
              restored.schemaFingerprint !== generation.manifest.schema_fingerprint ||
              restored.logicalDigest !== target.preimage_digest
            ) {
              throw new SnapshotError('snapshot-image-mismatch', 'Recovery did not reproduce the preimage.');
            }
          },
        );
        restoredPaths.push(target.path);
      }
    }
  } finally {
    closeValidatedGeneration(validated);
  }

  const cleanupFailures: SnapshotFailureCode[] = [];
  return {
    value: {
      status,
      generationId: generation.manifest.generation_id,
      restoredPaths,
      cleanupFailures,
    },
    afterCommit: () => {
      rewriteManifestState(generation, status === 'uncertain' ? 'uncertain' : status, options);
      cleanupStaging(identity.root, options, cleanupFailures);
      if (status !== 'uncertain') pruneGenerations(identity, retention, options, cleanupFailures);
    },
  };
}

function recoveryReport(decision: RecoveryDecision): SnapshotRecoveryReport {
  return {
    reportVersion: SNAPSHOT_REPORT_VERSION,
    operation: 'recovery',
    status: decision.status,
    generationId: decision.generationId,
    restoredPaths: decision.restoredPaths,
    failure: decision.status === 'uncertain' ? 'recovery-uncertain' : null,
    cleanupFailures: decision.cleanupFailures,
  };
}

function snapshotCleanupCode(failure: ReconciliationApplyFailure): SnapshotFailureCode {
  switch (failure.code) {
    case 'rollback-failed':
      return 'locked-rollback-failed';
    case 'close-failed':
      return 'locked-close-failed';
    case 'advisory-lock-release-failed':
      return 'locked-advisory-release-failed';
    default:
      return 'locked-operation-failed';
  }
}

function snapshotCleanupFailures(caught: unknown): SnapshotFailureCode[] {
  if (caught instanceof SnapshotError) return [...caught.cleanupFailures];
  if (caught instanceof ReconciliationLockedOperationError) {
    return [...snapshotCleanupFailures(caught.operationCause), ...caught.cleanupFailures.map(snapshotCleanupCode)];
  }
  return [];
}

function failedRecovery(caught: unknown): SnapshotRecoveryReport {
  const failure =
    caught instanceof SnapshotError
      ? caught.code
      : caught instanceof ReconciliationLockedOperationError
        ? caught.operationCause instanceof SnapshotError
          ? caught.operationCause.code
          : 'locked-operation-failed'
        : 'locked-operation-failed';
  return {
    reportVersion: SNAPSHOT_REPORT_VERSION,
    operation: 'recovery',
    status: 'operational-failure',
    generationId: null,
    restoredPaths: [],
    failure,
    cleanupFailures: snapshotCleanupFailures(caught),
  };
}

export function recoverDatabaseReconciliation(
  request: ReconciliationRequest,
  options: DatabaseSyncSnapshotOptions = {},
): SnapshotRecoveryReport {
  let retention: number;
  try {
    retention = validateRetention(options.keepSnapshots);
    const persistentRetention = retention === 0 ? DEFAULT_SNAPSHOT_RETENTION : retention;
    const decision = withLockedReconciliationDatabases(
      request,
      (inputs) => {
        const identity = identityFromCanonical(
          request.mode,
          inputs.map((input) => input.canonicalPath),
          options.snapshotRoot,
        );
        const unresolved = newestUnresolved(identity);
        if (unresolved === null) {
          const cleanupFailures: SnapshotFailureCode[] = [];
          return {
            value: {
              status: 'none' as const,
              generationId: null,
              restoredPaths: [],
              cleanupFailures,
            },
            afterCommit: () => cleanupStaging(identity.root, options, cleanupFailures),
          };
        }
        return recoverValidatedGeneration(identity, unresolved, inputs, options, persistentRetention);
      },
      {
        busyTimeoutMs: options.busyTimeoutMs,
        onEvent: options.onLockedOperationEvent,
        ...options.applyOptions,
      },
    );
    return recoveryReport(decision);
  } catch (caught) {
    return failedRecovery(caught);
  }
}

function capturesForPlan(
  plan: ReconciliationPlan,
  inputs: readonly {
    readonly role: ReconciliationInputRole;
    readonly canonicalPath: string;
    serialize(): Uint8Array;
  }[],
): GenerationCapture[] {
  return plan.targets.map((target) => {
    if (target.postimageDigest === null) {
      throw new SnapshotError('snapshot-image-mismatch', 'A mutating snapshot target is missing its postimage digest.');
    }
    const input = inputs.find((candidate) => candidate.canonicalPath === target.canonicalPath);
    if (input === undefined) {
      throw new SnapshotError('snapshot-image-mismatch', 'A snapshot target is missing from the locked input set.');
    }
    const validated = validateCapturedImage(input.serialize(), plan.schemaFingerprint, target.preimageDigest);
    return {
      role: target.role,
      canonicalPath: target.canonicalPath,
      preimageDigest: target.preimageDigest,
      postimageDigest: target.postimageDigest,
      ...validated,
    };
  });
}

function privateCleanup(
  root: string | null,
  identity: FileIdentity | null,
  options: DatabaseSyncSnapshotOptions,
  cleanupFailures: SnapshotFailureCode[],
): void {
  if (root === null || identity === null) return;
  try {
    removeBoundTree(root, identity, options);
  } catch {
    cleanupFailures.push('snapshot-cleanup-failed');
  }
}

function publishedGenerationId(published: PublishedGeneration | null): string | null {
  return published === null ? null : published.manifest.generation_id;
}

function recoverPrivateGeneration(
  published: PublishedGeneration,
  request: ReconciliationRequest,
  identity: SnapshotStoreIdentity,
  options: DatabaseSyncSnapshotOptions,
): SnapshotRecoveryReport {
  try {
    const decision = withLockedReconciliationDatabases(
      request,
      (inputs) => recoverValidatedGeneration(identity, readManifest(published.directory), inputs, options, 0),
      {
        busyTimeoutMs: options.busyTimeoutMs,
        onEvent: options.onLockedOperationEvent,
        ...options.applyOptions,
      },
    );
    return recoveryReport(decision);
  } catch (caught) {
    return failedRecovery(caught);
  }
}

export function applyDatabaseReconciliationWithSnapshots(
  plan: ReconciliationPlan,
  options: DatabaseSyncSnapshotOptions = {},
): SnapshotApplyReport {
  let retention: number;
  try {
    retention = validateRetention(options.keepSnapshots);
  } catch (caught) {
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'apply',
      status: 'operational-failure',
      generationId: null,
      recovery: failedRecovery(caught),
      apply: null,
      failure: caught instanceof SnapshotError ? caught.code : 'invalid-snapshot-option',
      cleanupFailures: [],
    };
  }
  const request = requestFromPlan(plan);
  const priorRecovery = recoverDatabaseReconciliation(request, options);
  if (priorRecovery.status !== 'none') {
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'apply',
      status: priorRecovery.status === 'operational-failure' ? 'operational-failure' : priorRecovery.status,
      generationId: priorRecovery.generationId,
      recovery: priorRecovery,
      apply: null,
      failure: priorRecovery.failure,
      cleanupFailures: priorRecovery.cleanupFailures,
    };
  }
  if (plan.status !== 'changed') {
    const apply = applyDatabaseReconciliation(plan, {
      busyTimeoutMs: options.busyTimeoutMs,
      onEvent: options.onApplyEvent,
      ...options.applyOptions,
    });
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'apply',
      status: apply.status,
      generationId: null,
      recovery: priorRecovery,
      apply,
      failure: null,
      cleanupFailures: apply.cleanupFailures.map(snapshotCleanupCode),
    };
  }

  const identity = identityFromCanonical(plan.mode, canonicalPathsFromPlan(plan), options.snapshotRoot);
  let published: PublishedGeneration | null = null;
  let privateRoot: string | null = null;
  let privateRootIdentity: FileIdentity | null = null;
  const cleanupFailures: SnapshotFailureCode[] = [...priorRecovery.cleanupFailures];
  try {
    if (retention === 0) {
      const created = createPrivateRoot();
      privateRoot = created.path;
      privateRootIdentity = created.identity;
    }
    const apply = applyDatabaseReconciliation(plan, {
      busyTimeoutMs: options.busyTimeoutMs,
      onEvent: options.onApplyEvent,
      ...options.applyOptions,
      onLocked: (inputs) => {
        const unresolved = newestUnresolved(identity);
        if (unresolved !== null) {
          throw new SnapshotError(
            'recovery-uncertain',
            'A persistent snapshot generation became unresolved after recovery and before apply.',
          );
        }
        const captures = capturesForPlan(plan, inputs);
        published = publishGeneration(identity, plan.schemaFingerprint, captures, options, privateRoot);
      },
    });
    cleanupFailures.push(...apply.cleanupFailures.map(snapshotCleanupCode));
    const recovery =
      retention === 0
        ? published === null
          ? recoveryReport({ status: 'none', generationId: null, restoredPaths: [], cleanupFailures: [] })
          : recoverPrivateGeneration(published, request, identity, options)
        : recoverDatabaseReconciliation(request, options);
    privateCleanup(privateRoot, privateRootIdentity, options, cleanupFailures);
    const status =
      recovery.status === 'none'
        ? apply.status
        : recovery.status === 'converged' && apply.status === 'changed'
          ? 'changed'
          : recovery.status === 'operational-failure'
            ? 'operational-failure'
            : recovery.status;
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'apply',
      status,
      generationId: publishedGenerationId(published) ?? recovery.generationId,
      recovery,
      apply,
      failure: recovery.failure,
      cleanupFailures: [...recovery.cleanupFailures, ...cleanupFailures],
    };
  } catch (caught) {
    privateCleanup(privateRoot, privateRootIdentity, options, cleanupFailures);
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'apply',
      status: 'operational-failure',
      generationId: publishedGenerationId(published),
      recovery: failedRecovery(caught),
      apply: null,
      failure: caught instanceof SnapshotError ? caught.code : 'snapshot-publication-failed',
      cleanupFailures: [...cleanupFailures, ...snapshotCleanupFailures(caught)],
    };
  }
}

export function rollbackDatabaseReconciliation(
  request: ReconciliationRequest,
  selectedGenerationId: string,
  options: DatabaseSyncSnapshotOptions = {},
): SnapshotRollbackReport {
  let retention: number;
  try {
    retention = validateRetention(options.keepSnapshots);
  } catch (caught) {
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'rollback',
      status: 'operational-failure',
      selectedGenerationId,
      safetyGenerationId: null,
      failure: caught instanceof SnapshotError ? caught.code : 'invalid-snapshot-option',
      cleanupFailures: [],
    };
  }
  const recovery = recoverDatabaseReconciliation(request, options);
  if (recovery.status === 'uncertain' || recovery.status === 'operational-failure') {
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'rollback',
      status: recovery.status === 'uncertain' ? 'uncertain' : 'operational-failure',
      selectedGenerationId,
      safetyGenerationId: null,
      failure: recovery.failure,
      cleanupFailures: recovery.cleanupFailures,
    };
  }

  let privateRoot: string | null = null;
  let privateRootIdentity: FileIdentity | null = null;
  let published: PublishedGeneration | null = null;
  const cleanupFailures: SnapshotFailureCode[] = [...recovery.cleanupFailures];
  try {
    if (retention === 0) {
      const created = createPrivateRoot();
      privateRoot = created.path;
      privateRootIdentity = created.identity;
    }
    const value = withLockedReconciliationDatabases(
      request,
      (inputs) => {
        const identity = identityFromCanonical(
          request.mode,
          inputs.map((input) => input.canonicalPath),
          options.snapshotRoot,
        );
        const racedUnresolved = newestUnresolved(identity);
        if (racedUnresolved !== null) {
          throw new SnapshotError(
            'recovery-uncertain',
            'A persistent snapshot generation became unresolved after recovery and before rollback.',
          );
        }
        const selected = validateGeneration(selectedGeneration(identity, selectedGenerationId));
        try {
          const captures = selected.manifest.targets.map((target) => {
            const input = targetInput(inputs, target.path);
            const current = input.observe();
            if (current.schemaFingerprint !== selected.manifest.schema_fingerprint) {
              throw new SnapshotError('snapshot-image-mismatch', 'Rollback target schema does not match the snapshot.');
            }
            const validated = validateCapturedImage(
              input.serialize(),
              current.schemaFingerprint,
              current.logicalDigest,
            );
            return {
              role: target.role,
              canonicalPath: target.path,
              preimageDigest: current.logicalDigest,
              postimageDigest: target.preimage_digest,
              ...validated,
            };
          });
          published = publishGeneration(identity, selected.manifest.schema_fingerprint, captures, options, privateRoot);
          for (const target of selected.manifest.targets) {
            const source = selected.snapshots.get(target.path);
            if (source === undefined)
              throw new SnapshotError('manifest-invalid', 'Rollback snapshot payload is missing.');
            around(
              options,
              { phase: 'rollback-restore', generationId: selectedGenerationId, role: target.role },
              () => {
                const restored = targetInput(inputs, target.path).restoreFrom(source);
                if (restored.logicalDigest !== target.preimage_digest) {
                  throw new SnapshotError('snapshot-image-mismatch', 'Rollback did not reproduce the selected image.');
                }
              },
            );
          }
          return {
            value: { identity, generation: published },
            afterCommit: () => {
              if (published === null) return;
              rewriteManifestState(published, 'rolled-back', options);
              if (retention > 0) {
                cleanupStaging(identity.root, options, cleanupFailures);
                pruneGenerations(identity, retention, options, cleanupFailures);
              }
            },
          };
        } finally {
          closeValidatedGeneration(selected);
        }
      },
      {
        busyTimeoutMs: options.busyTimeoutMs,
        onEvent: options.onLockedOperationEvent,
        ...options.applyOptions,
      },
    );
    privateCleanup(privateRoot, privateRootIdentity, options, cleanupFailures);
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'rollback',
      status: 'rolled-back',
      selectedGenerationId,
      safetyGenerationId: value.generation.manifest.generation_id,
      failure: null,
      cleanupFailures,
    };
  } catch (caught) {
    privateCleanup(privateRoot, privateRootIdentity, options, cleanupFailures);
    return {
      reportVersion: SNAPSHOT_REPORT_VERSION,
      operation: 'rollback',
      status: 'operational-failure',
      selectedGenerationId,
      safetyGenerationId: publishedGenerationId(published),
      failure: caught instanceof SnapshotError ? caught.code : 'locked-operation-failed',
      cleanupFailures: [...cleanupFailures, ...snapshotCleanupFailures(caught)],
    };
  }
}
