import { dlopen } from 'bun:ffi';
import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const LINUX_RENAME_NOREPLACE = 1;
const DARWIN_RENAME_EXCL = 4;
const LINUX_LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.so',
  'ld-musl-x86_64.so.1',
  'libc.musl-x86_64.so.1',
  'ld-musl-aarch64.so.1',
  'libc.musl-aarch64.so.1',
] as const;

type BigStat = ReturnType<typeof lstatBigInt>;
export type NativeNoReplaceRename = (
  sourceParentFd: number,
  source: Buffer,
  targetParentFd: number,
  target: Buffer,
) => number;

export interface NativeNoReplaceDependencies {
  platform?: NodeJS.Platform;
  linuxOpener?: (soname: string) => NativeNoReplaceRename | null;
  linuxCandidates?: readonly string[];
  darwinOpener?: () => NativeNoReplaceRename | null;
  /** Resolve the current path of a held directory fd (test seam for cross-platform simulation). */
  directoryPathForFd?: (fd: number, originalPath: string) => string;
  /** Deterministic boundary immediately after the last pathname validation. */
  beforeInvoke?: () => void;
  /** Deterministic boundary after the native call and before outcome reconciliation. */
  afterInvoke?: () => void;
  /** Durability seam; production fsyncs the held physical parent descriptors. */
  fsyncDirectoryFd?: (fd: number) => void;
}

export interface PhysicalPathIdentity {
  schemaVersion: 1;
  kind: 'file' | 'directory' | 'symlink';
  device: string;
  inode: string;
  mode: string;
  uid: string;
  gid: string;
  links: string;
  size: string;
  modifiedNanoseconds: string;
  digest: string;
}

export interface NoClobberRenameResult {
  committed: true;
  /** True only when every physical parent changed by the rename was fsynced through its held descriptor. */
  durable: boolean;
  durabilityErrors?: Array<{ parent: 'source' | 'target'; name: string; message: string }>;
  /** A concurrent writer reused the consumed source name; it remains untouched. */
  sourcePathOccupied: boolean;
  /** False means an ancestor was renamed, but the dirfd-bound target is still exact at `committedTargetPath`. */
  parentPathsStable: boolean;
  committedTargetPath: string;
  reconciledAfterNativeError: boolean;
  postInvokeError?: { name: string; message: string };
}

interface PhysicalDirectoryIdentity {
  device: string;
  inode: string;
  mode: string;
  uid: string;
  gid: string;
}

export class NativeNoReplaceUnavailableError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`native no-clobber rename is unavailable on ${platform}`);
    this.name = 'NativeNoReplaceUnavailableError';
  }
}

export class PhysicalPathIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhysicalPathIdentityError';
  }
}

export class NoClobberRenameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoClobberRenameError';
  }
}

function lstatBigInt(path: string) {
  return lstatSync(path, { bigint: true });
}

function fstatBigInt(fd: number) {
  return fstatSync(fd, { bigint: true });
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function pathKind(stat: BigStat): PhysicalPathIdentity['kind'] {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory() && !stat.isSymbolicLink()) return 'directory';
  if (stat.isSymbolicLink()) return 'symlink';
  throw new PhysicalPathIdentityError('transaction paths must be regular files, physical directories, or symlinks');
}

function statStable(left: BigStat, right: BigStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function updateStatDigest(hash: ReturnType<typeof createHash>, relativePath: string, stat: BigStat): void {
  hash.update(`${relativePath}\0${pathKind(stat)}\0`);
  hash.update(
    `${stat.dev}\0${stat.ino}\0${stat.mode}\0${stat.uid}\0${stat.gid}\0${stat.nlink}\0${stat.size}\0${stat.mtimeNs}\0`,
  );
}

/** Read a regular file through one O_NOFOLLOW descriptor and bind bytes to both pathname observations. */
function digestPhysicalFile(
  path: string,
  relativePath: string,
  pathStat: BigStat,
  hash: ReturnType<typeof createHash>,
) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatBigInt(fd);
    if (!before.isFile() || !statStable(pathStat, before)) {
      throw new PhysicalPathIdentityError(`physical file changed before it could be read: ${path}`);
    }
    const bytes = readFileSync(fd);
    const after = fstatBigInt(fd);
    const pathAfter = lstatBigInt(path);
    if (!statStable(before, after) || !statStable(after, pathAfter)) {
      throw new PhysicalPathIdentityError(`physical file changed while it was read: ${path}`);
    }
    hash.update(`${relativePath}\0bytes\0`);
    hash.update(bytes);
  } finally {
    closeSync(fd);
  }
}

