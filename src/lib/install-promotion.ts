import { dlopen } from 'bun:ffi';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  closeSync,
  cpSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  type NativeNoReplaceDependencies,
  type PhysicalPathIdentity,
  inspectPhysicalPath,
  nativeNoReplaceCapability,
  parsePhysicalPathIdentity,
  physicalPathIdentitiesEqual,
  renamePathNoClobber,
} from './install-transaction.js';

export const INSTALL_PAYLOAD_MEMBERS = [
  '.agents',
  '.claude-plugin',
  'LICENSE',
  'VERSION',
  'genie',
  'plugins',
  'skills',
  'templates',
] as const;

export type InstallPayloadMember = (typeof INSTALL_PAYLOAD_MEMBERS)[number];
export type InstallPromotionOutcome = 'committed' | 'rolledback';
export type InstallPromotionRenameOperation =
  | 'activate-transaction'
  | 'archive-transaction'
  | 'capture-prior'
  | 'publish-incoming'
  | 'publish-prior-binary'
  | 'publish-receipt'
  | 'reclaim-prior-binary'
  | 'restore-prior'
  | 'return-incoming';

export interface InstallPromotionRenameEvent {
  operation: InstallPromotionRenameOperation;
  member: InstallPayloadMember | null;
  sourcePath: string;
  targetPath: string;
  transactionId: string;
}

export interface InstallPromotionDependencies {
  nativeRename?: NativeNoReplaceDependencies;
  randomId?: () => string;
  /** Deterministic final-boundary race seam. Production callers should omit it. */
  beforeRename?: (event: InstallPromotionRenameEvent) => void;
  /** Deterministic process-death seam. Returning true leaves the durable transaction pending. */
  interruptAfterRename?: (event: InstallPromotionRenameEvent) => boolean;
  /** Deterministic staged-tree race seam. Production callers should omit it. */
  afterPayloadMemberInspected?: (member: InstallPayloadMember, identity: PhysicalPathIdentity) => void;
}

export interface InstallVersionVerificationContext {
  binaryPath: string;
  expectedVersion: string;
  phase: 'staged' | 'live';
}

export interface PromoteStagedInstallOptions {
  genieHome: string;
  stagingRoot: string;
  expectedVersion: string;
  verifyVersion?: (context: InstallVersionVerificationContext) => boolean | undefined;
  dependencies?: InstallPromotionDependencies;
}

export interface RecoverInstallPromotionsOptions {
  genieHome: string;
  dependencies?: InstallPromotionDependencies;
}

export interface InstallPromotionReport {
  schemaVersion: 1;
  transactionId: string;
  outcome: InstallPromotionOutcome;
  archivePath: string;
  stagingRoot: string;
  priorBinaryPath?: string;
}

export interface InstallStagingDirectoryGuard {
  schemaVersion: 1;
  genieHome: string;
  liveRoot: string;
  stagingRoot: string;
  /** Held physical staging directory used by the guard's descriptor-bound operations. */
  directoryFd: number;
}

export interface CreateInstallStagingDirectoryOptions {
  genieHome: string;
  randomId?: () => string;
  /** Deterministic race seam after GENIE_HOME/bin is bound and validated but before mkdirat. */
  afterParentValidated?: () => void;
  /** Deterministic race seam after the private child is bound but before the visible path is revalidated. */
  afterCreated?: () => void;
}

export interface AdmitExternalInstallStagingOptions extends CreateInstallStagingDirectoryOptions {
  externalStagingRoot: string;
  expectedVersion: string;
  verifyVersion?: (context: InstallVersionVerificationContext) => boolean | undefined;
  dependencies?: InstallPromotionDependencies;
}

interface HeldInstallStagingDirectory extends InstallStagingDirectoryGuard {
  homeFd: number;
  liveFd: number;
  stagingName: string;
}

interface InstallStagingAtApi {
  changeDirectory: (fd: number) => number;
  openDirectory: (parentFd: number, name: string) => number;
  mkdir: (parentFd: number, name: string, mode: number) => number;
  removeDirectory: (parentFd: number, name: string) => number;
}

interface JournalMember {
  name: InstallPayloadMember;
  incoming: PhysicalPathIdentity;
  prior: PhysicalPathIdentity | null;
}

interface InstallPromotionJournal {
  schemaVersion: 1;
  transactionId: string;
  expectedVersion: string | null;
  genieHome: string;
  liveRoot: string;
  stagingRoot: string;
  members: JournalMember[];
}

type ReceiptPhase =
  | 'captured'
  | 'committed'
  | 'created'
  | 'published'
  | 'restored'
  | 'returned'
  | 'rollback-started'
  | 'rolledback'
  | 'verified';

interface InstallPromotionReceipt {
  schemaVersion: 1;
  transactionId: string;
  sequence: number;
  phase: ReceiptPhase;
  member: InstallPayloadMember | null;
}

interface LoadedTransaction {
  root: string;
  journal: InstallPromotionJournal;
  receipts: InstallPromotionReceipt[];
}

type MemberState = 'captured' | 'initial' | 'published' | 'published-drifted' | 'quarantined';

const TRANSACTION_PREFIX = '.install-transaction-';
const PREPARATION_PREFIX = '.install-transaction-preparing-';
const HISTORY_DIRECTORY = '.install-history';
const JOURNAL_FILE = 'journal.json';
const RECEIPT_WIDTH = 12;
const MAX_JOURNAL_BYTES = 1024 * 1024;
const MAX_VERSION_STAMP_BYTES = 256;
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VERSION_PATTERN = /(?:^|[^0-9A-Za-z.+-])v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:[^0-9A-Za-z.+-]|$)/;
const INSTALL_STAGING_NAME_PATTERN =
  /^\.install-staging-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AT_REMOVEDIR = process.platform === 'darwin' ? 0x80 : 0x200;
const LINUX_LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.so',
  'ld-musl-x86_64.so.1',
  'libc.musl-x86_64.so.1',
  'ld-musl-aarch64.so.1',
  'libc.musl-aarch64.so.1',
] as const;

let cachedInstallStagingAtApi: InstallStagingAtApi | null | undefined;
const activeInstallStagingGuards = new WeakSet<InstallStagingDirectoryGuard>();
const installStagingContentDigests = new WeakMap<InstallStagingDirectoryGuard, string | null>();

const EXPECTED_MEMBER_KINDS: Record<InstallPayloadMember, PhysicalPathIdentity['kind']> = {
  '.agents': 'directory',
  '.claude-plugin': 'directory',
  LICENSE: 'file',
  VERSION: 'file',
  genie: 'file',
  plugins: 'directory',
  skills: 'directory',
  templates: 'directory',
};

const JOURNAL_KEYS = [
  'expectedVersion',
  'genieHome',
  'liveRoot',
  'members',
  'schemaVersion',
  'stagingRoot',
  'transactionId',
];
const JOURNAL_MEMBER_KEYS = ['incoming', 'name', 'prior'];
const RECEIPT_KEYS = ['member', 'phase', 'schemaVersion', 'sequence', 'transactionId'];
const RECEIPT_PHASES = new Set<ReceiptPhase>([
  'captured',
  'committed',
  'created',
  'published',
  'restored',
  'returned',
  'rollback-started',
  'rolledback',
  'verified',
]);
const MEMBER_RECEIPT_PHASES = new Set<ReceiptPhase>(['captured', 'published', 'restored', 'returned']);

export class InstallPromotionError extends Error {
  readonly transactionPath?: string;
  readonly archivePath?: string;
  readonly rolledBack: boolean;

