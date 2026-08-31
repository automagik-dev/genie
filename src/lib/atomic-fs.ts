/**
 * atomic-fs — the crash-safe filesystem primitives every
 * lifecycle command) publishes through.
 *
 * Extracted so the no-clobber publish, durable
 * write, and directory-fsync contracts live in one dependency-free leaf module.
 * Nothing here imports a command module: this file is the bottom of the graph.
 */

import { dlopen } from 'bun:ffi';
import { createHash, randomBytes } from 'node:crypto';
import {
  constants,
  type Stats,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/**
 * `constants` under the name the persistence primitives moved in from
 * the retired Codex activation persistence module already used, so those blocks read verbatim.
 */
const fsConstants = constants;

/** Feature-detected glibc/musl sonames for the Linux renameat2 no-clobber fast path (x86_64). */
const LINUX_LIBC_CANDIDATES = ['libc.so.6', 'ld-musl-x86_64.so.1', 'libc.musl-x86_64.so.1'] as const;

function lstatSafe(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function statSafe(path: string): Stats | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // best-effort: a leftover lock ages out via LOCK_STALE_MS anyway.
  }
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

class ManagedArtifactConflictError extends Error {}

class NoClobberPublishError extends ManagedArtifactConflictError {}

/** Errors a DIRECTORY-metadata flush may legitimately raise on platforms/filesystems that refuse it. */
function isTolerableDirectoryFsyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EISDIR' || code === 'EPERM' || code === 'EINVAL' || code === 'ENOTSUP';
}

/**
 * Test seam for {@link fsyncPath}: inject the open/fsync syscalls (and platform)
 * so a directory-metadata flush can be forced to throw the way Windows and some
 * network filesystems do. Real callers pass nothing.
 */
export interface FsyncPathDeps {
  open?: typeof openSync;
  fsync?: typeof fsyncSync;
  platform?: NodeJS.Platform;
}

/**
 * fsync a path's metadata to disk. FILE fsync is STRICT — journal and staging
 * byte durability is the load-bearing crash-safety guarantee, so a failure
 * propagates. DIRECTORY-metadata flush is best-effort: Windows (and some network
 * filesystems) refuse to open/fsync a directory fd (EISDIR/EPERM/EINVAL/ENOTSUP),
 * which must NOT brick Codex setup at retirement-journal preparation. On
 * win32 a directory fsync is skipped entirely; elsewhere the tolerable errors are
 * swallowed. A durable rename still lands; only the extra directory-entry flush
 * is skipped, exactly as on filesystems that never guaranteed it.
 */
function fsyncPath(path: string, deps: FsyncPathDeps = {}): void {
  const open = deps.open ?? openSync;
  const fsync = deps.fsync ?? fsyncSync;
  const platform = deps.platform ?? process.platform;
  const isDirectory = lstatSafe(path)?.isDirectory() ?? false;
  if (isDirectory && platform === 'win32') return; // never fsync a directory fd on Windows
  let fd: number;
  try {
    fd = open(path, constants.O_RDONLY);
  } catch (error) {
    if (isDirectory && isTolerableDirectoryFsyncError(error)) return; // best-effort directory flush
    throw error;
  }
  try {
    fsync(fd);
  } catch (error) {
    if (!(isDirectory && isTolerableDirectoryFsyncError(error))) throw error; // FILE fsync stays strict
  } finally {
    closeSync(fd);
  }
}

/** Directly exercisable {@link fsyncPath} for the directory-fsync-tolerance proof (Windows/network-fs failpoint). */
export function fsyncPathForTest(path: string, deps: FsyncPathDeps = {}): void {
  fsyncPath(path, deps);
}

/**
 * Write a whole buffer to a descriptor, tolerating partial `writeSync` results.
 * Exported for a direct unit proof (a `writeFn` that returns a partial count
 * once, then delegates). The `<= 0` guard turns a stuck writer into a thrown
 * error rather than an infinite loop.
 */
export function writeAllSync(fd: number, buffer: Buffer, writeFn: typeof writeSync = writeSync): void {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeFn(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error(`journal write made no progress at offset ${offset}/${buffer.length}`);
    offset += written;
  }
}

