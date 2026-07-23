/**
 * `.install-version` legacy install-marker lifecycle — Group D exclusive ownership.
 *
 * The v4-era installer wrote a `~/.genie/.install-version` marker whose content
 * duplicated the installed version. In v5 the canonical `VERSION` file is the
 * SOLE installed-version authority (Decision 14): the legacy marker is orphaned
 * drift that disagrees with `VERSION` on any machine upgraded across the v4→v5
 * boundary. Synchronising it would only mint a second authority, so this module
 * RETIRES the marker rather than reconciling it.
 *
 * This is the ONE module that owns the marker's lifecycle. Only install, update,
 * and uninstall wire to it; Group C (role-agent convergence) never imports or
 * mutates this API, which keeps install-lifecycle writes off the role-convergence
 * critical path.
 *
 *   - `readInstallVersionMarker`   — bounded, symlink-rejecting read of the legacy
 *     marker (`absent | present | unsafe`). Never trusted as version authority.
 *   - `retireInstallVersionMarker` — delete the legacy marker AFTER a successful
 *     install/update convergence. The caller gates the call on convergence
 *     success, so a failed convergence never reaches it and the prior bytes stay
 *     intact. The delete is backup-first (prior bytes are copied to a
 *     `.genie-backup-*` sidecar) and atomic, so an interrupted retirement leaves
 *     either the original file or nothing recoverable-from-backup — never a
 *     partial write. An unsafe (symlink/non-regular) marker is preserved and
 *     reported rather than followed. Idempotent: an already-absent marker is a
 *     no-op success.
 * UNINSTALL deliberately has NO dedicated marker call (Group E decision): the
 * digest-verified wholesale GENIE_HOME removal already deletes the marker in
 * both legacy layouts (regular file, symlink — the link is unlinked, never its
 * target; pinned by uninstall.test.ts). The marker is a snapshotted removable
 * child of `genieHomeRemovalDigest`, so any extra delete inside the
 * plan→execute window would poison that commitment and abort home removal;
 * before the window it is redundant, after it a no-op.
 *
 * Canonical `VERSION` is authoritative: this module never writes a version into
 * the marker and never reads it back as the installed version.
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { fsyncParentDir, readBoundedRegularFile, unlinkWithParentFsync } from './codex-activation-persistence.js';
import { resolveGenieHome } from './genie-home.js';

/** The stable legacy marker filename, resolved under `GENIE_HOME`. */
export const INSTALL_VERSION_MARKER_NAME = '.install-version';

/** A legacy marker cannot plausibly exceed a version string; anything larger is treated as unsafe drift. */
const MAX_MARKER_BYTES = 4 * 1024;

/** Stable path to the legacy marker under a given (or resolved) Genie home. */
export function resolveInstallVersionMarkerPath(genieHome: string = resolveGenieHome()): string {
  return join(genieHome, INSTALL_VERSION_MARKER_NAME);
}

export type InstallVersionMarkerRead =
  | { status: 'absent' }
  | { status: 'present'; value: string }
  | { status: 'unsafe'; detail: string };

/**
 * Bounded, symlink-rejecting read of the legacy marker. The returned `value` is
 * the trimmed marker content for diagnostics ONLY; callers must never treat it as
 * the installed version (canonical `VERSION` is authoritative). A symlink,
 * non-regular kind, oversize, or unreadable marker is `unsafe`, never `present`.
 */
export function readInstallVersionMarker(genieHome: string = resolveGenieHome()): InstallVersionMarkerRead {
  const read = readBoundedRegularFile(resolveInstallVersionMarkerPath(genieHome), MAX_MARKER_BYTES);
  switch (read.status) {
    case 'absent':
      return { status: 'absent' };
    case 'ok':
      return { status: 'present', value: read.content.trim() };
    case 'symlink':
      return { status: 'unsafe', detail: 'install-version marker is a symlink' };
    case 'non-regular':
      return { status: 'unsafe', detail: 'install-version marker is not a regular file' };
    case 'oversized':
      return { status: 'unsafe', detail: `install-version marker is oversized (${read.size} bytes)` };
    case 'unreadable':
      return { status: 'unsafe', detail: `install-version marker unreadable: ${read.detail}` };
  }
}

export type InstallVersionMarkerRetirement =
  | { status: 'already-absent' }
  | { status: 'retired'; previousValue: string | null }
  | { status: 'preserved'; detail: string };

/**
 * Retire (delete) the legacy marker after a successful install/update
 * convergence. The caller MUST only invoke this once convergence has succeeded;
 * a failed convergence returns before this point so the marker's prior bytes are
 * preserved untouched.
 *
 * A present regular marker is backed up (prior bytes copied to a
 * `.genie-backup-*` sidecar) and then atomically unlinked. An already-absent
 * marker is a no-op success (idempotent). An unsafe marker (symlink or
 * non-regular) is left exactly in place and reported — retirement never follows a
 * symlink or blindly removes an unexpected kind.
 */
export function retireInstallVersionMarker(genieHome: string = resolveGenieHome()): InstallVersionMarkerRetirement {
  const path = resolveInstallVersionMarkerPath(genieHome);
  const read = readInstallVersionMarker(genieHome);
  if (read.status === 'absent') return { status: 'already-absent' };
  if (read.status === 'unsafe') return { status: 'preserved', detail: read.detail };
  // Regular file: preserve prior bytes to a backup sidecar, then atomically remove.
  backupRegularFile(path);
  unlinkWithParentFsync(path);
  return { status: 'retired', previousValue: read.value.length > 0 ? read.value : null };
}

/** Best-effort copy of prior marker bytes to a unique sidecar; a backup failure never blocks retirement. */
function backupRegularFile(path: string): void {
  const backup = `${path}.genie-backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(6).toString('hex')}`;
  try {
    copyFileSync(path, backup);
    fsyncParentDir(backup);
  } catch {
    // Prior bytes are already durable on disk until the unlink below; a failed
    // forensic copy must not prevent retirement of a proven-current install.
  }
}