  constructor(
    message: string,
    options: { transactionPath?: string; archivePath?: string; rolledBack?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InstallPromotionError';
    this.transactionPath = options.transactionPath;
    this.archivePath = options.archivePath;
    this.rolledBack = options.rolledBack ?? false;
  }
}

export class InstallPromotionInterruptedError extends InstallPromotionError {
  constructor(transactionPath: string, event: InstallPromotionRenameEvent) {
    super(`install promotion interrupted after ${event.operation}; durable recovery is pending`, { transactionPath });
    this.name = 'InstallPromotionInterruptedError';
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new InstallPromotionError(`${label} has missing or unknown fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function memberName(value: unknown, label: string): InstallPayloadMember {
  if (typeof value !== 'string' || !INSTALL_PAYLOAD_MEMBERS.includes(value as InstallPayloadMember)) {
    throw new InstallPromotionError(`${label} is not an allowed installer member`);
  }
  return value as InstallPayloadMember;
}

function versionToken(value: string): string | null {
  return value.match(VERSION_PATTERN)?.[1] ?? null;
}

function canonicalExpectedVersion(value: string | undefined): string | null {
  if (value === undefined) return null;
  const token = versionToken(value);
  if (token === null) throw new InstallPromotionError('expected install version is malformed');
  return token;
}

function currentUid(): bigint {
  if (process.getuid === undefined) throw new InstallPromotionError('install promotion requires a POSIX user identity');
  return BigInt(process.getuid());
}

function cString(value: string): Buffer {
  return Buffer.from(`${value}\0`);
}

function openInstallStagingAtApi(path: string): InstallStagingAtApi | null {
  try {
    const libc = dlopen(path, {
      fchdir: { args: ['i32'], returns: 'i32' },
      mkdirat: { args: ['i32', 'cstring', 'u32'], returns: 'i32' },
      openat: { args: ['i32', 'cstring', 'i32', 'u32'], returns: 'i32' },
      unlinkat: { args: ['i32', 'cstring', 'i32'], returns: 'i32' },
    } as const);
    return {
      changeDirectory: (fd) => libc.symbols.fchdir(fd),
      openDirectory: (parentFd, name) =>
        libc.symbols.openat(
          parentFd,
          cString(name),
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
          0,
        ),
      mkdir: (parentFd, name, mode) => libc.symbols.mkdirat(parentFd, cString(name), mode),
      removeDirectory: (parentFd, name) => libc.symbols.unlinkat(parentFd, cString(name), AT_REMOVEDIR),
    };
  } catch {
    return null;
  }
}

function installStagingAtApi(): InstallStagingAtApi {
  if (cachedInstallStagingAtApi !== undefined) {
    if (cachedInstallStagingAtApi === null) {
      throw new InstallPromotionError('dirfd-bound install staging operations are unavailable');
    }
    return cachedInstallStagingAtApi;
  }
  const candidates = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib'] : LINUX_LIBC_CANDIDATES;
  for (const candidate of candidates) {
    const api = openInstallStagingAtApi(candidate);
    if (api !== null) {
      cachedInstallStagingAtApi = api;
      return api;
    }
  }
  cachedInstallStagingAtApi = null;
  throw new InstallPromotionError(`dirfd-bound install staging operations are unavailable on ${process.platform}`);
}

function assertSafeOwnedInstallDirectoryStat(stat: BigIntStats, label: string, exactMode?: number): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid() || stat.nlink < 1n) {
    throw new InstallPromotionError(`${label} is not an owned physical directory`);
  }
  const permissions = Number(stat.mode & 0o777n);
  if ((permissions & 0o022) !== 0 || (exactMode !== undefined && permissions !== exactMode)) {
    throw new InstallPromotionError(`${label} has unsafe permissions`);
  }
}

function installDirectoryObjectsEqual(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink
  );
}

function openOwnedInstallDirectory(path: string, label: string, exactMode?: number): number {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new InstallPromotionError(`${label} is unavailable as a no-follow directory`, { cause: error });
  }
  try {
    assertSafeOwnedInstallDirectoryStat(fstatSync(fd, { bigint: true }), label, exactMode);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openOwnedInstallChildDirectory(parentFd: number, name: string, label: string, exactMode?: number): number {
  const fd = installStagingAtApi().openDirectory(parentFd, name);
  if (fd < 0) throw new InstallPromotionError(`${label} is unavailable as a no-follow direct child directory`);
  try {
    assertSafeOwnedInstallDirectoryStat(fstatSync(fd, { bigint: true }), label, exactMode);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function heldInstallStagingGuard(value: InstallStagingDirectoryGuard): HeldInstallStagingDirectory {
  if (!activeInstallStagingGuards.has(value)) {
    throw new InstallPromotionError('install staging guard is closed or was not created by this process');
  }
  return value as HeldInstallStagingDirectory;
}

function assertHeldInstallDirectoryVisible(fd: number, path: string, label: string, exactMode?: number): void {
  const visibleFd = openOwnedInstallDirectory(path, label, exactMode);
  try {
    if (!installDirectoryObjectsEqual(fstatSync(fd, { bigint: true }), fstatSync(visibleFd, { bigint: true }))) {
      throw new InstallPromotionError(`${label} changed after its physical directory was bound`);
    }
  } finally {
    closeSync(visibleFd);
  }
}

function removeExactHeldInstallStagingChild(liveFd: number, stagingName: string, directoryFd: number): boolean {
  let visibleFd: number;
  try {
    visibleFd = openOwnedInstallChildDirectory(liveFd, stagingName, 'install staging directory', 0o700);
  } catch {
    return false;
  }
  try {
    if (
      !installDirectoryObjectsEqual(fstatSync(directoryFd, { bigint: true }), fstatSync(visibleFd, { bigint: true }))
    ) {
      return false;
    }
  } finally {
    closeSync(visibleFd);
  }
  const removed = installStagingAtApi().removeDirectory(liveFd, stagingName) === 0;
  if (removed) fsyncSync(liveFd);
  return removed;
}

/** Reopen the canonical chain no-follow and require it to name the exact three held directory objects. */
export function verifyInstallStagingDirectory(guardValue: InstallStagingDirectoryGuard): void {
  const guard = heldInstallStagingGuard(guardValue);
  if (
    guard.schemaVersion !== 1 ||
    guard.genieHome !== resolve(guard.genieHome) ||
    guard.liveRoot !== join(guard.genieHome, 'bin') ||
    guard.stagingRoot !== join(guard.liveRoot, guard.stagingName) ||
    !INSTALL_STAGING_NAME_PATTERN.test(guard.stagingName)
  ) {
    throw new InstallPromotionError('install staging guard is malformed');
  }
  assertHeldInstallDirectoryVisible(guard.homeFd, guard.genieHome, 'GENIE_HOME');
  const visibleLiveFd = openOwnedInstallChildDirectory(guard.homeFd, 'bin', 'GENIE_HOME/bin');
  try {
    if (
      !installDirectoryObjectsEqual(
        fstatSync(guard.liveFd, { bigint: true }),
        fstatSync(visibleLiveFd, { bigint: true }),
      )
    ) {
      throw new InstallPromotionError('GENIE_HOME/bin changed after its physical directory was bound');
    }
  } finally {
    closeSync(visibleLiveFd);
  }
  const visibleStagingFd = openOwnedInstallChildDirectory(
    guard.liveFd,
    guard.stagingName,
    'install staging directory',
    0o700,
  );
  try {
    if (
      !installDirectoryObjectsEqual(
        fstatSync(guard.directoryFd, { bigint: true }),
        fstatSync(visibleStagingFd, { bigint: true }),
      )
    ) {
      throw new InstallPromotionError('install staging directory changed after its physical directory was bound');
    }
  } finally {
    closeSync(visibleStagingFd);
  }
}

/** Create one exact private direct child without ever resolving a writable child pathname. */
export function createInstallStagingDirectory(
  options: CreateInstallStagingDirectoryOptions,
): InstallStagingDirectoryGuard {
  const genieHome = resolve(options.genieHome);
  if (genieHome !== options.genieHome) throw new InstallPromotionError('GENIE_HOME must be an absolute canonical path');
  const liveRoot = join(genieHome, 'bin');
  const homeFd = openOwnedInstallDirectory(genieHome, 'GENIE_HOME');
  let liveFd: number | null = null;
  let directoryFd: number | null = null;
  let stagingName: string | null = null;
  let guard: HeldInstallStagingDirectory | null = null;
  try {
    liveFd = openOwnedInstallChildDirectory(homeFd, 'bin', 'GENIE_HOME/bin');
    options.afterParentValidated?.();
    const id = (options.randomId ?? randomUUID)().toLowerCase();
    stagingName = `.install-staging-${id}`;
    if (!INSTALL_STAGING_NAME_PATTERN.test(stagingName)) {
      throw new InstallPromotionError('install staging id generator returned a non-UUID value');
    }
    if (installStagingAtApi().mkdir(liveFd, stagingName, 0o700) !== 0) {
      throw new InstallPromotionError('could not reserve an exclusive install staging directory');
    }
    directoryFd = openOwnedInstallChildDirectory(liveFd, stagingName, 'install staging directory');
    fchmodSync(directoryFd, 0o700);
    assertSafeOwnedInstallDirectoryStat(fstatSync(directoryFd, { bigint: true }), 'install staging directory', 0o700);
    fsyncSync(directoryFd);
    fsyncSync(liveFd);
    guard = {
      schemaVersion: 1,
      genieHome,
      liveRoot,
      stagingRoot: join(liveRoot, stagingName),
      directoryFd,
      homeFd,
      liveFd,
      stagingName,
    };
    activeInstallStagingGuards.add(guard);
    installStagingContentDigests.set(guard, null);
    options.afterCreated?.();
    verifyInstallStagingDirectory(guard);
    return guard;
  } catch (error) {
    if (guard !== null) activeInstallStagingGuards.delete(guard);
    if (guard !== null) installStagingContentDigests.delete(guard);
    if (directoryFd !== null && stagingName !== null && liveFd !== null) {
      removeExactHeldInstallStagingChild(liveFd, stagingName, directoryFd);
    }
    if (directoryFd !== null) closeSync(directoryFd);
    if (liveFd !== null) closeSync(liveFd);
    closeSync(homeFd);
    throw error;
  }
}

/** Remove only the held empty staging directory; never recursively delete a re-resolved pathname. */
export function removeInstallStagingDirectory(guardValue: InstallStagingDirectoryGuard): boolean {
  const guard = heldInstallStagingGuard(guardValue);
  return removeExactHeldInstallStagingChild(guard.liveFd, guard.stagingName, guard.directoryFd);
}

export function closeInstallStagingDirectory(guardValue: InstallStagingDirectoryGuard): void {
  if (!activeInstallStagingGuards.delete(guardValue)) return;
  installStagingContentDigests.delete(guardValue);
  const guard = guardValue as HeldInstallStagingDirectory;
  closeSync(guard.directoryFd);
  closeSync(guard.liveFd);
  closeSync(guard.homeFd);
}

function fsyncRelativePhysicalTree(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new InstallPromotionError(`copied install staging contains an unsafe object: ${path}`);
  }
  if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) fsyncRelativePhysicalTree(join(path, name));
  }
  const flags = stat.isDirectory()
    ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sameStablePayloadStat(left: BigIntStats, right: BigIntStats): boolean {
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

/** Read the canonical VERSION stamp through one bounded, no-follow descriptor. */
function verifyPayloadVersionStamp(path: string, expectedVersion: string): void {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new InstallPromotionError('staged VERSION is unavailable as a no-follow regular file', { cause: error });
  }
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      before.nlink !== 1n ||
      (before.mode & 0o022n) !== 0n ||
      before.size < 1n ||
      before.size > BigInt(MAX_VERSION_STAMP_BYTES)
    ) {
      throw new InstallPromotionError('staged VERSION is not a bounded owned regular file');
    }

    const buffer = Buffer.alloc(MAX_VERSION_STAMP_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const bytesRead = readSync(fd, buffer, length, buffer.byteLength - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_VERSION_STAMP_BYTES) {
      throw new InstallPromotionError('staged VERSION exceeds the bounded file size');
    }

    const after = fstatSync(fd, { bigint: true });
    let visibleAfter: BigIntStats;
    try {
      visibleAfter = lstatSync(path, { bigint: true });
    } catch (error) {
      throw new InstallPromotionError('staged VERSION changed while it was read', { cause: error });
    }
    if (
      !sameStablePayloadStat(before, after) ||
      !sameStablePayloadStat(after, visibleAfter) ||
      BigInt(length) !== after.size
    ) {
      throw new InstallPromotionError('staged VERSION changed while it was read');
    }

    const bytes = buffer.subarray(0, length);
    if (!bytes.equals(Buffer.from(`${expectedVersion}\n`, 'utf8'))) {
      throw new InstallPromotionError(`staged VERSION does not exactly match ${expectedVersion}`);
    }
  } finally {
    closeSync(fd);
  }
}

function updatePayloadContentDigest(hash: ReturnType<typeof createHash>, path: string, relativePath: string): void {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || (!before.isFile() && !before.isDirectory())) {
    throw new InstallPromotionError(`install payload content digest encountered an unsafe object: ${path}`);
  }
  hash.update(`${relativePath}\0${before.isDirectory() ? 'directory' : 'file'}\0${before.mode & 0o777n}\0`);
  if (before.isFile()) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const heldBefore = fstatSync(fd, { bigint: true });
      if (!sameStablePayloadStat(before, heldBefore)) {
        throw new InstallPromotionError(`install payload file changed before content hashing: ${path}`);
      }
      const bytes = readFileSync(fd);
      hash.update(`${bytes.byteLength}\0`);
      hash.update(bytes);
      hash.update('\0');
      const heldAfter = fstatSync(fd, { bigint: true });
      const visibleAfter = lstatSync(path, { bigint: true });
      if (!sameStablePayloadStat(heldBefore, heldAfter) || !sameStablePayloadStat(heldAfter, visibleAfter)) {
        throw new InstallPromotionError(`install payload file changed during content hashing: ${path}`);
      }
    } finally {
      closeSync(fd);
    }
    return;
  }
  for (const name of readdirSync(path).sort()) {
    updatePayloadContentDigest(hash, join(path, name), `${relativePath}/${name}`);
  }
  if (!sameStablePayloadStat(before, lstatSync(path, { bigint: true }))) {
    throw new InstallPromotionError(`install payload directory changed during content hashing: ${path}`);
  }
}

function payloadContentDigest(root: string): string {
  const hash = createHash('sha256');
  for (const name of INSTALL_PAYLOAD_MEMBERS) updatePayloadContentDigest(hash, join(root, name), name);
  return hash.digest('hex');
}

/** Require both the held visible root and the exact authenticated payload bytes admitted into it. */
export function verifyAdmittedInstallStagingPayload(guardValue: InstallStagingDirectoryGuard): void {
  verifyInstallStagingDirectory(guardValue);
  const guard = heldInstallStagingGuard(guardValue);
  const contentDigest = installStagingContentDigests.get(guard);
  if (
    contentDigest === undefined ||
    contentDigest === null ||
    payloadContentDigest(guard.stagingRoot) !== contentDigest
  ) {
    throw new InstallPromotionError('admitted install payload no longer matches its authenticated content digest');
  }
}

function copyPayloadIntoHeldStaging(externalStagingRoot: string, guard: InstallStagingDirectoryGuard): void {
  const cwdFd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let entered = false;
  let operationError: unknown;
  let restoreFailed = false;
  try {
    if (installStagingAtApi().changeDirectory(guard.directoryFd) !== 0) {
      throw new InstallPromotionError('could not bind payload copy to the held install staging directory');
    }
    entered = true;
    for (const name of INSTALL_PAYLOAD_MEMBERS) {
      cpSync(join(externalStagingRoot, name), name, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
    const binaryFd = openSync('genie', constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const binaryStat = fstatSync(binaryFd, { bigint: true });
      if (
        !binaryStat.isFile() ||
        binaryStat.isSymbolicLink() ||
        binaryStat.uid !== currentUid() ||
        binaryStat.nlink !== 1n
      ) {
        throw new InstallPromotionError('admitted Genie binary is not an owned physical file');
      }
      fchmodSync(binaryFd, 0o755);
      fsyncSync(binaryFd);
    } finally {
      closeSync(binaryFd);
    }
    for (const name of INSTALL_PAYLOAD_MEMBERS) fsyncRelativePhysicalTree(name);
    fsyncSync(guard.directoryFd);
  } catch (error) {
    operationError = error;
  } finally {
    if (entered && installStagingAtApi().changeDirectory(cwdFd) !== 0) {
      restoreFailed = true;
    }
    closeSync(cwdFd);
  }
  if (restoreFailed) {
    throw new InstallPromotionError('could not restore the working directory after descriptor-bound staging', {
      cause: operationError,
    });
  }
  if (operationError !== undefined) throw operationError;
}

/** Admit an exact external release payload into the existing promotion engine's private direct-child contract. */
export function admitExternalInstallStaging(options: AdmitExternalInstallStagingOptions): InstallStagingDirectoryGuard {
  const externalStagingRoot = resolve(options.externalStagingRoot);
  const genieHome = resolve(options.genieHome);
  const relation = relative(genieHome, externalStagingRoot);
  if (relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..')) {
    throw new InstallPromotionError('external install staging must be outside GENIE_HOME');
  }
  const dependencies = options.dependencies ?? {};
  const expectedVersion = canonicalExpectedVersion(options.expectedVersion);
  if (expectedVersion === null) {
    throw new InstallPromotionError('external install staging requires an expectedVersion to authenticate VERSION');
  }
  const externalBefore = verifyPayloadLayout(externalStagingRoot, dependencies);
  verifyPayloadVersionStamp(join(externalStagingRoot, 'VERSION'), expectedVersion);
  const authenticatedContentDigest = payloadContentDigest(externalStagingRoot);
  verifyVersion(join(externalStagingRoot, 'genie'), expectedVersion, 'staged', options.verifyVersion);
  const guard = createInstallStagingDirectory({
    genieHome: options.genieHome,
    randomId: options.randomId,
    afterParentValidated: options.afterParentValidated,
  });
  try {
    options.afterCreated?.();
    copyPayloadIntoHeldStaging(externalStagingRoot, guard);
    verifyInstallStagingDirectory(guard);
    const externalAfter = verifyPayloadLayout(externalStagingRoot, dependencies);
    assertSamePayloadGeneration(externalBefore, externalAfter);
    if (payloadContentDigest(externalStagingRoot) !== authenticatedContentDigest) {
      throw new InstallPromotionError('external install payload content changed during admission');
    }
    const internalBefore = verifyPayloadLayout(guard.stagingRoot, dependencies);
    verifyPayloadVersionStamp(join(guard.stagingRoot, 'VERSION'), expectedVersion);
    if (payloadContentDigest(guard.stagingRoot) !== authenticatedContentDigest) {
      throw new InstallPromotionError('admitted install payload content does not match the authenticated source');
    }
    verifyVersion(join(guard.stagingRoot, 'genie'), expectedVersion, 'staged', options.verifyVersion);
    const internalAfter = verifyPayloadLayout(guard.stagingRoot, dependencies);
    assertSamePayloadGeneration(internalBefore, internalAfter);
    installStagingContentDigests.set(guard, authenticatedContentDigest);
    verifyInstallStagingDirectory(guard);
    return guard;
  } catch (error) {
    removeInstallStagingDirectory(guard);
    closeInstallStagingDirectory(guard);
    throw error;
  }
}

function assertSafeOwnedDirectory(path: string, label: string, exactMode?: number): void {
  let stat: BigIntStats;
  try {
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new InstallPromotionError(`${label} is not available as an owned physical directory`, { cause: error });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new InstallPromotionError(`${label} is not a physical directory`);
  if (stat.uid !== currentUid() || stat.nlink < 1n) {
    throw new InstallPromotionError(`${label} is not owned by the current user or has an invalid link count`);
  }
  const permissions = Number(stat.mode & 0o777n);
  if ((permissions & 0o022) !== 0 || (exactMode !== undefined && permissions !== exactMode)) {
    throw new InstallPromotionError(`${label} has unsafe permissions`);
  }
  fsyncDirectory(path);
}

function assertSafeOwnedNode(path: string, allowSymlink: boolean): void {
  const stat = lstatSync(path, { bigint: true });
  if (stat.uid !== currentUid() || stat.nlink < 1n || Number(stat.mode & 0o022n) !== 0) {
    throw new InstallPromotionError(`transaction object has unsafe ownership, links, or permissions: ${path}`);
  }
  if (stat.isSymbolicLink()) {
    if (!allowSymlink) throw new InstallPromotionError(`staged payload contains a symlink: ${path}`);
    return;
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory()) throw new InstallPromotionError(`transaction object is a special node: ${path}`);
  for (const name of readdirSync(path).sort()) assertSafeOwnedNode(join(path, name), allowSymlink);
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function mkdirExclusive(path: string, parent: string): void {
  mkdirSync(path, { mode: 0o700 });
  assertSafeOwnedDirectory(path, path, 0o700);
  fsyncDirectory(path);
  fsyncDirectory(parent);
}

function ensurePhysicalPrivateDirectory(path: string, parent: string): void {
  try {
    mkdirExclusive(path, parent);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    assertSafeOwnedDirectory(path, path, 0o700);
  }
}

function ensureCompatiblePreviousDirectory(path: string, parent: string): void {
  try {
    mkdirExclusive(path, parent);
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    assertSafeOwnedDirectory(path, path);
  }
}

function stableFileBytes(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.uid !== currentUid() ||
      before.nlink !== 1n ||
      (before.mode & 0o777n) !== 0o600n ||
      before.size > BigInt(MAX_JOURNAL_BYTES)
    ) {
      throw new InstallPromotionError(`transaction metadata is not a bounded regular file: ${path}`);
    }
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const atPath = lstatSync(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.gid !== after.gid ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      after.dev !== atPath.dev ||
      after.ino !== atPath.ino ||
      after.mode !== atPath.mode ||
      after.uid !== atPath.uid ||
      after.gid !== atPath.gid ||
      after.nlink !== atPath.nlink ||
      after.size !== atPath.size ||
      after.mtimeNs !== atPath.mtimeNs
    ) {
      throw new InstallPromotionError(`transaction metadata changed while it was read: ${path}`);
    }
    return bytes.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function writeExclusiveDurableFile(path: string, contents: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function identityAt(path: string): PhysicalPathIdentity | null {
  try {
    return inspectPhysicalPath(path);
  } catch (error) {
    throw new InstallPromotionError(`could not inspect exact transaction object: ${path}`, { cause: error });
  }
}

function sameIdentity(actual: PhysicalPathIdentity | null, expected: PhysicalPathIdentity): boolean {
  return physicalPathIdentitiesEqual(actual, expected);
}

/**
 * A transaction may move an admitted root inode and then discover that a
 * descendant changed at the final syscall boundary. The changed generation is
 * never valid, but the root inode is still sufficient authority to quarantine
 * that whole object away from the public live name without following any
 * descendant symlink.
 */
function sameRootObject(actual: PhysicalPathIdentity | null, expected: PhysicalPathIdentity): boolean {
  return (
    actual !== null &&
    actual.schemaVersion === expected.schemaVersion &&
    actual.kind === expected.kind &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    actual.uid === expected.uid &&
    actual.gid === expected.gid
  );
}

function assertSafeJournalIdentity(identity: PhysicalPathIdentity, label: string): void {
  if (
    identity.uid !== currentUid().toString() ||
    BigInt(identity.links) < 1n ||
    (BigInt(identity.mode) & 0o022n) !== 0n
  ) {
    throw new InstallPromotionError(`${label} has unsafe ownership, links, or permissions`);
  }
}

function assertNoPath(path: string, label: string): void {
  if (identityAt(path) !== null) throw new InstallPromotionError(`${label} is already occupied: ${path}`);
}

function renameDependenciesFor(
  dependencies: InstallPromotionDependencies,
  event: InstallPromotionRenameEvent,
): NativeNoReplaceDependencies {
  const base = dependencies.nativeRename ?? {};
  return {
    ...base,
    beforeInvoke: () => {
      base.beforeInvoke?.();
      dependencies.beforeRename?.(event);
    },
  };
}

function moveExact(
  sourcePath: string,
  targetPath: string,
  expected: PhysicalPathIdentity,
  event: InstallPromotionRenameEvent,
  dependencies: InstallPromotionDependencies,
  transactionPath: string,
): void {
  const result = renamePathNoClobber(sourcePath, targetPath, expected, renameDependenciesFor(dependencies, event));
  if (!result.durable) {
    throw new InstallPromotionError(
      `held transaction parents could not be made durable during ${event.operation}; committed objects were retained`,
      { transactionPath },
    );
  }
  if (!result.parentPathsStable || result.committedTargetPath !== resolve(targetPath)) {
    throw new InstallPromotionError(
      `a transaction parent moved during ${event.operation}; exact objects were preserved`,
      {
        transactionPath,
      },
    );
  }
  if (result.sourcePathOccupied) {
    throw new InstallPromotionError(`the consumed source name was concurrently reused during ${event.operation}`, {
      transactionPath,
    });
  }
  if (dependencies.interruptAfterRename?.(event) === true) {
    throw new InstallPromotionInterruptedError(transactionPath, event);
  }
  if (result.postInvokeError !== undefined) {
    throw new InstallPromotionError(
      `post-invoke boundary failed after committed ${event.operation}: ${result.postInvokeError.name}: ${result.postInvokeError.message}`,
      { transactionPath },
    );
  }
}

function canonicalJournal(journal: InstallPromotionJournal): InstallPromotionJournal {
  return {
    schemaVersion: 1,
    transactionId: journal.transactionId,
    expectedVersion: journal.expectedVersion,
    genieHome: journal.genieHome,
    liveRoot: journal.liveRoot,
    stagingRoot: journal.stagingRoot,
    members: journal.members.map((member) => ({
      name: member.name,
      incoming: member.incoming,
      prior: member.prior,
    })),
  };
}

function canonicalReceipt(receipt: InstallPromotionReceipt): InstallPromotionReceipt {
  return {
    schemaVersion: 1,
    transactionId: receipt.transactionId,
    sequence: receipt.sequence,
    phase: receipt.phase,
    member: receipt.member,
  };
}

function canonicalJson(value: InstallPromotionJournal | InstallPromotionReceipt): string {
  return `${JSON.stringify(value)}\n`;
}

function parseJournal(path: string, expectedHome: string, transactionId: string): InstallPromotionJournal {
  const text = stableFileBytes(path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InstallPromotionError(`install transaction journal is not valid JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value)) throw new InstallPromotionError('install transaction journal must be an object');
  exactKeys(value, JOURNAL_KEYS, 'install transaction journal');
  if (value.schemaVersion !== 1 || value.transactionId !== transactionId) {
    throw new InstallPromotionError('install transaction journal identity is inconsistent');
  }
  if (value.expectedVersion !== null && typeof value.expectedVersion !== 'string') {
    throw new InstallPromotionError('install transaction journal expectedVersion is malformed');
  }
  const expectedVersion =
    value.expectedVersion === null ? null : canonicalExpectedVersion(value.expectedVersion as string);
  if (expectedVersion !== value.expectedVersion) {
    throw new InstallPromotionError('install transaction journal expectedVersion is not canonical');
  }
  const genieHome = resolve(expectedHome);
  const liveRoot = join(genieHome, 'bin');
  if (value.genieHome !== genieHome || value.liveRoot !== liveRoot || typeof value.stagingRoot !== 'string') {
    throw new InstallPromotionError('install transaction journal paths do not match the requested GENIE_HOME');
  }
  const stagingRoot = resolve(value.stagingRoot);
  if (
    stagingRoot !== value.stagingRoot ||
    dirname(stagingRoot) !== liveRoot ||
    !/^\.install-staging-[A-Za-z0-9._-]+$/.test(basename(stagingRoot))
  ) {
    throw new InstallPromotionError('install transaction journal staging path is outside the physical bin root');
  }
  assertSafeOwnedDirectory(genieHome, 'journal GENIE_HOME');
  assertSafeOwnedDirectory(liveRoot, 'journal live bin root');
  assertSafeOwnedDirectory(stagingRoot, 'journal staging root', 0o700);
  if (!Array.isArray(value.members) || value.members.length !== INSTALL_PAYLOAD_MEMBERS.length) {
    throw new InstallPromotionError('install transaction journal member set is incomplete');
  }
  const members = value.members.map((raw, index): JournalMember => {
    if (!isRecord(raw)) throw new InstallPromotionError('install transaction member must be an object');
    exactKeys(raw, JOURNAL_MEMBER_KEYS, 'install transaction member');
    const name = memberName(raw.name, 'install transaction member name');
    if (name !== INSTALL_PAYLOAD_MEMBERS[index]) {
      throw new InstallPromotionError('install transaction members are not the exact canonical allowlist');
    }
    const incoming = parsePhysicalPathIdentity(raw.incoming);
    const prior = raw.prior === null ? null : parsePhysicalPathIdentity(raw.prior);
    assertSafeJournalIdentity(incoming, `incoming identity for ${name}`);
    if (prior !== null) assertSafeJournalIdentity(prior, `prior identity for ${name}`);
    return {
      name,
      incoming,
      prior,
    };
  });
  const journal = canonicalJournal({
    schemaVersion: 1,
    transactionId,
    expectedVersion,
    genieHome,
    liveRoot,
    stagingRoot,
    members,
  });
  if (canonicalJson(journal) !== text) {
    throw new InstallPromotionError('install transaction journal is not in canonical strict JSON form');
  }
  return journal;
}

function receiptFileName(sequence: number): string {
  return `${sequence.toString().padStart(RECEIPT_WIDTH, '0')}.json`;
}

function parseReceipt(path: string, transactionId: string, expectedSequence: number): InstallPromotionReceipt {
  const text = stableFileBytes(path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InstallPromotionError(`install transaction receipt is not valid JSON: ${path}`, { cause: error });
  }
  if (!isRecord(value)) throw new InstallPromotionError('install transaction receipt must be an object');
  exactKeys(value, RECEIPT_KEYS, 'install transaction receipt');
  if (
    value.schemaVersion !== 1 ||
    value.transactionId !== transactionId ||
    value.sequence !== expectedSequence ||
    typeof value.phase !== 'string' ||
    !RECEIPT_PHASES.has(value.phase as ReceiptPhase)
  ) {
    throw new InstallPromotionError('install transaction receipt identity or phase is inconsistent');
  }
  const phase = value.phase as ReceiptPhase;
  const member = value.member === null ? null : memberName(value.member, 'install transaction receipt member');
  if (MEMBER_RECEIPT_PHASES.has(phase) !== (member !== null)) {
    throw new InstallPromotionError('install transaction receipt member does not match its phase');
  }
  const receipt = canonicalReceipt({ schemaVersion: 1, transactionId, sequence: expectedSequence, phase, member });
  if (canonicalJson(receipt) !== text) {
    throw new InstallPromotionError('install transaction receipt is not in canonical strict JSON form');
  }
  return receipt;
}

function validateReceiptOrder(
  receipts: readonly InstallPromotionReceipt[],
  index: number,
  rollbackStarted: boolean,
  verified: boolean,
): void {
  const phase = receipts[index]?.phase;
  if ((phase === 'captured' || phase === 'published') && (rollbackStarted || verified)) {
    throw new InstallPromotionError('forward receipt appears after a final decision began');
  }
  if ((phase === 'returned' || phase === 'restored') && !rollbackStarted) {
    throw new InstallPromotionError('rollback member receipt appears before rollback-started');
  }
  if (phase === 'verified' && (rollbackStarted || verified)) {
    throw new InstallPromotionError('verified receipt is duplicated or follows rollback');
  }
  if (phase === 'committed' && (!verified || receipts[index - 1]?.phase !== 'verified')) {
    throw new InstallPromotionError('committed receipt is not immediately authorized by verified');
  }
  if (phase === 'rolledback' && !rollbackStarted) {
    throw new InstallPromotionError('rolledback receipt is not authorized by rollback-started');
  }
}

function validateReceiptHistory(receipts: readonly InstallPromotionReceipt[]): void {
  if (receipts.length === 0) return;
  if (receipts[0]?.phase !== 'created' || receipts.slice(1).some((receipt) => receipt.phase === 'created')) {
    throw new InstallPromotionError('install transaction created receipt is missing or duplicated');
  }
  let rollbackStarted = false;
  let verified = false;
  for (const [index, receipt] of receipts.entries()) {
    validateReceiptOrder(receipts, index, rollbackStarted, verified);
    if (receipt.phase === 'rollback-started') rollbackStarted = true;
    if (receipt.phase === 'verified') verified = true;
  }
}

function assertExactDirectoryNames(path: string, expected: readonly string[], label: string): void {
  const actual = readdirSync(path).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((name, index) => name !== sortedExpected[index])) {
    throw new InstallPromotionError(`${label} contains an unknown or missing object`);
  }
}

