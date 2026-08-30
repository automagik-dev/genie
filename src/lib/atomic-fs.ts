/**
 * atomic-fs — the crash-safe filesystem primitives agent-sync (and every
 * lifecycle command) publishes through.
 *
 * Moved verbatim out of `agent-sync.ts` so the no-clobber publish, durable
 * write, and directory-fsync contracts live in one dependency-free leaf module.
 * Nothing here imports `agent-sync.ts`: this file is the bottom of the graph.
 */

import { dlopen } from 'bun:ffi';
import { randomBytes } from 'node:crypto';
import {
  constants,
  type Stats,
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';

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

/**
 * Atomically reserve an absent regular-file pathname with a hard link. The
 * linked candidate is a disposable copy, so the original staged bytes remain
 * immutable evidence if a concurrent writer changes the published inode.
 */
export function publishRegularFileNoClobber(stagedPath: string, targetPath: string): void {
  const stagedStat = lstatSync(stagedPath);
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
    throw new Error(`publish source is not a physical regular file: ${stagedPath}`);
  }
  const candidate = `${stagedPath}.publish-${process.pid}-${randomBytes(6).toString('hex')}`;
  copyFileSync(stagedPath, candidate, constants.COPYFILE_EXCL);
  chmodSync(candidate, stagedStat.mode & 0o7777);
  try {
    linkSync(candidate, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new NoClobberPublishError(`exclusive publish failed (${code}); target was preserved: ${targetPath}`);
  } finally {
    rmSync(candidate, { force: true });
  }
}

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

export {
  ManagedArtifactConflictError,
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
