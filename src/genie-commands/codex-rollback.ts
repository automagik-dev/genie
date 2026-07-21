/**
 * Group C protocol-safe rollback (item 5). Re-enables `genie update --rollback`
 * for a backup that PROVES it is a protocol-1+ generation, closing the gap dev
 * left when it disabled automatic rollback (`rollbackBinaryAt`): a fixed updater
 * must never hand control to a pre-contract binary that could silently reactivate
 * a Codex generation during rollback (wish decision 7).
 *
 * Flow:
 *   1. Discover the `.previous/genie-<version>` backup that carries a digest-bound
 *      capability sidecar.
 *   2. `enforceRollbackCapabilityFloor` confirms it (no-follow/fstat, bounded
 *      rehash, no-shell probe, sidecar/probe/rehash agreement, protocol ≥ 1,
 *      intent-schema coverage, dual-identity TOCTOU revalidation).
 *   3. Acquire the `rollback` lifecycle lease AFTER floor confirmation and BEFORE
 *      any staging — a busy lease refuses with `codex-lifecycle-busy`, zero
 *      mutation.
 *   4. Re-confirm the floor UNDER the lease (the confirmation→exchange TOCTOU
 *      window the wish names) and require the identical retained digest.
 *   5. Atomic exchange with the same identity discipline the floor enforces:
 *      open no-follow, fstat regular, copy backup→same-directory staging while
 *      hashing, verify the staged digest BEFORE committing, fsync file then
 *      parent dir, rename(2) over the live binary, then immediately re-fstat and
 *      re-hash the new live binary against the retained identity.
 *
 * On ANY revalidation miss before the rename the live binary is left untouched
 * and the exact miss is reported. This module holds no permit, begins no
 * activation, and runs no Codex plugin command — it only restores a proven
 * binary generation.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  type Stats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fsyncParentDir } from '../lib/codex-activation-persistence.js';
import {
  type LifecycleLeaseResult,
  acquireLifecycleLease as acquireCodexLifecycleLease,
} from '../lib/codex-lifecycle-lease.js';
import {
  type RollbackFloorResult,
  capabilitySidecarPath,
  enforceRollbackCapabilityFloor,
} from '../lib/update-capabilities.js';

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;
const COPY_BUFFER_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;

export type RollbackResult =
  | { status: 'rolled-back'; restoredVersion: string; binarySha256: string }
  | { status: 'no-backup'; detail: string }
  | { status: 'refused'; detail: string }
  | { status: 'busy'; holderKind: string | null }
  | { status: 'aborted'; detail: string };

export interface ProtocolSafeRollbackOptions {
  /** `<GENIE_HOME>/bin` — holds the live `genie` and the `.previous/` backups. */
  genieBin: string;
  genieHome: string;
  /** Test seams. */
  acquireLease?: (genieHome: string) => LifecycleLeaseResult;
  enforceFloor?: (backupPath: string) => RollbackFloorResult;
}

/**
 * Discover the newest `.previous/genie-*` backup paired with a capability
 * sidecar. Returns the absolute backup path, or null when no digest-bound backup
 * exists (a legacy or absent backup — rollback is refused, not attempted).
 */