function digestPhysicalNode(path: string, relativePath: string, hash: ReturnType<typeof createHash>): BigStat {
  const before = lstatBigInt(path);
  const kind = pathKind(before);
  updateStatDigest(hash, relativePath, before);
  if (kind === 'file') {
    digestPhysicalFile(path, relativePath, before, hash);
    return before;
  }
  if (kind === 'symlink') {
    const target = readlinkSync(path);
    const after = lstatBigInt(path);
    if (!statStable(before, after)) throw new PhysicalPathIdentityError(`symlink changed while it was read: ${path}`);
    hash.update(`${relativePath}\0target\0${target}\0`);
    return before;
  }
  const names = readdirSync(path).sort((left, right) => left.localeCompare(right));
  for (const name of names) digestPhysicalNode(join(path, name), `${relativePath}/${name}`, hash);
  const after = lstatBigInt(path);
  if (!statStable(before, after)) throw new PhysicalPathIdentityError(`directory changed while it was read: ${path}`);
  return before;
}

/**
 * Exact physical identity for a transaction pathname. Directory digests have
 * no exclusions and include every descendant inode, mode, and byte. A regular
 * file is read through O_NOFOLLOW and one stable descriptor.
 */
export function inspectPhysicalPath(path: string): PhysicalPathIdentity | null {
  const absolute = resolve(path);
  let initial: BigStat;
  try {
    initial = lstatBigInt(absolute);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
  const hash = createHash('sha256');
  const stable = digestPhysicalNode(absolute, '.', hash);
  if (!statStable(initial, stable)) throw new PhysicalPathIdentityError(`path changed during inspection: ${absolute}`);
  return {
    schemaVersion: 1,
    kind: pathKind(stable),
    device: stable.dev.toString(),
    inode: stable.ino.toString(),
    mode: stable.mode.toString(),
    uid: stable.uid.toString(),
    gid: stable.gid.toString(),
    links: stable.nlink.toString(),
    size: stable.size.toString(),
    modifiedNanoseconds: stable.mtimeNs.toString(),
    digest: hash.digest('hex'),
  };
}

export function physicalPathIdentitiesEqual(
  left: PhysicalPathIdentity | null,
  right: PhysicalPathIdentity | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.links === right.links &&
    left.size === right.size &&
    left.modifiedNanoseconds === right.modifiedNanoseconds &&
    left.digest === right.digest
  );
}

const PHYSICAL_IDENTITY_KEYS = [
  'device',
  'digest',
  'gid',
  'inode',
  'kind',
  'links',
  'mode',
  'modifiedNanoseconds',
  'schemaVersion',
  'size',
  'uid',
] as const;

/** Strict journal/CLI boundary: reject missing, extra, malformed, or unsupported identity fields. */
export function parsePhysicalPathIdentity(value: unknown): PhysicalPathIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PhysicalPathIdentityError('physical path identity must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  if (
    keys.length !== PHYSICAL_IDENTITY_KEYS.length ||
    keys.some((key, index) => key !== PHYSICAL_IDENTITY_KEYS[index])
  ) {
    throw new PhysicalPathIdentityError('physical path identity has missing or unknown fields');
  }
  if (
    record.schemaVersion !== 1 ||
    typeof record.kind !== 'string' ||
    !['file', 'directory', 'symlink'].includes(record.kind)
  ) {
    throw new PhysicalPathIdentityError('physical path identity schema or kind is unsupported');
  }
  for (const field of ['device', 'inode', 'mode', 'uid', 'gid', 'links', 'size'] as const) {
    if (typeof record[field] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(record[field])) {
      throw new PhysicalPathIdentityError(`physical path identity ${field} is not a canonical integer`);
    }
  }
  if (typeof record.modifiedNanoseconds !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(record.modifiedNanoseconds)) {
    throw new PhysicalPathIdentityError('physical path identity modifiedNanoseconds is not a canonical integer');
  }
  if (typeof record.digest !== 'string' || !/^[0-9a-f]{64}$/.test(record.digest)) {
    throw new PhysicalPathIdentityError('physical path identity digest is malformed');
  }
  return {
    schemaVersion: 1,
    kind: record.kind as PhysicalPathIdentity['kind'],
    device: record.device as string,
    inode: record.inode as string,
    mode: record.mode as string,
    uid: record.uid as string,
    gid: record.gid as string,
    links: record.links as string,
    size: record.size as string,
    modifiedNanoseconds: record.modifiedNanoseconds,
    digest: record.digest,
  };
}

function inspectPhysicalDirectory(path: string): PhysicalDirectoryIdentity {
  const stat = lstatBigInt(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new PhysicalPathIdentityError(`transaction parent is not a physical directory: ${path}`);
  }
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
  };
}

function inspectPhysicalDirectoryFd(fd: number): PhysicalDirectoryIdentity {
  const stat = fstatBigInt(fd);
  if (!stat.isDirectory()) throw new PhysicalPathIdentityError('held transaction parent is no longer a directory');
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    uid: stat.uid.toString(),
    gid: stat.gid.toString(),
  };
}

