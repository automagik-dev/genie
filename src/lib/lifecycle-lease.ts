/**
 * lifecycle-lease — the cross-process lock the lifecycle commands (install,
 * update, setup, uninstall) serialize on, plus the owner-record protocol it
 * shares byte-for-byte with the shell installer.
 *
 * Moved verbatim out of `agent-sync.ts`. It depends only on `atomic-fs.ts` and
 * `genie-home.ts`; nothing here imports `agent-sync.ts`.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { type Stats, closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { lstatSafe, readTrimmed, rmSyncSafe, statSafe } from './atomic-fs.js';
import { resolveGenieHome } from './genie-home.js';

/**
 * Bounded blocking wait before a lifecycle command gives up on a LIVE lease
 * holder. A dead same-host holder is stolen immediately and never waited on, so
 * this window only ever covers a genuinely concurrent lifecycle command.
 * Override with `GENIE_LIFECYCLE_LEASE_WAIT_MS`; `0` restores the historical
 * single-attempt fail-fast.
 */
const LIFECYCLE_LEASE_WAIT_MS = 15_000;
/** Borrowed lifecycle-lease path passed from a shell owner to its child process. */
export const LIFECYCLE_LEASE_PATH_ENV = 'GENIE_LIFECYCLE_LEASE_PATH';
/** Exact on-disk owner record paired with {@link LIFECYCLE_LEASE_PATH_ENV}. */
export const LIFECYCLE_LEASE_OWNER_ENV = 'GENIE_LIFECYCLE_LEASE_OWNER';
/** A lock older than this is a crashed run's debris and may be stolen. */
const LOCK_STALE_MS = 10 * 60 * 1000;

/** Portable synchronous bounded sleep — no dependency on the Bun global. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ============================================================================
// Cross-process lock
// ============================================================================

/**
 * Acquire the per-GENIE_HOME sync lock via O_EXCL create. Returns a release
 * handle or a fail-closed skip reason.
 *
 * Two stealing rules, in this order:
 *   1. DEATH-PROVEN (no staleness wait): the record names THIS host and its
 *      process is provably gone. A lifecycle command that crashed one second ago
 *      leaves a FRESH-mtime lock, so gating that case on {@link LOCK_STALE_MS}
 *      turns a dead holder into ten minutes of downtime for every subsequent
 *      `genie update`/`install`/`setup`/`uninstall`. Death is the proof;
 *      age adds nothing to it.
 *   2. STALE (unchanged legacy rule): every other record — live, unprovable
 *      (EPERM), cross-host, host-less, unparsable, or a lock created but not yet
 *      written — is stealable only once its mtime is outside the ± staleness
 *      window AND its recorded PID is not live.
 *
 * Both rules re-verify under the token-owned `.steal` guard before unlinking.
 * Any other lock I/O failure fails closed; a destructive sync never runs
 * without ownership.
 */
function acquireFileLock(lockPath: string): { release: () => void } | LifecycleLeaseSkip {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const created = tryInitializeFileLock(lockPath);
    if (created.status === 'acquired') return created.lock;
    if (created.status === 'failed') return { skipped: created.reason, cause: 'io' };
    const stat = statSafe(lockPath);
    if (stat === null) continue; // holder released between open and stat — retry
    const deathProvenRecord = sameHostDeadOwnerRecord(lockPath);
    if (deathProvenRecord !== null) {
      if (stealStaleFileLock(lockPath, deathProvenRecord) === 'contended') return heldLockSkip(lockPath);
      continue; // proven-dead debris cleared — retry the exclusive create
    }
    if (!isStaleOrInvalidLockTime(stat.mtimeMs)) return heldLockSkip(lockPath);
    // Age alone never proves abandonment. A slow or clock-skewed live owner
    // retains the lock regardless of whether its timestamp is old or future.
    if (lockHasLiveOwner(lockPath)) return heldLockSkip(lockPath);
    if (stealStaleFileLock(lockPath) === 'contended') return heldLockSkip(lockPath);
    // stale debris cleared — loop and retry the exclusive create
  }
  return { skipped: 'agent-sync lock remained contended after retries; skipped safely', cause: 'contended' };
}

