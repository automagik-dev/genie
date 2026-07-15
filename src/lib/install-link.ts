import { dlopen } from 'bun:ffi';
import { randomUUID } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  closeSync,
  fstatSync,
  fsyncSync,
  openSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  type NativeNoReplaceDependencies,
  type PhysicalPathIdentity,
  inspectPhysicalPath,
  physicalPathIdentitiesEqual,
  renamePathNoClobber,
} from './install-transaction.js';

export interface CanonicalInstallLinkGuard {
  schemaVersion: 1;
  linkPath: string;
  targetPath: string;
  trustedHome: string;
  identity: PhysicalPathIdentity;
  created: boolean;
}

export interface PrepareCanonicalInstallLinkOptions {
  linkPath: string;
  targetPath: string;
  trustedHome: string;
  nativeRename?: NativeNoReplaceDependencies;
  randomId?: () => string;
  /** Deterministic race seam after all three parent descriptors are validated. */
  afterParentValidated?: () => void;
}

interface HeldCanonicalParent {
  trustedHome: string;
  localRoot: string;
  localBin: string;
  homeFd: number;
  localFd: number;
  binFd: number;
}

interface AtApi {
  openDirectory: (parentFd: number, name: string) => number;
  mkdir: (parentFd: number, name: string, mode: number) => number;
  symlink: (target: string, parentFd: number, name: string) => number;
}

const LINUX_LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.so',
  'ld-musl-x86_64.so.1',
  'libc.musl-x86_64.so.1',
  'ld-musl-aarch64.so.1',
  'libc.musl-aarch64.so.1',
] as const;

let cachedAtApi: AtApi | null | undefined;

export class CanonicalInstallLinkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CanonicalInstallLinkError';
  }
}

function currentUid(): bigint {
  if (process.getuid === undefined)
    throw new CanonicalInstallLinkError('canonical link requires a POSIX user identity');
  return BigInt(process.getuid());
}

