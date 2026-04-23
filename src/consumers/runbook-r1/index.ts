/**
 * Runbook-R1 reference consumer (WISH §Group 7 deliverable #4).
 *
 * Subscribes to `mailbox.delivery` rows via the v2 follow-stream transport.
 * Detects the #1192 escalation-recursion signature (>50 scheduler→team-lead
 * deliveries inside a 10-minute sliding window) and emits a single
 * `runbook.triggered{rule:'R1'}` event with the recommended mitigation SQL.
 *
 * The consumer NEVER auto-executes the SQL — it only attaches it to the
 * payload so an operator (or a later, explicitly-authorized remediator) can
 * apply it after review. Mitigation execution is intentionally out of scope.
 *
 * Subscription token: minted with role `events:subscriber` and the explicit
 * type allowlist `['mailbox.delivery']`. The mint helper rejects any attempt
 * to escalate scope to the audit channel — this is verified in the unit
 * tests under `test/observability/runbook-r1.test.ts`.
 *
 * The consumer survives PG restarts because the underlying stream transport
 * (`runEventsStreamFollow`) persists its `last_seen_id` via consumer-state.
 * Re-subscribing after a crash resumes from the saved cursor; the detector's
 * idempotency window prevents duplicate fires within 60 s of the last one.
 */

import { emitEvent } from '../../lib/emit.js';
import { mintToken } from '../../lib/events/tokens.js';
import type { V2EventRow } from '../../lib/events/v2-query.js';
import { type StreamFollowHandle, runEventsStreamFollow } from '../../term-commands/events-stream.js';
import { type DetectorFinding, type DetectorOptions, R1Detector } from './detector.js';

export interface R1ConsumerOptions {
  /** Override detector knobs (window, threshold, idempotency). */
  detector?: DetectorOptions;
  /** Pre-minted subscription token. When omitted the consumer mints its own. */
  token?: string;
  /** Stable subscriber id for cursor persistence + audit grouping. */
  subscriberId?: string;
  /** When set, emit findings via this callback instead of `emitEvent` (tests). */
  onFinding?: (finding: DetectorFinding) => void;
  /** Test-only: stop after seeing this many mailbox.delivery rows. */
  maxEvents?: number;
  /** Test-only: stop after this many ms with no new events. */
  idleExitMs?: number;
}

export interface R1ConsumerHandle {
  stop: () => Promise<void>;
  /** Exposed for tests — current sliding-window depth in the detector. */
  getWindowDepth: () => number;
  /** Exposed for tests — total findings emitted by this consumer. */
  getFindingCount: () => number;
}

/**
 * Mint a subscription token scoped narrowly to the `mailbox.delivery` type
 * on the `genie_events.mailbox` channel. Throws via tokens.ts/RBAC if the
 * caller has somehow widened scope; the wish requires this remain scoped.
 */
export function mintR1Token(opts: { subscriberId?: string; ttlSeconds?: number } = {}) {
  return mintToken({
    role: 'events:subscriber',
    allowed_types: ['mailbox.delivery'],
    allowed_channels: ['genie_events.mailbox'],
    subscriber_id: opts.subscriberId ?? 'runbook-r1',
    ttl_seconds: opts.ttlSeconds ?? 3600,
  });
}

/**
 * Start the R1 consumer. Returns a handle the caller can stop. The handle
 * also exposes counters useful for tests.
 */
export async function startRunbookR1(opts: R1ConsumerOptions = {}): Promise<R1ConsumerHandle> {
  const detector = new R1Detector(opts.detector);
  let findingCount = 0;

  const token = opts.token ?? mintR1Token({ subscriberId: opts.subscriberId }).token;

  const parseDelivery = (row: V2EventRow): { from: string; to: string } | null => {
    if (row.subject !== 'mailbox.delivery') return null;
    const data = (row.data ?? {}) as Record<string, unknown>;
    const from = typeof data.from === 'string' ? data.from : null;
    const to = typeof data.to === 'string' ? data.to : null;
    if (!from || !to) return null;
    return { from, to };
  };

  const emitFinding = (finding: DetectorFinding) => {
    try {
      emitEvent(
        'runbook.triggered',
        {
          rule: finding.rule,
          evidence_count: finding.evidence_count,
          window_minutes: 10,
          correlation_id: finding.correlation_id,
          recommended_sql: finding.recommended_sql,
          evidence_summary: `scheduler→team-lead mailbox burst: ${finding.evidence_count} deliveries in 10m window`,
        },
        { severity: 'warn', source_subsystem: 'consumer-runbook-r1' },
      );
    } catch {
      // Emitting must never tear down the consumer — bookkeeping only.
    }
  };

  const handle: StreamFollowHandle = await runEventsStreamFollow(
    {
      follow: true,
      kind: 'mailbox',
      token,
      maxEvents: opts.maxEvents,
      idleExitMs: opts.idleExitMs,
    },
    (row: V2EventRow) => {
      const delivery = parseDelivery(row);
      if (!delivery) return;

      const finding = detector.observe({
        createdAt: new Date(row.created_at).getTime(),
        from: delivery.from,
        to: delivery.to,
        trace_id: row.trace_id,
      });
      if (!finding) return;

      findingCount++;
      if (opts.onFinding) opts.onFinding(finding);
      else emitFinding(finding);
    },
  );

  return {
    stop: () => handle.stop(),
    getWindowDepth: () => detector.getWindowDepth(),
    getFindingCount: () => findingCount,
  };
}