/**
 * The exact on-disk record of a lock whose owner is PROVABLY dead on THIS host,
 * or null when no such proof exists. The positive host match is load-bearing:
 * a host-less legacy/shell record, a cross-host record, an unparsable record,
 * and a lock created but not yet written (which parses to null) all return null
 * and keep the conservative staleness rule. PID reuse is rejected inside
 * {@link lockOwnerIsLive} through the process-start identity, and an unprovable
 * liveness probe (EPERM) counts as alive. The returned record is the value the
 * steal guard re-compares against, mirroring the shell's `current == observed`
 * re-read in `recover_stale_lifecycle_lock`.
 */
function sameHostDeadOwnerRecord(lockPath: string): string | null {
  const record = readTrimmed(lockPath);
  const owner = parseLockOwner(record);
  if (record === null || owner === null) return null;
  if (owner.host === null || owner.host !== currentSyncLockHostId()) return null;
  return lockOwnerIsLive(owner) ? null : record;
}

type LockCreateAttempt =
  | { status: 'acquired'; lock: { release: () => void } }
  | { status: 'exists' }
  | { status: 'failed'; reason: string };

function tryInitializeFileLock(lockPath: string): LockCreateAttempt {
  let fd: number;
  const token = randomBytes(16).toString('hex');
  const processIdentity = processStartIdentity(process.pid) ?? 'unknown';
  // Host identity is appended as a 4th field so a lock created on one host can
  // never be stolen from another on an NFS / pid-namespace-shared $HOME. The
  // shell installer (install.sh) writes only the 3-field `pid:token:unknown`
  // form and parses just the leading pid, so a 4th field is backward-compatible
  // both ways: {@link lockOwner} reads it, the shell ignores it.
  const ownerRecord = `${process.pid}:${token}:${processIdentity}:${currentSyncLockHostId()}`;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return code === 'EEXIST'
      ? { status: 'exists' }
      : { status: 'failed', reason: `could not acquire agent-sync lock (${code}); skipped safely` };
  }
  let failure: unknown;
  try {
    writeSync(fd, `${ownerRecord}\n`);
  } catch (error) {
    failure = error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    failure ??= error;
  }
  if (failure === undefined) {
    return { status: 'acquired', lock: { release: () => releaseOwnedLock(lockPath, ownerRecord) } };
  }
  // A failed initializer never unlinks by pathname alone: if another process
  // replaced the record, only our token may release it. Partial debris safely
  // fails closed and is handled by the stale-lock path later.
  releaseOwnedLock(lockPath, ownerRecord);
  const code = (failure as NodeJS.ErrnoException).code ?? 'unknown';
  return { status: 'failed', reason: `could not initialize agent-sync lock (${code}); skipped safely` };
}

/**
 * The lock is held by someone we may not displace: a live owner, a cross-host
 * owner, or a record whose liveness could not be disproved. The message names
 * the exact file so an operator can inspect or remove it. The previous wording
 * reassured the reader that the holder was converging the same targets — true
 * for the agent-sync report skip (which keeps its own literal), FALSE for this
 * lease, where the holder may be an unrelated update/install/setup/uninstall.
 * It also gave the reader nothing actionable.
 */
function heldLockSkip(lockPath: string): LifecycleLeaseSkip {
  return {
    skipped: `another Genie process holds the lock at ${lockPath}; retry shortly, or remove the file if its owner has crashed`,
    cause: 'held',
  };
}

/** Old locks and far-future timestamps cannot suppress synchronization indefinitely. */
function isStaleOrInvalidLockTime(mtimeMs: number, nowMs = Date.now()): boolean {
  const ageMs = nowMs - mtimeMs;
  return ageMs > LOCK_STALE_MS || ageMs < -LOCK_STALE_MS;
}

/**
 * Parse current `pid:token:start:host` locks plus every legacy form
 * (`pid:token:start`, `pid:token`, `pid`) and the shell's `pid:token:unknown`.
 * `host` is absent (→ null) for any record written before this field existed or
 * by the shell installer; a null host is treated as "unknown host" downstream.
 */
interface LockOwner {
  pid: number;
  processIdentity: string | null;
  host: string | null;
}

