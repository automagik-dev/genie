/**
 * Persistence primitives for the Codex activation protocol and lifecycle lease.
 *
 * Every durable state file the activation store owns — refresh intents, delivery
 * records, receipt-consumption tombstones, and explicit-downgrade receipts — is
 * written through these helpers so the durability contract lives in exactly one
 * place: bounded regular-file reads that fail closed on symlinks/oversize,
 * atomic backup-first fsync-before-rename writes, and non-overwriting renames for
 * quarantine and stale-holder supersession.
 *
 * None of these helpers classify or authorize. They are pure file mechanics that
 * distinguish physical fault categories (absent / symlink / non-regular /
 * oversized / unreadable) without mutation, so callers can fail closed on an
 * exact category rather than collapsing every fault into "missing".
 */

import { randomBytes } from 'node:crypto';
import {
  type Stats,
  closeSync,
  copyFileSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

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
  mkdirSync(dir, { recursive: true });
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

/**
 * Rename `from` to `to` without ever overwriting an existing `to`. Used for
 * quarantine (`.invalid-<sha256>` / `.invalid-oversized-<nonce>`) and stale-lease
 * supersession (`.stale-<operationId>`), where clobbering an existing sidecar
 * would destroy prior forensic evidence. Returns the path the content now lives
 * at: `to` when the move happened, or `to` when it already existed with the
 * source discarded (idempotent for content-addressed names).
 */
export function renameNonOverwriting(from: string, to: string): { moved: boolean; path: string } {
  try {
    linkAndUnlink(from, to);
    fsyncParentDir(to);
    return { moved: true, path: to };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      // Destination already holds this content; drop the redundant source.
      try {
        unlinkSync(from);
      } catch {
        // Source already gone — the move is effectively complete.
      }
      return { moved: false, path: to };
    }
    throw error;
  }
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

function linkAndUnlink(from: string, to: string): void {
  // renameSync overwrites on POSIX, so use link (fails EEXIST) then unlink the
  // source. This preserves the "never overwrite" invariant atomically.
  linkSync(from, to);
  try {
    unlinkSync(from);
  } catch {
    // The hard link is committed; a lingering source is harmless.
  }
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
