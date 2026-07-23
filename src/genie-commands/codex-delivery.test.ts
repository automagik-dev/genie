import { describe, expect, test } from 'bun:test';
import type { CodexActivationStore, DeliveryRecord, PublishDeliveryInput } from '../lib/codex-activation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import {
  CODEX_DELIVERY_RESULT_TRAILER,
  CODEX_LIFECYCLE_BUSY_TRAILER,
  CodexLifecycleBusyError,
  buildDeliveryPublication,
  classifyCodexDelivery,
  publishCodexDelivery,
} from './codex-delivery.js';

const N = '5.260711.6';
const T = '5.260712.1';
const DIGEST = 'a'.repeat(64);

describe('classifyCodexDelivery — the one delivery classifier', () => {
  test('absent installed generation', () => {
    expect(classifyCodexDelivery(null, T)).toEqual({ kind: 'absent' });
  });
  test('canonical-equal is current', () => {
    expect(classifyCodexDelivery(T, T)).toEqual({ kind: 'current' });
  });
  test('N < T is a pending upgrade', () => {
    expect(classifyCodexDelivery(N, T)).toEqual({ kind: 'pending', direction: 'upgrade' });
  });
  test('N > T is a pending downgrade', () => {
    expect(classifyCodexDelivery(T, N)).toEqual({ kind: 'pending', direction: 'downgrade' });
  });
  test('unparseable versions fail closed as indeterminate', () => {
    expect(classifyCodexDelivery('garbage', T).kind).toBe('indeterminate');
    expect(classifyCodexDelivery(N, 'garbage').kind).toBe('indeterminate');
  });
});

describe('buildDeliveryPublication — publish facts only for pending', () => {
  test('upgrade publishes without a downgradeFrom', () => {
    expect(
      buildDeliveryPublication({
        installedVersion: N,
        targetVersion: T,
        canonicalPayloadSha256: DIGEST,
        channel: 'dev',
      }),
    ).toEqual({ targetVersion: T, canonicalPayloadSha256: DIGEST, channel: 'dev' });
  });
  test('downgrade binds downgradeFrom = N', () => {
    expect(
      buildDeliveryPublication({
        installedVersion: T,
        targetVersion: N,
        canonicalPayloadSha256: DIGEST,
        channel: 'stable',
      }),
    ).toEqual({ targetVersion: N, canonicalPayloadSha256: DIGEST, channel: 'stable', downgradeFrom: T });
  });
  test('absent-N publishes the delivery facts (fresh host: setup gate needs the record); no downgrade binding', () => {
    // Group E live-QA regression: without this, a fresh codex host required a
    // SECOND `genie update` (already-current repair) before setup could pass
    // the Decision-9 record gate.
    expect(
      buildDeliveryPublication({
        installedVersion: null,
        targetVersion: T,
        canonicalPayloadSha256: DIGEST,
        channel: 'dev',
      }),
    ).toEqual({ targetVersion: T, canonicalPayloadSha256: DIGEST, channel: 'dev' });
  });

  test('current publishes nothing', () => {
    expect(
      buildDeliveryPublication({
        installedVersion: T,
        targetVersion: T,
        canonicalPayloadSha256: DIGEST,
        channel: 'dev',
      }),
    ).toBeNull();
  });
});

/** A store that flags any activation-time call — C must only ever call publishDelivery. */
function spyStore(): { store: CodexActivationStore; publishCalls: PublishDeliveryInput[]; forbidden: string[] } {
  const publishCalls: PublishDeliveryInput[] = [];
  const forbidden: string[] = [];
  const store: CodexActivationStore = {
    observe() {
      forbidden.push('observe');
      throw new Error('parent publish must not observe through the store');
    },
    publishDelivery(_lease, input): DeliveryRecord {
      publishCalls.push(input);
      return {
        schemaVersion: 1,
        deliveryId: input.deliveryId ?? 'd'.repeat(32),
        targetVersion: input.targetVersion,
        canonicalPayloadSha256: input.canonicalPayloadSha256,
        channel: input.channel,
        deliveredAt: '2026-07-21T00:00:00.000Z',
      };
    },
    withRevalidatedDeliveryRoot() {
      forbidden.push('withRevalidatedDeliveryRoot');
      throw new Error('C must not retain a delivery root');
    },
    beginActivation() {
      forbidden.push('beginActivation');
      throw new Error('C must not begin activation');
    },
    advanceIntentPhase() {
      forbidden.push('advanceIntentPhase');
      throw new Error('C must not advance a journal');
    },
    finalizeActivation() {
      forbidden.push('finalizeActivation');
      throw new Error('C must not consume/tombstone a receipt');
    },
    quarantineIntent() {
      forbidden.push('quarantineIntent');
      return { skipped: 'spy' };
    },
  };
  return { store, publishCalls, forbidden };
}