const AT_FDCWD = -100;
const LINUX_RENAME_NOREPLACE = 1;
const DARWIN_RENAME_EXCL = 4;

type Renameat2 = (staged: Buffer, target: Buffer) => number;
type LibcRenameOpener = (soname: string) => Renameat2 | null;
interface RenameProbe {
  resolved?: Renameat2 | null;
}
/** Native no-clobber capability seams — no global mutable state or test-only setter. */
export interface NoClobberDeps {
  opener?: LibcRenameOpener;
  candidates?: readonly string[];
  probe?: RenameProbe;
  /** Deterministically select the native no-clobber family without mutating global process state. */
  platform?: NodeJS.Platform;
  /** Regular-file and lock-home callers use an explicit opener to select the Darwin branch on test hosts. */
  darwinOpener?: () => ((staged: Buffer, target: Buffer) => number) | null;
}

const defaultLibcOpener: LibcRenameOpener = (soname) => {
  try {
    const libc = dlopen(soname, {
      renameat2: { args: ['i32', 'cstring', 'i32', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    // Handle intentionally retained for process lifetime via the closure (single memoized detection).
    return (s, t) => libc.symbols.renameat2(AT_FDCWD, s, AT_FDCWD, t, LINUX_RENAME_NOREPLACE);
  } catch {
    return null;
  }
};

/** First soname whose renameat2 resolves, else null (musl / no renameat2). Exported for candidate fall-through proofs. */
export function resolveLinuxRenameat2(
  opener: LibcRenameOpener = defaultLibcOpener,
  candidates: readonly string[] = LINUX_LIBC_CANDIDATES,
): Renameat2 | null {
  for (const soname of candidates) {
    const fn = opener(soname);
    if (fn) return fn;
  }
  return null;
}

const defaultLinuxProbe: RenameProbe = {};
function probeLinuxRenameat2(deps: NoClobberDeps): Renameat2 | null {
  const hasInjectedResolution = deps.opener !== undefined || deps.candidates !== undefined;
  const probe = deps.probe ?? (hasInjectedResolution ? {} : defaultLinuxProbe);
  if (!('resolved' in probe)) {
    try {
      probe.resolved = resolveLinuxRenameat2(deps.opener, deps.candidates);
    } catch {
      probe.resolved = null;
    }
  }
  return probe.resolved ?? null;
}

const defaultDarwinRenameOpener: NonNullable<NoClobberDeps['darwinOpener']> = () => {
  try {
    const libc = dlopen('/usr/lib/libSystem.B.dylib', {
      renamex_np: { args: ['cstring', 'cstring', 'u32'], returns: 'i32' },
    } as const);
    try {
      const renamex = libc.symbols.renamex_np;
      if (typeof renamex !== 'function') {
        libc.close();
        return null;
      }
      return (staged, target) => {
        let result: number;
        try {
          result = renamex(staged, target, DARWIN_RENAME_EXCL);
        } catch (error) {
          try {
            libc.close();
          } catch {
            // Preserve the native invocation error; cleanup cannot authorize a portable retry.
          }
          throw error;
        }
        try {
          libc.close();
        } catch {
          // The native result is already known; close-only failure cannot rewrite the commit outcome.
        }
        return result;
      };
    } catch {
      try {
        libc.close();
      } catch {
        // Setup already failed; inability to close the incomplete handle does not make the capability available.
      }
      return null;
    }
  } catch {
    return null;
  }
};

function resolveDarwinRenameExclusive(deps: NoClobberDeps): ((staged: Buffer, target: Buffer) => number) | null {
  try {
    return (deps.darwinOpener ?? defaultDarwinRenameOpener)();
  } catch {
    return null;
  }
}

/**
 * Portable, always-available, directory-ONLY, provably no-clobber publish.
 * `mkdir` reserves the target name atomically (EEXIST => a real target is
 * present and never touched); `rename` then replaces only the empty dir we just
 * claimed. A concurrently-populated claim makes `rename` fail and only the
 * still-empty claim is removed.
 */
export function publishDirectoryViaNameClaim(stagedDir: string, targetDir: string): void {
  try {
    mkdirSync(targetDir);
  } catch (e) {
    throw new NoClobberPublishError(
      `portable directory claim failed (${(e as NodeJS.ErrnoException).code}); target preserved: ${targetDir}`,
    );
  }
  try {
    renameSync(stagedDir, targetDir);
  } catch (e) {
    if (readdirSync(targetDir).length === 0) rmSyncSafe(targetDir); // remove only our own still-empty claim
    throw new NoClobberPublishError(
      `portable directory publish failed (${(e as NodeJS.ErrnoException).code}); target preserved: ${targetDir}`,
    );
  }
}

/** Publish one complete same-filesystem directory while atomically rejecting every existing target inode. */
export function atomicRenameDirectoryNoClobber(stagedDir: string, targetDir: string, deps: NoClobberDeps = {}): void {
  const stagedStat = lstatSync(stagedDir);
  if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) {
    throw new Error(`atomic publish source is not a physical directory: ${stagedDir}`);
  }
  const stagedPath = Buffer.from(`${stagedDir}\0`);
  const targetPath = Buffer.from(`${targetDir}\0`);
  const platform = selectedNoClobberPlatform(deps);
  if (platform === 'linux') {
    const rn = probeLinuxRenameat2(deps);
    if (rn === null) {
      publishDirectoryViaNameClaim(stagedDir, targetDir); // musl / no renameat2 => portable
      return;
    }
    if (rn(stagedPath, targetPath) !== 0) {
      const detail = lstatSafe(targetDir) === null ? 'rename failed' : 'target exists';
      throw new NoClobberPublishError(`atomic no-clobber publish failed (${detail}); target preserved: ${targetDir}`);
    }
    return;
  }
  if (platform === 'darwin') {
    const renameExclusive = resolveDarwinRenameExclusive(deps);
    if (renameExclusive === null) {
      publishDirectoryViaNameClaim(stagedDir, targetDir);
      return;
    }
    const result = renameExclusive(stagedPath, targetPath);
    if (result !== 0) {
      const detail = lstatSafe(targetDir) === null ? 'rename failed' : 'target exists';
      throw new NoClobberPublishError(`atomic no-clobber publish failed (${detail}); target preserved: ${targetDir}`);
    }
    return;
  }
  publishDirectoryViaNameClaim(stagedDir, targetDir); // was: throw unsupported — now portable & no-clobber
}

function selectedNoClobberPlatform(deps: NoClobberDeps): NodeJS.Platform {
  return deps.platform ?? (deps.darwinOpener === undefined ? process.platform : 'darwin');
}

// ============================================================================
// Physical-tree digest
// ============================================================================
//
// `computeDirDigest` / `computeFileDigest` are the verification primitive
// `atomic-fs.test.ts` already used, and the only pieces of this cluster that
// survive wish `skills-everywhere-b`. The private helpers travel with them
// (a digest is defined by its traversal), and `MANIFEST_NAME` /
// `PHYSICAL_TREE_IDENTITY_VERSION` come along because the digest grammar is
// defined in terms of both. `legacy-integration-retirement.ts` is the only
// surviving consumer of the wider set (`computeExactDirDigest`,
// `computeLegacyRegularTreeDigest`, `physicalEntryKind`, `PhysicalTreeEntry`).

/** Manifest marker written into every managed skill dir. Exported: single source of truth. */
export const MANIFEST_NAME = '.genie-sync.json';
/** Physical-tree digest schema. Version 1 was the legacy regular-file content digest. */
export const PHYSICAL_TREE_IDENTITY_VERSION = 2;
// ============================================================================
// Digest — a stable fingerprint of a physical directory tree
// ============================================================================

/**
 * Version-2 SHA-256 identity over the root and every physical entry. Each entry
 * contributes its normalized relative path, exact lstat kind, permission mode,
 * and kind-specific payload (regular-file content hash or raw symlink target).
 * Symlinks are never followed; FIFOs, sockets, devices, and other non-regular
 * entries are represented rather than silently skipped. The manifest is always
 * excluded because its digest field would otherwise be self-referential.
 */
export function computeDirDigest(dir: string, exclude?: Set<string>): string {
  const excluded = new Set([...(exclude ?? [])].map(normalizePhysicalRelPath));
  excluded.add(MANIFEST_NAME);
  return computePhysicalTreeDigest(dir, excluded);
}

function computePhysicalTreeDigest(dir: string, excluded: Set<string>): string {
  const rootStat = lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`physical tree root is not a directory: ${dir}`);
  }
  const entries: PhysicalTreeEntry[] = [physicalTreeEntry('.', rootStat, dir)];
  collectPhysicalTreeEntries(dir, dir, excluded, entries);
  entries.sort(byRel);
  const digest = createHash('sha256');
  digest.update(`genie-physical-tree-v${PHYSICAL_TREE_IDENTITY_VERSION}\0`);
  for (const entry of entries) {
    updateLengthPrefixed(digest, entry.rel);
    updateLengthPrefixed(digest, entry.kind);
    updateLengthPrefixed(digest, entry.mode.toString(8));
    updateLengthPrefixed(digest, entry.payload);
  }
  return digest.digest('hex');
}

export interface PhysicalTreeEntry {
  rel: string;
  kind: 'directory' | 'file' | 'symlink' | 'fifo' | 'socket' | 'block-device' | 'character-device' | 'other';
  mode: number;
  payload: string;
}

function byRel(a: { rel: string }, b: { rel: string }): number {
  if (a.rel < b.rel) return -1;
  if (a.rel > b.rel) return 1;
  return 0;
}

function normalizePhysicalRelPath(path: string): string {
  return path.split(sep).join('/');
}

export function physicalEntryKind(stat: Stats): PhysicalTreeEntry['kind'] {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isFIFO()) return 'fifo';
  if (stat.isSocket()) return 'socket';
  if (stat.isBlockDevice()) return 'block-device';
  if (stat.isCharacterDevice()) return 'character-device';
  return 'other';
}

