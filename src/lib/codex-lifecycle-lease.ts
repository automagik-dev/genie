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
 * retirement assertion. Acquisition writes a complete fsynced private `O_EXCL`
 * record, then atomically publishes it at the stable path without overwrite. A
 * provably dead PID (host-local `kill(pid,0)` → ESRCH) is superseded under a
 * complete, no-clobber recovery claim, with atomic capture, identity revalidation,
 * and durable forensic evidence. Abandoned recovery claims are reclaimed only
 * after bounded identity and liveness rechecks. A live or indeterminate holder is
 * always busy with no TTL, force flag, or consent override. PID reuse can only
 * make a dead holder look live, which fails safe (stays busy).
 *
 * Boundary: a shared `GENIE_HOME` across PID namespaces (containers) is outside
 * this contract — cross-namespace PIDs are not comparable.
 */

import { randomBytes } from 'node:crypto';
import {
  type Stats,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  fsyncParentDir,
  readBoundedRegularFile,
  renameNonOverwriting,
  unlinkWithParentFsync,
} from './codex-activation-persistence.js';
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
const STAGING_SLOT_COUNT = 256;
const MAX_STAGING_RECOVERIES = 16;
const OPERATION_ID_RE = /^[0-9a-f]{32}$/;
const STAGING_SLOT_RE = /^[0-9a-f]{2}$/;