export function discoverRollbackBackup(genieBin: string): string | null {
  const previousDir = join(genieBin, '.previous');
  let entries: string[];
  try {
    entries = readdirSync(previousDir);
  } catch {
    return null;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const name of entries) {
    if (!name.startsWith('genie-') || name.endsWith('.capabilities.json')) continue;
    const path = join(previousDir, name);
    if (!hasSidecar(path)) continue;
    try {
      const stat = statSync(path);
      if (stat.isFile()) candidates.push({ path, mtimeMs: stat.mtimeMs });
    } catch {
      // unreadable entry — skip
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0].path;
}

function hasSidecar(backupPath: string): boolean {
  try {
    return statSync(capabilitySidecarPath(backupPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Perform a protocol-safe rollback. Every refusal path leaves the live binary,
 * the backup, and its sidecar byte-identical.
 */
export function performProtocolSafeRollback(options: ProtocolSafeRollbackOptions): RollbackResult {
  const livePath = join(options.genieBin, 'genie');
  const backupPath = discoverRollbackBackup(options.genieBin);
  if (backupPath === null) {
    return {
      status: 'no-backup',
      detail:
        'No digest-bound rollback backup found under .previous/. Legacy backups do not authenticate a protocol-1+ generation; reinstall the desired signed version explicitly.',
    };
  }

  const enforceFloor =
    options.enforceFloor ?? ((path: string) => enforceRollbackCapabilityFloor({ backupBinaryPath: path }));
  const floor = enforceFloor(backupPath);
  if (!floor.ok) return { status: 'refused', detail: floor.reason };

  // Acquire the rollback lease AFTER floor confirmation and BEFORE any staging.
  const acquire =
    options.acquireLease ?? ((genieHome: string) => acquireCodexLifecycleLease('rollback', { genieHome }));
  const lease = acquire(options.genieHome);
  if (!lease.ok) return { status: 'busy', holderKind: lease.holderKind };

  try {
    // Re-confirm under the lease: close the confirmation→exchange TOCTOU window.
    const recheck = enforceFloor(backupPath);
    if (!recheck.ok)
      return { status: 'aborted', detail: `backup no longer passes the floor under lease: ${recheck.reason}` };
    if (recheck.binarySha256 !== floor.binarySha256) {
      return { status: 'aborted', detail: 'backup digest changed between confirmation and exchange' };
    }
    exchangeBinaryAtomically(backupPath, livePath, floor.binarySha256);
    return { status: 'rolled-back', restoredVersion: floor.restoredVersion, binarySha256: floor.binarySha256 };
  } catch (error) {
    return { status: 'aborted', detail: error instanceof Error ? error.message : String(error) };
  } finally {
    lease.release();
  }
}

/**
 * Atomically restore `backupPath` over `livePath` with the floor's identity
 * discipline. Every verification is completed BEFORE the rename commit, so a
 * failure leaves the live binary untouched; the post-rename re-fstat is a final
 * identity confirmation (under the held lease no concurrent command can race it).
 */
export function exchangeBinaryAtomically(backupPath: string, livePath: string, expectedDigest: string): void {
  if (!isAbsolute(backupPath) || !isAbsolute(livePath)) {
    throw new Error('rollback exchange requires absolute paths');
  }
  const dir = dirname(livePath);
  const staging = join(dir, `.${basename(livePath)}.rollback-${process.pid}-${randomBytes(8).toString('hex')}`);
  let committed = false;
  try {
    const stagedDigest = copyNoFollowToStaging(backupPath, staging);
    // Verify the staged copy BEFORE committing — abort leaves live untouched.
    if (stagedDigest !== expectedDigest) {
      throw new Error('staged rollback copy digest does not match the confirmed backup');
    }
    fsyncParentDir(staging);
    renameSync(staging, livePath);
    committed = true;
    fsyncParentDir(livePath);
    // Immediately re-fstat + re-hash the new live binary against the retained id.
    const liveDigest = hashRegularFileNoFollow(livePath);
    if (liveDigest !== expectedDigest) {
      throw new Error('post-exchange live binary digest does not match the confirmed backup');
    }
  } finally {
    if (!committed) {
      try {
        unlinkSync(staging);
      } catch {
        // staging may not exist if the copy never opened it
      }
    }
  }
}

/** Copy a no-follow regular file into `staging` (O_EXCL, mode 0755), returning its sha256. */
function copyNoFollowToStaging(source: string, staging: string): string {
  const inFd = openSync(source, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    assertRegular(fstatSync(inFd), source);
    const outFd = openSync(staging, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o755);
    try {
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
      let total = 0;
      for (;;) {
        const read = readSync(inFd, buffer, 0, buffer.length, null);
        if (read <= 0) break;
        total += read;
        if (total > MAX_BINARY_BYTES) throw new Error('backup exceeds the rollback read cap');
        let written = 0;
        while (written < read) written += writeSync(outFd, buffer, written, read - written, null);
        hash.update(buffer.subarray(0, read));
      }
      fsyncSync(outFd);
      return hash.digest('hex');
    } finally {
      closeSync(outFd);
    }
  } finally {
    closeSync(inFd);
  }
}

function hashRegularFileNoFollow(path: string): string {
  const fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    assertRegular(fstatSync(fd), path);
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function assertRegular(stat: Stats, path: string): void {
  if (stat.isSymbolicLink()) throw new Error(`rollback path is a symlink: ${path}`);
  if (!stat.isFile()) throw new Error(`rollback path is not a regular file: ${path}`);
}