function validateTransactionStructure(transactionRoot: string): void {
  assertSafeOwnedDirectory(transactionRoot, 'install transaction root', 0o700);
  assertExactDirectoryNames(
    transactionRoot,
    [JOURNAL_FILE, 'prior', 'receipt-staging', 'receipts'],
    'install transaction root',
  );
  const priorRoot = join(transactionRoot, 'prior');
  const receiptStagingRoot = join(transactionRoot, 'receipt-staging');
  const receiptsRoot = join(transactionRoot, 'receipts');
  assertSafeOwnedDirectory(priorRoot, 'install transaction prior directory', 0o700);
  assertSafeOwnedDirectory(receiptStagingRoot, 'install receipt staging directory', 0o700);
  assertSafeOwnedDirectory(receiptsRoot, 'install transaction receipts', 0o700);
  for (const name of readdirSync(priorRoot).sort()) {
    memberName(name, 'install transaction prior object');
    assertSafeOwnedNode(join(priorRoot, name), true);
  }
  for (const name of readdirSync(receiptStagingRoot).sort()) {
    if (!/^\.receipt-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name)) {
      throw new InstallPromotionError('install receipt staging directory contains an unknown object');
    }
    stableFileBytes(join(receiptStagingRoot, name));
  }
}

function readReceipts(transactionRoot: string, transactionId: string): InstallPromotionReceipt[] {
  const receiptsRoot = join(transactionRoot, 'receipts');
  assertSafeOwnedDirectory(receiptsRoot, 'install transaction receipts', 0o700);
  const names = readdirSync(receiptsRoot).sort();
  const receipts: InstallPromotionReceipt[] = [];
  for (const [index, name] of names.entries()) {
    const sequence = index + 1;
    if (name !== receiptFileName(sequence)) {
      throw new InstallPromotionError('install transaction receipt sequence contains a gap or unknown object');
    }
    receipts.push(parseReceipt(join(receiptsRoot, name), transactionId, sequence));
  }
  const terminalIndex = receipts.findIndex(
    (receipt) => receipt.phase === 'committed' || receipt.phase === 'rolledback',
  );
  if (terminalIndex >= 0 && terminalIndex !== receipts.length - 1) {
    throw new InstallPromotionError('install transaction has receipts after its terminal decision');
  }
  if (receipts[0] !== undefined && receipts[0].phase !== 'created') {
    throw new InstallPromotionError('install transaction first receipt is not created');
  }
  validateReceiptHistory(receipts);
  return receipts;
}

