import { CString, FFIType, dlopen, toArrayBuffer } from 'bun:ffi';
import type { Pointer } from 'bun:ffi';
import { Database } from 'bun:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { linuxLibcCandidates } from '../install-transaction.js';
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
const POSIX_CLOSE_ON_EXEC = process.platform === 'darwin' ? 0x1000000 : 0x80000;

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
  /** Private N=0 root seams for aliased-temp and canonicalization fault tests. */
  readonly privateRoot?: {
    readonly temporaryDirectory?: string;
    readonly canonicalize?: (path: string) => string;
  };
  /** Lazy native descriptor-relative filesystem resolution seam for portability and fault tests. */
  readonly posixDirectory?: SnapshotPosixDirectoryDependencies;
  readonly applyOptions?: Omit<ReconciliationApplyOptions, 'busyTimeoutMs' | 'onEvent' | 'onLocked'>;
}

export interface SnapshotPosixDirectoryApi {
  openAt(directoryDescriptor: number, name: string, flags: number, mode?: number): number;
  mkdirAt(directoryDescriptor: number, name: string, mode: number): void;
  renameAt(
    sourceDirectoryDescriptor: number,
    sourceName: string,
    destinationDirectoryDescriptor: number,
    destinationName: string,
  ): void;
  unlinkAt(directoryDescriptor: number, name: string, directory: boolean): void;
  list(directoryDescriptor: number): readonly string[];
}

export interface SnapshotPosixDirectoryDependencies {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly linuxCandidates?: readonly string[];
  readonly linuxOpener?: (candidate: string, platform: 'linux') => SnapshotPosixDirectoryApi | null;
  readonly darwinOpener?: (candidate: string, platform: 'darwin') => SnapshotPosixDirectoryApi | null;
  readonly api?: SnapshotPosixDirectoryApi;
  /** Native fault seam: make the indexed readdir call return null with this errno. */
  readonly readdirError?: { readonly at: number; readonly errno: number; readonly list?: number };
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
  readonly binding: BoundDirectory;
}

interface ValidatedGeneration {
  readonly manifest: SnapshotManifestV1;
  readonly directory: string;
  readonly binding: BoundDirectory;
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

const MAX_DIRECTORY_ENTRIES = 4096;
const POSIX_DIRECTORY_SYMBOLS = {
  openat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32],
    returns: FFIType.i32,
  },
  mkdirat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.u32],
    returns: FFIType.i32,
  },
  renameat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring],
    returns: FFIType.i32,
  },
  unlinkat: {
    args: [FFIType.i32, FFIType.cstring, FFIType.i32],
    returns: FFIType.i32,
  },
  dup: {
    args: [FFIType.i32],
    returns: FFIType.i32,
  },
  fdopendir: {
    args: [FFIType.i32],
    returns: FFIType.ptr,
  },
  readdir: {
    args: [FFIType.ptr],
    returns: FFIType.ptr,
  },
  closedir: {
    args: [FFIType.ptr],
    returns: FFIType.i32,
  },
} as const;
const ERRNO_ACCESSOR_SYMBOL = {
  args: [],
  returns: FFIType.ptr,
} as const;
let defaultPosixDirectoryApi: SnapshotPosixDirectoryApi | null | undefined;

interface NativeDirectorySymbols {
  openat(directoryDescriptor: number, name: Uint8Array, flags: number, mode: number): number;
  mkdirat(directoryDescriptor: number, name: Uint8Array, mode: number): number;
  renameat(
    sourceDirectoryDescriptor: number,
    sourceName: Uint8Array,
    destinationDirectoryDescriptor: number,
    destinationName: Uint8Array,
  ): number;
  unlinkat(directoryDescriptor: number, name: Uint8Array, flags: number): number;
  dup(descriptor: number): number;
  fdopendir(descriptor: number): Pointer | null;
  readdir(stream: Pointer): Pointer | null;
  closedir(stream: Pointer): number;
}

function nativeError(operation: string, errno: number): Error & { code?: string; errno: number } {
  const error = new Error(`${operation} failed with errno ${errno}`) as Error & { code?: string; errno: number };
  error.errno = errno;
  if (errno === 2) error.code = 'ENOENT';
  return error;
}

function componentBytes(name: string): Uint8Array {
  if (name.length === 0 || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new SnapshotError('manifest-invalid', 'Snapshot entry name is not a safe path component.');
  }
  return new TextEncoder().encode(`${name}\0`);
}

function readNativeDirectory(
  stream: Pointer,
  symbols: NativeDirectorySymbols,
  errno: Int32Array,
  nameOffset: number,
  fault: SnapshotPosixDirectoryDependencies['readdirError'],
  listIndex: number,
): string[] {
  const entries: string[] = [];
  for (let readIndex = 0; ; readIndex++) {
    errno[0] = 0;
    const injected = fault?.at === readIndex && (fault.list === undefined || fault.list === listIndex);
    const entry = injected
      ? (() => {
          errno[0] = fault.errno;
          return null;
        })()
      : symbols.readdir(stream);
    if (entry === null) {
      if (errno[0] !== 0) throw nativeError('readdir', errno[0]);
      return entries;
    }
    const name = new CString(entry, nameOffset).toString();
    if (name === '.' || name === '..') continue;
    componentBytes(name);
    entries.push(name);
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new SnapshotError('manifest-invalid', 'Snapshot directory exceeds the bounded entry limit.');
    }
  }
}