interface LeaseRecord {
  schemaVersion: typeof LEASE_SCHEMA_VERSION;
  operationId: string;
  kind: LifecycleLeaseKind;
  pid: number;
  startedAt: string;
  stagingSlot?: string;
  recoveryTargetOperationId?: string;
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

export interface LifecycleLeaseCaptureEvent {
  operation: 'release' | 'stale-supersede' | 'staging-recovery' | 'recovery-claim';
  path: string;
  capturedPath: string;
}

export interface AcquireLeaseOptions {
  genieHome?: string;
  /** Injectable liveness probe (host `kill(pid,0)` by default) for deterministic tests. */
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
  /**
   * Test-only barrier after the complete private record is fsynced but before it
   * is published at the stable lease path.
   */
  beforePublishForTest?: () => void;
  /** Test-only barrier after a dead stable holder is observed but before capture. */
  afterDeadHolderObservedForTest?: () => void;
  /** Test-only barrier after stale-recovery ownership is durably published. */
  afterRecoveryClaimForTest?: () => void;
  /** Test-only replacement seam after a pathname is atomically captured. */
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void;
}

/**
 * Acquire the lifecycle lease for `kind`, or return a typed busy refusal naming
 * the current holder. Exactly one concurrent caller can win stable publication.
 */
export function acquireLifecycleLease(
  kind: LifecycleLeaseKind,
  options: AcquireLeaseOptions = {},
): LifecycleLeaseResult {
  if (!LEASE_KINDS.has(kind)) throw new Error(`unsupported lifecycle lease kind: ${String(kind)}`);
  const path = lifecycleLeasePath(options.genieHome);
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const now = options.now ?? (() => new Date());

  const abandonedClaim = recoverAbandonedRecoveryClaim(path, isAlive, options.afterCaptureForTest);
  if (abandonedClaim.status === 'active') {
    return busy(abandonedClaim.holderKind, 'another acquirer is recovering a stale lifecycle holder');
  }
  if (abandonedClaim.status === 'invalid') {
    return busy(null, 'stale-holder recovery claim is invalid or changed while being inspected');
  }
  if (abandonedClaim.status === 'error') return busy(null, abandonedClaim.detail);

  recoverDeadStagingRecords(path, isAlive, options.afterCaptureForTest);
  const first = tryCreateLease(path, kind, now, undefined, options.beforePublishForTest, options.afterCaptureForTest);
  if (first.ok) return first.lease;
  if (first.reason !== 'exists') return busy(first.holderKind, first.detail);

  const holder = readLeaseSnapshot(path);
  if (holder === null) {
    // Symlinked, non-regular, oversized, or schema-invalid lease files fail
    // closed as busy — never granted, never silently deleted.
    const invalid = readLeaseHolder(path);
    if (invalid.status === 'valid') {
      return busy(invalid.record.kind, `held by ${invalid.record.kind}; lease publication is stabilizing`);
    }
    return busy(null, invalid.detail);
  }
  if (!pidIsProvablyDead(holder.record.pid, isAlive)) {
    return busy(holder.record.kind, `held by ${holder.record.kind} (pid ${holder.record.pid})`);
  }

  // Dead holder: elect one recovery owner, retain a no-clobber evidence link,
  // then atomically capture and revalidate the observed pathname. Losers never
  // touch the stable path and name the recovery owner's operation kind.
  options.afterDeadHolderObservedForTest?.();
  const acquirerOperationId = mintOperationId();
  const supersession = supersedeStaleLease(
    path,
    holder,
    kind,
    now,
    acquirerOperationId,
    isAlive,
    options.afterRecoveryClaimForTest,
    options.afterCaptureForTest,
  );
  if (supersession.status === 'error') return busy(null, supersession.detail);
  if (supersession.status === 'contended') {
    const contender = readLeaseHolder(path);
    const contenderKind = contender.status === 'valid' ? contender.record.kind : null;
    return busy(contenderKind, 'observed stale holder changed before supersession');
  }
  if (supersession.status === 'claimed') {
    return busy(supersession.holderKind, 'another acquirer is recovering the observed stale holder');
  }
  let second: CreateResult;
  try {
    second = tryCreateLease(
      path,
      kind,
      now,
      acquirerOperationId,
      options.beforePublishForTest,
      options.afterCaptureForTest,
    );
  } finally {
    releaseRecoveryClaim(supersession.claim);
  }
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

interface StagedLeaseRecord {
  path: string;
  slot: string;
  snapshot: LeaseSnapshot;
}

function tryCreateLease(
  path: string,
  kind: LifecycleLeaseKind,
  now: () => Date,
  operationId = mintOperationId(),
  beforePublishForTest?: () => void,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): CreateResult {
  try {
    mkdirSync(dirOf(path), { recursive: true });
  } catch (error) {
    return {
      ok: false,
      reason: 'error',
      holderKind: null,
      detail: `lease directory creation failed: ${errorText(error)}`,
    };
  }
  const record: LeaseRecord = {
    schemaVersion: LEASE_SCHEMA_VERSION,
    operationId,
    kind,
    pid: process.pid,
    startedAt: now().toISOString(),
  };
  const staged = stageLeaseRecord(path, record);
  if (!staged.ok) return { ok: false, reason: 'error', holderKind: null, detail: staged.detail };
  const { path: stagingPath } = staged;
  record.stagingSlot = staged.slot;
  try {
    beforePublishForTest?.();
  } catch (error) {
    cleanupStagedGenerationOrThrow(staged, error, 'lifecycle lease test barrier and cleanup both failed');
    throw error;
  }
  let publication: ReturnType<typeof renameNonOverwriting>;
  try {
    publication = renameNonOverwriting(stagingPath, path);
  } catch (error) {
    const cleanupDetail = cleanupStagedGenerationDetail(staged);
    return {
      ok: false,
      reason: 'error',
      holderKind: null,
      detail: `lease publication failed: ${errorText(error)}${cleanupDetail}`,
    };
  }
  if (!publication.moved) {
    // `renameNonOverwriting` already removed this generation's losing private
    // sibling. The bound cleanup only fsyncs absence or removes the same inode;
    // a contender that reused the fixed slot is preserved.
    const cleanupDetail = cleanupStagedGenerationDetail(staged);
    if (cleanupDetail) {
      return {
        ok: false,
        reason: 'error',
        holderKind: null,
        detail: `another acquirer won publication${cleanupDetail}`,
      };
    }
    return { ok: false, reason: 'exists' };
  }
  const published = readLeaseSnapshot(path);
  if (published === null || published.record.operationId !== operationId) {
    return {
      ok: false,
      reason: 'error',
      holderKind: null,
      detail: 'published lease ownership could not be verified',
    };
  }
  return { ok: true, lease: makeHeldLease(path, record, published.fingerprint, afterCaptureForTest) };
}

function stageLeaseRecord(
  path: string,
  record: LeaseRecord,
): ({ ok: true } & StagedLeaseRecord) | { ok: false; detail: string } {
  let stagingPath = '';
  let stagingSlot = '';
  let fd: number | null = null;
  for (const slot of stagingSlotsFor(record.operationId)) {
    const candidate = `${path}.staging-${slot}`;
    try {
      fd = openSync(candidate, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      stagingPath = candidate;
      stagingSlot = slot;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      return { ok: false, detail: errorText(error) };
    }
  }
  if (fd === null) return { ok: false, detail: `all ${STAGING_SLOT_COUNT} lifecycle lease staging slots are occupied` };
  record.stagingSlot = stagingSlot;
  try {
    try {
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
      let written = 0;
      while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written, null);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    const cleanupDetail = cleanupStagingDetail(stagingPath);
    return { ok: false, detail: `lifecycle lease staging write failed: ${errorText(error)}${cleanupDetail}` };
  }
  const snapshot = readLeaseSnapshot(stagingPath, true);
  if (
    snapshot === null ||
    snapshot.record.operationId !== record.operationId ||
    snapshot.record.stagingSlot !== stagingSlot
  ) {
    const cleanupDetail = cleanupStagingDetail(stagingPath);
    return { ok: false, detail: `lifecycle lease staging verification failed${cleanupDetail}` };
  }
  return { ok: true, path: stagingPath, slot: stagingSlot, snapshot };
}

function makeHeldLease(
  path: string,
  record: LeaseRecord,
  fingerprint: LeaseFingerprint,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): HeldLifecycleLease {
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
      const holder = readLeaseSnapshot(path);
      if (
        holder === null ||
        holder.record.operationId !== record.operationId ||
        !sameLeaseFingerprint(fingerprint, holder.fingerprint)
      ) {
        throw new LifecycleFencingError('on-disk lease no longer matches this operation (superseded)');
      }
    },
    release(): void {
      if (released) return;
      released = true;
      const holder = readLeaseSnapshot(path);
      // Compare-and-delete only: malformed, oversized, unreadable, symlinked, or foreign
      // replacements are never ours and must remain byte-for-byte in place.
      if (
        holder === null ||
        holder.record.operationId !== record.operationId ||
        !sameLeaseFingerprint(fingerprint, holder.fingerprint)
      ) {
        return;
      }
      const capture = captureExactLeasePath(path, holder, 'release', afterCaptureForTest);
      if (capture.status === 'captured') discardCapturedPath(capture.captured);
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
  const { schemaVersion, operationId, kind, pid, startedAt, stagingSlot, recoveryTargetOperationId } = record;
  if (schemaVersion !== LEASE_SCHEMA_VERSION) return null;
  if (typeof operationId !== 'string' || !OPERATION_ID_RE.test(operationId)) return null;
  if (typeof kind !== 'string' || !LEASE_KINDS.has(kind)) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== 'string' || startedAt.length === 0) return null;
  if (stagingSlot !== undefined && (typeof stagingSlot !== 'string' || !STAGING_SLOT_RE.test(stagingSlot))) return null;
  if (
    recoveryTargetOperationId !== undefined &&
    (typeof recoveryTargetOperationId !== 'string' || !OPERATION_ID_RE.test(recoveryTargetOperationId))
  ) {
    return null;
  }
  return {
    schemaVersion: LEASE_SCHEMA_VERSION,
    operationId,
    kind: kind as LifecycleLeaseKind,
    pid,
    startedAt,
    ...(typeof stagingSlot === 'string' ? { stagingSlot } : {}),
    ...(typeof recoveryTargetOperationId === 'string' ? { recoveryTargetOperationId } : {}),
  };
}

function supersedeStaleLease(
  path: string,
  observed: LeaseSnapshot,
  kind: LifecycleLeaseKind,
  now: () => Date,
  operationId: string,
  isAlive: (pid: number) => boolean,
  afterRecoveryClaimForTest?: () => void,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): SupersedeResult {
  const claimResult = acquireRecoveryClaim(
    path,
    observed,
    kind,
    now,
    operationId,
    isAlive,
    afterRecoveryClaimForTest,
    afterCaptureForTest,
  );
  if (claimResult.status !== 'acquired') return claimResult;
  const claim = claimResult.claim;
  const evidencePath = `${path}.stale-${observed.record.operationId}`;
  let createdEvidence = false;
  try {
    linkSync(path, evidencePath);
    createdEvidence = true;
    fsyncParentDir(evidencePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      releaseRecoveryClaim(claim);
      return { status: 'error', detail: `stale-holder evidence publication failed: ${errorText(error)}` };
    }
  }
  const evidence = readLeaseSnapshot(evidencePath);
  const current = readLeaseSnapshot(path);
  if (
    evidence === null ||
    current === null ||
    evidence.record.operationId !== observed.record.operationId ||
    current.record.operationId !== observed.record.operationId ||
    !sameLeaseGeneration(observed.fingerprint, evidence.fingerprint) ||
    !sameLeaseGeneration(evidence.fingerprint, current.fingerprint)
  ) {
    if (createdEvidence) removeClaimedEvidence(evidencePath, evidence);
    releaseRecoveryClaim(claim);
    return { status: 'contended' };
  }
  if (!pidIsProvablyDead(observed.record.pid, isAlive)) {
    if (createdEvidence) removeClaimedEvidence(evidencePath, evidence);
    releaseRecoveryClaim(claim);
    return { status: 'contended' };
  }
  let capture: CaptureAttempt;
  try {
    capture = captureExactLeasePath(path, current, 'stale-supersede', afterCaptureForTest);
  } catch (error) {
    if (createdEvidence) removeClaimedEvidence(evidencePath, evidence);
    releaseRecoveryClaim(claim);
    throw error;
  }
  if (capture.status === 'error') {
    if (createdEvidence) removeClaimedEvidence(evidencePath, evidence);
    releaseRecoveryClaim(claim);
    return { status: 'error', detail: capture.detail };
  }
  if (capture.status !== 'captured') {
    if (createdEvidence) removeClaimedEvidence(evidencePath, evidence);
    releaseRecoveryClaim(claim);
    return { status: 'contended' };
  }
  try {
    discardCapturedPath(capture.captured);
  } catch (error) {
    restoreOrPreserveCapturedPath(capture.captured, path);
    releaseRecoveryClaim(claim);
    return { status: 'error', detail: `stale-holder captured-record cleanup failed: ${errorText(error)}` };
  }
  return { status: 'superseded', claim };
}

interface RecoveryClaim {
  path: string;
  snapshot: LeaseSnapshot;
}

type SupersedeResult =
  | { status: 'superseded'; claim: RecoveryClaim }
  | { status: 'claimed'; holderKind: LifecycleLeaseKind | null }
  | { status: 'contended' }
  | { status: 'error'; detail: string };

type RecoveryClaimRecovery =
  | { status: 'absent' }
  | { status: 'recovered' }
  | { status: 'active'; holderKind: LifecycleLeaseKind }
  | { status: 'invalid' }
  | { status: 'error'; detail: string };

function acquireRecoveryClaim(
  path: string,
  observed: LeaseSnapshot,
  kind: LifecycleLeaseKind,
  now: () => Date,
  operationId: string,
  isAlive: (pid: number) => boolean,
  afterRecoveryClaimForTest?: () => void,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): { status: 'acquired'; claim: RecoveryClaim } | Exclude<SupersedeResult, { status: 'superseded' }> {
  const claimPath = `${path}.recovery`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const record: LeaseRecord = {
      schemaVersion: LEASE_SCHEMA_VERSION,
      operationId,
      kind,
      pid: process.pid,
      startedAt: now().toISOString(),
      recoveryTargetOperationId: observed.record.operationId,
    };
    const staged = stageLeaseRecord(path, record);
    if (!staged.ok) {
      return { status: 'error', detail: `stale-holder recovery claim failed: ${staged.detail}` };
    }
    let publication: ReturnType<typeof renameNonOverwriting>;
    try {
      publication = renameNonOverwriting(staged.path, claimPath);
    } catch (error) {
      const cleanupDetail = cleanupStagedGenerationDetail(staged);
      return {
        status: 'error',
        detail: `stale-holder recovery claim failed: ${errorText(error)}${cleanupDetail}`,
      };
    }
    const cleanupDetail = cleanupStagedGenerationDetail(staged);
    if (publication.moved) {
      const published = readLeaseSnapshot(claimPath);
      if (!recoveryClaimMatches(published, operationId, observed.record.operationId)) {
        return { status: 'error', detail: 'stale-holder recovery claim ownership could not be verified' };
      }
      const claim = { path: claimPath, snapshot: published };
      if (cleanupDetail) {
        releaseRecoveryClaim(claim);
        return {
          status: 'error',
          detail: `stale-holder recovery claim staging cleanup failed${cleanupDetail}`,
        };
      }
      try {
        afterRecoveryClaimForTest?.();
      } catch (error) {
        releaseRecoveryClaim(claim);
        throw error;
      }
      return { status: 'acquired', claim };
    }
    if (cleanupDetail) {
      return {
        status: 'error',
        detail: `stale-holder recovery claim staging cleanup failed${cleanupDetail}`,
      };
    }

    const recovery = recoverAbandonedRecoveryClaim(path, isAlive, afterCaptureForTest);
    if (recovery.status === 'recovered' || recovery.status === 'absent') continue;
    if (recovery.status === 'active') return { status: 'claimed', holderKind: recovery.holderKind };
    if (recovery.status === 'invalid') return { status: 'claimed', holderKind: null };
    return recovery;
  }
  return { status: 'contended' };
}

function recoveryClaimMatches(
  snapshot: LeaseSnapshot | null,
  operationId: string,
  targetOperationId: string,
): snapshot is LeaseSnapshot {
  return (
    snapshot !== null &&
    snapshot.record.operationId === operationId &&
    snapshot.record.recoveryTargetOperationId === targetOperationId
  );
}

function recoverAbandonedRecoveryClaim(
  path: string,
  isAlive: (pid: number) => boolean,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): RecoveryClaimRecovery {
  const claimPath = `${path}.recovery`;
  const first = inspectRecoveryClaim(claimPath);
  if (first.status === 'unstable') return { status: 'active', holderKind: first.holderKind };
  if (first.status !== 'valid') return first;
  if (!pidIsProvablyDead(first.snapshot.record.pid, isAlive)) {
    return { status: 'active', holderKind: first.snapshot.record.kind };
  }

  const second = inspectRecoveryClaim(claimPath);
  if (second.status === 'absent') return { status: 'recovered' };
  if (second.status === 'unstable') return { status: 'active', holderKind: second.holderKind };
  if (second.status === 'invalid') return second;
  if (
    second.snapshot.record.operationId !== first.snapshot.record.operationId ||
    second.snapshot.record.pid !== first.snapshot.record.pid ||
    second.snapshot.record.recoveryTargetOperationId !== first.snapshot.record.recoveryTargetOperationId ||
    !sameLeaseFingerprint(first.snapshot.fingerprint, second.snapshot.fingerprint)
  ) {
    return { status: 'active', holderKind: second.snapshot.record.kind };
  }
  if (!pidIsProvablyDead(second.snapshot.record.pid, isAlive)) {
    return { status: 'active', holderKind: second.snapshot.record.kind };
  }

  const capture = captureExactLeasePath(claimPath, second.snapshot, 'recovery-claim', afterCaptureForTest);
  if (capture.status === 'error') {
    return { status: 'error', detail: `stale-holder recovery claim cleanup failed: ${capture.detail}` };
  }
  if (capture.status === 'contended') {
    const current = inspectRecoveryClaim(claimPath);
    if (current.status === 'absent') return { status: 'recovered' };
    if (current.status === 'unstable') return { status: 'active', holderKind: current.holderKind };
    if (current.status === 'valid') return { status: 'active', holderKind: current.snapshot.record.kind };
    return current;
  }
  const captured = readLeaseSnapshot(capture.captured.path);
  if (
    captured === null ||
    captured.record.operationId !== second.snapshot.record.operationId ||
    captured.record.pid !== second.snapshot.record.pid ||
    captured.record.recoveryTargetOperationId !== second.snapshot.record.recoveryTargetOperationId ||
    !sameLeaseFingerprint(second.snapshot.fingerprint, captured.fingerprint) ||
    !pidIsProvablyDead(captured.record.pid, isAlive)
  ) {
    restoreOrPreserveCapturedPath(capture.captured, claimPath);
    return { status: 'active', holderKind: second.snapshot.record.kind };
  }
  try {
    discardCapturedPath(capture.captured);
    const replacement = inspectRecoveryClaim(claimPath);
    if (replacement.status === 'absent') return { status: 'recovered' };
    if (replacement.status === 'unstable') {
      return { status: 'active', holderKind: replacement.holderKind };
    }
    if (replacement.status === 'valid') {
      return { status: 'active', holderKind: replacement.snapshot.record.kind };
    }
    return replacement;
  } catch (error) {
    restoreOrPreserveCapturedPath(capture.captured, claimPath);
    return { status: 'error', detail: `stale-holder recovery claim cleanup failed: ${errorText(error)}` };
  }
}

function inspectRecoveryClaim(
  claimPath: string,
):
  | { status: 'valid'; snapshot: LeaseSnapshot }
  | { status: 'unstable'; holderKind: LifecycleLeaseKind }
  | { status: 'absent' }
  | { status: 'invalid' } {
  const snapshot = readLeaseSnapshot(claimPath);
  if (snapshot !== null && snapshot.record.recoveryTargetOperationId !== undefined) {
    return { status: 'valid', snapshot };
  }
  const holder = readLeaseHolder(claimPath);
  if (holder.status === 'valid' && holder.record.recoveryTargetOperationId !== undefined) {
    return { status: 'unstable', holderKind: holder.record.kind };
  }
  return holder.status === 'invalid' && holder.detail === 'lease absent' ? { status: 'absent' } : { status: 'invalid' };
}

function releaseRecoveryClaim(claim: RecoveryClaim): void {
  const capture = captureExactLeasePath(claim.path, claim.snapshot, 'recovery-claim');
  if (capture.status !== 'captured') return;
  try {
    discardCapturedPath(capture.captured);
  } catch {
    restoreOrPreserveCapturedPath(capture.captured, claim.path);
  }
}

function removeClaimedEvidence(path: string, expected: LeaseSnapshot | null): void {
  if (expected === null) return;
  const capture = captureExactLeasePath(path, expected, 'stale-supersede');
  if (capture.status !== 'captured') return;
  try {
    discardCapturedPath(capture.captured);
  } catch {
    restoreOrPreserveCapturedPath(capture.captured, path);
  }
}

function pidIsProvablyDead(pid: number, isAlive: (pid: number) => boolean): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // indeterminate → treat as live (busy)
  try {
    return !isAlive(pid);
  } catch {
    return false;
  }
}

