/**
 * Omni queue — typed API over the global genie.db (global-db.ts).
 *
 * Two durable queues feed the Omni runner:
 *   - `approvals`: human-in-the-loop tool-approval requests. A request is
 *     enqueued `pending`, optionally tagged with the Omni message id used to
 *     match a WhatsApp reaction, then resolved exactly once to `approved` or
 *     `denied`. Stale pending requests expire past a horizon.
 *   - `inbound_messages`: an at-least-once inbox of messages received from Omni,
 *     each marked handled after processing.
 *
 * Ports the v4 shape (git show origin/v4:src/lib/providers/claude-sdk-remote-approval.ts
 * and origin/v4:src/services/omni-queue.ts) onto sqlite storage. v4's PG
 * `decision` of `allow`/`deny`/`pending` maps here to `status`
 * `approved`/`denied`/`pending`.
 *
 * Resolution is the concurrency-critical path: an ATOMIC conditional UPDATE
 * inside an IMMEDIATE transaction means exactly one concurrent resolver wins and
 * every loser gets a typed {@link ApprovalConflictError} — the multi-process
 * analogue of task-state's checkout claim.
 */

import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { MIGRATED_STATUS_SENTINEL } from './global-db.js';

// ============================================================================
// Types
// ============================================================================

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';
export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalRow {
  id: string;
  repo: string;
  sessionHint: string | null;
  tool: string;
  inputSummary: string;
  status: ApprovalStatus;
  omniMessageId: string | null;
  /** Last status-ack glyph the runner successfully set on the Omni message
   *  (⏳ on announce, ✅/❌ once terminal). null until the first ack lands. Drives
   *  the runner's reconciliation pass so a stuck ⏳ is never left on the phone. */
  lastStatusGlyph: string | null;
  requestedBy: string | null;
  resolvedBy: string | null;
  createdAt: number;
  resolvedAt: number | null;
}

export interface EnqueueApprovalFields {
  repo: string;
  tool: string;
  inputSummary: string;
  sessionHint?: string | null;
  requestedBy?: string | null;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: number;
}

export interface InboundRow {
  id: string;
  instance: string;
  chat: string;
  sender: string;
  body: string;
  receivedAt: number;
  handledAt: number | null;
}

export interface RecordInboundFields {
  instance: string;
  chat: string;
  sender: string;
  body: string;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: number;
}

export interface ClaimInboundFields extends RecordInboundFields {
  /** Stable transport identity. Exact duplicate deliveries share this key. */
  eventKey: string;
  /** Unpredictable process/run token used to condition every completion. */
  claimToken: string;
  /** Resident identity and monotonic lease epoch. A higher epoch may reclaim
   * work abandoned by an expired resident without accepting stale completion. */
  claimOwnerId?: string;
  claimEpoch?: number;
}

export interface DurableClaimIdentity {
  ownerId: string;
  epoch: number;
  now?: number;
}

export type ApprovalAnnouncementClaimOutcome = 'claimed' | 'ambiguous' | 'unavailable';

export interface ApprovalAnnouncementCompletion {
  attached: boolean;
  status?: ApprovalStatus;
}

export interface InboundPreparedDelivery {
  phase: 'prepared' | 'flushed';
  eventId: string;
  subject: string;
  payload: string;
  meta: string;
}

export interface InboundClaimResult {
  id: string;
  mode: 'fresh' | 'resume-delivery' | 'ambiguous';
  delivery?: InboundPreparedDelivery;
}

export interface RecoverableInboundEvent extends RecordInboundFields {
  eventKey: string;
}

export interface InboxFilter {
  /** When true, only messages still awaiting handling; when false, only handled. */
  handled?: boolean;
  /** Restrict to one Omni instance. */
  instance?: string;
  /** Restrict to one chat. */
  chat?: string;
}

// ============================================================================
// Typed errors
// ============================================================================

/** No approval exists with the given id. */
export class UnknownApprovalError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`No approval found with id ${id}`);
    this.name = 'UnknownApprovalError';
    this.id = id;
  }
}

/**
 * Lost the race to resolve an approval — the row is no longer `pending`
 * (another resolver already transitioned it, or it expired). The multi-process
 * guarantee: exactly one resolver wins, every other gets this typed conflict.
 */