function physicalTreeEntry(rel: string, stat: Stats, absolute: string): PhysicalTreeEntry {
  const kind = physicalEntryKind(stat);
  const payload = kind === 'file' ? hashFile(absolute) : kind === 'symlink' ? readlinkSync(absolute) : '';
  return { rel, kind, mode: stat.mode & 0o7777, payload };
}

function collectPhysicalTreeEntries(
  root: string,
  current: string,
  excluded: Set<string>,
  out: PhysicalTreeEntry[],
): void {
  for (const name of readdirSync(current)) {
    const abs = join(current, name);
    const rel = normalizePhysicalRelPath(relative(root, abs));
    if (excluded.has(rel)) continue;
    const stat = lstatSync(abs);
    const entry = physicalTreeEntry(rel, stat, abs);
    out.push(entry);
    if (entry.kind === 'directory') collectPhysicalTreeEntries(root, abs, excluded, out);
  }
}

function updateLengthPrefixed(digest: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value);
  digest.update(String(bytes.length));
  digest.update(':');
  digest.update(bytes);
  digest.update('\0');
}

/**
 * Legacy v1 digest, accepted only when every physical entry is a regular file
 * or directory. A symlink or special entry in an old tree therefore revokes
 * deletion/update authority instead of recreating the legacy follow/skip bug.
 */
