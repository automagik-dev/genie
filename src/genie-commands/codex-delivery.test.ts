import { describe, expect, test } from 'bun:test';
import type {
  CanonicalFact,
  CodexActivationSnapshot,
  CodexActivationStore,
  DeliveryRecord,
  PublishDeliveryInput,
  RegistrationFact,
} from '../lib/codex-activation.js';
import { parseReleaseVersion } from '../lib/codex-activation.js';
import type { HeldLifecycleLease } from '../lib/codex-lifecycle-lease.js';
import type { IntegrationResult } from '../lib/runtime-integrations.js';
import { deliverCodexPlugin } from './codex-delivery.js';

const N = '5.260711.6';
const T = '5.260712.1';
const DIGEST_T = 'a'.repeat(64);
const DIGEST_N = 'b'.repeat(64);

function version(raw: string) {
  const parsed = parseReleaseVersion(raw);
  if (parsed === null) throw new Error(`bad test version ${raw}`);
  return parsed;
}

function witness() {
  return { status: 'present' as const, digest: 'w'.repeat(64), identity: '1:2' };
}

/** A snapshot with a present, enabled registration at `installedVersion` and a canonical `T`. */
function snapshot(overrides: Partial<CodexActivationSnapshot> = {}): CodexActivationSnapshot {
  const registration: RegistrationFact = { present: true, enabled: true, version: version(N) };
  const canonical: CanonicalFact = { status: 'ok', version: version(T), digest: DIGEST_T, identity: '3:4' };
  return {
    canonical,
    query: { status: 'ok', registration },
    cache: { kind: 'present', digest: DIGEST_N, identity: '5:6' },
    receipt: { status: 'absent' },
    delivery: { status: 'absent' },
    intent: { status: 'absent' },
    receiptConsumed: false,
    observationWitness: { before: witness(), after: witness() },
    observedAt: '2026-07-21T00:00:00.000Z',
    ...overrides,
  };
}

function currentSnapshot(): CodexActivationSnapshot {
  return snapshot({
    query: { status: 'ok', registration: { present: true, enabled: true, version: version(T) } },
    cache: { kind: 'present', digest: DIGEST_T, identity: '5:6' },
  });
}

function installedNewerSnapshot(): CodexActivationSnapshot {
  return snapshot({
    query: { status: 'ok', registration: { present: true, enabled: true, version: version(T) } },
    canonical: { status: 'ok', version: version(N), digest: DIGEST_N, identity: '3:4' },
    cache: { kind: 'present', digest: DIGEST_T, identity: '5:6' },
  });
}

function pendingDowngradeSnapshot(): CodexActivationSnapshot {
  const receiptId = 'c'.repeat(32);
  return snapshot({
    query: { status: 'ok', registration: { present: true, enabled: true, version: version(T) } },
    canonical: { status: 'ok', version: version(N), digest: DIGEST_N, identity: '3:4' },
    cache: { kind: 'present', digest: DIGEST_N, identity: '5:6' },
    receipt: {
      status: 'present',
      receipt: {
        schemaVersion: 1,
        receiptId,
        fromPluginVersion: T,
        targetVersion: N,
        canonicalPayloadSha256: DIGEST_N,
        channel: 'stable',
      },
    },
    delivery: {
      status: 'present',
      record: {
        schemaVersion: 1,
        deliveryId: receiptId,
        targetVersion: N,
        canonicalPayloadSha256: DIGEST_N,
        channel: 'stable',
        deliveredAt: '2026-07-21T00:00:00.000Z',
      },
    },
  });
}

interface SpyState {
  observeQueue: CodexActivationSnapshot[];
  observeCount: number;
  publishCalls: PublishDeliveryInput[];
  forbiddenCalls: string[];
}

function spyLease(): HeldLifecycleLease {
  return {
    ok: true,
    operationId: 'd'.repeat(32),
    kind: 'update-delivery',
    assertOperation() {},
    release() {},
  };
}

/** A store that serves queued snapshots and flags any activation-time call. */
function spyStore(snapshots: CodexActivationSnapshot[]): { store: CodexActivationStore; spy: SpyState } {
  const spy: SpyState = { observeQueue: [...snapshots], observeCount: 0, publishCalls: [], forbiddenCalls: [] };
  const store: CodexActivationStore = {
    observe() {
      const next = spy.observeQueue[Math.min(spy.observeCount, spy.observeQueue.length - 1)];
      spy.observeCount += 1;
      return next;
    },
    publishDelivery(_lease, input): DeliveryRecord {
      spy.publishCalls.push(input);
      return {
        schemaVersion: 1,
        deliveryId: input.deliveryId ?? 'e'.repeat(32),
        targetVersion: input.targetVersion,
        canonicalPayloadSha256: input.canonicalPayloadSha256,
        channel: input.channel,
        deliveredAt: '2026-07-21T00:00:00.000Z',
      };
    },
    withRevalidatedDeliveryRoot() {
      spy.forbiddenCalls.push('withRevalidatedDeliveryRoot');
      throw new Error('C must not retain a delivery root');
    },
    beginActivation() {
      spy.forbiddenCalls.push('beginActivation');
      throw new Error('C must not begin activation');
    },
    advanceIntentPhase() {
      spy.forbiddenCalls.push('advanceIntentPhase');
      throw new Error('C must not advance a journal');
    },
    finalizeActivation() {
      spy.forbiddenCalls.push('finalizeActivation');
      throw new Error('C must not consume/tombstone a receipt');
    },
    quarantineIntent() {
      spy.forbiddenCalls.push('quarantineIntent');
      return { skipped: 'spy' };
    },
  };
  return { store, spy };
}