function parseLockOwner(raw: string | null): LockOwner | null {
  const match = raw?.match(/^(\d+)(?::[a-f0-9]{32})?(?::([a-f0-9]{64}|unknown))?(?::([a-f0-9]{64}))?$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0
    ? { pid, processIdentity: match[2] ?? null, host: match[3] ?? null }
    : null;
}

function lockOwner(lockPath: string): LockOwner | null {
  return parseLockOwner(readTrimmed(lockPath));
}

/**
 * Never steal a live lock. Beyond PID-reuse rejection via the process-start
 * identity, a recorded HOST identity that DIFFERS from this host is treated as a
 * live owner and never stolen: `process.kill`/`ps` liveness on THIS host says
 * nothing about a peer on an NFS- or pid-namespace-shared $HOME, so a locally
 * "dead" pid cannot authorize stealing a lock a remote host may still hold. The
 * fail-closed asymmetry is deliberate — a wrongly-kept stale lock costs one
 * manual `rm`; a wrongly-stolen live lock costs a silent double writer.
 *
 * Deliberate scope decision (host-less records): a record with NO host field —
 * pre-this-change debris OR the shell installer's `pid:token:unknown` — falls
 * through to the legacy pid + start-identity liveness rather than being refused
 * outright. This preserves the shipped, tested shell<->TS lifecycle-lock parity
 * contract (install.sh writes and reaps host-less records by pid+mtime; the
 * guard-debris parity test in update.test.ts pins it). Refusing host-less steals
 * in TS alone would desynchronize the two acquirers AND still leave the shell
 * able to cross-host-steal — trading a real regression for incomplete safety.
 * Because every lock written after this change carries a host field — INCLUDING
 * every retirement lock (TS-only) and every post-upgrade agent-sync/lifecycle
 * lock — cross-host steal is prevented everywhere it can actually occur; only
 * transient legacy/shell-shaped records retain the prior semantics, in lockstep
 * with the shell.
 */
function lockHasLiveOwner(
  lockPath: string,
  resolveProcessStartIdentity: (pid: number) => string | null = processStartIdentity,
): boolean {
  return lockOwnerIsLive(lockOwner(lockPath), resolveProcessStartIdentity);
}

function lockOwnerIsLive(
  owner: LockOwner | null,
  resolveProcessStartIdentity: (pid: number) => string | null = processStartIdentity,
): boolean {
  if (owner === null) return false; // empty / unparseable record is genuine dead-writer debris
  if (owner.host !== null && owner.host !== currentSyncLockHostId()) return true; // host-bearing + cross-host → never steal
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (owner.processIdentity === null || owner.processIdentity === 'unknown') return true;
  const currentIdentity = resolveProcessStartIdentity(owner.pid);
  return currentIdentity === null || currentIdentity === owner.processIdentity;
}

/** Release only the exact owner record created by this acquisition. */
function releaseOwnedLock(lockPath: string, ownerRecord: string): void {
  if (readTrimmed(lockPath) !== ownerRecord) return;
  rmSyncSafe(lockPath);
}

let cachedSyncLockHostId: string | null = null;

/**
 * A stable identity for THIS host, embedded in every lock owner record so a
 * cross-host stealer can recognize "not my host" and refuse to steal. It is the
 * sha256 of the hostname plus, on linux, the kernel boot id
 * (`/proc/sys/kernel/random/boot_id`) — so a reused hostname across reboots
 * still yields distinct identities where the boot id is readable. Coverage is
 * scoped to distinct-hostname/distinct-kernel hosts: same-kernel containers
 * SHARE the boot id (runc/containerd do not namespace it), so two containers
 * with a pinned identical hostname and a shared $HOME collapse to one host id
 * and fall back to pid-liveness semantics across pid namespaces. The boot id is
 * best-effort: an empty read degrades to hostname-only, which is still
 * host-scoped. Exported for tests that must forge same-host vs cross-host owner
 * records.
 */
export function currentSyncLockHostId(): string {
  if (cachedSyncLockHostId !== null) return cachedSyncLockHostId;
  let bootId = '';
  if (process.platform === 'linux') {
    try {
      bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    } catch {
      bootId = '';
    }
  }
  cachedSyncLockHostId = createHash('sha256').update(`${hostname()}\0${bootId}`).digest('hex');
  return cachedSyncLockHostId;
}

function processStartIdentity(pid: number): string | null {
  let marker: string;
  try {
    if (process.platform === 'linux') {
      const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = raw.lastIndexOf(')');
      const fields = raw
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      marker = `linux:${fields[19] ?? ''}`;
    } else if (process.platform === 'win32') {
      marker = `windows:${execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
        { encoding: 'utf8', timeout: 1_000 },
      ).trim()}`;
    } else {
      marker = `ps:${execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
      }).trim()}`;
    }
    if (marker.endsWith(':')) return null;
    return createHash('sha256').update(marker).digest('hex');
  } catch {
    return null;
  }
}

export interface LifecycleLease {
  path: string;
  release: () => void;
}

/**
 * Why a lease was refused. Only `held` and `contended` describe a condition
 * that can clear on its own, so only those authorize the bounded wait in
 * {@link acquireLifecycleLeaseWithWait}. `borrow-mismatch` (a child's borrowed
 * lease does not match the live owner) and `io` (the lock file could not be
 * created or written) are permanent for this invocation and must fail fast.
 */
type LifecycleLeaseSkipCause = 'borrow-mismatch' | 'held' | 'io' | 'contended';

/**
 * A refused lease. `cause` is DELIBERATELY optional: hand-built fixtures and
 * pre-existing callers construct a bare `{ skipped }`, and a missing cause is
 * treated as "not retryable" so no caller silently gains a wait it never asked
 * for.
 */
export interface LifecycleLeaseSkip {
  skipped: string;
  cause?: LifecycleLeaseSkipCause;
}

const ACTIVE_LIFECYCLE_LEASES = new Map<string, { count: number; releaseUnderlying: () => void }>();

/** Stable sibling-of-GENIE_HOME lease shared by lifecycle commands. */
export function lifecycleLockPath(genieHome = resolveGenieHome()): string {
  const canonical = resolve(genieHome);
  const suffix = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return join(dirname(canonical), `.genie-lifecycle-${suffix}.lock`);
}

export function acquireLifecycleLease(genieHome = resolveGenieHome()): LifecycleLease | LifecycleLeaseSkip {
  const path = lifecycleLockPath(genieHome);
  const borrowedPath = process.env[LIFECYCLE_LEASE_PATH_ENV];
  const borrowedOwner = process.env[LIFECYCLE_LEASE_OWNER_ENV];
  if (borrowedPath !== undefined || borrowedOwner !== undefined) {
    if (
      borrowedPath !== path ||
      borrowedOwner === undefined ||
      borrowedOwner.length === 0 ||
      borrowedOwner.includes('\n') ||
      borrowedOwner.includes('\r') ||
      readTrimmed(path) !== borrowedOwner
    ) {
      return {
        skipped: 'borrowed lifecycle lease did not exactly match the expected live owner; skipped safely',
        cause: 'borrow-mismatch',
      };
    }
    // The shell parent remains the sole owner. A child must neither register
    // an exit handler nor unlink/decrement the parent lease when it finishes.
    return { path, release: () => undefined };
  }
  const active = ACTIVE_LIFECYCLE_LEASES.get(path);
  if (active) {
    active.count += 1;
    let released = false;
    return {
      path,
      release: () => {
        if (released) return;
        released = true;
        active.count -= 1;
        if (active.count === 0) {
          ACTIVE_LIFECYCLE_LEASES.delete(path);
          active.releaseUnderlying();
        }
      },
    };
  }
  const acquired = acquireFileLock(path);
  if ('skipped' in acquired) return acquired;
  const releaseOnExit = () => acquired.release();
  process.once('exit', releaseOnExit);
  const state = {
    count: 1,
    releaseUnderlying: () => {
      process.removeListener('exit', releaseOnExit);
      acquired.release();
    },
  };
  ACTIVE_LIFECYCLE_LEASES.set(path, state);
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      state.count -= 1;
      if (state.count === 0) {
        ACTIVE_LIFECYCLE_LEASES.delete(path);
        state.releaseUnderlying();
      }
    },
  };
}

