import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIGRATED_STATUS_SENTINEL,
  OMNI_SERVICE_LEASE_NAME,
  acquireServiceLeaseEpoch,
  openGlobalDb,
  releaseServiceLease,
} from './global-db.js';
import {
  ApprovalConflictError,
  UnknownApprovalError,
  UnknownInboundError,
  attachOmniMessageId,
  claimApprovalAnnouncementWithLease,
  consumeClaimedApprovalInbound,
  enqueueApproval,
  expireApprovalIfPending,
  expireStale,
  finalizeApprovalAnnouncement,
  getApproval,
  listApprovalsNeedingStatusAck,
  listInbox,
  listPendingApprovals,
  listRecoverableInbound,
  markApprovalAnnouncementSending,
  markHandled,
  markInboundDeliveryFlushed,
  markInboundExecuted,
  markInboundExecuting,
  markInboundHandledIfClaimed,
  prepareInboundDelivery,
  recordAndClaimInbound,
  recordAndClaimInboundDelivery,
  recordInbound,
  recordStatusGlyph,
  releaseApprovalAnnouncementWithLease,
  releaseInboundClaim,
  resolveApproval,
  validatePreparedInboundLease,
} from './omni-queue.js';

const HOURGLASS = '\u{23F3}'; // ⏳
const CHECK = '\u{2705}'; // ✅
const CROSS = '\u{274C}'; // ❌
const TERMINAL = [CHECK, CROSS];
// Deterministic clock + recency window for the reconciliation-query tests.
const NOW_Q = 5_000_000;
const WINDOW = 1_000_000;
const TEST_OWNER = 'queue-test-resident';
const testIdentity = (now = 1) => ({ ownerId: TEST_OWNER, epoch: 1, now });

let dir: string;
let db: Database;
const originalGenieHome = process.env.GENIE_HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-omniq-'));
  process.env.GENIE_HOME = dir;
  db = openGlobalDb({ path: join(dir, 'genie.db') });
  expect(acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 0, 1_000_000_000)).toBe(1);
});

