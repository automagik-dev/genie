/**
 * Codex activation lifecycle lease.
 *
 * One host, one PID namespace, one `GENIE_HOME`: this lease serialises every
 * mutating Codex-activation lifecycle operation (update delivery, external setup
 * activation, rollback, install convergence, journal quarantine) behind a single
 * atomically-created record and hands the acquirer a fresh 128-bit operation ID.
 * Every durable transition the activation store performs — journal, receipt,
 * tombstone, delivery-record, and the lease release itself — is fenced by that
 * operation ID, so a superseded holder can never write into another holder's
 * transaction.
 *
 * The lease grants mutual exclusion only. It never grants recovery authority:
 * that comes exclusively from the intent-phase truth table plus a fresh external
 * retirement assertion. Acquisition is a single `O_EXCL` create; a provably dead
 * PID (host-local `kill(pid,0)` → ESRCH) is superseded exactly once via a
 * non-overwriting rename that retains forensic evidence; a live or indeterminate
 * holder is always busy with no TTL, force flag, or consent override. PID reuse
 * can only make a dead holder look live, which fails safe (stays busy).
 *
 * Boundary: a shared `GENIE_HOME` across PID namespaces (containers) is outside
 * this contract — cross-namespace PIDs are not comparable.
 */

import { randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { readBoundedRegularFile, renameNonOverwriting, unlinkWithParentFsync } from './codex-activation-persistence.js';
import { resolveGenieHome } from './genie-home.js';

/** Lifecycle operations that may hold the lease; the kind names the holder in refusals. */
export type LifecycleLeaseKind =
  | 'update-delivery'
  | 'setup-activation'
  | 'rollback'
  | 'install-converge'
  | 'uninstall'
  | 'journal-quarantine';

const LEASE_KINDS: ReadonlySet<string> = new Set<LifecycleLeaseKind>([
  'update-delivery',
  'setup-activation',
  'rollback',
  'install-converge',
  'uninstall',
  'journal-quarantine',
]);

const LEASE_SCHEMA_VERSION = 1 as const;
const LEASE_FILE_NAME = '.codex-lifecycle.lock';
const MAX_LEASE_BYTES = 16 * 1024;
const OPERATION_ID_RE = /^[0-9a-f]{32}$/;

interface LeaseRecord {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  operationId: string;
  kind: LifecycleLeaseKind;
  pid: number;
  startedAt: string;
}

/** Thrown when a fenced transition carries an operation ID that no longer holds the lease. */
export class LifecycleFencingError extends Error {
  readonly code = 'codex-lifecycle-fenced';
  constructor(detail: string) {
    super(`codex lifecycle transition fenced: ${detail}`);
    this.name = 'LifecycleFencingError';
  }
}

export interface HeldLifecycleLease {
  ok: true;
  operationId: string;
  kind: LifecycleLeaseKind;
  /**
   * Fail closed unless `operationId` still owns the on-disk lease. Every store
   * transition calls this immediately before its durable write so a superseded
   * or released holder can never mutate protocol state.
   */
  assertOperation(operationId: string): void;
  /** Atomic delete + parent fsync; no-op if we no longer hold the lease. Idempotent. */
  release(): void;
}

export interface LifecycleLeaseBusy {
  ok: false;
  reason: 'codex-lifecycle-busy';
  /** The holder's kind when a valid record was read, else null (unreadable/invalid holder). */
  holderKind: LifecycleLeaseKind | null;
  detail: string;
}

export type LifecycleLeaseResult = HeldLifecycleLease | LifecycleLeaseBusy;

export interface AcquireLeaseOptions {
  genieHome?: string;
  /** Injectable liveness probe (host `kill(pid,0)` by default) for deterministic tests. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}

/**
 * Acquire the lifecycle lease for `kind`, or return a typed busy refusal naming
 * the current holder. Exactly one concurrent caller can win the `O_EXCL` create.
 */
export function acquireLifecycleLease(
  kind: LifecycleLeaseKind,
  options: AcquireLeaseOptions = {},
): LifecycleLeaseResult {
  if (!LEASE_KINDS.has(kind)) throw new Error(`unsupported lifecycle lease kind: ${String(kind)}`);
  const path = lifecycleLeasePath(options.genieHome);
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => new Date());

  const first = tryCreateLease(path, kind, now);
  if (first.ok) return first.lease;
  if (first.reason !== 'exists') return busy(first.holderKind, first.detail);

  const holder = readLeaseHolder(path);
  if (holder.status !== 'valid') {
    // Symlinked, non-regular, oversized, or schema-invalid lease files fail
    // closed as busy — never granted, never silently deleted.
    return busy(null, holder.detail);
  }
  if (!pidIsProvablyDead(holder.record.pid, isAlive)) {
    return busy(holder.record.kind, `held by ${holder.record.kind} (pid ${holder.record.pid})`);
  }

  // Dead holder: supersede via a non-overwriting rename that retains evidence,
  // then retry the atomic create exactly once. A competitor that grabbed the
  // slot during the window keeps us busy.
  const acquirerOperationId = mintOperationId();
  supersedeStaleLease(path, acquirerOperationId);
  const second = tryCreateLease(path, kind, now, acquirerOperationId);
  if (second.ok) return second.lease;
  if (second.reason === 'exists') {
    const contender = readLeaseHolder(path);
    const contenderKind = contender.status === 'valid' ? contender.record.kind : null;
    return busy(contenderKind, 'stale holder was superseded but another acquirer won the retry');
  }
  return busy(second.holderKind, second.detail);
}

/** Stable per-`GENIE_HOME` lease path; never exported as a raw capability to callers. */
function lifecycleLeasePath(genieHome = resolveGenieHome()): string {
  return join(genieHome, LEASE_FILE_NAME);
}

type CreateResult =
  | { ok: true; lease: HeldLifecycleLease }
  | { ok: false; reason: 'exists' }
  | { ok: false; reason: 'error'; holderKind: null; detail: string };

function tryCreateLease(
  path: string,
  kind: LifecycleLeaseKind,
  now: () => Date,
  operationId = mintOperationId(),
): CreateResult {
  mkdirSync(dirOf(path), { recursive: true });
  const record: LeaseRecord = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    operationId,
    kind,
    pid: process.pid,
    startedAt: now().toISOString(),
  };
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' };
    return { ok: false, reason: 'error', holderKind: null, detail: errorText(error) };
  }
  try {
    const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    let written = 0;
    while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written, null);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return { ok: true, lease: makeHeldLease(path, record) };
}