function baseInput(store: CodexActivationStore, extra: Partial<Parameters<typeof deliverCodexPlugin>[0]> = {}) {
  let convergeCurrentCalls = 0;
  let convergeAgentsCalls = 0;
  const convergeResult: IntegrationResult = { runtime: 'codex', ok: true, detail: 'refreshed' };
  const input = {
    lease: spyLease(),
    store,
    expectedVersion: T,
    channel: 'stable',
    convergeCurrent: () => {
      convergeCurrentCalls += 1;
      return convergeResult;
    },
    convergeAgentsOnly: () => {
      convergeAgentsCalls += 1;
    },
    ...extra,
  };
  return { input, counts: () => ({ convergeCurrentCalls, convergeAgentsCalls }) };
}

describe('deliverCodexPlugin — delivery never advances the cache', () => {
  test('activation-pending publishes delivery facts, converges agents only, exits 2, defers activation', () => {
    const { store, spy } = spyStore([snapshot()]);
    const { input, counts } = baseInput(store);
    const outcome = deliverCodexPlugin(input);

    expect(outcome.disposition).toBe('delivered');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.deliveryComplete).toBe(true);
    expect(spy.publishCalls).toHaveLength(1);
    expect(spy.publishCalls[0].downgradeFrom).toBeUndefined();
    expect(spy.publishCalls[0].targetVersion).toBe(T);
    expect(spy.publishCalls[0].canonicalPayloadSha256).toBe(DIGEST_T);
    expect(spy.forbiddenCalls).toEqual([]);
    expect(counts()).toEqual({ convergeCurrentCalls: 0, convergeAgentsCalls: 1 });
    // Pending output names N/T and the exact retirement recovery.
    expect(outcome.human.text).toContain(`installed=${N}`);
    expect(outcome.human.text).toContain(`target=${T}`);
    expect(outcome.human.text).toContain('retire tasks → genie setup --codex → /hooks → new task');
    // Result trailer is the A-owned serializer output.
    const trailer = JSON.parse(outcome.resultTrailer ?? '{}');
    expect(trailer).toEqual({
      schemaVersion: 1,
      code: 'activation-pending',
      deliveryComplete: true,
      retry: false,
      nextAction: 'retire tasks → genie setup --codex → /hooks → new task',
    });
  });

  test('verified-current re-converges the safe surface, exits 0, publishes nothing', () => {
    const { store, spy } = spyStore([currentSnapshot()]);
    const { input, counts } = baseInput(store);
    const outcome = deliverCodexPlugin(input);

    expect(outcome.disposition).toBe('current');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.resultTrailer).toBeNull();
    expect(outcome.convergeResult).toEqual({ runtime: 'codex', ok: true, detail: 'refreshed' });
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.forbiddenCalls).toEqual([]);
    expect(counts()).toEqual({ convergeCurrentCalls: 1, convergeAgentsCalls: 0 });
  });

  test('installed-newer without an explicit downgrade refuses (exit 1) and publishes nothing', () => {
    const { store, spy } = spyStore([installedNewerSnapshot()]);
    const { input, counts } = baseInput(store);
    const outcome = deliverCodexPlugin(input);

    expect(outcome.disposition).toBe('broken');
    expect(outcome.exitCode).toBe(1);
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.forbiddenCalls).toEqual([]);
    expect(counts()).toEqual({ convergeCurrentCalls: 0, convergeAgentsCalls: 0 });
    const trailer = JSON.parse(outcome.resultTrailer ?? '{}');
    expect(trailer.code).toBe('installed-newer');
    expect(trailer.retry).toBe(true);
  });

  test('explicit channel downgrade publishes the downgrade receipt and re-observes to pending-downgrade (exit 2)', () => {
    const { store, spy } = spyStore([installedNewerSnapshot(), pendingDowngradeSnapshot()]);
    const { input } = baseInput(store, { downgradeFrom: T });
    const outcome = deliverCodexPlugin(input);

    expect(spy.publishCalls).toHaveLength(1);
    expect(spy.publishCalls[0].downgradeFrom).toBe(T);
    expect(outcome.wroteDowngradeReceipt).toBe(true);
    expect(outcome.disposition).toBe('delivered');
    expect(outcome.exitCode).toBe(2);
    expect(outcome.state.kind).toBe('pending-downgrade-explicit');
    expect(spy.forbiddenCalls).toEqual([]);
    // Re-observed exactly twice (before + after publish).
    expect(spy.observeCount).toBe(2);
  });

  test('query-failed is broken (exit 1), publishes nothing, never cache-advances', () => {
    const broken = snapshot({ query: { status: 'failed', detail: 'codex unavailable' } });
    const { store, spy } = spyStore([broken]);
    const { input, counts } = baseInput(store);
    const outcome = deliverCodexPlugin(input);

    expect(outcome.disposition).toBe('broken');
    expect(outcome.exitCode).toBe(1);
    expect(spy.publishCalls).toHaveLength(0);
    expect(spy.forbiddenCalls).toEqual([]);
    expect(counts()).toEqual({ convergeCurrentCalls: 0, convergeAgentsCalls: 0 });
  });
});