function loadTransaction(transactionRoot: string, genieHome: string): LoadedTransaction {
  validateTransactionStructure(transactionRoot);
  const name = basename(transactionRoot);
  if (!name.startsWith(TRANSACTION_PREFIX)) throw new InstallPromotionError('install transaction name is malformed');
  const transactionId = name.slice(TRANSACTION_PREFIX.length);
  if (!TRANSACTION_ID_PATTERN.test(transactionId))
    throw new InstallPromotionError('install transaction id is malformed');
  const journal = parseJournal(join(transactionRoot, JOURNAL_FILE), genieHome, transactionId);
  return { root: transactionRoot, journal, receipts: readReceipts(transactionRoot, transactionId) };
}

function writeReceipt(
  transaction: LoadedTransaction,
  phase: ReceiptPhase,
  member: InstallPayloadMember | null,
  dependencies: InstallPromotionDependencies,
): void {
  const receipts = readReceipts(transaction.root, transaction.journal.transactionId);
  const sequence = receipts.length + 1;
  const receipt = canonicalReceipt({
    schemaVersion: 1,
    transactionId: transaction.journal.transactionId,
    sequence,
    phase,
    member,
  });
  if (MEMBER_RECEIPT_PHASES.has(phase) !== (member !== null)) {
    throw new InstallPromotionError('cannot publish a receipt with an inconsistent member phase');
  }
  const stagingRoot = join(transaction.root, 'receipt-staging');
  const receiptsRoot = join(transaction.root, 'receipts');
  const temporaryPath = join(stagingRoot, `.receipt-${(dependencies.randomId ?? randomUUID)()}`);
  assertNoPath(temporaryPath, 'receipt staging name');
  writeExclusiveDurableFile(temporaryPath, canonicalJson(receipt));
  const identity = identityAt(temporaryPath);
  if (identity === null) throw new InstallPromotionError('durable receipt disappeared before publication');
  const targetPath = join(receiptsRoot, receiptFileName(sequence));
  moveExact(
    temporaryPath,
    targetPath,
    identity,
    {
      operation: 'publish-receipt',
      member,
      sourcePath: temporaryPath,
      targetPath,
      transactionId: transaction.journal.transactionId,
    },
    dependencies,
    transaction.root,
  );
  transaction.receipts = [...receipts, receipt];
}