afterEach(() => {
  db.close();
  // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
  if (originalGenieHome === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = originalGenieHome;
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------
describe('approvals', () => {
  test('enqueue creates a pending row and round-trips via getApproval', () => {
    const id = enqueueApproval(db, {
      repo: '/home/me/genie',
      tool: 'Bash',
      inputSummary: 'rm -rf build',
      sessionHint: 'sess-1',
      requestedBy: 'agent-a',
      now: 1000,
    });
    const row = getApproval(db, id);
    expect(row).not.toBeNull();
    expect(row?.status).toBe('pending');
    expect(row?.repo).toBe('/home/me/genie');
    expect(row?.tool).toBe('Bash');
    expect(row?.inputSummary).toBe('rm -rf build');
    expect(row?.sessionHint).toBe('sess-1');
    expect(row?.requestedBy).toBe('agent-a');
    expect(row?.omniMessageId).toBeNull();
    expect(row?.resolvedBy).toBeNull();
    expect(row?.resolvedAt).toBeNull();
    expect(row?.createdAt).toBe(1000);
  });

  test('optional fields default to null', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Read', inputSummary: 'x' });
    const row = getApproval(db, id);
    expect(row?.sessionHint).toBeNull();
    expect(row?.requestedBy).toBeNull();
  });

  test('getApproval returns null for an unknown id', () => {
    expect(getApproval(db, 'appr_missing')).toBeNull();
  });

  test('attachOmniMessageId tags a pending approval', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    attachOmniMessageId(db, id, 'wamid.ABC');
    expect(getApproval(db, id)?.omniMessageId).toBe('wamid.ABC');
  });

  test('attachOmniMessageId is idempotent and never overwrites an existing correlation id', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    attachOmniMessageId(db, id, 'stanza-a');
    attachOmniMessageId(db, id, 'stanza-a');
    expect(() => attachOmniMessageId(db, id, 'stanza-b')).toThrow(ApprovalConflictError);
    expect(getApproval(db, id)?.omniMessageId).toBe('stanza-a');
  });

  test('attachOmniMessageId throws UnknownApprovalError for a missing id', () => {
    expect(() => attachOmniMessageId(db, 'appr_nope', 'm')).toThrow(UnknownApprovalError);
  });

  test('announcement claim has one winner and cannot overwrite another runner correlation id', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(claimApprovalAnnouncementWithLease(db, id, 'runner-a', testIdentity())).toBe('claimed');
    expect(claimApprovalAnnouncementWithLease(db, id, 'runner-b', testIdentity())).toBe('unavailable');
    expect(finalizeApprovalAnnouncement(db, id, 'runner-b', 'stanza-b', testIdentity())).toEqual({ attached: false });
    expect(finalizeApprovalAnnouncement(db, id, 'runner-a', 'stanza-a', testIdentity())).toEqual({
      attached: true,
      status: 'pending',
    });
    expect(getApproval(db, id)?.omniMessageId).toBe('stanza-a');
    expect(claimApprovalAnnouncementWithLease(db, id, 'runner-b', testIdentity())).toBe('unavailable');
  });

  test('failed announcement releases only its own claim for retry', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(claimApprovalAnnouncementWithLease(db, id, 'runner-a', testIdentity())).toBe('claimed');
    expect(releaseApprovalAnnouncementWithLease(db, id, 'runner-b', testIdentity())).toBe(false);
    expect(releaseApprovalAnnouncementWithLease(db, id, 'runner-a', testIdentity())).toBe(true);
    expect(claimApprovalAnnouncementWithLease(db, id, 'runner-b', testIdentity())).toBe('claimed');
  });

  test('a higher lease epoch reclaims a pre-send announcement and fences the abandoned owner', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 10 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-a', ownerA)).toBe('claimed');
    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    const ownerB = { ownerId: 'resident-b', epoch: epochB, now: 20 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-b', ownerB)).toBe('claimed');
    expect(finalizeApprovalAnnouncement(db, id, 'claim-a', 'stale-stanza', ownerA)).toEqual({ attached: false });
    expect(markApprovalAnnouncementSending(db, id, 'claim-b', ownerB)).toBe(true);
    expect(finalizeApprovalAnnouncement(db, id, 'claim-b', 'live-stanza', ownerB)).toEqual({
      attached: true,
      status: 'pending',
    });
    expect(getApproval(db, id)?.omniMessageId).toBe('live-stanza');
  });

  test('takeover after the external-send boundary is explicit ambiguous state', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 10 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-a', ownerA)).toBe('claimed');
    expect(markApprovalAnnouncementSending(db, id, 'claim-a', ownerA)).toBe(true);
    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    const ownerB = { ownerId: 'resident-b', epoch: epochB, now: 20 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-b', ownerB)).toBe('ambiguous');
    expect(
      finalizeApprovalAnnouncement(db, id, 'attacker', 'wrong-stanza', { ownerId: 'not-prior', epoch: 0 }),
    ).toEqual({ attached: false });
    expect(finalizeApprovalAnnouncement(db, id, 'claim-a', 'late-stanza', ownerA)).toEqual({
      attached: true,
      status: 'pending',
    });
    expect(getApproval(db, id)?.omniMessageId).toBe('late-stanza');
  });

  test('a definitely-not-started prior sender releases an ambiguous takeover for retry', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 10 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-a', ownerA)).toBe('claimed');
    expect(markApprovalAnnouncementSending(db, id, 'claim-a', ownerA)).toBe(true);

    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    const ownerB = { ownerId: 'resident-b', epoch: epochB, now: 20 };
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-b', ownerB)).toBe('ambiguous');

    expect(releaseApprovalAnnouncementWithLease(db, id, 'claim-a', ownerA)).toBe(true);
    expect(claimApprovalAnnouncementWithLease(db, id, 'claim-b-retry', ownerB)).toBe('claimed');
  });

  test('a stale resident cannot claim fresh approval/inbound work or cross the send boundary', () => {
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 10 };
    const claimed = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 1 });
    expect(claimApprovalAnnouncementWithLease(db, claimed, 'claim-a', ownerA)).toBe('claimed');
    const inboundA = recordAndClaimInboundDelivery(db, {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'claimed before takeover',
      eventKey: 'claimed-before-takeover',
      claimToken: 'inbound-a',
      claimOwnerId: ownerA.ownerId,
      claimEpoch: ownerA.epoch,
      now: 10,
    });
    expect(inboundA?.mode).toBe('fresh');
    const expiredFresh = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 2 });
    expect(claimApprovalAnnouncementWithLease(db, expiredFresh, 'expired-owner', { ...ownerA, now: 16 })).toBe(
      'unavailable',
    );

    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    const fresh = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: '{}', now: 2 });
    expect(claimApprovalAnnouncementWithLease(db, fresh, 'stale-fresh', { ...ownerA, now: 20 })).toBe('unavailable');
    expect(markApprovalAnnouncementSending(db, claimed, 'claim-a', { ...ownerA, now: 20 })).toBe(false);
    expect(markInboundExecuting(db, inboundA?.id as string, 'inbound-a', { ...ownerA, now: 20 })).toBe(false);
    expect(
      recordAndClaimInboundDelivery(db, {
        instance: 'i',
        chat: 'c',
        sender: 's',
        body: 'stale',
        eventKey: 'stale-fresh-inbound',
        claimToken: 'stale-claim',
        claimOwnerId: ownerA.ownerId,
        claimEpoch: ownerA.epoch,
        now: 20,
      }),
    ).toBeUndefined();
    expect(listInbox(db).map((row) => row.body)).toEqual(['claimed before takeover']);
    expect(
      claimApprovalAnnouncementWithLease(db, fresh, 'live-fresh', {
        ownerId: 'resident-b',
        epoch: epochB,
        now: 20,
      }),
    ).toBe('claimed');
  });

  test('resolveApproval transitions pending -> approved and records resolver/time', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x', now: 100 });
    const resolved = resolveApproval(db, id, 'approved', 'human-1', 500);
    expect(resolved.status).toBe('approved');
    expect(resolved.resolvedBy).toBe('human-1');
    expect(resolved.resolvedAt).toBe(500);
    expect(getApproval(db, id)?.status).toBe('approved');
  });

  test('resolveApproval supports denial (v4 deny -> denied)', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    expect(resolveApproval(db, id, 'denied', 'human-2').status).toBe('denied');
  });

  test('resolveApproval is single-shot: a second resolve conflicts (in-process)', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    resolveApproval(db, id, 'approved', 'first');
    expect(() => resolveApproval(db, id, 'denied', 'second')).toThrow(ApprovalConflictError);
    // Winner's decision stands.
    expect(getApproval(db, id)?.status).toBe('approved');
    expect(getApproval(db, id)?.resolvedBy).toBe('first');
  });

  test('resolveApproval throws UnknownApprovalError for a missing id', () => {
    expect(() => resolveApproval(db, 'appr_nope', 'approved', 'x')).toThrow(UnknownApprovalError);
  });

  test('listPendingApprovals returns only pending rows, oldest first', () => {
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'a', now: 1 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'b', now: 2 });
    const c = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'c', now: 3 });
    resolveApproval(db, b, 'approved', 'x');
    const pending = listPendingApprovals(db);
    expect(pending.map((p) => p.id)).toEqual([a, c]);
  });
});