function fdReferencePath(fd: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') return `/dev/fd/${fd}`;
  throw new CanonicalInstallLinkError(`canonical link parent descriptors are unsupported on ${process.platform}`);
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function openAtApi(path: string): AtApi | null {
  try {
    const libc = dlopen(path, {
      mkdirat: { args: ['i32', 'cstring', 'u32'], returns: 'i32' },
      openat: { args: ['i32', 'cstring', 'i32', 'u32'], returns: 'i32' },
      symlinkat: { args: ['cstring', 'i32', 'cstring'], returns: 'i32' },
    } as const);
    return {
      openDirectory: (parentFd, name) =>
        libc.symbols.openat(
          parentFd,
          cString(name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
        ),
      mkdir: (parentFd, name, mode) => libc.symbols.mkdirat(parentFd, cString(name), mode),
      symlink: (target, parentFd, name) => libc.symbols.symlinkat(cString(target), parentFd, cString(name)),
    };
  } catch {
    return null;
  }
}

function atApi(): AtApi {
  if (cachedAtApi !== undefined) {
    if (cachedAtApi === null) throw new CanonicalInstallLinkError('dirfd-bound libc operations are unavailable');
    return cachedAtApi;
  }
  const candidates = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : LINUX_LIBC_CANDIDATES;
  for (const candidate of candidates) {
    const api = openAtApi(candidate);
    if (api !== null) {
      cachedAtApi = api;
      return api;
    }
  }
  cachedAtApi = null;
  throw new CanonicalInstallLinkError(`dirfd-bound libc operations are unavailable on ${process.platform}`);
}

function physicalChildPath(parentFd: number, name: string): string {
  return join(resolve(realpathSync(fdReferencePath(parentFd))), name);
}

function assertSafeOwnedDirectoryStat(stat: BigIntStats, label: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CanonicalInstallLinkError(`${label} is not a physical directory`);
  }
  if (stat.uid !== currentUid() || stat.nlink < 1n || Number(stat.mode & 0o022n) !== 0) {
    throw new CanonicalInstallLinkError(`${label} is not current-user-owned with safe permissions`);
  }
}

function directoryObjectsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function openOwnedDirectory(path: string, label: string): number {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new CanonicalInstallLinkError(`${label} is unavailable as a no-follow directory`, { cause: error });
  }
  try {
    assertSafeOwnedDirectoryStat(fstatSync(fd, { bigint: true }), label);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openOwnedChildDirectory(parentFd: number, name: string, label: string, createMissing: boolean): number {
  const api = atApi();
  let created = false;
  let fd = api.openDirectory(parentFd, name);
  if (fd < 0 && createMissing) {
    created = api.mkdir(parentFd, name, 0o755) === 0;
    fd = api.openDirectory(parentFd, name);
  }
  if (fd < 0) {
    throw new CanonicalInstallLinkError(
      `${label} is not a physical directory or is unavailable through its held parent`,
    );
  }
  try {
    assertSafeOwnedDirectoryStat(fstatSync(fd, { bigint: true }), label);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (created) {
    fsyncSync(fd);
    fsyncSync(parentFd);
  }
  return fd;
}

function holdCanonicalParent(
  trustedHomeValue: string,
  linkPathValue: string,
  createMissing: boolean,
): HeldCanonicalParent {
  const trustedHome = resolve(trustedHomeValue);
  const linkPath = resolve(linkPathValue);
  const localRoot = join(trustedHome, '.local');
  const localBin = join(localRoot, 'bin');
  if (linkPath !== join(localBin, 'genie')) {
    throw new CanonicalInstallLinkError('canonical Genie link must be the direct ~/.local/bin/genie path');
  }
  const homeFd = openOwnedDirectory(trustedHome, 'trusted home');
  let localFd: number | null = null;
  let binFd: number | null = null;
  try {
    localFd = openOwnedChildDirectory(homeFd, '.local', '~/.local', createMissing);
    binFd = openOwnedChildDirectory(localFd, 'bin', '~/.local/bin', createMissing);
    return { trustedHome, localRoot, localBin, homeFd, localFd, binFd };
  } catch (error) {
    if (binFd !== null) closeSync(binFd);
    if (localFd !== null) closeSync(localFd);
    closeSync(homeFd);
    throw error;
  }
}

function closeCanonicalParent(parent: HeldCanonicalParent): void {
  closeSync(parent.binFd);
  closeSync(parent.localFd);
  closeSync(parent.homeFd);
}

function assertHeldDirectoryAtPath(fd: number, path: string, label: string): void {
  const expected = fstatSync(fd, { bigint: true });
  const observedFd = openOwnedDirectory(path, label);
  try {
    const observed = fstatSync(observedFd, { bigint: true });
    if (!directoryObjectsEqual(expected, observed)) {
      throw new CanonicalInstallLinkError(`${label} changed after its descriptor was validated`);
    }
  } finally {
    closeSync(observedFd);
  }
}

function assertCanonicalChainUnchanged(parent: HeldCanonicalParent): void {
  assertHeldDirectoryAtPath(parent.homeFd, parent.trustedHome, 'trusted home');
  const observedLocal = openOwnedChildDirectory(parent.homeFd, '.local', '~/.local', false);
  try {
    if (
      !directoryObjectsEqual(fstatSync(parent.localFd, { bigint: true }), fstatSync(observedLocal, { bigint: true }))
    ) {
      throw new CanonicalInstallLinkError('~/.local changed after its descriptor was validated');
    }
  } finally {
    closeSync(observedLocal);
  }
  const observedBin = openOwnedChildDirectory(parent.localFd, 'bin', '~/.local/bin', false);
  try {
    if (!directoryObjectsEqual(fstatSync(parent.binFd, { bigint: true }), fstatSync(observedBin, { bigint: true }))) {
      throw new CanonicalInstallLinkError('~/.local/bin changed after its descriptor was validated');
    }
  } finally {
    closeSync(observedBin);
  }
}

function inspectLink(path: string): PhysicalPathIdentity | null {
  try {
    return inspectPhysicalPath(path);
  } catch (error) {
    throw new CanonicalInstallLinkError(`could not inspect canonical link object: ${path}`, { cause: error });
  }
}

function assertExpectedLink(path: string, target: string, identity: PhysicalPathIdentity): void {
  const actual = inspectLink(path);
  if (!physicalPathIdentitiesEqual(actual, identity) || actual?.kind !== 'symlink') {
    throw new CanonicalInstallLinkError(`canonical Genie link changed or is not a symlink: ${path}`);
  }
  let rawTarget: string;
  try {
    rawTarget = readlinkSync(path);
  } catch (error) {
    throw new CanonicalInstallLinkError(`canonical Genie link could not be read: ${path}`, { cause: error });
  }
  if (rawTarget !== target) {
    throw new CanonicalInstallLinkError(`canonical Genie link points somewhere unexpected: ${path}`);
  }
}

function guardFor(
  parent: HeldCanonicalParent,
  linkPath: string,
  targetPath: string,
  identity: PhysicalPathIdentity,
  created: boolean,
): CanonicalInstallLinkGuard {
  return {
    schemaVersion: 1,
    linkPath,
    targetPath,
    trustedHome: parent.trustedHome,
    identity,
    created,
  };
}

/** Verify that a previously admitted canonical link and every PATH ancestor remain exact and safe. */
export function verifyCanonicalInstallLink(guard: CanonicalInstallLinkGuard): void {
  if (
    guard.schemaVersion !== 1 ||
    guard.linkPath !== resolve(guard.linkPath) ||
    guard.targetPath !== resolve(guard.targetPath) ||
    guard.trustedHome !== resolve(guard.trustedHome)
  ) {
    throw new CanonicalInstallLinkError('canonical link guard is malformed');
  }
  const parent = holdCanonicalParent(guard.trustedHome, guard.linkPath, false);
  try {
    assertCanonicalChainUnchanged(parent);
    assertExpectedLink(physicalChildPath(parent.binFd, 'genie'), guard.targetPath, guard.identity);
  } finally {
    closeCanonicalParent(parent);
  }
}

/**
 * Validate the canonical PATH ancestry and admit an existing exact link, but
 * never create the public link. This is the pre-promotion collision check.
 */
export function preflightCanonicalInstallLink(
  options: PrepareCanonicalInstallLinkOptions,
): CanonicalInstallLinkGuard | null {
  const linkPath = resolve(options.linkPath);
  const targetPath = resolve(options.targetPath);
  if (basename(linkPath) !== 'genie') throw new CanonicalInstallLinkError('canonical link basename must be genie');
  const parent = holdCanonicalParent(options.trustedHome, linkPath, true);
  try {
    options.afterParentValidated?.();
    assertCanonicalChainUnchanged(parent);
    const heldLinkPath = physicalChildPath(parent.binFd, 'genie');
    const existing = inspectLink(heldLinkPath);
    if (existing === null) return null;
    assertExpectedLink(heldLinkPath, targetPath, existing);
    const guard = guardFor(parent, linkPath, targetPath, existing, false);
    verifyCanonicalInstallLink(guard);
    return guard;
  } finally {
    closeCanonicalParent(parent);
  }
}

/**
 * Admit an existing exact canonical symlink or publish one through the shared
 * native no-clobber primitive. Every occupied foreign pathname is preserved.
 */
export function prepareCanonicalInstallLink(options: PrepareCanonicalInstallLinkOptions): CanonicalInstallLinkGuard {
  const linkPath = resolve(options.linkPath);
  const targetPath = resolve(options.targetPath);
  if (basename(linkPath) !== 'genie') throw new CanonicalInstallLinkError('canonical link basename must be genie');
  const parent = holdCanonicalParent(options.trustedHome, linkPath, true);
  try {
    options.afterParentValidated?.();
    assertCanonicalChainUnchanged(parent);
    const heldLinkPath = physicalChildPath(parent.binFd, 'genie');
    const existing = inspectLink(heldLinkPath);
    if (existing !== null) {
      assertExpectedLink(heldLinkPath, targetPath, existing);
      const guard = guardFor(parent, linkPath, targetPath, existing, false);
      verifyCanonicalInstallLink(guard);
      return guard;
    }

    const stagingName = `.genie-install-link-${process.pid}-${(options.randomId ?? randomUUID)()}`;
    if (atApi().symlink(targetPath, parent.binFd, stagingName) !== 0) {
      throw new CanonicalInstallLinkError('could not reserve an exclusive canonical-link staging name');
    }
    const heldStagingPath = physicalChildPath(parent.binFd, stagingName);
    const expected = inspectLink(heldStagingPath);
    if (expected === null || expected.kind !== 'symlink') {
      throw new CanonicalInstallLinkError('canonical-link staging object disappeared or changed kind');
    }
    assertCanonicalChainUnchanged(parent);
    const physicalBin = resolve(realpathSync(fdReferencePath(parent.binFd)));
    const sourcePath = join(physicalBin, stagingName);
    const targetPhysicalPath = join(physicalBin, 'genie');
    const result = renamePathNoClobber(sourcePath, targetPhysicalPath, expected, options.nativeRename);
    if (
      !result.durable ||
      !result.parentPathsStable ||
      result.committedTargetPath !== targetPhysicalPath ||
      result.sourcePathOccupied ||
      result.postInvokeError !== undefined
    ) {
      throw new CanonicalInstallLinkError('canonical link committed with unresolved durability or race evidence');
    }
    assertCanonicalChainUnchanged(parent);
    const guard = guardFor(parent, linkPath, targetPath, expected, true);
    verifyCanonicalInstallLink(guard);
    return guard;
  } finally {
    closeCanonicalParent(parent);
  }
}
