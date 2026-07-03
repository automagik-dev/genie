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
 * reaction. Best-effort by contract, but throws {@link UnknownApprovalError}
 * when the id does not exist so callers can distinguish a typo from a no-op.
 */
export function attachOmniMessageId(db: Database, id: string, omniMessageId: string): void {
  const res = db.query('UPDATE approvals SET omni_message_id = ? WHERE id = ?').run(omniMessageId, id);
  if (res.changes !== 1) throw new UnknownApprovalError(id);
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