function directoryIdentitiesEqual(left: PhysicalDirectoryIdentity, right: PhysicalDirectoryIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function originalDirectoryStillHeld(fdIdentity: PhysicalDirectoryIdentity, originalPath: string): boolean {
  try {
    return directoryIdentitiesEqual(fdIdentity, inspectPhysicalDirectory(originalPath));
  } catch {
    return false;
  }
}

function currentHeldDirectoryPath(
  fd: number,
  originalPath: string,
  platform: NodeJS.Platform,
  dependencies: NativeNoReplaceDependencies,
): string {
  const heldIdentity = inspectPhysicalDirectoryFd(fd);
  if (originalDirectoryStillHeld(heldIdentity, originalPath)) return originalPath;
  if (dependencies.directoryPathForFd !== undefined) return resolve(dependencies.directoryPathForFd(fd, originalPath));
  if (platform === 'linux') return resolve(realpathSync(`/proc/self/fd/${fd}`));
  if (platform === 'darwin') return resolve(realpathSync(`/dev/fd/${fd}`));
  throw new NativeNoReplaceUnavailableError(platform);
}

function serializeError(error: unknown): { name: string; message: string } {
  try {
    return error instanceof Error
      ? { name: String(error.name), message: String(error.message) }
      : { name: 'Error', message: String(error) };
  } catch {
    return { name: 'Error', message: 'post-invoke callback threw an unprintable value' };
  }
}

function pathNameOccupied(path: string): boolean {
  try {
    lstatBigInt(path);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ENOENT');
  }
}

function fsyncRenameParents(
  sourceParentFd: number,
  targetParentFd: number,
  sameParent: boolean,
  dependencies: NativeNoReplaceDependencies,
): Array<{ parent: 'source' | 'target'; name: string; message: string }> {
  const sync = dependencies.fsyncDirectoryFd ?? fsyncSync;
  const errors: Array<{ parent: 'source' | 'target'; name: string; message: string }> = [];
  try {
    sync(sourceParentFd);
  } catch (error) {
    errors.push({ parent: 'source', ...serializeError(error) });
  }
  if (!sameParent) {
    try {
      sync(targetParentFd);
    } catch (error) {
      errors.push({ parent: 'target', ...serializeError(error) });
    }
  }
  return errors;
}

const defaultLinuxOpener: NonNullable<NativeNoReplaceDependencies['linuxOpener']> = (soname) => {
  try {
    const libc = dlopen(soname, {
      renameat2: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    return (sourceParentFd, source, targetParentFd, target) =>
      libc.symbols.renameat2(sourceParentFd, source, targetParentFd, target, LINUX_RENAME_NOREPLACE);
  } catch {
    return null;
  }
};

const defaultDarwinOpener: NonNullable<NativeNoReplaceDependencies['darwinOpener']> = () => {
  try {
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      renameatx_np: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    return (sourceParentFd, source, targetParentFd, target) =>
      libc.symbols.renameatx_np(sourceParentFd, source, targetParentFd, target, DARWIN_RENAME_EXCL);
  } catch {
    return null;
  }
};

let cachedLinuxRename: NativeNoReplaceRename | null | undefined;
let cachedDarwinRename: NativeNoReplaceRename | null | undefined;

function resolveLinuxRename(dependencies: NativeNoReplaceDependencies): NativeNoReplaceRename | null {
  const injected = dependencies.linuxOpener !== undefined || dependencies.linuxCandidates !== undefined;
  if (!injected && cachedLinuxRename !== undefined) return cachedLinuxRename;
  const opener = dependencies.linuxOpener ?? defaultLinuxOpener;
  const candidates = dependencies.linuxCandidates ?? LINUX_LIBC_CANDIDATES;
  let resolved: NativeNoReplaceRename | null = null;
  for (const soname of candidates) {
    try {
      resolved = opener(soname);
    } catch {
      resolved = null;
    }
    if (resolved !== null) break;
  }
  if (!injected) cachedLinuxRename = resolved;
  return resolved;
}

function resolveDarwinRename(dependencies: NativeNoReplaceDependencies): NativeNoReplaceRename | null {
  const injected = dependencies.darwinOpener !== undefined;
  if (!injected && cachedDarwinRename !== undefined) return cachedDarwinRename;
  let resolved: NativeNoReplaceRename | null;
  try {
    resolved = (dependencies.darwinOpener ?? defaultDarwinOpener)();
  } catch {
    resolved = null;
  }
  if (!injected) cachedDarwinRename = resolved;
  return resolved;
}

function resolveNativeRename(dependencies: NativeNoReplaceDependencies): NativeNoReplaceRename | null {
  const platform = dependencies.platform ?? process.platform;
  if (platform === 'linux') return resolveLinuxRename(dependencies);
  if (platform === 'darwin') return resolveDarwinRename(dependencies);
  return null;
}

/** Read-only capability probe used before an install transaction receives mutation authority. */
export function nativeNoReplaceCapability(dependencies: NativeNoReplaceDependencies = {}): {
  schemaVersion: 1;
  platform: NodeJS.Platform;
  available: boolean;
} {
  const platform = dependencies.platform ?? process.platform;
  return { schemaVersion: 1, platform, available: resolveNativeRename(dependencies) !== null };
}

/**
 * Move one exact physical object while atomically refusing every occupied
 * target name. Native invocation is a one-way decision: an exception or
 * non-zero return is reconciled against the exact moved inode and never
 * selects a portable retry. This primitive never unlinks or recursively
 * removes any pathname.
 */
export function renamePathNoClobber(
  sourcePath: string,
  targetPath: string,
  expected: PhysicalPathIdentity,
  dependencies: NativeNoReplaceDependencies = {},
): NoClobberRenameResult {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (source === target) throw new NoClobberRenameError('source and target must be different paths');
  const sourceParent = dirname(source);
  const targetParent = dirname(target);
  const sourceName = basename(source);
  const targetName = basename(target);
  if (sourceName.length === 0 || targetName.length === 0) {
    throw new NoClobberRenameError('filesystem roots cannot be transaction members');
  }
  const platform = dependencies.platform ?? process.platform;
  const rename = resolveNativeRename(dependencies);
  if (rename === null) throw new NativeNoReplaceUnavailableError(platform);
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const sourceParentFd = openSync(sourceParent, directoryFlags);
  let targetParentFd: number | null = null;
  try {
    targetParentFd = openSync(targetParent, directoryFlags);
    const sourceParentIdentity = inspectPhysicalDirectoryFd(sourceParentFd);
    const targetParentIdentity = inspectPhysicalDirectoryFd(targetParentFd);
    if (sourceParentIdentity.device !== targetParentIdentity.device) {
      throw new NoClobberRenameError('native no-clobber rename requires one filesystem');
    }
    const boundSourceParent = currentHeldDirectoryPath(sourceParentFd, sourceParent, platform, dependencies);
    const boundTargetParent = currentHeldDirectoryPath(targetParentFd, targetParent, platform, dependencies);
    const boundSource = join(boundSourceParent, sourceName);
    const boundTarget = join(boundTargetParent, targetName);
    if (!physicalPathIdentitiesEqual(inspectPhysicalPath(boundSource), expected)) {
      throw new PhysicalPathIdentityError(`rename source changed before invocation: ${boundSource}`);
    }
    if (inspectPhysicalPath(boundTarget) !== null) {
      throw new NoClobberRenameError(`rename target already exists: ${boundTarget}`);
    }

    dependencies.beforeInvoke?.();
    let result: number | null = null;
    let invocationError: unknown;
    try {
      result = rename(sourceParentFd, Buffer.from(`${sourceName}\0`), targetParentFd, Buffer.from(`${targetName}\0`));
    } catch (error) {
      invocationError = error;
    }
    const durabilityErrors = fsyncRenameParents(
      sourceParentFd,
      targetParentFd,
      directoryIdentitiesEqual(sourceParentIdentity, targetParentIdentity),
      dependencies,
    );
    let postInvokeError: unknown;
    try {
      dependencies.afterInvoke?.();
    } catch (error) {
      postInvokeError = error;
    }

    const currentSourceParent = currentHeldDirectoryPath(sourceParentFd, sourceParent, platform, dependencies);
    const currentTargetParent = currentHeldDirectoryPath(targetParentFd, targetParent, platform, dependencies);
    const committedTargetPath = join(currentTargetParent, targetName);
    const targetCommitted = physicalPathIdentitiesEqual(inspectPhysicalPath(committedTargetPath), expected);
    if (targetCommitted) {
      return {
        committed: true,
        durable: durabilityErrors.length === 0,
        ...(durabilityErrors.length === 0 ? {} : { durabilityErrors }),
        sourcePathOccupied: pathNameOccupied(join(currentSourceParent, sourceName)),
        parentPathsStable:
          originalDirectoryStillHeld(sourceParentIdentity, sourceParent) &&
          originalDirectoryStillHeld(targetParentIdentity, targetParent),
        committedTargetPath,
        reconciledAfterNativeError: invocationError !== undefined || result !== 0,
        ...(postInvokeError === undefined ? {} : { postInvokeError: serializeError(postInvokeError) }),
      };
    }
    if (invocationError !== undefined) throw invocationError;
    if (postInvokeError !== undefined) throw postInvokeError;
    throw new NoClobberRenameError(
      `native no-clobber rename did not commit exact source (result=${result ?? 'exception'}); all observed objects preserved`,
    );
  } finally {
    if (targetParentFd !== null) closeSync(targetParentFd);
    closeSync(sourceParentFd);
  }
}