function spyLease(): HeldLifecycleLease {
  return { ok: true, operationId: 'e'.repeat(32), kind: 'update-delivery', assertOperation() {}, release() {} };
}

describe('publishCodexDelivery — parent publishes facts, nothing else', () => {
  test('pending upgrade publishes exactly one delivery record and no receipt', () => {
    const { store, publishCalls, forbidden } = spyStore();
    const result = publishCodexDelivery({
      lease: spyLease(),
      store,
      installedVersion: N,
      targetVersion: T,
      canonicalPayloadSha256: DIGEST,
      channel: 'dev',
      deliveryId: 'c'.repeat(32),
    });
    expect(result.published).toBe(true);
    expect(result.wroteDowngradeReceipt).toBe(false);
    expect(result.state).toEqual({ kind: 'pending', direction: 'upgrade' });
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].downgradeFrom).toBeUndefined();
    expect(publishCalls[0].deliveryId).toBe('c'.repeat(32));
    expect(forbidden).toEqual([]);
  });

  test('pending downgrade publishes with the receipt-binding downgradeFrom', () => {
    const { store, publishCalls, forbidden } = spyStore();
    const result = publishCodexDelivery({
      lease: spyLease(),
      store,
      installedVersion: T,
      targetVersion: N,
      canonicalPayloadSha256: DIGEST,
      channel: 'stable',
    });
    expect(result.published).toBe(true);
    expect(result.wroteDowngradeReceipt).toBe(true);
    expect(publishCalls[0].downgradeFrom).toBe(T);
    expect(forbidden).toEqual([]);
  });

  test('current publishes nothing and never touches activation state', () => {
    const { store, publishCalls, forbidden } = spyStore();
    const result = publishCodexDelivery({
      lease: spyLease(),
      store,
      installedVersion: T,
      targetVersion: T,
      canonicalPayloadSha256: DIGEST,
      channel: 'dev',
    });
    expect(result.published).toBe(false);
    expect(publishCalls).toHaveLength(0);
    expect(forbidden).toEqual([]);
  });

  test('absent-N publishes the facts once, with no receipt and no activation-state touch', () => {
    const { store, publishCalls, forbidden } = spyStore();
    const result = publishCodexDelivery({
      lease: spyLease(),
      store,
      installedVersion: null,
      targetVersion: T,
      canonicalPayloadSha256: DIGEST,
      channel: 'dev',
    });
    expect(result.published).toBe(true);
    expect(result.wroteDowngradeReceipt).toBe(false);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0]).toMatchObject({ targetVersion: T, canonicalPayloadSha256: DIGEST, channel: 'dev' });
    expect(forbidden).toEqual([]);
  });
});

describe('the shared result trailers', () => {
  test('the delivery-pending trailer carries deliveryComplete:true and the retire recovery', () => {
    expect(JSON.parse(CODEX_DELIVERY_RESULT_TRAILER)).toEqual({
      schemaVersion: 1,
      code: 'activation-pending',
      deliveryComplete: true,
      retry: false,
      nextAction: 'retire tasks → genie setup --codex → /hooks → new task',
    });
  });

  test('the lifecycle-busy trailer carries deliveryComplete:false and retry:true', () => {
    expect(JSON.parse(CODEX_LIFECYCLE_BUSY_TRAILER)).toEqual({
      schemaVersion: 1,
      code: 'codex-lifecycle-busy',
      deliveryComplete: false,
      retry: true,
      nextAction: 'another Genie lifecycle command is active; retry once it completes',
    });
  });

  test('CodexLifecycleBusyError names the holder kind and carries the machine code', () => {
    const err = new CodexLifecycleBusyError('setup-activation');
    expect(err.code).toBe('codex-lifecycle-busy');
    expect(err.holderKind).toBe('setup-activation');
    expect(err.message).toContain('setup-activation');
  });
});