function openPosixDirectoryApi(
  candidate: string,
  platform: 'linux' | 'darwin',
  readdirError?: SnapshotPosixDirectoryDependencies['readdirError'],
): SnapshotPosixDirectoryApi | null {
  try {
    const library =
      platform === 'darwin'
        ? dlopen(candidate, { ...POSIX_DIRECTORY_SYMBOLS, __error: ERRNO_ACCESSOR_SYMBOL })
        : dlopen(candidate, { ...POSIX_DIRECTORY_SYMBOLS, __errno_location: ERRNO_ACCESSOR_SYMBOL });
    const symbols = library.symbols as unknown as NativeDirectorySymbols &
      Partial<{ __error(): Pointer | null; __errno_location(): Pointer | null }>;
    const errnoPointer = platform === 'darwin' ? symbols.__error?.() : symbols.__errno_location?.();
    if (errnoPointer == null) return null;
    const errno = new Int32Array(toArrayBuffer(errnoPointer, 0, Int32Array.BYTES_PER_ELEMENT));
    const nameOffset = platform === 'darwin' ? 21 : 19;
    const removedDirectoryFlag = platform === 'darwin' ? 0x80 : 0x200;
    let listIndex = 0;
    return {
      openAt(directoryDescriptor, name, flags, mode = 0) {
        const descriptor = symbols.openat(directoryDescriptor, componentBytes(name), flags, mode);
        if (descriptor < 0) throw nativeError('openat', errno[0]);
        return descriptor;
      },
      mkdirAt(directoryDescriptor, name, mode) {
        if (symbols.mkdirat(directoryDescriptor, componentBytes(name), mode) !== 0) {
          throw nativeError('mkdirat', errno[0]);
        }
      },
      renameAt(sourceDirectoryDescriptor, sourceName, destinationDirectoryDescriptor, destinationName) {
        if (
          symbols.renameat(
            sourceDirectoryDescriptor,
            componentBytes(sourceName),
            destinationDirectoryDescriptor,
            componentBytes(destinationName),
          ) !== 0
        ) {
          throw new Error('renameat failed');
        }
      },
      unlinkAt(directoryDescriptor, name, directory) {
        if (symbols.unlinkat(directoryDescriptor, componentBytes(name), directory ? removedDirectoryFlag : 0) !== 0) {
          throw nativeError('unlinkat', errno[0]);
        }
      },
      list(directoryDescriptor) {
        const currentList = listIndex++;
        const duplicate = symbols.dup(directoryDescriptor);
        if (duplicate < 0) throw nativeError('dup', errno[0]);
        const stream = symbols.fdopendir(duplicate);
        if (stream === null) {
          closeSync(duplicate);
          throw nativeError('fdopendir', errno[0]);
        }
        let entries: string[];
        try {
          entries = readNativeDirectory(stream, symbols, errno, nameOffset, readdirError, currentList);
        } catch (caught) {
          symbols.closedir(stream);
          throw caught;
        }
        if (symbols.closedir(stream) !== 0) throw nativeError('closedir', errno[0]);
        return entries;
      },
    };
  } catch {
    return null;
  }
}

/**
 * Resolve the supported descriptor-relative POSIX surface lazily.
 *
 * No native library is loaded at module import. Linux tries the repository's
 * architecture-aware glibc/musl candidates; Darwin uses libSystem.
 */
export function resolveSnapshotPosixDirectory(
  dependencies?: SnapshotPosixDirectoryDependencies,
): SnapshotPosixDirectoryApi | null {
  if (dependencies?.api !== undefined) return dependencies.api;
  if (dependencies === undefined && defaultPosixDirectoryApi !== undefined) return defaultPosixDirectoryApi;
  const platform = dependencies?.platform ?? process.platform;
  const architecture = dependencies?.architecture ?? process.arch;
  let resolved: SnapshotPosixDirectoryApi | null = null;
  if (platform === 'linux') {
    const opener =
      dependencies?.linuxOpener ??
      ((candidate: string, target: 'linux') => openPosixDirectoryApi(candidate, target, dependencies?.readdirError));
    for (const candidate of dependencies?.linuxCandidates ?? linuxLibcCandidates(architecture)) {
      try {
        resolved = opener(candidate, 'linux');
      } catch {
        resolved = null;
      }
      if (resolved !== null) break;
    }
  } else if (platform === 'darwin') {
    try {
      const opener =
        dependencies?.darwinOpener ??
        ((candidate: string, target: 'darwin') => openPosixDirectoryApi(candidate, target, dependencies?.readdirError));
      resolved = opener('/usr/lib/libSystem.B.dylib', 'darwin');
    } catch {
      resolved = null;
    }
  }
  if (dependencies === undefined) defaultPosixDirectoryApi = resolved;
  return resolved;
}

function posixDirectory(options: DatabaseSyncSnapshotOptions): SnapshotPosixDirectoryApi {
  const api = resolveSnapshotPosixDirectory(options.posixDirectory);
  if (api === null) {
    throw new SnapshotError(
      'snapshot-publication-failed',
      'Descriptor-relative snapshot filesystem operations are unavailable on this platform.',
    );
  }
  return api;
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
        snapshotRoot === undefined
          ? join(dirname(sorted[0]), 'sync-snapshots', operationId)
          : normalizedSnapshotRoot(snapshotRoot),
      mode,
      canonicalPaths: sorted,
    };
  }
  const [source, destination] = canonicalPaths;
  const operationId = encodeIdentity('genie-db-sync-directional-pair-v1', [source, destination]);
  return {
    operationId,
    root:
      snapshotRoot === undefined ? join(dirname(destination), 'sync-snapshots') : normalizedSnapshotRoot(snapshotRoot),
    mode,
    canonicalPaths: [source, destination],
  };
}

