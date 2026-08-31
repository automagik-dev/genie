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
 *
 * The four generic primitives -- `readBoundedRegularFile`, `fsyncParentDir`,
 * `atomicWriteFileSync` and `unlinkWithParentFsync` -- now live in
 * `atomic-fs.ts`: two of their consumers (`install-version-marker.ts`,
 * `update-capabilities.ts`) survive wish `skills-everywhere-b`, which deletes
 * this module in Group 3. They are re-exported here so no caller changes this
 * wave; `renameNonOverwriting` stays because only Codex activation uses it.
 *
 * The `BoundedFileRead` and `AtomicWriteOptions` types are NOT re-exported: no
 * module outside this one ever imported them (they were reachable only because
 * this file used them locally), and a pure type re-export with no importer is a
 * knip failure. Both are still exported from `atomic-fs.ts`.
 */

import { linkSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync, fsyncParentDir, readBoundedRegularFile, unlinkWithParentFsync } from './atomic-fs.js';

export { atomicWriteFileSync, fsyncParentDir, readBoundedRegularFile, unlinkWithParentFsync };

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