function lifecycleLeaseWaitMs(): number {
  const override = process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS;
  const parsed = override === undefined ? Number.NaN : Number(override);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : LIFECYCLE_LEASE_WAIT_MS;
}

/**
 * Bounded-blocking wrapper over ANY lifecycle-lease acquirer (the default one,
 * or a DI-injected seam), mirroring {@link acquireRetirementLock}'s sleep-poll.
 *
 * The wait is deliberately narrow: only a `held`/`contended` refusal describes a
 * holder that can go away on its own, so only those are retried. A
 * `borrow-mismatch` or `io` refusal — and any fixture-built skip with NO cause —
 * returns on the first attempt without a single sleep. `deadlineMs` of 0 makes
 * exactly one attempt, restoring the historical fail-fast for operators and
 * tests via `GENIE_LIFECYCLE_LEASE_WAIT_MS=0`.
 *
 * A dead same-host holder never reaches this loop: {@link acquireFileLock}
 * steals it on the first attempt. This window covers only a genuinely live
 * concurrent lifecycle command.
 */
export function acquireLifecycleLeaseWithWait(
  acquirer: () => LifecycleLease | LifecycleLeaseSkip,
  deadlineMs: number = lifecycleLeaseWaitMs(),
): LifecycleLease | LifecycleLeaseSkip {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const result = acquirer();
    if (!('skipped' in result)) return result;
    if (result.cause !== 'held' && result.cause !== 'contended') return result;
    if (Date.now() >= deadline) return result;
    sleepSyncMs(25);
  }
}