export function computeLegacyRegularTreeDigest(dir: string): string | null {
  const rootStat = lstatSync(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  const files: Array<{ rel: string; hash: string }> = [];
  const visit = (current: string): boolean => {
    for (const name of readdirSync(current)) {
      const absolute = join(current, name);
      const rel = relative(dir, absolute);
      if (rel === MANIFEST_NAME) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!visit(absolute)) return false;
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        files.push({ rel, hash: hashFile(absolute) });
      } else {
        return false;
      }
    }
    return true;
  };
  if (!visit(dir)) return null;
  files.sort(byRel);
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.rel);
    digest.update('\0');
    digest.update(file.hash);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function computeFileDigest(path: string): string {
  return hashFile(path);
}

// ============================================================================
// Bounded reads + durable writes — moved verbatim out of
// the retired Codex activation persistence module
// ============================================================================
//
// Nothing in these four primitives is Codex-specific: they are bounded
// regular-file reads that fail closed on symlink/oversize, a best-effort
// parent-directory fsync, an atomic backup-first write, and an idempotent
// unlink. Wish `skills-everywhere-b` Group 3 deletes their old home, and two
// consumers that survive it -- `install-version-marker.ts` and
// `update-capabilities.ts` -- depend on them, so they live here with the rest
// of the crash-safety contract. The old module re-exports them for this wave.