function makeHeldLease(path: string, record: LeaseRecord): HeldLifecycleLease {
  let released = false;
  return {
    ok: true,
    operationId: record.operationId,
    kind: record.kind,
    assertOperation(operationId: string): void {
      if (released) throw new LifecycleFencingError('lease already released');
      if (operationId !== record.operationId) {
        throw new LifecycleFencingError(`operation ${operationId} does not match held ${record.operationId}`);
      }
      const holder = readLeaseHolder(path);
      if (holder.status !== 'valid' || holder.record.operationId !== record.operationId) {
        throw new LifecycleFencingError('on-disk lease no longer matches this operation (superseded)');
      }
    },
    release(): void {
      if (released) return;
      released = true;
      const holder = readLeaseHolder(path);
      // Only delete the lease if it is still ours; a supersession may have
      // replaced it with another acquirer's record.
      if (holder.status === 'valid' && holder.record.operationId !== record.operationId) return;
      unlinkWithParentFsync(path);
    },
  };
}

type HolderRead = { status: 'valid'; record: LeaseRecord } | { status: 'invalid'; detail: string };

function readLeaseHolder(path: string): HolderRead {
  const read = readBoundedRegularFile(path, MAX_LEASE_BYTES);
  if (read.status === 'absent') return { status: 'invalid', detail: 'lease absent' };
  if (read.status === 'symlink') return { status: 'invalid', detail: 'lease path is a symlink' };
  if (read.status === 'non-regular') return { status: 'invalid', detail: 'lease path is not a regular file' };
  if (read.status === 'oversized') return { status: 'invalid', detail: `lease exceeds ${MAX_LEASE_BYTES} bytes` };
  if (read.status === 'unreadable') return { status: 'invalid', detail: `lease unreadable: ${read.detail}` };
  const record = parseLeaseRecord(read.content);
  return record ? { status: 'valid', record } : { status: 'invalid', detail: 'lease schema invalid' };
}

function parseLeaseRecord(content: string): LeaseRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const { schemaVersion, operationId, kind, pid, startedAt } = record;
  if (schemaVersion !== LEASE_SCHEMA_VERSION) return null;
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) return null;
  if (typeof kind !== 'string' || !LEASE_KINDS.has(kind)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  return { schemaVersion: LEASE_SCHEMA_VERSION, operationId, kind: kind as LifecycleLeaseKind, pid, startedAt };
}

function supersedeStaleLease(path: string, acquirerOperationId: string): void {
  renameNonOverwriting(path, `${path}.stale-${acquirerOperationId}`);
}

function pidIsProvablyDead(pid: number, isAlive: (pid: number) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // indeterminate → treat as live (busy)
  return !isAlive(pid);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: no such process (provably dead). EPERM: exists but not signalable
    // (alive). Anything else is indeterminate and treated as alive (fail safe).
    return code !== 'ESRCH';
  }
}

function mintOperationId(): string {
  return randomBytes(16).toString('hex');
}

function busy(holderKind: LifecycleLeaseKind | null, detail: string): LifecycleLeaseBusy {
  return { ok: false, reason: 'codex-lifecycle-busy', holderKind, detail };
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? '.' : path.slice(0, idx);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