/**
 * Clear a stale lock safely under a `.steal` guard file. The previous
 * unlink-then-retry steal let two processes both "win": between one stealer's
 * unlink and its re-create, a second stealer's unlink silently removed the
 * first's FRESH lock (observed as two concurrent writers in the regression
 * test). The guard closes that hole with two properties: (a) the O_EXCL guard
 * admits exactly one stealer at a time, and (b) the caller's grounds for
 * stealing are RE-verified while holding the guard, so a lock that changed after
 * the caller's first observation is never removed. A guard left by a crashed
 * stealer ages out via {@link LOCK_STALE_MS} like the lock itself.
 *
 * `deathProvenRecord` selects WHICH re-verification runs; the guard and the
 * `lockHasLiveOwner` re-check below are common to both and must never be
 * dropped:
 *   - undefined (staleness mode): re-verify the mtime is still outside the
 *     staleness window.
 *   - a record string (death-proven mode): re-verify the record on disk is
 *     BYTE-IDENTICAL to what the caller proved dead and still names this host —
 *     the same `current == observed` re-read the shell performs at
 *     install.sh:267-269. mtime is deliberately NOT consulted, because the whole
 *     point of this mode is a fresh-mtime lock whose owner is already gone.
 *
 * ONE protocol, two acquirers — this function and the shell installer
 * (recover_stale_lifecycle_lock in install.sh) must stay byte-compatible:
 *   - Lock path: `<dirname(canonical GENIE_HOME)>/.genie-lifecycle-<sha256(canonical)[:16]>.lock`
 *     ({@link lifecycleLockPath}); guard path is `<lock>.steal`.
 *   - Owner record: `pid:token32[:sha64|unknown]` — a decimal pid, an optional
 *     32-hex token, and an optional process-start identity (64-hex, or the
 *     literal `unknown` the shell always writes). {@link lockOwner} parses it;
 *     an empty or otherwise unparseable record yields `null`.
 *   - Staleness window: ±{@link LOCK_STALE_MS} (10 min) around the mtime; a
 *     timestamp too old OR implausibly far future is "stale".
 *   - Guard reap rule (the aged-guard-recovery branch below, mirrored by the
 *     shell's foreign_lock_record_is_stale): reap an existing guard we did not
 *     create only when its mtime is stale AND its owner is dead. An empty or
 *     unparseable record counts as dead (`lockOwner` → null). A live pid —
 *     including another user's process, where `process.kill(pid, 0)` throws
 *     EPERM — counts as alive and is never reaped ({@link lockHasLiveOwner}). A
 *     symlinked/non-regular guard OR lock is never reaped (lstat, never follow —
 *     parity with the shell's `! -L`). Reaping only unlinks; it never renames or
 *     quarantines.
 *   - Residual race (accepted): a process suspended (e.g. SIGSTOP, GC, swap)
 *     across BOTH the guard read→rm window and the lock read→rm window can
 *     still let two acquirers proceed as concurrent owners. This is pre-existing
 *     in the TS path; the shell matches it at parity rather than widening it.
 *   - DIVERGENCE (deliberate, one-sided): TS additionally steals a FRESH
 *     same-host lock whose owner is provably dead
 *     ({@link sameHostDeadOwnerRecord}); the shell's
 *     recover_stale_lifecycle_lock stays staleness-gated and still waits out
 *     {@link LOCK_STALE_MS} on the same debris. Safe in one direction only: TS
 *     steals a strict SUBSET of "abandoned" (dead ⊂ dead-or-stale), never a lock
 *     the shell would consider live, and the shell keeps refusing locks TS would
 *     take — the worst outcome is the shell waiting, never two writers. Do NOT
 *     "fix" the asymmetry by teaching install.sh to steal fresh locks: bash
 *     cannot reject PID reuse (it has no process-start identity), so a death
 *     proof there would be strictly weaker than the one made here.
 *   - {@link acquireRetirementLock} inherits the early steal through
 *     {@link acquireFileLock}. Benign and desirable: a retirement lock is TS-only
 *     and always carries a host field, so a crashed retirement no longer blocks
 *     the next one for ten minutes, while the cross-host refusal is unchanged (a
 *     cross-host record never yields a death proof).
 */