interface LeaseFingerprint {
  dev: number;
  ino: number;
  mode: number;
  size: number;
  mtimeMs: number;
  nlink: number;
}

interface LeaseSnapshot {
  record: LeaseRecord;
  fingerprint: LeaseFingerprint;
}

interface CapturedLeasePath {
  directory: string;
  path: string;
}

/**
 * Best-effort bounded cleanup for private records left by a process killed
 * after fsync and before stable publication. Only an exact filename/record
 * operation binding with a stable physical identity, one link, and a provably
 * dead PID is removable. Every other state is preserved fail-closed.
 */
function recoverDeadStagingRecords(
  path: string,
  isAlive: (pid: number) => boolean,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): void {
  let recovered = 0;
  for (let slotIndex = 0; slotIndex < STAGING_SLOT_COUNT && recovered < MAX_STAGING_RECOVERIES; slotIndex += 1) {
    const slot = slotIndex.toString(16).padStart(2, '0');
    if (recoverOneDeadStagingRecord(`${path}.staging-${slot}`, slot, isAlive, afterCaptureForTest)) {
      recovered += 1;
    }
  }
}

function recoverOneDeadStagingRecord(
  stagingPath: string,
  expectedSlot: string,
  isAlive: (pid: number) => boolean,
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): boolean {
  const first = readLeaseSnapshot(stagingPath, true);
  if (first === null || first.record.stagingSlot !== expectedSlot) return false;
  if (!pidIsProvablyDead(first.record.pid, isAlive)) return false;
  const second = readLeaseSnapshot(stagingPath, true);
  if (
    second === null ||
    second.record.operationId !== first.record.operationId ||
    second.record.stagingSlot !== expectedSlot ||
    second.record.pid !== first.record.pid ||
    !sameLeaseFingerprint(first.fingerprint, second.fingerprint)
  ) {
    return false;
  }
  const capture = captureExactLeasePath(stagingPath, second, 'staging-recovery', afterCaptureForTest);
  if (capture.status !== 'captured') return false;
  const capturedState = readLeaseSnapshot(capture.captured.path, true);
  if (
    capturedState === null ||
    capturedState.record.operationId !== second.record.operationId ||
    capturedState.record.stagingSlot !== expectedSlot ||
    capturedState.record.pid !== second.record.pid ||
    !sameLeaseFingerprint(second.fingerprint, capturedState.fingerprint) ||
    !pidIsProvablyDead(capturedState.record.pid, isAlive)
  ) {
    restoreOrPreserveCapturedPath(capture.captured, stagingPath);
    return false;
  }
  try {
    discardCapturedPath(capture.captured);
    return true;
  } catch {
    restoreOrPreserveCapturedPath(capture.captured, stagingPath);
    return false;
  }
}