function promotionOrder(): InstallPayloadMember[] {
  return [...INSTALL_PAYLOAD_MEMBERS.filter((name) => name !== 'genie'), 'genie'];
}

function forwardCaptureOrder(): InstallPayloadMember[] {
  return ['genie', 'VERSION', ...INSTALL_PAYLOAD_MEMBERS.filter((name) => name !== 'genie' && name !== 'VERSION')];
}

function rollbackCaptureOrder(): InstallPayloadMember[] {
  return [
    'genie',
    'VERSION',
    ...promotionOrder()
      .reverse()
      .filter((name) => name !== 'genie' && name !== 'VERSION'),
  ];
}

function memberRecord(journal: InstallPromotionJournal, name: InstallPayloadMember): JournalMember {
  const member = journal.members.find((candidate) => candidate.name === name);
  if (member === undefined) throw new InstallPromotionError(`transaction member is missing: ${name}`);
  return member;
}

function memberPaths(transaction: LoadedTransaction, name: InstallPayloadMember) {
  return {
    incoming: join(transaction.journal.stagingRoot, name),
    live: join(transaction.journal.liveRoot, name),
    prior: join(transaction.root, 'prior', name),
  };
}

function inferFirstInstallMemberState(
  incoming: PhysicalPathIdentity | null,
  live: PhysicalPathIdentity | null,
  prior: PhysicalPathIdentity | null,
  member: JournalMember,
): MemberState | null {
  if (live === null && prior === null) {
    if (sameIdentity(incoming, member.incoming)) return 'captured';
    if (sameRootObject(incoming, member.incoming)) return 'quarantined';
  }
  if (incoming === null && prior === null) {
    if (sameIdentity(live, member.incoming)) return 'published';
    if (sameRootObject(live, member.incoming)) return 'published-drifted';
  }
  return null;
}