// ---------------------------------------------------------------------------
// Status-ack bookkeeping + reconciliation query
// ---------------------------------------------------------------------------
describe('status-ack glyph + listApprovalsNeedingStatusAck', () => {
  test('enqueue defaults lastStatusGlyph to null', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    expect(getApproval(db, id)?.lastStatusGlyph).toBeNull();
  });

  test('recordStatusGlyph sets the glyph keyed by omni_message_id; no-op for an unknown id', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    attachOmniMessageId(db, id, 'stanza-1');
    recordStatusGlyph(db, 'stanza-1', HOURGLASS);
    expect(getApproval(db, id)?.lastStatusGlyph).toBe(HOURGLASS);
    // No row carries this message id → silent no-op, never throws.
    expect(() => recordStatusGlyph(db, 'stanza-absent', CHECK)).not.toThrow();
    expect(getApproval(db, id)?.lastStatusGlyph).toBe(HOURGLASS);
  });

  test('reconciliation query returns only done + announced + non-terminal + recent rows', () => {
    // (1) pending + announced → excluded (still awaiting a decision)
    const pending = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'p', now: 1 });
    attachOmniMessageId(db, pending, 'stanza-p');

    // (2) resolved but NEVER announced (no omni_message_id) → excluded
    const noId = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'n', now: 2 });
    resolveApproval(db, noId, 'approved', 'x', NOW_Q);

    // (3) approved + announced + still ⏳ → INCLUDED (needs ✅ swap)
    const stuck = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 's', now: 3 });
    attachOmniMessageId(db, stuck, 'stanza-s');
    recordStatusGlyph(db, 'stanza-s', HOURGLASS);
    resolveApproval(db, stuck, 'approved', 'x', NOW_Q);

    // (4) expired + announced + glyph NULL (hook-fork race) → INCLUDED (needs ❌).
    // Faithful to the hook's single-row expireOwnRow: expire ONLY this row, no
    // status glyph — so the runner never acked it and a ⏳ would be stuck.
    const raced = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'r', now: 4 });
    attachOmniMessageId(db, raced, 'stanza-r');
    db.query("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ?").run(NOW_Q, raced);

    // (5) denied + announced + already ❌ → excluded (terminal)
    const done = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'd', now: 6 });
    attachOmniMessageId(db, done, 'stanza-d');
    recordStatusGlyph(db, 'stanza-d', CROSS);
    resolveApproval(db, done, 'denied', 'x', NOW_Q);

    const need = listApprovalsNeedingStatusAck(db, TERMINAL, NOW_Q, WINDOW);
    expect(need.map((r) => r.id).sort()).toEqual([stuck, raced].sort());
  });

  test('the migration sentinel is treated as terminal — historical rows are excluded', () => {
    const migrated = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'h', now: 1 });
    attachOmniMessageId(db, migrated, 'stanza-h');
    resolveApproval(db, migrated, 'approved', 'x', NOW_Q);
    recordStatusGlyph(db, 'stanza-h', MIGRATED_STATUS_SENTINEL); // as the upgrade backfill stamps
    expect(listApprovalsNeedingStatusAck(db, TERMINAL, NOW_Q, WINDOW)).toEqual([]);
  });

  test('recency window: a row resolved before the window is excluded, a recent one included', () => {
    // Resolved WELL before the window → excluded even though its glyph is ⏳.
    const old = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'old', now: 1 });
    attachOmniMessageId(db, old, 'stanza-old');
    recordStatusGlyph(db, 'stanza-old', HOURGLASS);
    resolveApproval(db, old, 'approved', 'x', NOW_Q - WINDOW - 1);

    // Resolved just inside the window → included.
    const recent = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'new', now: 2 });
    attachOmniMessageId(db, recent, 'stanza-new');
    recordStatusGlyph(db, 'stanza-new', HOURGLASS);
    resolveApproval(db, recent, 'approved', 'x', NOW_Q - WINDOW + 1);

    const need = listApprovalsNeedingStatusAck(db, TERMINAL, NOW_Q, WINDOW);
    expect(need.map((r) => r.id)).toEqual([recent]);
  });

  test('empty terminal set returns nothing (guard against invalid NOT IN ())', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x' });
    attachOmniMessageId(db, id, 'stanza-x');
    resolveApproval(db, id, 'approved', 'x', NOW_Q);
    expect(listApprovalsNeedingStatusAck(db, [], NOW_Q, WINDOW)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------
describe('expireStale', () => {
  test('expires only the exact owned pending row', () => {
    const owned = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'owned', now: 1 });
    const other = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'other', now: 2 });
    expect(expireApprovalIfPending(db, owned, 50)).toBe(true);
    expect(expireApprovalIfPending(db, owned, 60)).toBe(false);
    expect(getApproval(db, owned)?.status).toBe('expired');
    expect(getApproval(db, owned)?.resolvedAt).toBe(50);
    expect(getApproval(db, other)?.status).toBe('pending');
  });

  test('expires only pending rows older than the horizon', () => {
    const old1 = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'old1', now: 1000 });
    const old2 = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'old2', now: 1500 });
    const fresh = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'fresh', now: 9000 });

    // Horizon: expire anything created at/before now(10000) - olderThanMs(8000) = 2000.
    const expired = expireStale(db, 8000, 10000);
    expect(expired).toBe(2);
    expect(getApproval(db, old1)?.status).toBe('expired');
    expect(getApproval(db, old2)?.status).toBe('expired');
    expect(getApproval(db, fresh)?.status).toBe('pending');
    expect(getApproval(db, old1)?.resolvedAt).toBe(10000);
  });

  test('does not touch already-resolved rows and is idempotent', () => {
    const id = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'x', now: 1000 });
    resolveApproval(db, id, 'approved', 'human', 1100);
    expect(expireStale(db, 0, 10000)).toBe(0);
    expect(getApproval(db, id)?.status).toBe('approved');
    // Second call over an empty pending set is a no-op.
    expect(expireStale(db, 0, 10000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------
describe('inbox', () => {
  test('recordInbound round-trips and starts unhandled', () => {
    const id = recordInbound(db, {
      instance: 'wa-1',
      chat: 'chat-42',
      sender: '+15550001111',
      body: 'approve please',
      now: 200,
    });
    const [row] = listInbox(db);
    expect(row.id).toBe(id);
    expect(row.instance).toBe('wa-1');
    expect(row.chat).toBe('chat-42');
    expect(row.sender).toBe('+15550001111');
    expect(row.body).toBe('approve please');
    expect(row.receivedAt).toBe(200);
    expect(row.handledAt).toBeNull();
  });

  test('markHandled stamps handled_at and filters split correctly', () => {
    const a = recordInbound(db, { instance: 'i', chat: 'c', sender: 's', body: 'a', now: 1 });
    const b = recordInbound(db, { instance: 'i', chat: 'c', sender: 's', body: 'b', now: 2 });
    markHandled(db, a, 500);

    expect(listInbox(db, { handled: false }).map((r) => r.id)).toEqual([b]);
    const handled = listInbox(db, { handled: true });
    expect(handled.map((r) => r.id)).toEqual([a]);
    expect(handled[0].handledAt).toBe(500);
  });

  test('listInbox filters by instance and chat', () => {
    recordInbound(db, { instance: 'i1', chat: 'c1', sender: 's', body: 'x', now: 1 });
    recordInbound(db, { instance: 'i2', chat: 'c1', sender: 's', body: 'y', now: 2 });
    recordInbound(db, { instance: 'i1', chat: 'c2', sender: 's', body: 'z', now: 3 });
    expect(listInbox(db, { instance: 'i1' }).map((r) => r.body)).toEqual(['x', 'z']);
    expect(listInbox(db, { instance: 'i1', chat: 'c1' }).map((r) => r.body)).toEqual(['x']);
  });

  test('markHandled throws UnknownInboundError for a missing id', () => {
    expect(() => markHandled(db, 'inb_nope')).toThrow(UnknownInboundError);
  });

  test('record-and-claim gives one duplicate-delivery winner until handled', () => {
    const fields = {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'hello',
      eventKey: 'event-1',
      now: 1,
      claimOwnerId: TEST_OWNER,
      claimEpoch: 1,
    };
    const id = recordAndClaimInbound(db, { ...fields, claimToken: 'runner-a' });
    expect(id).toBeString();
    expect(recordAndClaimInbound(db, { ...fields, claimToken: 'runner-b' })).toBeUndefined();
    expect(markInboundHandledIfClaimed(db, id as string, 'runner-b', 2, testIdentity(2))).toBe(false);
    expect(markInboundHandledIfClaimed(db, id as string, 'runner-a', 2, testIdentity(2))).toBe(true);
    expect(recordAndClaimInbound(db, { ...fields, claimToken: 'runner-b' })).toBeUndefined();
    expect(listInbox(db)).toHaveLength(1);
  });

  test('failed processor releases only its own inbound claim for retry', () => {
    const fields = {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'hello',
      eventKey: 'event-2',
      now: 1,
      claimOwnerId: TEST_OWNER,
      claimEpoch: 1,
    };
    const id = recordAndClaimInbound(db, { ...fields, claimToken: 'runner-a' }) as string;
    expect(releaseInboundClaim(db, id, 'runner-b', testIdentity())).toBe(false);
    expect(releaseInboundClaim(db, id, 'runner-a', testIdentity())).toBe(true);
    expect(recordAndClaimInbound(db, { ...fields, claimToken: 'runner-b' })).toBe(id);
    expect(listInbox(db)).toHaveLength(1);
  });

  test('a released pre-execution claim remains visible to startup recovery', () => {
    const fields = {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'retry after lease loss',
      eventKey: 'pre-execution-release',
      claimToken: 'runner-a',
      claimOwnerId: TEST_OWNER,
      claimEpoch: 1,
      now: 1,
    };
    const claim = recordAndClaimInboundDelivery(db, fields);
    expect(claim?.mode).toBe('fresh');
    expect(
      releaseInboundClaim(db, claim?.id as string, fields.claimToken, testIdentity(), {
        preservePreExecution: true,
      }),
    ).toBe(true);
    expect(listRecoverableInbound(db, 2).map((event) => event.eventKey)).toEqual([fields.eventKey]);
  });

  test('recovery enumerates a legacy null-phase claim written after schema initialization', () => {
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const first = recordAndClaimInboundDelivery(db, {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'legacy write',
      eventKey: 'late-null-phase',
      claimToken: 'claim-a',
      claimOwnerId: 'resident-a',
      claimEpoch: epochA,
      now: 10,
    });
    db.query('UPDATE inbound_messages SET processing_phase = NULL WHERE id = ?').run(first?.id as string);

    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    expect(listRecoverableInbound(db, epochB).map((event) => event.eventKey)).toEqual(['late-null-phase']);
    expect(
      recordAndClaimInboundDelivery(db, {
        instance: 'i',
        chat: 'c',
        sender: 's',
        body: 'legacy write',
        eventKey: 'late-null-phase',
        claimToken: 'claim-b',
        claimOwnerId: 'resident-b',
        claimEpoch: epochB,
        now: 20,
      }),
    ).toMatchObject({ id: first?.id, mode: 'ambiguous' });
  });

  test('lease takeover marks abandoned execution ambiguous and fences stale completion', () => {
    const fields = { instance: 'i', chat: 'c', sender: 's', body: 'hello', eventKey: 'event-3', now: 1 };
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 1, 1) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 1 };
    const first = recordAndClaimInboundDelivery(db, {
      ...fields,
      claimToken: 'shared-token',
      claimOwnerId: ownerA.ownerId,
      claimEpoch: ownerA.epoch,
    });
    expect(first?.mode).toBe('fresh');
    expect(markInboundExecuting(db, first?.id as string, 'shared-token', ownerA)).toBe(true);
    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 2, 100) as number;
    const ownerB = { ownerId: 'resident-b', epoch: epochB, now: 2 };
    const takeover = recordAndClaimInboundDelivery(db, {
      ...fields,
      now: 2,
      claimToken: 'shared-token',
      claimOwnerId: ownerB.ownerId,
      claimEpoch: ownerB.epoch,
    });
    expect(takeover).toMatchObject({ id: first?.id, mode: 'ambiguous' });
    expect(
      markInboundHandledIfClaimed(db, first?.id as string, 'shared-token', 3, {
        ownerId: 'resident-a',
        epoch: epochA,
        now: 3,
      }),
    ).toBe(false);
  });

  test('prepared delivery survives a kill-point takeover with the same stable event id', () => {
    const fields = { instance: 'i', chat: 'c', sender: 's', body: 'hello', eventKey: 'event-4', now: 1 };
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 1, 1) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 1 };
    const first = recordAndClaimInboundDelivery(db, {
      ...fields,
      claimToken: 'claim-a',
      claimOwnerId: ownerA.ownerId,
      claimEpoch: ownerA.epoch,
    });
    expect(
      prepareInboundDelivery(db, first?.id as string, 'claim-a', ownerA, {
        eventId: 'reply-stable-1',
        subject: 'omni.reply.i.c',
        payload: '{"request_id":"reply-stable-1"}',
        meta: '{"version":1,"ok":true}',
      }),
    ).toBe(true);
    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 2, 100) as number;
    const ownerB = { ownerId: 'resident-b', epoch: epochB, now: 2 };
    const takeover = recordAndClaimInboundDelivery(db, {
      ...fields,
      now: 2,
      claimToken: 'claim-b',
      claimOwnerId: ownerB.ownerId,
      claimEpoch: ownerB.epoch,
    });
    expect(takeover).toMatchObject({
      id: first?.id,
      mode: 'resume-delivery',
      delivery: { phase: 'prepared', eventId: 'reply-stable-1' },
    });
    expect(validatePreparedInboundLease(db, first?.id as string, 'claim-a', ownerA)).toBe(false);
    expect(markInboundDeliveryFlushed(db, first?.id as string, 'claim-a', ownerA)).toBe(false);
    expect(markInboundHandledIfClaimed(db, first?.id as string, 'claim-b', 3, ownerB, 'flushed')).toBe(false);
    expect(markInboundDeliveryFlushed(db, first?.id as string, 'claim-b', ownerB)).toBe(true);
    expect(markInboundHandledIfClaimed(db, first?.id as string, 'claim-b', 3, ownerB, 'flushed')).toBe(true);
  });

  test('atomically consumes a bare approval inbound so replay cannot resolve the next request', () => {
    const firstApproval = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'first', now: 1 });
    const secondApproval = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'second', now: 2 });
    const fields = {
      instance: 'i',
      chat: 'approval',
      sender: 'human',
      body: 'y',
      eventKey: 'bare-y-once',
      claimToken: 'approval-inbound-claim',
      claimOwnerId: TEST_OWNER,
      claimEpoch: 1,
      now: 3,
    };
    const claim = recordAndClaimInboundDelivery(db, fields);
    expect(claim?.mode).toBe('fresh');
    const consumed = consumeClaimedApprovalInbound(
      db,
      claim?.id as string,
      fields.claimToken,
      testIdentity(3),
      'approved',
      'human',
      undefined,
      3,
    );
    expect(consumed).toMatchObject({ consumed: true, resolved: { id: firstApproval, status: 'approved' } });
    expect(recordAndClaimInboundDelivery(db, { ...fields, claimToken: 'replay', now: 4 })).toBeUndefined();
    expect(getApproval(db, firstApproval)?.status).toBe('approved');
    expect(getApproval(db, secondApproval)?.status).toBe('pending');
    expect(listInbox(db)[0].handledAt).toBe(3);
  });

  test('post-execution preparation failure becomes ambiguity and is never fresh on takeover', () => {
    expect(releaseServiceLease(db, OMNI_SERVICE_LEASE_NAME, TEST_OWNER, 1)).toBe(true);
    const epochA = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-a', 10, 5) as number;
    const ownerA = { ownerId: 'resident-a', epoch: epochA, now: 10 };
    const fields = {
      instance: 'i',
      chat: 'c',
      sender: 's',
      body: 'write',
      eventKey: 'post-exec-failure',
      claimToken: 'claim-a',
      claimOwnerId: ownerA.ownerId,
      claimEpoch: ownerA.epoch,
      now: 10,
    };
    const first = recordAndClaimInboundDelivery(db, fields);
    expect(markInboundExecuting(db, first?.id as string, fields.claimToken, ownerA)).toBe(true);
    expect(markInboundExecuted(db, first?.id as string, fields.claimToken, ownerA)).toBe(true);
    expect(() =>
      prepareInboundDelivery(db, first?.id as string, fields.claimToken, ownerA, {
        eventId: 'too-large',
        subject: 'omni.reply.i.c',
        payload: 'x'.repeat(32 * 1024 + 1),
        meta: '{}',
      }),
    ).toThrow('durable limit');
    expect(releaseInboundClaim(db, first?.id as string, fields.claimToken, ownerA)).toBe(true);

    const epochB = acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'resident-b', 20, 100) as number;
    const takeover = recordAndClaimInboundDelivery(db, {
      ...fields,
      claimToken: 'claim-b',
      claimOwnerId: 'resident-b',
      claimEpoch: epochB,
      now: 20,
    });
    expect(takeover).toMatchObject({ id: first?.id, mode: 'ambiguous' });
  });
});