function normalizedSnapshotRoot(path: string): string {
  if (!isAbsolute(path) || path.split('/').some((component) => component === '.' || component === '..')) {
    throw new SnapshotError('invalid-snapshot-option', 'Snapshot root must be a normalized absolute path.');
  }
  return resolve(path);
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

function rootComponents(path: string): readonly string[] {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) {
    throw new SnapshotError('manifest-invalid', 'Snapshot root must be a normalized absolute path.');
  }
  const components = path.split('/').filter(Boolean);
  if (components.some((component) => component === '.' || component === '..')) {
    throw new SnapshotError('manifest-invalid', 'Snapshot root contains an unsafe path component.');
  }
  return components;
}

function openRootComponent(
  api: SnapshotPosixDirectoryApi,
  parent: number,
  component: string,
  create: boolean,
): { readonly descriptor: number; readonly created: boolean } {
  const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | POSIX_CLOSE_ON_EXEC;
  try {
    return { descriptor: api.openAt(parent, component, flags), created: false };
  } catch (caught) {
    if (!create) throw caught;
    if (filesystemCode(caught) !== 'ENOENT') {
      throw new SnapshotError('manifest-invalid', 'Snapshot root is not a safe physical directory.');
    }
  }
  try {
    api.mkdirAt(parent, component, 0o700);
    return { descriptor: api.openAt(parent, component, flags), created: true };
  } catch {
    throw new SnapshotError('manifest-invalid', 'Snapshot root is not a safe physical directory.');
  }
}

function assertCreatedRootComponent(descriptor: number): void {
  const stats = fstatSync(descriptor);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
  if (!stats.isDirectory() || stats.uid !== currentUid || (stats.mode & 0o777) !== 0o700) {
    throw new SnapshotError('manifest-invalid', 'Created snapshot ancestor changed before descriptor binding.');
  }
}

function openBoundDirectory(
  path: string,
  create: boolean,
  options: DatabaseSyncSnapshotOptions,
  requirePrivate = false,
  allowShared = false,
): BoundDirectory {
  const api = posixDirectory(options);
  const components = rootComponents(path);
  let descriptor = openSync(
    '/',
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | POSIX_CLOSE_ON_EXEC,
  );
  try {
    for (const component of components) {
      const child = openRootComponent(api, descriptor, component, create);
      try {
        if (child.created) assertCreatedRootComponent(child.descriptor);
      } catch (caught) {
        closeSync(child.descriptor);
        throw caught;
      }
      closeSync(descriptor);
      descriptor = child.descriptor;
    }
    const stats = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
    const mode = stats.mode & 0o777;
    if (
      !stats.isDirectory() ||
      (!allowShared && (stats.uid !== currentUid || (requirePrivate ? mode !== 0o700 : (mode & 0o022) !== 0)))
    ) {
      throw new SnapshotError('manifest-invalid', 'Snapshot root must be a private directory owned by this user.');
    }
    return { path, descriptor, identity: fileIdentity(stats) };
  } catch (caught) {
    closeSync(descriptor);
    throw caught;
  }
}

function closeBoundDirectory(directory: BoundDirectory): void {
  closeSync(directory.descriptor);
}

function openBoundDirectoryAt(
  parent: BoundDirectory,
  name: string,
  path: string,
  options: DatabaseSyncSnapshotOptions,
  requirePrivate = false,
): BoundDirectory {
  const api = posixDirectory(options);
  let descriptor: number;
  try {
    descriptor = api.openAt(
      parent.descriptor,
      name,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | POSIX_CLOSE_ON_EXEC,
    );
  } catch {
    throw new SnapshotError('manifest-invalid', 'Snapshot child is not a safe physical directory.');
  }
  try {
    const stats = fstatSync(descriptor);
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : stats.uid;
    const mode = stats.mode & 0o777;
    if (!stats.isDirectory() || stats.uid !== currentUid || (requirePrivate ? mode !== 0o700 : (mode & 0o022) !== 0)) {
      throw new SnapshotError('manifest-invalid', 'Snapshot child must be a private directory owned by this user.');
    }
    return { path, descriptor, identity: fileIdentity(stats) };
  } catch (caught) {
    closeSync(descriptor);
    throw caught;
  }
}

function openRegularFileAt(
  directory: BoundDirectory,
  name: string,
  flags: number,
  options: DatabaseSyncSnapshotOptions,
  mode = 0,
): number {
  try {
    return posixDirectory(options).openAt(
      directory.descriptor,
      name,
      flags | fsConstants.O_NOFOLLOW | POSIX_CLOSE_ON_EXEC,
      mode,
    );
  } catch {
    throw new SnapshotError('manifest-invalid', 'Snapshot input must be a no-follow physical regular file.');
  }
}

function readBoundedRegularDescriptor(
  descriptor: number,
  maximumBytes: number,
): { readonly bytes: Uint8Array; readonly identity: FileIdentity } {
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
  return { bytes, identity };
}

function readBoundedRegularFileAt(
  directory: BoundDirectory,
  name: string,
  maximumBytes: number,
  options: DatabaseSyncSnapshotOptions,
): { readonly bytes: Uint8Array; readonly identity: FileIdentity } {
  const descriptor = openRegularFileAt(directory, name, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0), options);
  try {
    return readBoundedRegularDescriptor(descriptor, maximumBytes);
  } finally {
    closeSync(descriptor);
  }
}