function inferReplacementMemberState(
  incoming: PhysicalPathIdentity | null,
  live: PhysicalPathIdentity | null,
  prior: PhysicalPathIdentity | null,
  member: JournalMember & { prior: PhysicalPathIdentity },
): MemberState | null {
  if (prior === null && sameIdentity(live, member.prior)) {
    if (sameIdentity(incoming, member.incoming)) return 'initial';
    if (sameRootObject(incoming, member.incoming)) return 'quarantined';
  }
  if (live === null && sameIdentity(prior, member.prior)) {
    if (sameIdentity(incoming, member.incoming)) return 'captured';
    if (sameRootObject(incoming, member.incoming)) return 'quarantined';
  }
  if (incoming === null && sameIdentity(prior, member.prior)) {
    if (sameIdentity(live, member.incoming)) return 'published';
    if (sameRootObject(live, member.incoming)) return 'published-drifted';
  }
  return null;
}

function inferMemberState(transaction: LoadedTransaction, member: JournalMember): MemberState {
  const paths = memberPaths(transaction, member.name);
  const incoming = identityAt(paths.incoming);
  const live = identityAt(paths.live);
  const prior = identityAt(paths.prior);
  const state =
    member.prior === null
      ? inferFirstInstallMemberState(incoming, live, prior, member)
      : inferReplacementMemberState(incoming, live, prior, member as JournalMember & { prior: PhysicalPathIdentity });
  if (state !== null) return state;
  throw new InstallPromotionError(
    `transaction member ${member.name} is in an unknown or foreign state; every observed object was preserved`,
    { transactionPath: transaction.root },
  );
}

function transitionMember(
  transaction: LoadedTransaction,
  member: JournalMember,
  operation: InstallPromotionRenameOperation,
  sourcePath: string,
  targetPath: string,
  expected: PhysicalPathIdentity,
  receiptPhase: ReceiptPhase,
  dependencies: InstallPromotionDependencies,
): void {
  const event: InstallPromotionRenameEvent = {
    operation,
    member: member.name,
    sourcePath,
    targetPath,
    transactionId: transaction.journal.transactionId,
  };
  moveExact(sourcePath, targetPath, expected, event, dependencies, transaction.root);
  if (terminalOutcome(transaction.receipts) === null) {
    writeReceipt(transaction, receiptPhase, member.name, dependencies);
  }
}

function captureMember(
  transaction: LoadedTransaction,
  member: JournalMember,
  dependencies: InstallPromotionDependencies,
): void {
  const state = inferMemberState(transaction, member);
  if (state === 'captured') return;
  if (state !== 'initial' || member.prior === null) {
    throw new InstallPromotionError(`cannot capture ${member.name} from state ${state}`, {
      transactionPath: transaction.root,
    });
  }
  const paths = memberPaths(transaction, member.name);
  transitionMember(
    transaction,
    member,
    'capture-prior',
    paths.live,
    paths.prior,
    member.prior,
    'captured',
    dependencies,
  );
}

function publishMember(
  transaction: LoadedTransaction,
  member: JournalMember,
  dependencies: InstallPromotionDependencies,
): void {
  const state = inferMemberState(transaction, member);
  if (state === 'published') return;
  if (state !== 'captured') {
    throw new InstallPromotionError(`cannot publish ${member.name} from state ${state}`, {
      transactionPath: transaction.root,
    });
  }
  const paths = memberPaths(transaction, member.name);
  transitionMember(
    transaction,
    member,
    'publish-incoming',
    paths.incoming,
    paths.live,
    member.incoming,
    'published',
    dependencies,
  );
}

function runForward(transaction: LoadedTransaction, dependencies: InstallPromotionDependencies): void {
  // Remove the prior executable before its VERSION stamp. If capture is
  // interrupted, no executable can observe a generation stamp whose payload
  // is already being dismantled. Publication keeps VERSION ahead of `genie`,
  // with `genie` as the final public boundary.
  for (const name of forwardCaptureOrder())
    captureMember(transaction, memberRecord(transaction.journal, name), dependencies);
  for (const name of promotionOrder())
    publishMember(transaction, memberRecord(transaction.journal, name), dependencies);
}

function returnIncoming(
  transaction: LoadedTransaction,
  member: JournalMember,
  dependencies: InstallPromotionDependencies,
): void {
  const paths = memberPaths(transaction, member.name);
  const actual = identityAt(paths.live);
  if (!sameRootObject(actual, member.incoming)) {
    throw new InstallPromotionError(`cannot quarantine a foreign live ${member.name}`, {
      transactionPath: transaction.root,
    });
  }
  transitionMember(
    transaction,
    member,
    'return-incoming',
    paths.live,
    paths.incoming,
    actual as PhysicalPathIdentity,
    'returned',
    dependencies,
  );
}

function reclaimPriorBinaryBackup(transaction: LoadedTransaction, dependencies: InstallPromotionDependencies): void {
  const member = memberRecord(transaction.journal, 'genie');
  if (member.prior === null) return;
  const priorPath = memberPaths(transaction, 'genie').prior;
  const backupPath = priorBinaryBackupPath(transaction);
  const prior = identityAt(priorPath);
  const backup = identityAt(backupPath);
  if (backup === null) return;
  if (prior !== null || !sameIdentity(backup, member.prior)) {
    throw new InstallPromotionError('prior Genie binary cannot be reclaimed exactly for rollback', {
      transactionPath: transaction.root,
    });
  }
  moveExact(
    backupPath,
    priorPath,
    member.prior,
    {
      operation: 'reclaim-prior-binary',
      member: 'genie',
      sourcePath: backupPath,
      targetPath: priorPath,
      transactionId: transaction.journal.transactionId,
    },
    dependencies,
    transaction.root,
  );
}

function restorePrior(
  transaction: LoadedTransaction,
  member: JournalMember,
  dependencies: InstallPromotionDependencies,
): void {
  if (member.prior === null) return;
  const paths = memberPaths(transaction, member.name);
  transitionMember(
    transaction,
    member,
    'restore-prior',
    paths.prior,
    paths.live,
    member.prior,
    'restored',
    dependencies,
  );
}

function rollbackTransaction(transaction: LoadedTransaction, dependencies: InstallPromotionDependencies): void {
  reclaimPriorBinaryBackup(transaction, dependencies);
  const quarantined = new Set<InstallPayloadMember>();
  // Remove the incoming executable before its VERSION stamp. The remaining
  // incoming objects are returned in a separate pass so no prior executable
  // can become visible while an incoming stamp is still live.
  for (const name of rollbackCaptureOrder()) {
    const member = memberRecord(transaction.journal, name);
    let state = inferMemberState(transaction, member);
    if (state === 'published' || state === 'published-drifted') {
      returnIncoming(transaction, member, dependencies);
      state = inferMemberState(transaction, member);
    }
    if (state === 'quarantined') quarantined.add(name);
  }

  // Restore the prior generation only after every incoming public name has
  // been captured. VERSION is restored before `genie`, and `genie` is always
  // the final executable boundary.
  for (const name of promotionOrder()) {
    const member = memberRecord(transaction.journal, name);
    if (
      member.prior !== null &&
      identityAt(memberPaths(transaction, name).live) === null &&
      sameIdentity(identityAt(memberPaths(transaction, name).prior), member.prior)
    ) {
      restorePrior(transaction, member, dependencies);
    }
    const finalState = inferMemberState(transaction, member);
    if (finalState === 'quarantined') {
      quarantined.add(name);
      continue;
    }
    const restored = member.prior === null ? finalState === 'captured' : finalState === 'initial';
    if (!restored) {
      throw new InstallPromotionError(`rollback did not restore exact original state for ${name}`, {
        transactionPath: transaction.root,
      });
    }
  }
  if (quarantined.size > 0) {
    throw new InstallPromotionError(
      `rollback quarantined changed incoming roots away from public paths: ${[...quarantined].join(', ')}`,
      { transactionPath: transaction.root },
    );
  }
}

function terminalOutcome(receipts: readonly InstallPromotionReceipt[]): InstallPromotionOutcome | null {
  const last = receipts.at(-1)?.phase;
  if (last === 'committed') return 'committed';
  if (last === 'rolledback') return 'rolledback';
  return null;
}

function ensureHistoryRoot(genieHome: string): string {
  const historyRoot = join(genieHome, HISTORY_DIRECTORY);
  ensurePhysicalPrivateDirectory(historyRoot, genieHome);
  return historyRoot;
}