// ---------------------------------------------------------------------------
// Multi-PROCESS resolution race: N concurrent bun processes resolve the same
// pending approval against one shared on-disk WAL database. Exactly one must
// win with 'approved'; every loser must get a typed ApprovalConflictError. This
// is the real proof the conditional-UPDATE-in-a-transaction is atomic across
// processes. Mirrors task-state.test.ts's checkout-race pattern.
// ---------------------------------------------------------------------------
describe('multi-process resolution race', () => {
  test('exactly one of N concurrent resolvers wins', async () => {
    const dbPath = join(dir, 'race.db');
    const seed = openGlobalDb({ path: dbPath });
    const id = enqueueApproval(seed, { repo: '/r', tool: 'Bash', inputSummary: 'contended' });
    seed.close(); // checkpoint so child processes see the committed row

    const gdbPath = join(import.meta.dir, 'global-db.ts');
    const queuePath = join(import.meta.dir, 'omni-queue.ts');
    const workerPath = join(dir, 'resolve-worker.ts');
    writeFileSync(
      workerPath,
      `
import { openGlobalDb } from ${JSON.stringify(gdbPath)};
import { resolveApproval, ApprovalConflictError } from ${JSON.stringify(queuePath)};
const [dbPath, id, resolver] = process.argv.slice(2);
const db = openGlobalDb({ path: dbPath });
try {
  resolveApproval(db, id, 'approved', resolver);
  process.stdout.write('WON');
} catch (e) {
  if (e instanceof ApprovalConflictError) process.stdout.write('CONFLICT');
  else { process.stdout.write('ERR:' + (e && e.message)); process.exitCode = 3; }
} finally {
  db.close();
}
`,
    );

    const N = 8;
    const runs = Array.from({ length: N }, (_, i) => {
      const proc = Bun.spawn(['bun', 'run', workerPath, dbPath, id, `resolver-${i}`], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return (async () => {
        const out = await new Response(proc.stdout).text();
        const err = await new Response(proc.stderr).text();
        const code = await proc.exited;
        return { out, err, code };
      })();
    });

    const settled = await Promise.allSettled(runs);
    const outcomes = settled.map((s) =>
      s.status === 'fulfilled' ? `${s.value.out}(exit ${s.value.code})` : `REJECTED:${s.reason}`,
    );

    const wins = outcomes.filter((o) => o.startsWith('WON')).length;
    const conflicts = outcomes.filter((o) => o.startsWith('CONFLICT')).length;

    if (wins !== 1 || conflicts !== N - 1) {
      console.error('race outcomes:', JSON.stringify(outcomes));
      for (const s of settled) {
        if (s.status === 'fulfilled' && !s.value.out.startsWith('WON') && !s.value.out.startsWith('CONFLICT')) {
          console.error('straggler stderr:', s.value.err);
        }
      }
    }

    expect(wins).toBe(1);
    expect(conflicts).toBe(N - 1);

    // Final state: exactly one resolver owns the decision, status approved.
    const verify = openGlobalDb({ path: dbPath });
    const final = getApproval(verify, id);
    verify.close();
    expect(final?.status).toBe('approved');
    expect(final?.resolvedBy).toMatch(/^resolver-\d+$/);
  }, 60_000);
});