function readLeaseSnapshot(path: string, requireSingleLink = false): LeaseSnapshot | null {
  const before = leaseFingerprint(path);
  if (before === null || (requireSingleLink && before.nlink !== 1)) return null;
  const holder = readLeaseHolder(path);
  if (holder.status !== 'valid') return null;
  const after = leaseFingerprint(path);
  if (after === null || !sameLeaseFingerprint(before, after)) return null;
  return { record: holder.record, fingerprint: after };
}

function leaseFingerprint(path: string): LeaseFingerprint | null {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    nlink: stat.nlink,
  };
}

function sameLeaseFingerprint(a: LeaseFingerprint, b: LeaseFingerprint): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.nlink === b.nlink
  );
}

function sameLeaseGeneration(a: LeaseFingerprint, b: LeaseFingerprint): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

type CaptureAttempt =
  | { status: 'captured'; captured: CapturedLeasePath }
  | { status: 'contended' }
  | { status: 'error'; detail: string };

function captureExactLeasePath(
  path: string,
  expected: LeaseSnapshot,
  operation: LifecycleLeaseCaptureEvent['operation'],
  afterCaptureForTest?: (event: LifecycleLeaseCaptureEvent) => void,
): CaptureAttempt {
  const attempt = captureLeasePath(path, operation);
  if (attempt.status !== 'captured') return attempt;
  const captured = attempt.captured;
  try {
    afterCaptureForTest?.({ operation, path, capturedPath: captured.path });
  } catch (error) {
    restoreOrPreserveCapturedPath(captured, path);
    throw error;
  }
  const state = readLeaseSnapshot(captured.path, operation === 'staging-recovery');
  if (
    state === null ||
    state.record.operationId !== expected.record.operationId ||
    !sameLeaseFingerprint(expected.fingerprint, state.fingerprint)
  ) {
    restoreOrPreserveCapturedPath(captured, path);
    return { status: 'contended' };
  }
  return { status: 'captured', captured };
}