function assertEntryIdentityAt(
  directory: BoundDirectory,
  name: string,
  identity: FileIdentity,
  kind: 'directory' | 'file',
  options: DatabaseSyncSnapshotOptions,
): void {
  let descriptor: number;
  try {
    descriptor =
      kind === 'directory'
        ? posixDirectory(options).openAt(
            directory.descriptor,
            name,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | POSIX_CLOSE_ON_EXEC,
          )
        : openRegularFileAt(directory, name, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0), options);
  } catch {
    throw new SnapshotError('manifest-invalid', `Snapshot ${kind} identity changed during the operation.`);
  }
  try {
    const stats = fstatSync(descriptor);
    const validType = kind === 'directory' ? stats.isDirectory() : stats.isFile();
    if (!validType || !sameFileIdentity(identity, stats)) {
      throw new SnapshotError('manifest-invalid', `Snapshot ${kind} identity changed during the operation.`);
    }
  } finally {
    closeSync(descriptor);
  }
}

function assertBoundDirectory(directory: BoundDirectory): void {
  const stats = fstatSync(directory.descriptor);
  if (!stats.isDirectory() || !sameFileIdentity(directory.identity, stats)) {
    throw new SnapshotError('manifest-invalid', 'Snapshot directory binding changed during the operation.');
  }
}

function assertBoundRoot(directory: BoundDirectory, options: DatabaseSyncSnapshotOptions): void {
  const reopened = openBoundDirectory(directory.path, false, options);
  try {
    if (!sameFileIdentity(directory.identity, reopened.identity)) {
      throw new SnapshotError('manifest-invalid', 'Snapshot root identity changed during the operation.');
    }
  } finally {
    closeBoundDirectory(reopened);
  }
}