export class ApprovalConflictError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Approval ${id} is not pending (already resolved or expired)`);
    this.name = 'ApprovalConflictError';
    this.id = id;
  }
}

/** No inbound message exists with the given id. */
export class UnknownInboundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`No inbound message found with id ${id}`);
    this.name = 'UnknownInboundError';
    this.id = id;
  }
}

// ============================================================================
// IDs
// ============================================================================

/** Time-sortable, collision-resistant id: `<prefix>_<base36 ms><random>`. */
function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
}

// ============================================================================
// Row mapping
// ============================================================================

interface RawApproval {
  id: string;
  repo: string;
  session_hint: string | null;
  tool: string;
  input_summary: string;
  status: string;
  omni_message_id: string | null;
  last_status_glyph: string | null;
  requested_by: string | null;
  resolved_by: string | null;
  created_at: number;
  resolved_at: number | null;
}

function mapApproval(r: RawApproval): ApprovalRow {
  return {
    id: r.id,
    repo: r.repo,
    sessionHint: r.session_hint,
    tool: r.tool,
    inputSummary: r.input_summary,
    status: r.status as ApprovalStatus,
    omniMessageId: r.omni_message_id,
    lastStatusGlyph: r.last_status_glyph,
    requestedBy: r.requested_by,
    resolvedBy: r.resolved_by,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

interface RawInbound {
  id: string;
  instance: string;
  chat: string;
  sender: string;
  body: string;
  received_at: number;
  handled_at: number | null;
}

function mapInbound(r: RawInbound): InboundRow {
  return {
    id: r.id,
    instance: r.instance,
    chat: r.chat,
    sender: r.sender,
    body: r.body,
    receivedAt: r.received_at,
    handledAt: r.handled_at,
  };
}

// ============================================================================
// Approvals
// ============================================================================

/** Enqueue a `pending` approval request. Returns the generated approval id. */
export function enqueueApproval(db: Database, fields: EnqueueApprovalFields): string {
  const id = newId('appr');
  const createdAt = fields.now ?? Date.now();
  db.query(
    `INSERT INTO approvals
       (id, repo, session_hint, tool, input_summary, status, omni_message_id, requested_by, resolved_by, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, ?, NULL)`,
  ).run(
    id,
    fields.repo,
    fields.sessionHint ?? null,
    fields.tool,
    fields.inputSummary,
    fields.requestedBy ?? null,
    createdAt,
  );
  return id;
}

/**
 * Tag a pending approval with the Omni message id used to match a WhatsApp
 * reaction. Idempotent for the same value and fail-closed for a conflicting
 * value, so a late runner can never overwrite the winner's correlation id.
 */
export function attachOmniMessageId(db: Database, id: string, omniMessageId: string): void {
  const res = db
    .query('UPDATE approvals SET omni_message_id = ? WHERE id = ? AND omni_message_id IS NULL')
    .run(omniMessageId, id);
  if (res.changes === 1) return;
  const current = getApproval(db, id);
  if (!current) throw new UnknownApprovalError(id);
  // Idempotent same-value replay is safe; a different existing correlation id
  // is never overwritten by a late/duplicate runner.
  if (current.omniMessageId === omniMessageId) return;
  throw new ApprovalConflictError(id);
}

/** Claim an unannounced approval exactly once across runner processes. */
export function claimApprovalAnnouncement(db: Database, id: string, claimToken: string): boolean {
  return claimApprovalAnnouncementWithLease(db, id, claimToken, { ownerId: claimToken, epoch: 0 }) === 'claimed';
}

/** Claim or epoch-reclaim an approval announcement. Taking over a claim that
 * crossed the external-send boundary is explicitly ambiguous and never
 * silently re-sent; a pre-send claim is safe to resume. */
export function claimApprovalAnnouncementWithLease(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
): ApprovalAnnouncementClaimOutcome {
  const claimedAt = identity.now ?? Date.now();
  const claim = db.transaction(() => {
    const row = db
      .query(
        `SELECT status, omni_message_id AS omniMessageId, announce_claim AS claimToken,
                announce_claim_owner AS ownerId, announce_claim_epoch AS epoch, announce_phase AS phase,
                announce_prior_claim AS priorToken, announce_prior_owner AS priorOwner,
                announce_prior_epoch AS priorEpoch
         FROM approvals WHERE id = ?`,
      )
      .get(id) as {
      status: ApprovalStatus;
      omniMessageId: string | null;
      claimToken: string | null;
      ownerId: string | null;
      epoch: number | null;
      phase: string | null;
      priorToken: string | null;
      priorOwner: string | null;
      priorEpoch: number | null;
    } | null;
    if (!row || row.status !== 'pending' || row.omniMessageId !== null) return 'unavailable' as const;
    if (row.claimToken && (row.epoch ?? 0) >= identity.epoch) return 'unavailable' as const;
    const phase = row.claimToken && (row.phase === 'sending' || row.phase === 'ambiguous') ? 'ambiguous' : 'claimed';
    const priorToken = phase === 'ambiguous' ? (row.priorToken ?? row.claimToken) : null;
    const priorOwner = phase === 'ambiguous' ? (row.priorOwner ?? row.ownerId) : null;
    const priorEpoch = phase === 'ambiguous' ? (row.priorEpoch ?? row.epoch) : null;
    const changed = db
      .query(
        `UPDATE approvals
         SET announce_claim = ?, announce_claim_owner = ?, announce_claim_epoch = ?,
             announce_claimed_at = ?, announce_phase = ?, announce_prior_claim = ?,
             announce_prior_owner = ?, announce_prior_epoch = ?
         WHERE id = ? AND status = 'pending' AND omni_message_id IS NULL
           AND (announce_claim IS NULL OR COALESCE(announce_claim_epoch, 0) < ?)`,
      )
      .run(
        claimToken,
        identity.ownerId,
        identity.epoch,
        claimedAt,
        phase,
        priorToken,
        priorOwner,
        priorEpoch,
        id,
        identity.epoch,
      ).changes;
    return changed === 1 ? phase : ('unavailable' as const);
  });
  return claim.immediate();
}

export function markApprovalAnnouncementSending(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
): boolean {
  return (
    db
      .query(
        `UPDATE approvals SET announce_phase = 'sending'
         WHERE id = ? AND announce_claim = ? AND announce_claim_owner = ? AND announce_claim_epoch = ?
           AND announce_phase = 'claimed'`,
      )
      .run(id, claimToken, identity.ownerId, identity.epoch).changes === 1
  );
}

export function markApprovalAnnouncementAmbiguous(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
): boolean {
  return (
    db
      .query(
        `UPDATE approvals SET announce_phase = 'ambiguous'
         WHERE id = ? AND announce_claim = ? AND announce_claim_owner = ? AND announce_claim_epoch = ?`,
      )
      .run(id, claimToken, identity.ownerId, identity.epoch).changes === 1
  );
}

/** Attach the returned external id even if the approval resolved while HTTP was
 * in flight. The caller receives the current status and can immediately swap
 * the ghost prompt to a terminal glyph. */
export function finalizeApprovalAnnouncement(
  db: Database,
  id: string,
  claimToken: string,
  omniMessageId: string,
  identity: DurableClaimIdentity,
): ApprovalAnnouncementCompletion {
  const finalize = db.transaction(() => {
    const changed = db
      .query(
        `UPDATE approvals
         SET omni_message_id = ?, announce_claim = NULL, announce_claim_owner = NULL,
             announce_claim_epoch = NULL, announce_claimed_at = NULL, announce_phase = NULL,
             announce_prior_claim = NULL, announce_prior_owner = NULL, announce_prior_epoch = NULL
         WHERE id = ? AND omni_message_id IS NULL
           AND ((announce_claim = ? AND announce_claim_owner = ? AND announce_claim_epoch = ?)
             OR (announce_phase = 'ambiguous' AND announce_prior_claim = ?
               AND announce_prior_owner = ? AND announce_prior_epoch = ?))`,
      )
      .run(
        omniMessageId,
        id,
        claimToken,
        identity.ownerId,
        identity.epoch,
        claimToken,
        identity.ownerId,
        identity.epoch,
      ).changes;
    if (changed !== 1) return { attached: false };
    const current = db.query('SELECT status FROM approvals WHERE id = ?').get(id) as { status: ApprovalStatus } | null;
    return { attached: true, status: current?.status };
  });
  return finalize.immediate();
}

/** Attach the external id only for the exact durable announcement claimant. */
export function completeApprovalAnnouncement(
  db: Database,
  id: string,
  claimToken: string,
  omniMessageId: string,
): boolean {
  return finalizeApprovalAnnouncement(db, id, claimToken, omniMessageId, {
    ownerId: claimToken,
    epoch: 0,
  }).attached;
}

/** Failed sends release only their own claim so a later tick can retry. */
export function releaseApprovalAnnouncement(db: Database, id: string, claimToken: string): boolean {
  return releaseApprovalAnnouncementWithLease(db, id, claimToken, { ownerId: claimToken, epoch: 0 });
}

export function releaseApprovalAnnouncementWithLease(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
): boolean {
  return (
    db
      .query(
        `UPDATE approvals
         SET announce_claim = NULL, announce_claim_owner = NULL, announce_claim_epoch = NULL,
             announce_claimed_at = NULL, announce_phase = NULL, announce_prior_claim = NULL,
             announce_prior_owner = NULL, announce_prior_epoch = NULL
         WHERE id = ? AND announce_claim = ? AND announce_claim_owner = ? AND announce_claim_epoch = ?`,
      )
      .run(id, claimToken, identity.ownerId, identity.epoch).changes === 1
  );
}

/**
 * Record the status-ack glyph the runner just SUCCESSFULLY set on an approval's
 * Omni message, keyed by the message id (the stanza id both the ack and inbound
 * reactions correlate on). Advisory bookkeeping — a no-op when no row carries
 * that message id (e.g. the row was pruned), so it never throws and never wedges
 * the runner. This is what makes the reconciliation query
 * ({@link listApprovalsNeedingStatusAck}) idempotent: a recorded terminal glyph
 * stops the pass re-firing every tick.
 */
export function recordStatusGlyph(db: Database, omniMessageId: string, glyph: string): void {
  db.query('UPDATE approvals SET last_status_glyph = ? WHERE omni_message_id = ?').run(glyph, omniMessageId);
}

/**
 * Rows whose status-ack is stale: RESOLVED or EXPIRED (no longer pending),
 * already ANNOUNCED (an omni_message_id to react on), yet whose last recorded
 * glyph is not terminal (still ⏳, or never acked). These are the rows the runner
 * must swap to a terminal ✅/❌ — the hook-fork-expiry race and any
 * transport-dropped swap both land here. Oldest first.
 *
 * Two bounds keep this from ever sweeping history:
 *   - the `MIGRATED_STATUS_SENTINEL` is always excluded, so the one-time upgrade
 *     backfill's pre-upgrade closed rows are ignored;
 *   - `resolved_at >= now - windowMs` caps the pass to RECENTLY-closed rows, so
 *     per-tick work is bounded and long-dead history is never re-acked. The
 *     window is deliberately generous (see the runner) so a legitimately recent
 *     row is not dropped just because `omni serve` was briefly down.
 *
 * `terminalGlyphs` must be non-empty (the runner passes [✅, ❌]).
 */
export function listApprovalsNeedingStatusAck(
  db: Database,
  terminalGlyphs: string[],
  now: number,
  windowMs: number,
): ApprovalRow[] {
  if (terminalGlyphs.length === 0) return [];
  // The migration sentinel is terminal for reconciliation purposes — a pre-upgrade
  // closed row must never be re-acked, regardless of what the runner passes.
  const excluded = [...terminalGlyphs, MIGRATED_STATUS_SENTINEL];
  const placeholders = excluded.map(() => '?').join(', ');
  const cutoff = now - windowMs;
  const rows = db
    .query(
      `SELECT * FROM approvals
       WHERE status != 'pending'
         AND omni_message_id IS NOT NULL
         AND (last_status_glyph IS NULL OR last_status_glyph NOT IN (${placeholders}))
         AND resolved_at >= ?
       ORDER BY created_at ASC`,
    )
    .all(...excluded, cutoff) as RawApproval[];
  return rows.map(mapApproval);
}

/**
 * Atomically resolve a pending approval to `approved`/`denied`. The conditional
 * UPDATE (`WHERE id = ? AND status = 'pending'`) runs in an IMMEDIATE
 * transaction, so exactly one concurrent resolver changes the row; losers get a
 * typed {@link ApprovalConflictError}, and an unknown id gets
 * {@link UnknownApprovalError}. Returns the resolved row.
 */
export function resolveApproval(
  db: Database,
  id: string,
  decision: ApprovalDecision,
  resolvedBy: string,
  now?: number,
): ApprovalRow {
  const resolvedAt = now ?? Date.now();

  const resolve = db.transaction(() => {
    const res = db
      .query(
        `UPDATE approvals
         SET status = ?, resolved_by = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, resolvedBy, resolvedAt, id);
    return res.changes;
  });

  let changes: number;
  try {
    changes = resolve.immediate();
  } catch (err) {
    // Under heavy cross-process contention a straggler can exhaust busy_timeout
    // and surface SQLITE_BUSY instead of a clean 0-change result. If the row is
    // meanwhile gone or no longer pending, that IS a lost race — translate to
    // the typed conflict the contract promises. Anything else stays a real error.
    if (err instanceof Error && err.message.includes('SQLITE_BUSY')) {
      const current = getApproval(db, id);
      if (!current) throw new UnknownApprovalError(id);
      if (current.status !== 'pending') throw new ApprovalConflictError(id);
    }
    throw err;
  }

  if (changes !== 1) {
    if (!getApproval(db, id)) throw new UnknownApprovalError(id);
    throw new ApprovalConflictError(id);
  }
  return getApproval(db, id) as ApprovalRow;
}