function captureLeasePath(path: string, label: string): CaptureAttempt {
  let directory: string;
  try {
    directory = mkdtempSync(join(dirOf(path), `.${baseOf(path)}.${label}-`));
  } catch (error) {
    return { status: 'error', detail: `lease ${label} capture setup failed: ${errorText(error)}` };
  }
  const capturedPath = join(directory, 'record');
  try {
    renameSync(path, capturedPath);
    return { status: 'captured', captured: { directory, path: capturedPath } };
  } catch (error) {
    removeCaptureDirectory(directory);
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'contended' };
    return { status: 'error', detail: `lease ${label} capture failed: ${errorText(error)}` };
  }
}

function restoreOrPreserveCapturedPath(captured: CapturedLeasePath, originalPath: string): void {
  try {
    const stat = lstatSync(captured.path);
    if (stat.isFile() && !stat.isSymbolicLink()) {
      linkSync(captured.path, originalPath);
      unlinkSync(captured.path);
      fsyncParentDir(originalPath);
      removeCaptureDirectory(captured.directory);
      return;
    }
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(captured.path), originalPath);
      unlinkSync(captured.path);
      fsyncParentDir(originalPath);
      removeCaptureDirectory(captured.directory);
    }
  } catch {
    // A replacement already won the original pathname, or the captured object
    // is foreign. Preserve the capture directory byte-for-byte for inspection.
  }
}