/** O_NOFOLLOW is POSIX-only; degrade to 0 on platforms that lack it. */
const O_NOFOLLOW = (fsConstants.O_NOFOLLOW ?? 0) as number;

export type BoundedFileRead =
  | { status: 'ok'; content: string; size: number }
  | { status: 'absent' }
  | { status: 'symlink' }
  | { status: 'non-regular' }
  | { status: 'oversized'; size: number }
  | { status: 'unreadable'; detail: string };

/**
 * Read a regular file bounded to `maxBytes`, following no symlink at the final
 * component. A symlink, non-regular kind, or oversize is a distinct fail-closed
 * category the caller must handle explicitly; nothing here is mutated.
 */
export function readBoundedRegularFile(path: string, maxBytes: number): BoundedFileRead {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', detail: errorText(error) };
  }
  if (stat.isSymbolicLink()) return { status: 'symlink' };
  if (!stat.isFile()) return { status: 'non-regular' };
  if (stat.size > maxBytes) return { status: 'oversized', size: stat.size };
  try {
    const fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
    try {
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const chunk = readSync(fd, buffer, read, stat.size - read, read);
        if (chunk <= 0) break;
        read += chunk;
      }
      return { status: 'ok', content: buffer.subarray(0, read).toString('utf8'), size: read };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { status: 'symlink' };
    return { status: 'unreadable', detail: errorText(error) };
  }
}

/** Best-effort parent-directory fsync; unsupported filesystems degrade silently. */
export function fsyncParentDir(path: string): void {
  try {
    const dirFd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Directory fsync is not portable; the file fsync + atomic rename remain sound.
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  /** Copy an existing regular target to a timestamped sidecar before replacing it. */
  backup?: boolean;
}

/**
 * Atomically publish `content` to `path`: create the parent, back up any prior
 * regular file, write a private staging sibling, fsync it, rename over the
 * target, and fsync the parent directory. The rename is the commit point, so a
 * crash before it leaves the prior file intact.
 */
export function atomicWriteFileSync(path: string, content: string, options: AtomicWriteOptions = {}): void {
  const mode = options.mode ?? 0o600;
  const dir = dirname(path);
  // Every caller writes under GENIE_HOME — the activation store's paths derive
  // from `resolveGenieHome()`, delivery evidence sits under
  // `<GENIE_HOME>/<evidence>`, and the capability sidecar lands beside the
  // prior binary in `<GENIE_HOME>/bin/.previous`. A direct mode is therefore
  // correct here; no caller opt-in is needed.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (options.backup) backupExistingRegularFile(path);
  const staging = join(dir, `.${basenameOf(path)}.staging-${process.pid}-${uniqueSuffix()}`);
  const fd = openSync(staging, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
  try {
    const buffer = Buffer.from(content, 'utf8');
    let written = 0;
    while (written < buffer.length) {
      written += writeSync(fd, buffer, written, buffer.length - written, null);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(staging, path);
  fsyncParentDir(path);
}

/** Delete a file and fsync its parent; ENOENT is treated as already-released. */
export function unlinkWithParentFsync(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fsyncParentDir(path);
}

function backupExistingRegularFile(path: string): void {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return;
  const backup = `${path}.genie-backup-${timestamp()}-${uniqueSuffix()}`;
  try {
    copyFileSync(path, backup);
    fsyncParentDir(backup);
  } catch {
    // A best-effort backup failure must not block the durable write itself.
  }
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || 'state';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export {
  NoClobberPublishError,
  fsyncPath,
  lstatSafe,
  probeLinuxRenameat2,
  readTrimmed,
  resolveDarwinRenameExclusive,
  rmSyncSafe,
  selectedNoClobberPlatform,
  statSafe,
};
export type { Renameat2 };