/** Fetch one approval by id, or null when absent. */
export function getApproval(db: Database, id: string): ApprovalRow | null {
  const row = db.query('SELECT * FROM approvals WHERE id = ?').get(id) as RawApproval | null;
  return row ? mapApproval(row) : null;
}

/** List every `pending` approval, oldest first. */
export function listPendingApprovals(db: Database): ApprovalRow[] {
  const rows = db
    .query("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC")
    .all() as RawApproval[];
  return rows.map(mapApproval);
}

/**
 * Expire pending approvals older than `olderThanMs` (created at or before
 * `now - olderThanMs`), transitioning them `pending → expired`. Returns the
 * number expired. Idempotent — only pending rows are touched.
 */
export function expireStale(db: Database, olderThanMs: number, now?: number): number {
  const cutoff = (now ?? Date.now()) - olderThanMs;
  const expire = db.transaction(() => {
    const res = db
      .query(
        `UPDATE approvals
         SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND created_at <= ?`,
      )
      .run(now ?? Date.now(), cutoff);
    return res.changes;
  });
  return expire.immediate();
}

/** Expire exactly one still-pending approval owned by a hook invocation. */
export function expireApprovalIfPending(db: Database, id: string, now = Date.now()): boolean {
  const result = db
    .query("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'")
    .run(now, id);
  return result.changes === 1;
}