function discardCapturedPath(captured: CapturedLeasePath): void {
  unlinkWithParentFsync(captured.path);
  removeCaptureDirectory(captured.directory);
}

function removeCaptureDirectory(directory: string): void {
  try {
    rmdirSync(directory);
    fsyncParentDir(directory);
  } catch {
    // A non-empty or replaced private directory is preserved fail-closed.
  }
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

function stagingSlotsFor(operationId: string): string[] {
  const start = Number.parseInt(operationId.slice(0, 2), 16);
  const step = Number.parseInt(operationId.slice(2, 4), 16) | 1;
  return Array.from({ length: STAGING_SLOT_COUNT }, (_, offset) =>
    ((start + offset * step) % STAGING_SLOT_COUNT).toString(16).padStart(2, '0'),
  );
}

function busy(holderKind: LifecycleLeaseKind | null, detail: string): LifecycleLeaseBusy {
  return { ok: false, reason: 'codex-lifecycle-busy', holderKind, detail };
}

function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx <= 0 ? '.' : path.slice(0, idx);
}

function baseOf(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx < 0 ? path : path.slice(idx + 1);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanupStagingDetail(stagingPath: string): string {
  try {
    unlinkWithParentFsync(stagingPath);
    return '';
  } catch (error) {
    return `; staging cleanup failed: ${errorText(error)}`;
  }
}

function cleanupStagedGenerationDetail(staged: StagedLeaseRecord): string {
  const current = readLeaseSnapshot(staged.path, true);
  if (
    current === null ||
    current.record.operationId !== staged.snapshot.record.operationId ||
    current.record.pid !== staged.snapshot.record.pid ||
    current.record.stagingSlot !== staged.slot ||
    !sameLeaseGeneration(current.fingerprint, staged.snapshot.fingerprint)
  ) {
    return fsyncStagingParentDetail(staged.path);
  }
  const capture = captureExactLeasePath(staged.path, current, 'staging-recovery');
  if (capture.status === 'error') return `; staging cleanup failed: ${capture.detail}`;
  if (capture.status === 'contended') return fsyncStagingParentDetail(staged.path);
  try {
    discardCapturedPath(capture.captured);
    return '';
  } catch (error) {
    restoreOrPreserveCapturedPath(capture.captured, staged.path);
    return `; staging cleanup failed: ${errorText(error)}`;
  }
}

function fsyncStagingParentDetail(stagingPath: string): string {
  try {
    fsyncParentDir(stagingPath);
    return '';
  } catch (error) {
    return `; staging parent sync failed: ${errorText(error)}`;
  }
}

function cleanupStagedGenerationOrThrow(
  staged: StagedLeaseRecord,
  primaryError: unknown,
  aggregateMessage: string,
): void {
  const cleanupDetail = cleanupStagedGenerationDetail(staged);
  if (cleanupDetail) {
    throw new AggregateError([primaryError, new Error(cleanupDetail.slice(2))], aggregateMessage);
  }
}