function stealStaleFileLock(lockPath: string, deathProvenRecord?: string): 'cleared' | 'contended' {
  const guardPath = `${lockPath}.steal`;
  const guardAttempt = tryInitializeFileLock(guardPath);
  if (guardAttempt.status !== 'acquired') {
    // lstat (never follow): a symlinked or otherwise non-regular guard is never
    // ours to reap — refuse it, matching the shell's `! -L` guard, so neither
    // acquirer can be redirected into unlinking a target it does not own.
    const guardStat = lstatSafe(guardPath);
    if (guardStat?.isFile() && isStaleOrInvalidLockTime(guardStat.mtimeMs) && !lockHasLiveOwner(guardPath)) {
      rmSyncSafe(guardPath);
    }
    return 'contended'; // another stealer holds the guard — back off like a live lock
  }
  try {
    const stat = statSafe(lockPath);
    if (stat !== null && !stealGroundsStillHold(lockPath, stat, deathProvenRecord)) return 'contended';
    if (stat !== null && lockHasLiveOwner(lockPath)) return 'contended';
    // Same fail-closed refusal for the lock: never unlink through a symlink or
    // other non-regular node (a symlinked lock is not ours to steal).
    const lockStat = lstatSafe(lockPath);
    if (lockStat !== null && !lockStat.isFile()) return 'contended';
    rmSyncSafe(lockPath); // re-verified stealable (or already gone) under the guard
    return 'cleared';
  } finally {
    guardAttempt.lock.release();
  }
}

/**
 * The under-guard half of the steal re-verification. Staleness mode re-reads the
 * mtime; death-proven mode re-reads the RECORD and requires it byte-identical to
 * the one the caller proved dead and still same-host. Either way a lock that was
 * replaced between the caller's observation and the guard is refused — that is
 * the property closing the double-writer hole.
 */
function stealGroundsStillHold(lockPath: string, stat: Stats, deathProvenRecord?: string): boolean {
  if (deathProvenRecord === undefined) return isStaleOrInvalidLockTime(stat.mtimeMs); // refreshed under us — live
  const current = readTrimmed(lockPath);
  if (current !== deathProvenRecord) return false; // a different owner published under us
  const owner = parseLockOwner(current);
  return owner !== null && owner.host !== null && owner.host === currentSyncLockHostId();
}

export {
  acquireFileLock,
  isStaleOrInvalidLockTime,
  lockHasLiveOwner,
  lockOwnerIsLive,
  parseLockOwner,
  processStartIdentity,
  sleepSyncMs,
  tryInitializeFileLock,
};