// ============================================================================
// Inbox
// ============================================================================

/** Persist an inbound Omni message. Returns the generated message id. */
export function recordInbound(db: Database, fields: RecordInboundFields): string {
  const id = newId('inb');
  const receivedAt = fields.now ?? Date.now();
  db.query(
    `INSERT INTO inbound_messages (id, instance, chat, sender, body, received_at, handled_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(id, fields.instance, fields.chat, fields.sender, fields.body, receivedAt);
  return id;
}

/**
 * Insert-or-find one transport event, then atomically claim it for processing.
 * A duplicate delivery while the first runner owns or completed the row returns
 * `undefined`, so it cannot spawn, reply, or resolve twice.
 */
export function recordAndClaimInbound(db: Database, fields: ClaimInboundFields): string | undefined {
  return recordAndClaimInboundDelivery(db, fields)?.id;
}

function mapPreparedDelivery(row: {
  processing_phase: string | null;
  outbound_event_id: string | null;
  outbound_subject: string | null;
  outbound_payload: string | null;
  outbound_meta: string | null;
}): InboundPreparedDelivery | undefined {
  if (
    (row.processing_phase !== 'prepared' && row.processing_phase !== 'flushed') ||
    !row.outbound_event_id ||
    !row.outbound_subject ||
    row.outbound_payload === null ||
    row.outbound_meta === null
  ) {
    return undefined;
  }
  return {
    phase: row.processing_phase,
    eventId: row.outbound_event_id,
    subject: row.outbound_subject,
    payload: row.outbound_payload,
    meta: row.outbound_meta,
  };
}

/** Insert-or-claim one transport event with lease-epoch fencing. A higher epoch
 * safely resumes a prepared outbox entry; takeover during workspace execution
 * becomes explicit ambiguous state and never replays the writing prompt. */
export function recordAndClaimInboundDelivery(
  db: Database,
  fields: ClaimInboundFields,
): InboundClaimResult | undefined {
  if (!fields.eventKey || fields.eventKey.length > 256) throw new Error('Inbound event key must be 1..256 characters');
  if (!fields.claimToken || fields.claimToken.length > 256)
    throw new Error('Inbound claim token must be 1..256 characters');
  const ownerId = fields.claimOwnerId ?? fields.claimToken;
  const epoch = fields.claimEpoch ?? 0;
  if (!ownerId || ownerId.length > 256) throw new Error('Inbound claim owner must be 1..256 characters');
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Inbound claim epoch must be a non-negative integer');
  const candidateId = newId('inb');
  const receivedAt = fields.now ?? Date.now();
  const claim = db.transaction(() => {
    db.query(
      `INSERT INTO inbound_messages
         (id, instance, chat, sender, body, received_at, handled_at, event_key, processing_claim)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)
       ON CONFLICT(event_key) WHERE event_key IS NOT NULL DO NOTHING`,
    ).run(candidateId, fields.instance, fields.chat, fields.sender, fields.body, receivedAt, fields.eventKey);
    const row = db.query('SELECT * FROM inbound_messages WHERE event_key = ?').get(fields.eventKey) as
      | (RawInbound & {
          event_key: string | null;
          processing_claim: string | null;
          processing_claim_owner: string | null;
          processing_claim_epoch: number | null;
          processing_phase: string | null;
          outbound_event_id: string | null;
          outbound_subject: string | null;
          outbound_payload: string | null;
          outbound_meta: string | null;
        })
      | null;
    if (!row) throw new Error('Inbound event insert did not produce a row');
    if (row.handled_at !== null) return undefined;
    if (row.processing_claim && (row.processing_claim_epoch ?? 0) >= epoch) return undefined;
    let phase = row.processing_phase;
    let mode: InboundClaimResult['mode'];
    if (phase === 'processing') {
      phase = 'ambiguous';
      mode = 'ambiguous';
    } else if (phase === 'prepared' || phase === 'flushed') {
      mode = 'resume-delivery';
    } else if (phase === 'ambiguous') {
      mode = 'ambiguous';
    } else {
      phase = 'processing';
      mode = 'fresh';
    }
    const claimed = db
      .query(
        `UPDATE inbound_messages
         SET processing_claim = ?, processing_claim_owner = ?, processing_claim_epoch = ?,
             processing_claimed_at = ?, processing_phase = ?
         WHERE id = ? AND handled_at IS NULL
           AND (processing_claim IS NULL OR COALESCE(processing_claim_epoch, 0) < ?)`,
      )
      .run(fields.claimToken, ownerId, epoch, receivedAt, phase, row.id, epoch).changes;
    if (claimed !== 1) return undefined;
    const delivery = mapPreparedDelivery({ ...row, processing_phase: phase });
    return { id: row.id, mode, ...(delivery ? { delivery } : {}) };
  });
  return claim.immediate();
}

/** Bounded startup/tick scan for work owned by an older resident epoch. Core
 * NATS is not a durable consumer, so recovery cannot depend on redelivery. */
export function listRecoverableInbound(db: Database, residentEpoch: number, limit = 100): RecoverableInboundEvent[] {
  const boundedLimit = Math.max(1, Math.min(Math.floor(limit), 1_000));
  const rows = db
    .query(
      `SELECT instance, chat, sender, body, event_key AS eventKey
       FROM inbound_messages
       WHERE handled_at IS NULL
         AND event_key IS NOT NULL
         AND processing_phase IN ('processing', 'prepared', 'flushed', 'ambiguous')
         AND (processing_claim IS NULL OR COALESCE(processing_claim_epoch, 0) < ?)
       ORDER BY received_at ASC
       LIMIT ?`,
    )
    .all(residentEpoch, boundedLimit) as Array<{
    instance: string;
    chat: string;
    sender: string;
    body: string;
    eventKey: string;
  }>;
  return rows.map((row) => ({
    instance: row.instance,
    chat: row.chat,
    sender: row.sender,
    body: row.body,
    eventKey: row.eventKey,
  }));
}

const MAX_OUTBOUND_PAYLOAD_BYTES = 32 * 1024;

/** Persist a bounded stable reply before touching NATS. */
export function prepareInboundDelivery(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
  delivery: Omit<InboundPreparedDelivery, 'phase'>,
): boolean {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(delivery.eventId)) throw new Error('Invalid outbound event id');
  if (!delivery.subject || delivery.subject.length > 512 || /[\s\0]/u.test(delivery.subject)) {
    throw new Error('Invalid outbound subject');
  }
  if (Buffer.byteLength(delivery.payload, 'utf8') > MAX_OUTBOUND_PAYLOAD_BYTES) {
    throw new Error('Outbound payload exceeded the durable limit');
  }
  if (Buffer.byteLength(delivery.meta, 'utf8') > 2_048) throw new Error('Outbound metadata exceeded the durable limit');
  return (
    db
      .query(
        `UPDATE inbound_messages
         SET processing_phase = 'prepared', outbound_event_id = ?, outbound_subject = ?,
             outbound_payload = ?, outbound_meta = ?
         WHERE id = ? AND handled_at IS NULL AND processing_claim = ?
           AND processing_claim_owner = ? AND processing_claim_epoch = ?`,
      )
      .run(
        delivery.eventId,
        delivery.subject,
        delivery.payload,
        delivery.meta,
        id,
        claimToken,
        identity.ownerId,
        identity.epoch,
      ).changes === 1
  );
}

export function markInboundDeliveryFlushed(
  db: Database,
  id: string,
  claimToken: string,
  identity: DurableClaimIdentity,
): boolean {
  return (
    db
      .query(
        `UPDATE inbound_messages SET processing_phase = 'flushed'
         WHERE id = ? AND handled_at IS NULL AND processing_phase = 'prepared'
           AND processing_claim = ? AND processing_claim_owner = ? AND processing_claim_epoch = ?`,
      )
      .run(id, claimToken, identity.ownerId, identity.epoch).changes === 1
  );
}

/** Mark handled only for the exact processor that successfully published. */
export function markInboundHandledIfClaimed(
  db: Database,
  id: string,
  claimToken: string,
  now = Date.now(),
  identity?: DurableClaimIdentity,
  requiredPhase?: 'flushed',
): boolean {
  const ownership = identity ? ' AND processing_claim_owner = ? AND processing_claim_epoch = ?' : '';
  const phase = requiredPhase ? ' AND processing_phase = ?' : '';
  const params: Array<string | number> = identity
    ? [now, id, claimToken, identity.ownerId, identity.epoch]
    : [now, id, claimToken];
  if (requiredPhase) params.push(requiredPhase);
  return (
    db
      .query(
        `UPDATE inbound_messages
         SET handled_at = ?, processing_claim = NULL, processing_claim_owner = NULL,
             processing_claim_epoch = NULL, processing_claimed_at = NULL, processing_phase = 'delivered',
             outbound_subject = NULL, outbound_payload = NULL, outbound_meta = NULL
         WHERE id = ? AND handled_at IS NULL AND processing_claim = ?${ownership}${phase}`,
      )
      .run(...params).changes === 1
  );
}

/** Publication/processing failure returns the row to the retryable unhandled state. */
export function releaseInboundClaim(
  db: Database,
  id: string,
  claimToken: string,
  identity?: DurableClaimIdentity,
): boolean {
  const ownership = identity ? ' AND processing_claim_owner = ? AND processing_claim_epoch = ?' : '';
  const params = identity ? [id, claimToken, identity.ownerId, identity.epoch] : [id, claimToken];
  return (
    db
      .query(
        `UPDATE inbound_messages
         SET processing_claim = NULL, processing_claim_owner = NULL, processing_claim_epoch = NULL,
             processing_claimed_at = NULL,
             processing_phase = CASE WHEN processing_phase = 'processing' THEN NULL ELSE processing_phase END
         WHERE id = ? AND handled_at IS NULL AND processing_claim = ?${ownership}`,
      )
      .run(...params).changes === 1
  );
}

/** List inbox messages, oldest first, optionally filtered by handled state / instance / chat. */
export function listInbox(db: Database, filter: InboxFilter = {}): InboundRow[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.handled === true) clauses.push('handled_at IS NOT NULL');
  else if (filter.handled === false) clauses.push('handled_at IS NULL');
  if (filter.instance !== undefined) {
    clauses.push('instance = ?');
    params.push(filter.instance);
  }
  if (filter.chat !== undefined) {
    clauses.push('chat = ?');
    params.push(filter.chat);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .query(`SELECT * FROM inbound_messages ${where} ORDER BY received_at ASC`)
    .all(...params) as RawInbound[];
  return rows.map(mapInbound);
}

/**
 * Mark an inbound message handled. Idempotent stamp of `handled_at` — re-marking
 * an already-handled message refreshes the timestamp. Throws
 * {@link UnknownInboundError} when the id does not exist.
 */
export function markHandled(db: Database, id: string, now?: number): void {
  const res = db.query('UPDATE inbound_messages SET handled_at = ? WHERE id = ?').run(now ?? Date.now(), id);
  if (res.changes !== 1) throw new UnknownInboundError(id);
}
