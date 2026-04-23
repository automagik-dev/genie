/**
 * Process identity helpers — kernel-derived facts about a PID that survive the
 * PID being recycled to a different process.
 *
 * The start time is held by the kernel and cannot be spoofed by a later
 * process that inherits the same PID. Pairing `{pid}:{startTime}` in
 * `~/.genie/serve.pid` lets us detect "PID is alive but it's not our serve"
 * without needing IPC or an extra token file.
 *
 * Platforms:
 *   macOS  — `ps -o lstart= -p <pid>` returns a long-form start-time string
 *            like "Thu Apr 17 10:22:11 2026". Stable across `ps` versions.
 *   Linux  — field 22 of `/proc/<pid>/stat` is `starttime` in clock ticks
 *            since boot. Stable for the lifetime of the process.
 *
 * On any unsupported platform or on failure we return null. Callers treat
 * null as "cannot prove identity → assume stale", which is the safe default
 * (forces a respawn rather than silently skipping one).
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * Look up a stable, kernel-derived start-time token for the given PID.
 * Returns null if the PID is gone, the platform is unsupported, or the
 * lookup fails for any reason.
 */
export function getProcessStartTime(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;

  try {
    if (process.platform === 'darwin') {
      const raw = execSync(`ps -o lstart= -p ${pid}`, {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return raw === '' ? null : raw;
    }

    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
      // /proc/<pid>/stat format: "<pid> (<comm>) <state> ...". `comm` may
      // contain spaces/parens, so slice from the final ')' to avoid splitting
      // through the process name.
      const closeParen = raw.lastIndexOf(')');
      if (closeParen < 0) return null;
      const rest = raw
        .slice(closeParen + 1)
        .trim()
        .split(/\s+/);
      // After `)` the remaining fields are: state(3) ppid(4) ... starttime(22).
      // Index in `rest` is field_number - 3, so starttime → index 19.
      const starttime = rest[19];
      return starttime && starttime.length > 0 ? starttime : null;
    }
  } catch {
    return null;
  }

  return null;
}