function archiveTransaction(
  transaction: LoadedTransaction,
  outcome: InstallPromotionOutcome,
  dependencies: InstallPromotionDependencies,
): string {
  validateTransactionStructure(transaction.root);
  const historyRoot = ensureHistoryRoot(transaction.journal.genieHome);
  const archivePath = join(historyRoot, `${transaction.journal.transactionId}.${outcome}`);
  assertNoPath(archivePath, 'install transaction archive');
  const identity = identityAt(transaction.root);
  if (identity === null) throw new InstallPromotionError('install transaction disappeared before archival');
  const event: InstallPromotionRenameEvent = {
    operation: 'archive-transaction',
    member: null,
    sourcePath: transaction.root,
    targetPath: archivePath,
    transactionId: transaction.journal.transactionId,
  };
  moveExact(transaction.root, archivePath, identity, event, dependencies, transaction.root);
  return archivePath;
}

function priorBinaryBackupPath(transaction: LoadedTransaction): string {
  return join(transaction.journal.liveRoot, '.previous', `genie-prior-${transaction.journal.transactionId}`);
}

function assertExactPriorNames(transaction: LoadedTransaction, expected: readonly InstallPayloadMember[]): void {
  assertExactDirectoryNames(join(transaction.root, 'prior'), expected, 'install transaction prior directory');
}

function assertCommittedTerminalState(transaction: LoadedTransaction, backupRequired: boolean): void {
  assertSafeOwnedDirectory(transaction.journal.stagingRoot, 'install staging root', 0o700);
  assertExactDirectoryNames(transaction.journal.stagingRoot, [], 'committed install staging root');
  const expectedPrior: InstallPayloadMember[] = [];
  const backupPath = priorBinaryBackupPath(transaction);
  for (const member of transaction.journal.members) {
    const paths = memberPaths(transaction, member.name);
    if (identityAt(paths.incoming) !== null || !sameIdentity(identityAt(paths.live), member.incoming)) {
      throw new InstallPromotionError(`committed transaction has no exact live ${member.name}`, {
        transactionPath: transaction.root,
      });
    }
    if (member.prior === null) {
      if (identityAt(paths.prior) !== null) {
        throw new InstallPromotionError(`committed transaction has an unexpected prior ${member.name}`);
      }
      continue;
    }
    if (member.name !== 'genie') {
      if (!sameIdentity(identityAt(paths.prior), member.prior)) {
        throw new InstallPromotionError(`committed transaction lost exact prior ${member.name}`);
      }
      expectedPrior.push(member.name);
      continue;
    }
    const prior = identityAt(paths.prior);
    const backup = identityAt(backupPath);
    const beforeBackup = sameIdentity(prior, member.prior) && backup === null;
    const afterBackup = prior === null && sameIdentity(backup, member.prior);
    if ((backupRequired && !afterBackup) || (!backupRequired && !beforeBackup && !afterBackup)) {
      throw new InstallPromotionError('committed transaction prior binary shape is not exact', {
        transactionPath: transaction.root,
      });
    }
    if (beforeBackup) expectedPrior.push('genie');
  }
  const binaryMember = memberRecord(transaction.journal, 'genie');
  if (binaryMember.prior === null && identityAt(backupPath) !== null) {
    throw new InstallPromotionError('committed transaction has an unexpected prior binary backup');
  }
  assertExactPriorNames(transaction, expectedPrior);
}

function assertRolledbackTerminalState(transaction: LoadedTransaction): void {
  assertSafeOwnedDirectory(transaction.journal.stagingRoot, 'install staging root', 0o700);
  assertExactDirectoryNames(
    transaction.journal.stagingRoot,
    INSTALL_PAYLOAD_MEMBERS,
    'rolled-back install staging root',
  );
  for (const member of transaction.journal.members) {
    const paths = memberPaths(transaction, member.name);
    const expectedLive = member.prior;
    if (
      !sameIdentity(identityAt(paths.incoming), member.incoming) ||
      (expectedLive === null ? identityAt(paths.live) !== null : !sameIdentity(identityAt(paths.live), expectedLive)) ||
      identityAt(paths.prior) !== null
    ) {
      throw new InstallPromotionError(`rolled-back transaction did not restore exact member ${member.name}`, {
        transactionPath: transaction.root,
      });
    }
  }
  if (identityAt(priorBinaryBackupPath(transaction)) !== null) {
    throw new InstallPromotionError('rolled-back transaction unexpectedly published a prior binary backup');
  }
  assertExactPriorNames(transaction, []);
}

function publishPriorBinaryBackup(
  transaction: LoadedTransaction,
  dependencies: InstallPromotionDependencies,
): string | undefined {
  const member = memberRecord(transaction.journal, 'genie');
  if (member.prior === null) return undefined;
  const previousRoot = join(transaction.journal.liveRoot, '.previous');
  ensureCompatiblePreviousDirectory(previousRoot, transaction.journal.liveRoot);
  const sourcePath = memberPaths(transaction, 'genie').prior;
  const targetPath = priorBinaryBackupPath(transaction);
  const source = identityAt(sourcePath);
  const target = identityAt(targetPath);
  if (sameIdentity(target, member.prior) && source === null) return targetPath;
  if (!sameIdentity(source, member.prior) || target !== null) {
    throw new InstallPromotionError('prior Genie binary backup is occupied or no longer exact; transaction retained', {
      transactionPath: transaction.root,
    });
  }
  moveExact(
    sourcePath,
    targetPath,
    member.prior,
    {
      operation: 'publish-prior-binary',
      member: 'genie',
      sourcePath,
      targetPath,
      transactionId: transaction.journal.transactionId,
    },
    dependencies,
    transaction.root,
  );
  return targetPath;
}

function inspectStablePayloadMember(path: string, name: InstallPayloadMember): PhysicalPathIdentity {
  const before = identityAt(path);
  if (before === null || before.kind !== EXPECTED_MEMBER_KINDS[name]) {
    throw new InstallPromotionError(`staged install member ${name} has the wrong physical object kind`);
  }
  assertSafeOwnedNode(path, false);
  const after = identityAt(path);
  if (!sameIdentity(after, before)) {
    throw new InstallPromotionError(`staged install member ${name} changed during physical validation`);
  }
  return before;
}

function verifyPayloadLayout(stagingRoot: string, dependencies: InstallPromotionDependencies): JournalMember[] {
  assertSafeOwnedDirectory(stagingRoot, 'install staging root', 0o700);
  const actual = readdirSync(stagingRoot).sort();
  if (
    actual.length !== INSTALL_PAYLOAD_MEMBERS.length ||
    actual.some((name, index) => name !== INSTALL_PAYLOAD_MEMBERS[index])
  ) {
    throw new InstallPromotionError('staged install does not match the exact installer member allowlist');
  }
  return INSTALL_PAYLOAD_MEMBERS.map((name) => {
    const incoming = inspectStablePayloadMember(join(stagingRoot, name), name);
    dependencies.afterPayloadMemberInspected?.(name, incoming);
    return { name, incoming, prior: null };
  });
}

function assertSamePayloadGeneration(before: readonly JournalMember[], after: readonly JournalMember[]): void {
  for (const [index, member] of before.entries()) {
    const verified = after[index];
    if (verified?.name !== member.name || !sameIdentity(verified.incoming, member.incoming)) {
      throw new InstallPromotionError(`staged install member ${member.name} changed during version verification`);
    }
  }
}