function writeJsonDescriptor(descriptor: number, manifest: SnapshotManifestV1): void {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  let offset = 0;
  while (offset < bytes.byteLength) {
    offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
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

function cleanupFailedPrivateRoot(
  lexicalPath: string,
  physicalParent: string,
  name: string,
  identity: FileIdentity,
  options: DatabaseSyncSnapshotOptions,
): SnapshotFailureCode[] {
  try {
    options.removeTree?.(lexicalPath);
    const parent = openBoundDirectory(physicalParent, false, options, false, true);
    try {
      removeBoundTreeAt(parent, name, join(physicalParent, name), identity, options);
    } finally {
      closeBoundDirectory(parent);
    }
    return [];
  } catch {
    return ['snapshot-cleanup-failed'];
  }
}

function privateRootFailure(caught: unknown, cleanupFailures: readonly SnapshotFailureCode[]): SnapshotError {
  if (caught instanceof SnapshotError) {
    return new SnapshotError(caught.code, caught.message, [...caught.cleanupFailures, ...cleanupFailures]);
  }
  return new SnapshotError(
    'snapshot-publication-failed',
    caught instanceof Error ? caught.message : 'Private snapshot root setup failed.',
    cleanupFailures,
  );
}

function createPrivateRoot(options: DatabaseSyncSnapshotOptions): {
  readonly path: string;
  readonly identity: FileIdentity;
} {
  const temporaryDirectory = options.privateRoot?.temporaryDirectory ?? tmpdir();
  const physicalParent = realpathSync(temporaryDirectory);
  const lexicalRoot = mkdtempSync(join(temporaryDirectory, 'genie-db-sync-private-'));
  const initial = lstatSync(lexicalRoot);
  const identity = fileIdentity(initial);
  const name = basename(lexicalRoot);
  let cleanupParent = physicalParent;
  try {
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : initial.uid;
    if (
      !initial.isDirectory() ||
      initial.isSymbolicLink() ||
      initial.uid !== currentUid ||
      (initial.mode & 0o777) !== 0o700
    ) {
      throw new SnapshotError(
        'snapshot-publication-failed',
        'Private snapshot directory was not created with mode 0700.',
      );
    }
    const canonicalize = options.privateRoot?.canonicalize ?? realpathSync;
    const physicalRoot = canonicalize(lexicalRoot);
    if (!isAbsolute(physicalRoot) || resolve(physicalRoot) !== physicalRoot || basename(physicalRoot) !== name) {
      throw new SnapshotError('snapshot-publication-failed', 'Private snapshot directory canonical identity changed.');
    }
    cleanupParent = dirname(physicalRoot);
    const binding = openBoundDirectory(physicalRoot, false, options, true);
    try {
      if (!sameFileIdentity(identity, binding.identity)) {
        throw new SnapshotError('snapshot-publication-failed', 'Private snapshot directory identity changed.');
      }
      return { path: physicalRoot, identity };
    } finally {
      closeBoundDirectory(binding);
    }
  } catch (caught) {
    throw privateRootFailure(caught, cleanupFailedPrivateRoot(lexicalRoot, cleanupParent, name, identity, options));
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
  const rootBinding = openBoundDirectory(root, true, options, privateRoot !== null);
  let stagingBinding: BoundDirectory | null = null;
  let manifestDescriptor: number | null = null;
  const payloadDescriptors: number[] = [];
  try {
    const api = posixDirectory(options);
    const generated = generationId(identity, options);
    const stagingName = `${STAGING_PREFIX}${generated.id}-${randomUUID()}`;
    const staging = join(root, stagingName);
    const finalDirectory = join(root, generated.id);
    api.mkdirAt(rootBinding.descriptor, stagingName, 0o700);
    stagingBinding = openBoundDirectoryAt(rootBinding, stagingName, staging, options, true);
    const provisional = makeManifest(
      identity,
      schemaFingerprint,
      captures,
      generated.id,
      generated.createdAt,
      'provisional',
      false,
    );
    for (let index = 0; index < captures.length; index++) {
      const capture = captures[index];
      around(options, { phase: 'payload-write', generationId: generated.id, role: capture.role }, () =>
        (() => {
          const descriptor = openRegularFileAt(
            stagingBinding as BoundDirectory,
            provisional.targets[index].snapshot_file,
            fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
            options,
            0o600,
          );
          payloadDescriptors.push(descriptor);
          writeFileSync(descriptor, capture.normalizedBytes);
        })(),
      );
    }
    around(options, { phase: 'provisional-manifest-write', generationId: generated.id }, () =>
      (() => {
        manifestDescriptor = openRegularFileAt(
          stagingBinding as BoundDirectory,
          MANIFEST_FILE,
          fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
          options,
          0o600,
        );
        writeJsonDescriptor(manifestDescriptor, provisional);
      })(),
    );
    for (let index = 0; index < provisional.targets.length; index++) {
      const target = provisional.targets[index];
      around(options, { phase: 'payload-fsync', generationId: generated.id, role: target.role }, () =>
        fsyncSync(payloadDescriptors[index]),
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
        ftruncateSync(manifestDescriptor as number, 0);
        writeJsonDescriptor(manifestDescriptor as number, complete);
      })(),
    );
    around(options, { phase: 'complete-manifest-fsync', generationId: generated.id }, () =>
      fsyncSync(manifestDescriptor as number),
    );
    around(options, { phase: 'staging-fsync', generationId: generated.id }, () => {
      fsyncSync((stagingBinding as BoundDirectory).descriptor);
    });
    around(options, { phase: 'generation-rename', generationId: generated.id }, () => {
      assertBoundRoot(rootBinding, options);
      assertEntryIdentityAt(
        rootBinding,
        stagingName,
        (stagingBinding as BoundDirectory).identity,
        'directory',
        options,
      );
      assertEntryIdentityAt(
        stagingBinding as BoundDirectory,
        MANIFEST_FILE,
        fileIdentity(fstatSync(manifestDescriptor as number)),
        'file',
        options,
      );
      for (let index = 0; index < provisional.targets.length; index++) {
        assertEntryIdentityAt(
          stagingBinding as BoundDirectory,
          provisional.targets[index].snapshot_file,
          fileIdentity(fstatSync(payloadDescriptors[index])),
          'file',
          options,
        );
      }
      api.renameAt(rootBinding.descriptor, stagingName, rootBinding.descriptor, generated.id);
      assertEntryIdentityAt(
        rootBinding,
        generated.id,
        (stagingBinding as BoundDirectory).identity,
        'directory',
        options,
      );
    });
    around(options, { phase: 'root-fsync', generationId: generated.id }, () => {
      assertBoundRoot(rootBinding, options);
      assertEntryIdentityAt(
        rootBinding,
        generated.id,
        (stagingBinding as BoundDirectory).identity,
        'directory',
        options,
      );
      fsyncSync(rootBinding.descriptor);
      assertBoundRoot(rootBinding, options);
    });
    if (manifestDescriptor === null) {
      throw new SnapshotError('snapshot-publication-failed', 'Snapshot manifest descriptor was not created.');
    }
    const manifestIdentity = fileIdentity(fstatSync(manifestDescriptor));
    return {
      manifest: complete,
      directory: finalDirectory,
      directoryIdentity: (stagingBinding as BoundDirectory).identity,
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
    if (manifestDescriptor !== null) closeSync(manifestDescriptor);
    for (const descriptor of payloadDescriptors) closeSync(descriptor);
    if (stagingBinding !== null) closeBoundDirectory(stagingBinding);
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

function readManifestAt(
  rootBinding: BoundDirectory,
  name: string,
  options: DatabaseSyncSnapshotOptions,
): GenerationReference {
  const directory = join(rootBinding.path, name);
  const directoryBinding = openBoundDirectoryAt(rootBinding, name, directory, options, true);
  let parsed: unknown;
  try {
    const loaded = readBoundedRegularFileAt(directoryBinding, MANIFEST_FILE, MAX_MANIFEST_BYTES, options);
    parsed = JSON.parse(new TextDecoder().decode(loaded.bytes)) as unknown;
    const manifest = parseManifest(parsed);
    if (name !== manifest.generation_id) {
      throw new SnapshotError('manifest-invalid', 'Snapshot generation directory does not match its manifest.');
    }
    return {
      manifest,
      directory,
      directoryIdentity: directoryBinding.identity,
      manifestIdentity: loaded.identity,
      binding: directoryBinding,
    };
  } catch {
    closeBoundDirectory(directoryBinding);
    throw new SnapshotError('manifest-invalid', 'Snapshot manifest is not valid JSON.');
  }
}

function readPublishedGeneration(
  published: PublishedGeneration,
  options: DatabaseSyncSnapshotOptions,
): GenerationReference {
  const rootPath = dirname(published.directory);
  const rootBinding = openBoundDirectory(rootPath, false, options, published.privateRoot !== null);
  try {
    const generation = readManifestAt(rootBinding, published.manifest.generation_id, options);
    if (
      !sameFileIdentity(published.directoryIdentity, generation.directoryIdentity) ||
      !sameFileIdentity(published.manifestIdentity, generation.manifestIdentity)
    ) {
      closeBoundDirectory(generation.binding);
      throw new SnapshotError('manifest-invalid', 'Published snapshot generation identity changed.');
    }
    return generation;
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

function reopenGeneration(generation: GenerationReference, options: DatabaseSyncSnapshotOptions): GenerationReference {
  const rootPath = dirname(generation.directory);
  const rootBinding = openBoundDirectory(rootPath, false, options);
  try {
    const reopened = readManifestAt(rootBinding, basename(generation.directory), options);
    if (
      !sameFileIdentity(generation.directoryIdentity, reopened.directoryIdentity) ||
      !sameFileIdentity(generation.manifestIdentity, reopened.manifestIdentity)
    ) {
      closeBoundDirectory(reopened.binding);
      throw new SnapshotError('manifest-invalid', 'Snapshot generation identity changed before state rewrite.');
    }
    return reopened;
  } finally {
    closeBoundDirectory(rootBinding);
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

function matchingGenerationNames(
  identity: SnapshotStoreIdentity,
  rootBinding: BoundDirectory,
  options: DatabaseSyncSnapshotOptions,
): string[] {
  return posixDirectory(options)
    .list(rootBinding.descriptor)
    .filter((name) => name.startsWith(`${identity.operationId}${GENERATION_SEPARATOR}`))
    .sort((left, right) => compareText(right, left));
}

function newestUnresolved(
  identity: SnapshotStoreIdentity,
  options: DatabaseSyncSnapshotOptions,
): GenerationReference | null {
  let rootBinding: BoundDirectory;
  try {
    rootBinding = openBoundDirectory(identity.root, false, options);
  } catch (caught) {
    if (filesystemCode(caught) === 'ENOENT') return null;
    throw caught;
  }
  try {
    for (const name of matchingGenerationNames(identity, rootBinding, options)) {
      const generation = readManifestAt(rootBinding, name, options);
      try {
        validateManifestIdentity(generation.manifest, identity);
        if (generation.manifest.state === 'complete' || generation.manifest.state === 'uncertain') {
          return generation;
        }
      } catch (caught) {
        closeBoundDirectory(generation.binding);
        throw caught;
      }
      closeBoundDirectory(generation.binding);
    }
    return null;
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

function selectedGeneration(
  identity: SnapshotStoreIdentity,
  selectedGenerationId: string,
  options: DatabaseSyncSnapshotOptions,
): GenerationReference {
  if (!GENERATION_ID_PATTERN.test(selectedGenerationId) || !selectedGenerationId.startsWith(identity.operationId)) {
    throw new SnapshotError('generation-not-found', 'Selected snapshot generation does not belong to this operation.');
  }
  let rootBinding: BoundDirectory;
  try {
    rootBinding = openBoundDirectory(identity.root, false, options);
  } catch {
    throw new SnapshotError('generation-not-found', 'Selected snapshot generation does not exist.');
  }
  try {
    if (!matchingGenerationNames(identity, rootBinding, options).includes(selectedGenerationId)) {
      throw new SnapshotError('generation-not-found', 'Selected snapshot generation does not exist.');
    }
    const generation = readManifestAt(rootBinding, selectedGenerationId, options);
    try {
      validateManifestIdentity(generation.manifest, identity);
      if (
        generation.manifest.state === 'provisional' ||
        generation.manifest.targets.some((target) => target.snapshot_sha256 === null)
      ) {
        throw new SnapshotError('manifest-invalid', 'Selected snapshot generation is incomplete.');
      }
      return generation;
    } catch (caught) {
      closeBoundDirectory(generation.binding);
      throw caught;
    }
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

function validateGeneration(
  generation: GenerationReference,
  options: DatabaseSyncSnapshotOptions,
): ValidatedGeneration {
  const snapshots = new Map<string, Database>();
  try {
    for (const target of generation.manifest.targets) {
      if (target.snapshot_sha256 === null) {
        throw new SnapshotError('manifest-invalid', 'Complete snapshot manifest is missing a payload hash.');
      }
      assertBoundDirectory(generation.binding);
      assertEntryIdentityAt(generation.binding, MANIFEST_FILE, generation.manifestIdentity, 'file', options);
      const bytes = readBoundedRegularFileAt(
        generation.binding,
        target.snapshot_file,
        MAX_RECONCILIATION_DATABASE_BYTES,
        options,
      ).bytes;
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
      assertBoundDirectory(generation.binding);
      assertEntryIdentityAt(generation.binding, MANIFEST_FILE, generation.manifestIdentity, 'file', options);
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

function removeBoundTreeAt(
  parent: BoundDirectory,
  name: string,
  path: string,
  expected: FileIdentity,
  options: DatabaseSyncSnapshotOptions,
): void {
  const api = posixDirectory(options);
  const directory = openBoundDirectoryAt(parent, name, path, options);
  try {
    if (!sameFileIdentity(expected, directory.identity)) {
      throw new SnapshotError('snapshot-cleanup-failed', 'Snapshot cleanup target identity changed.');
    }
    for (const childName of api.list(directory.descriptor)) {
      const childPath = join(path, childName);
      let childDescriptor: number | null = null;
      try {
        childDescriptor = api.openAt(
          directory.descriptor,
          childName,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_NONBLOCK ?? 0) | POSIX_CLOSE_ON_EXEC,
        );
      } catch {
        // A no-follow open rejects symlinks. unlinkat removes the link itself,
        // never the object it names.
      }
      if (childDescriptor === null) {
        api.unlinkAt(directory.descriptor, childName, false);
        continue;
      }
      try {
        const stats = fstatSync(childDescriptor);
        const childIdentity = fileIdentity(stats);
        if (stats.isDirectory()) {
          closeSync(childDescriptor);
          childDescriptor = null;
          removeBoundTreeAt(directory, childName, childPath, childIdentity, options);
        } else {
          assertEntryIdentityAt(directory, childName, childIdentity, 'file', options);
          api.unlinkAt(directory.descriptor, childName, false);
        }
      } finally {
        if (childDescriptor !== null) closeSync(childDescriptor);
      }
    }
    fsyncSync(directory.descriptor);
  } finally {
    closeBoundDirectory(directory);
  }
  assertEntryIdentityAt(parent, name, expected, 'directory', options);
  api.unlinkAt(parent.descriptor, name, true);
}

function removeBoundTree(path: string, expected: FileIdentity, options: DatabaseSyncSnapshotOptions): void {
  assertPathIdentity(path, expected, 'directory');
  options.removeTree?.(path);
  const parentPath = dirname(path);
  const parent = openBoundDirectory(parentPath, false, options, false, true);
  try {
    removeBoundTreeAt(parent, basename(path), path, expected, options);
  } finally {
    closeBoundDirectory(parent);
  }
}

function rewriteManifestState(
  generation: GenerationReference,
  state: Exclude<SnapshotGenerationState, 'provisional' | 'complete'>,
  options: DatabaseSyncSnapshotOptions,
): SnapshotManifestV1 {
  const updated = { ...generation.manifest, state };
  const temporaryName = `.manifest-${randomUUID()}.tmp`;
  let temporaryIdentity: FileIdentity | null = null;
  let temporaryDescriptor: number | null = null;
  let temporaryPublished = false;
  try {
    assertBoundDirectory(generation.binding);
    assertEntryIdentityAt(generation.binding, MANIFEST_FILE, generation.manifestIdentity, 'file', options);
    around(options, { phase: 'state-rewrite-write', generationId: generation.manifest.generation_id }, () => {
      temporaryDescriptor = openRegularFileAt(
        generation.binding,
        temporaryName,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        options,
        0o600,
      );
      writeJsonDescriptor(temporaryDescriptor, updated);
      temporaryIdentity = fileIdentity(fstatSync(temporaryDescriptor));
    });
    around(options, { phase: 'state-rewrite-fsync', generationId: generation.manifest.generation_id }, () => {
      fsyncSync(temporaryDescriptor as number);
    });
    around(options, { phase: 'state-rewrite-rename', generationId: generation.manifest.generation_id }, () => {
      assertBoundDirectory(generation.binding);
      assertEntryIdentityAt(generation.binding, MANIFEST_FILE, generation.manifestIdentity, 'file', options);
      assertEntryIdentityAt(generation.binding, temporaryName, temporaryIdentity as FileIdentity, 'file', options);
      posixDirectory(options).renameAt(
        generation.binding.descriptor,
        temporaryName,
        generation.binding.descriptor,
        MANIFEST_FILE,
      );
      temporaryPublished = true;
      assertEntryIdentityAt(generation.binding, MANIFEST_FILE, temporaryIdentity as FileIdentity, 'file', options);
    });
    around(options, { phase: 'generation-fsync', generationId: generation.manifest.generation_id }, () => {
      assertBoundDirectory(generation.binding);
      fsyncSync(generation.binding.descriptor);
    });
    return updated;
  } catch (caught) {
    const cleanupFailures: SnapshotFailureCode[] = [];
    if (temporaryIdentity !== null && !temporaryPublished) {
      try {
        assertEntryIdentityAt(generation.binding, temporaryName, temporaryIdentity, 'file', options);
        posixDirectory(options).unlinkAt(generation.binding.descriptor, temporaryName, false);
      } catch {
        cleanupFailures.push('snapshot-cleanup-failed');
      }
    }
    if (caught instanceof SnapshotError) {
      throw new SnapshotError(caught.code, caught.message, [...caught.cleanupFailures, ...cleanupFailures]);
    }
    throw new SnapshotError('snapshot-publication-failed', 'Snapshot manifest state rewrite failed.', cleanupFailures);
  } finally {
    if (temporaryDescriptor !== null) closeSync(temporaryDescriptor);
  }
}

function cleanupStaging(
  root: string,
  options: DatabaseSyncSnapshotOptions,
  cleanupFailures: SnapshotFailureCode[],
): void {
  let rootBinding: BoundDirectory;
  try {
    rootBinding = openBoundDirectory(root, false, options);
  } catch (caught) {
    if (filesystemCode(caught) === 'ENOENT') return;
    cleanupFailures.push('snapshot-cleanup-failed');
    return;
  }
  try {
    for (const name of posixDirectory(options).list(rootBinding.descriptor)) {
      if (!name.startsWith(STAGING_PREFIX)) continue;
      const path = join(root, name);
      let staging: BoundDirectory;
      try {
        staging = openBoundDirectoryAt(rootBinding, name, path, options);
      } catch {
        continue;
      }
      try {
        around(options, { phase: 'staging-cleanup', path }, () =>
          removeBoundTreeAt(rootBinding, name, path, staging.identity, options),
        );
      } catch {
        cleanupFailures.push('snapshot-cleanup-failed');
      } finally {
        closeBoundDirectory(staging);
      }
    }
  } catch {
    cleanupFailures.push('snapshot-cleanup-failed');
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

function pruneGenerations(
  identity: SnapshotStoreIdentity,
  retention: number,
  options: DatabaseSyncSnapshotOptions,
  cleanupFailures: SnapshotFailureCode[],
): void {
  let rootBinding: BoundDirectory;
  try {
    rootBinding = openBoundDirectory(identity.root, false, options);
  } catch (caught) {
    if (filesystemCode(caught) === 'ENOENT') return;
    cleanupFailures.push('snapshot-cleanup-failed');
    return;
  }
  let removed = false;
  try {
    const names = matchingGenerationNames(identity, rootBinding, options);
    const retained = new Set(names.slice(0, retention));
    for (const name of names) {
      if (retained.has(name)) continue;
      let manifest: GenerationReference | null = null;
      const directory = join(identity.root, name);
      try {
        manifest = readManifestAt(rootBinding, name, options);
        validateManifestIdentity(manifest.manifest, identity);
        if (manifest.manifest.state === 'complete' || manifest.manifest.state === 'uncertain') continue;
        around(options, { phase: 'prune', generationId: manifest.manifest.generation_id, path: directory }, () =>
          removeBoundTreeAt(rootBinding, name, directory, (manifest as GenerationReference).directoryIdentity, options),
        );
        removed = true;
      } catch {
        cleanupFailures.push('snapshot-cleanup-failed');
      } finally {
        if (manifest !== null) closeBoundDirectory(manifest.binding);
      }
    }
    if (removed) fsyncSync(rootBinding.descriptor);
  } catch {
    cleanupFailures.push('snapshot-cleanup-failed');
  } finally {
    closeBoundDirectory(rootBinding);
  }
}

/*
 * Keep this pathname wrapper only for private-temp cleanup and the existing
 * deterministic cleanup-failure seam. Persistent cleanup and pruning call the
 * parent-descriptor form above.
 */
function removePrivateTree(path: string, expected: FileIdentity, options: DatabaseSyncSnapshotOptions): void {
  try {
    removeBoundTree(path, expected, options);
  } catch {
    throw new SnapshotError('snapshot-cleanup-failed', 'Private snapshot cleanup failed.');
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
  cleanupPersistentStaging = true,
): { value: RecoveryDecision; afterCommit: () => void } {
  if (generation.manifest.state === 'uncertain') {
    closeBoundDirectory(generation.binding);
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
  const validated = validateGeneration(generation, options);
  let status: RecoveryDecision['status'];
  const restoreTargets: SnapshotManifestTarget[] = [];
  const restoredPaths: string[] = [];
  try {
    const observed = new Map(inputs.map((input) => [input.canonicalPath, input.observe().logicalDigest]));
    const classifications = generation.manifest.targets.map((target) => ({
      target,
      current: observed.get(target.path),
      pre: observed.get(target.path) === target.preimage_digest,
      post: observed.get(target.path) === target.postimage_digest,
    }));
    emit(options, { phase: 'recovery-classify', state: 'before', generationId: generation.manifest.generation_id });
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
  closeBoundDirectory(generation.binding);
  return {
    value: {
      status,
      generationId: generation.manifest.generation_id,
      restoredPaths,
      cleanupFailures,
    },
    afterCommit: () => {
      const rebound = reopenGeneration(generation, options);
      try {
        rewriteManifestState(rebound, status === 'uncertain' ? 'uncertain' : status, options);
        if (cleanupPersistentStaging) cleanupStaging(identity.root, options, cleanupFailures);
        if (status !== 'uncertain') pruneGenerations(identity, retention, options, cleanupFailures);
      } finally {
        closeBoundDirectory(rebound.binding);
      }
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
        const unresolved = newestUnresolved(identity, options);
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
        try {
          return recoverValidatedGeneration(identity, unresolved, inputs, options, persistentRetention);
        } catch (caught) {
          closeBoundDirectory(unresolved.binding);
          throw caught;
        }
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
    removePrivateTree(root, identity, options);
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
      (inputs) => {
        const generation = readPublishedGeneration(published, options);
        try {
          return recoverValidatedGeneration(identity, generation, inputs, options, 0, false);
        } catch (caught) {
          closeBoundDirectory(generation.binding);
          throw caught;
        }
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
      const created = createPrivateRoot(options);
      privateRoot = created.path;
      privateRootIdentity = created.identity;
    }
    const apply = applyDatabaseReconciliation(plan, {
      busyTimeoutMs: options.busyTimeoutMs,
      onEvent: options.onApplyEvent,
      ...options.applyOptions,
      onLocked: (inputs) => {
        const unresolved = newestUnresolved(identity, options);
        if (unresolved !== null) {
          closeBoundDirectory(unresolved.binding);
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
      const created = createPrivateRoot(options);
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
        const racedUnresolved = newestUnresolved(identity, options);
        if (racedUnresolved !== null) {
          closeBoundDirectory(racedUnresolved.binding);
          throw new SnapshotError(
            'recovery-uncertain',
            'A persistent snapshot generation became unresolved after recovery and before rollback.',
          );
        }
        const selectedReference = selectedGeneration(identity, selectedGenerationId, options);
        let selected: ValidatedGeneration;
        try {
          selected = validateGeneration(selectedReference, options);
        } catch (caught) {
          closeBoundDirectory(selectedReference.binding);
          throw caught;
        }
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
              const generation = readPublishedGeneration(published, options);
              try {
                rewriteManifestState(generation, 'rolled-back', options);
              } finally {
                closeBoundDirectory(generation.binding);
              }
              if (retention > 0) cleanupStaging(identity.root, options, cleanupFailures);
              pruneGenerations(identity, retention, options, cleanupFailures);
            },
          };
        } finally {
          closeValidatedGeneration(selected);
          closeBoundDirectory(selected.binding);
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