function verifyVersion(
  binaryPath: string,
  expectedVersion: string,
  phase: 'staged' | 'live',
  verifier: PromoteStagedInstallOptions['verifyVersion'],
): void {
  if (verifier !== undefined) {
    if (verifier({ binaryPath, expectedVersion, phase }) === false) {
      throw new InstallPromotionError(`${phase} Genie binary failed caller-supplied version verification`);
    }
    return;
  }
  let output: string;
  try {
    output = execFileSync(binaryPath, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    throw new InstallPromotionError(`${phase} Genie binary failed to execute for version verification`, {
      cause: error,
    });
  }
  if (versionToken(output) !== expectedVersion) {
    throw new InstallPromotionError(`${phase} Genie binary version does not match ${expectedVersion}`);
  }
}

function assertAllPublished(transaction: LoadedTransaction): void {
  for (const member of transaction.journal.members) {
    if (inferMemberState(transaction, member) !== 'published') {
      throw new InstallPromotionError(`install member is not exactly published after verification: ${member.name}`, {
        transactionPath: transaction.root,
      });
    }
  }
}

function createTransaction(
  journal: InstallPromotionJournal,
  dependencies: InstallPromotionDependencies,
): LoadedTransaction {
  const preparationRoot = join(journal.genieHome, `${PREPARATION_PREFIX}${journal.transactionId}`);
  const transactionRoot = join(journal.genieHome, `${TRANSACTION_PREFIX}${journal.transactionId}`);
  assertNoPath(preparationRoot, 'install transaction preparation path');
  assertNoPath(transactionRoot, 'install transaction path');
  mkdirExclusive(preparationRoot, journal.genieHome);
  mkdirExclusive(join(preparationRoot, 'prior'), preparationRoot);
  mkdirExclusive(join(preparationRoot, 'receipts'), preparationRoot);
  mkdirExclusive(join(preparationRoot, 'receipt-staging'), preparationRoot);
  writeExclusiveDurableFile(join(preparationRoot, JOURNAL_FILE), canonicalJson(canonicalJournal(journal)));
  fsyncDirectory(preparationRoot);
  const identity = identityAt(preparationRoot);
  if (identity === null) throw new InstallPromotionError('prepared install transaction disappeared');
  moveExact(
    preparationRoot,
    transactionRoot,
    identity,
    {
      operation: 'activate-transaction',
      member: null,
      sourcePath: preparationRoot,
      targetPath: transactionRoot,
      transactionId: journal.transactionId,
    },
    dependencies,
    transactionRoot,
  );
  const transaction: LoadedTransaction = { root: transactionRoot, journal, receipts: [] };
  writeReceipt(transaction, 'created', null, dependencies);
  return transaction;
}

function nextTransactionId(dependencies: InstallPromotionDependencies): string {
  const value = (dependencies.randomId ?? randomUUID)().toLowerCase();
  if (!TRANSACTION_ID_PATTERN.test(value)) {
    throw new InstallPromotionError('transaction id generator returned a non-UUID value');
  }
  return value;
}

function assertPromotionRoots(
  genieHomeValue: string,
  stagingRootValue: string,
): { genieHome: string; liveRoot: string; stagingRoot: string } {
  const genieHome = resolve(genieHomeValue);
  const liveRoot = join(genieHome, 'bin');
  const stagingRoot = resolve(stagingRootValue);
  assertSafeOwnedDirectory(genieHome, 'GENIE_HOME');
  assertSafeOwnedDirectory(liveRoot, 'GENIE_HOME/bin');
  if (
    stagingRoot !== stagingRootValue ||
    dirname(stagingRoot) !== liveRoot ||
    !/^\.install-staging-[A-Za-z0-9._-]+$/.test(basename(stagingRoot))
  ) {
    throw new InstallPromotionError(
      'staging root must be an absolute direct .install-staging-* child of GENIE_HOME/bin',
    );
  }
  assertSafeOwnedDirectory(stagingRoot, 'install staging root', 0o700);
  return { genieHome, liveRoot, stagingRoot };
}

function pendingTransactionPaths(genieHome: string): string[] {
  const paths: string[] = [];
  for (const name of readdirSync(genieHome).sort()) {
    if (!name.startsWith(TRANSACTION_PREFIX) || name.startsWith(PREPARATION_PREFIX)) continue;
    const id = name.slice(TRANSACTION_PREFIX.length);
    if (!TRANSACTION_ID_PATTERN.test(id)) {
      throw new InstallPromotionError(`GENIE_HOME contains a malformed pending install transaction: ${name}`);
    }
    paths.push(join(genieHome, name));
  }
  return paths;
}

function recoverOne(
  transaction: LoadedTransaction,
  dependencies: InstallPromotionDependencies,
): InstallPromotionReport {
  if (transaction.receipts.length === 0) writeReceipt(transaction, 'created', null, dependencies);
  const activeTerminal = terminalOutcome(transaction.receipts) !== null;
  const rollbackAlreadyStarted = transaction.receipts.some((receipt) => receipt.phase === 'rollback-started');
  // Every object under the active transaction root is writable by the same
  // account running recovery. Consequently even a grammar-valid terminal
  // receipt is evidence, not authorization: all interrupted active roots are
  // rollback-only and must be inferred from exact filesystem objects.
  if (!activeTerminal && !rollbackAlreadyStarted) writeReceipt(transaction, 'rollback-started', null, dependencies);
  rollbackTransaction(transaction, dependencies);
  if (!activeTerminal) writeReceipt(transaction, 'rolledback', null, dependencies);
  assertRolledbackTerminalState(transaction);
  const archivePath = archiveTransaction(transaction, 'rolledback', dependencies);
  return {
    schemaVersion: 1,
    transactionId: transaction.journal.transactionId,
    outcome: 'rolledback',
    archivePath,
    stagingRoot: transaction.journal.stagingRoot,
  };
}

/** Read-only native capability check suitable for a hidden installer CLI command. */
export function installPromotionCapability(dependencies: InstallPromotionDependencies = {}) {
  const native = nativeNoReplaceCapability(dependencies.nativeRename);
  return {
    schemaVersion: 1 as const,
    platform: native.platform,
    available: native.available,
    members: [...INSTALL_PAYLOAD_MEMBERS],
  };
}

/**
 * Roll back every active transaction by exact inode identity. Receipt history
 * is evidence, never authorization to keep a live generation: even an active
 * terminal-looking transaction is rolled back from exact filesystem state.
 * Unknown or colliding objects stop recovery and remain untouched.
 */
export function recoverPendingInstallPromotions(options: RecoverInstallPromotionsOptions): InstallPromotionReport[] {
  const genieHome = resolve(options.genieHome);
  const dependencies = options.dependencies ?? {};
  assertSafeOwnedDirectory(genieHome, 'GENIE_HOME');
  if (!installPromotionCapability(dependencies).available) {
    throw new InstallPromotionError('native no-clobber rename capability is unavailable');
  }
  const reports: InstallPromotionReport[] = [];
  for (const path of pendingTransactionPaths(genieHome)) {
    const transaction = loadTransaction(path, genieHome);
    try {
      reports.push(recoverOne(transaction, dependencies));
    } catch (error) {
      if (error instanceof InstallPromotionInterruptedError) throw error;
      throw new InstallPromotionError('pending install transaction could not be recovered safely', {
        transactionPath: transaction.root,
        cause: error,
      });
    }
  }
  return reports;
}

/**
 * Promote one exact release generation into `$GENIE_HOME/bin`. All public
 * paths remain physical. Prior objects are moved into a private journal and
 * archived after verification; this function never copies or deletes them.
 */
export function promoteStagedInstall(options: PromoteStagedInstallOptions): InstallPromotionReport {
  const dependencies = options.dependencies ?? {};
  if (!installPromotionCapability(dependencies).available) {
    throw new InstallPromotionError('native no-clobber rename capability is unavailable');
  }
  const roots = assertPromotionRoots(options.genieHome, options.stagingRoot);
  recoverPendingInstallPromotions({ genieHome: roots.genieHome, dependencies });
  const expectedVersion = canonicalExpectedVersion(options.expectedVersion);
  if (expectedVersion === null) {
    throw new InstallPromotionError('promotion requires an expectedVersion to authenticate VERSION');
  }
  const beforeVerification = verifyPayloadLayout(roots.stagingRoot, dependencies);
  verifyPayloadVersionStamp(join(roots.stagingRoot, 'VERSION'), expectedVersion);
  verifyVersion(join(roots.stagingRoot, 'genie'), expectedVersion, 'staged', options.verifyVersion);
  const verifiedMembers = verifyPayloadLayout(roots.stagingRoot, dependencies);
  assertSamePayloadGeneration(beforeVerification, verifiedMembers);
  const members = verifiedMembers.map((member) => ({
    ...member,
    prior: identityAt(join(roots.liveRoot, member.name)),
  }));
  const transactionId = nextTransactionId(dependencies);
  const journal = canonicalJournal({
    schemaVersion: 1,
    transactionId,
    expectedVersion,
    genieHome: roots.genieHome,
    liveRoot: roots.liveRoot,
    stagingRoot: roots.stagingRoot,
    members,
  });
  let transaction: LoadedTransaction | null = null;
  try {
    transaction = createTransaction(journal, dependencies);
    runForward(transaction, dependencies);
    verifyVersion(join(roots.liveRoot, 'genie'), expectedVersion, 'live', options.verifyVersion);
    assertAllPublished(transaction);
    writeReceipt(transaction, 'verified', null, dependencies);
    writeReceipt(transaction, 'committed', null, dependencies);
    assertCommittedTerminalState(transaction, false);
    const priorBinaryPath = publishPriorBinaryBackup(transaction, dependencies);
    assertCommittedTerminalState(transaction, true);
    const archivePath = archiveTransaction(transaction, 'committed', dependencies);
    return {
      schemaVersion: 1,
      transactionId,
      outcome: 'committed',
      archivePath,
      stagingRoot: roots.stagingRoot,
      ...(priorBinaryPath === undefined ? {} : { priorBinaryPath }),
    };
  } catch (error) {
    if (error instanceof InstallPromotionInterruptedError) throw error;
    if (transaction === null) throw error;
    const refreshed = loadTransaction(transaction.root, roots.genieHome);
    if (terminalOutcome(refreshed.receipts) !== null) {
      throw new InstallPromotionError('install reached a terminal decision but archival failed; recovery is pending', {
        transactionPath: refreshed.root,
        cause: error,
      });
    }
    try {
      writeReceipt(refreshed, 'rollback-started', null, dependencies);
      rollbackTransaction(refreshed, dependencies);
      writeReceipt(refreshed, 'rolledback', null, dependencies);
      assertRolledbackTerminalState(refreshed);
      const archivePath = archiveTransaction(refreshed, 'rolledback', dependencies);
      throw new InstallPromotionError('install promotion failed and the exact prior generation was restored', {
        archivePath,
        rolledBack: true,
        cause: error,
      });
    } catch (rollbackError) {
      if (rollbackError instanceof InstallPromotionError && rollbackError.rolledBack) throw rollbackError;
      throw new InstallPromotionError(
        'install promotion failed and rollback retained a transaction for safe recovery',
        {
          transactionPath: refreshed.root,
          cause: rollbackError,
        },
      );
    }
  }
}
