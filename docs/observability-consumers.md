# Writing an Observability Consumer

A *consumer* is a long-running process that subscribes to the structured-event
stream, pattern-matches against incoming rows, and emits a `runbook.triggered`
event when a known pathology fires. Consumers do **not** auto-execute
mitigations — they attach a recommended SQL/CLI payload that an operator runs
after review.

This doc walks through the reference implementation,
[`src/consumers/runbook-r1/`](../src/consumers/runbook-r1), as the worked example
for any rule R2-R5 you'd like to add.

---

## The 4 pieces

A consumer is always four small files:

| Piece                    | What it owns                                        | R1 file                                       |
| ------------------------ | --------------------------------------------------- | --------------------------------------------- |
| **Detector**             | Pure logic — sliding window, threshold, idempotency | `src/consumers/runbook-r1/detector.ts`        |
| **Token mint helper**    | Subscription token narrowed to the rule's surface   | `src/consumers/runbook-r1/index.ts` (`mintR1Token`) |
| **Consumer wrapper**     | Glues stream-follow + detector + emit               | `src/consumers/runbook-r1/index.ts` (`startRunbookR1`) |
| **Integration test**     | Synthetic replay → assert finding shape             | `test/observability/runbook-r1.test.ts`       |

Keep the detector pure (no DB, no network, no `Date.now()` baked in — pass
`createdAt` explicitly). Keep the consumer wrapper trivial (one filter + one
detector call per row + one `emitEvent`). The integration test seeds rows
directly via `sql.json()` rather than `emitEvent` — see the
[Bypassing emit](#bypassing-emit-in-tests) note below.

---

## 1. The detector

The detector decides "given this row, does the rule fire?" It owns no I/O. R1
keeps a fixed-size deque of timestamped events for the last 10 minutes:

```ts
// src/consumers/runbook-r1/detector.ts
export class R1Detector {
  observe(ev: MailboxDeliveryEvent): DetectorFinding | null {
    if (ev.from !== this.fromRole || ev.to !== this.toRole) return null;
    this.evictOlderThan(ev.createdAt - this.windowMs);
    this.window.push({ createdAt: ev.createdAt, trace_id: ev.trace_id ?? null });

    if (this.window.length <= this.threshold) return null;
    if (ev.createdAt - this.lastFiredAt < this.idempotencyMs) return null;

    this.lastFiredAt = ev.createdAt;
    return {
      rule: 'R1',
      evidence_count: this.window.length,
      correlation_id: ev.trace_id ?? undefined,
      recommended_sql: `DELETE FROM mailbox WHERE to_worker='${this.toRole}' AND from_worker='${this.fromRole}';`,
      window_start_ms: this.window[0].createdAt,
      window_end_ms: this.window[this.window.length - 1].createdAt,
    };
  }
}
```

Detector knobs are `windowMs`, `threshold`, `idempotencyMs`, plus the
rule-specific `fromRole`/`toRole`. Defaults match what the R1 wish demands
(>50 in 10 minutes, 60 s cool-down).

**Test the detector first.** It's pure, so unit tests run in milliseconds:

```ts
test('does not fire below the threshold', () => {
  const det = new R1Detector({ threshold: 5, idempotencyMs: 1_000 });
  for (let i = 0; i < 5; i++) {
    expect(det.observe({ createdAt: i, from: 'scheduler', to: 'team-lead' })).toBeNull();
  }
});

test('fires once when threshold crossed', () => {
  const det = new R1Detector({ threshold: 5, idempotencyMs: 60_000 });
  let fires = 0;
  for (let i = 0; i < 10; i++) {
    if (det.observe({ createdAt: i, from: 'scheduler', to: 'team-lead' })) fires++;
  }
  expect(fires).toBe(1);
});
```

---

## 2. The token mint helper

Subscription tokens are HMAC-signed by `src/lib/events/tokens.ts` and validated
at the stream boundary. Each token carries:

- `role` — one of `events:admin`, `events:operator`, `events:subscriber`, `events:audit`
- `allowed_channels` — LISTEN-channel allowlist (`genie_events.<prefix>`)
- `allowed_types` — event-type allowlist (matched against `subject` column)
- `subscriber_id` — stable id, used for cursor persistence + audit grouping
- `ttl_seconds` — short-lived (R1 picks 1 h)

Mint with the narrowest scope your rule needs. R1 only watches mailbox events,
so it asks for *just* `mailbox.delivery`:

```ts
export function mintR1Token(opts: { subscriberId?: string; ttlSeconds?: number } = {}) {
  return mintToken({
    role: 'events:subscriber',
    allowed_types: ['mailbox.delivery'],
    allowed_channels: ['genie_events.mailbox'],
    subscriber_id: opts.subscriberId ?? 'runbook-r1',
    ttl_seconds: opts.ttlSeconds ?? 3600,
  });
}
```

Two RBAC invariants are worth a unit test:

1. The helper rejects scope escalation. A `events:subscriber` role cannot mint a
   token for `genie_events.audit` — `mintToken` throws `RBACError`. Assert that
   directly.
2. The minted payload only contains the types you asked for. A regression that
   silently widens scope past `mailbox.delivery` shows up immediately.

---

## 3. The consumer wrapper

Wrap `runEventsStreamFollow` from `src/term-commands/events-stream.ts`. That
function owns LISTEN/NOTIFY plumbing, the 2 s safety-net poll, the gap-detect
emitter, and consumer-state cursor persistence. Your wrapper stays small:

```ts
// src/consumers/runbook-r1/index.ts
export async function startRunbookR1(opts: R1ConsumerOptions = {}): Promise<R1ConsumerHandle> {
  const detector = new R1Detector(opts.detector);
  const token = opts.token ?? mintR1Token({ subscriberId: opts.subscriberId }).token;

  const handle = await runEventsStreamFollow(
    { follow: true, kind: 'mailbox', token, maxEvents: opts.maxEvents, idleExitMs: opts.idleExitMs },
    (row: V2EventRow) => {
      if (row.subject !== 'mailbox.delivery') return;
      const data = (row.data ?? {}) as Record<string, unknown>;
      const from = typeof data.from === 'string' ? data.from : null;
      const to = typeof data.to === 'string' ? data.to : null;
      if (!from || !to) return;

      const finding = detector.observe({
        createdAt: new Date(row.created_at).getTime(),
        from, to, trace_id: row.trace_id,
      });
      if (!finding) return;

      if (opts.onFinding) { opts.onFinding(finding); return; }
      try {
        emitEvent('runbook.triggered', {
          rule: finding.rule,
          evidence_count: finding.evidence_count,
          window_minutes: 10,
          correlation_id: finding.correlation_id,
          recommended_sql: finding.recommended_sql,
          evidence_summary: `scheduler→team-lead mailbox burst: ${finding.evidence_count} deliveries in 10m window`,
        }, { severity: 'warn', source_subsystem: 'consumer-runbook-r1' });
      } catch {
        // Emitting must never tear down the consumer — bookkeeping only.
      }
    },
  );

  return { stop: () => handle.stop(), getWindowDepth: () => detector.getWindowDepth(), getFindingCount: () => findingCount };
}
```

Three guarantees this wrapper enforces:

- **Filter on subject, not kind.** `kind` is always `'system'` under the
  current writer; the type lives in `subject`. Stream-side token filtering
  matches `allowed_types` against `subject`.
- **Never auto-execute the recommended SQL.** Attach it; let the operator run
  it. R1's `runbook.triggered` event carries `recommended_sql` as a string —
  there is no `execute_sql` flag, by design.
- **Never throw out of `onEvent`.** A consumer that crashes on a malformed row
  loses every subsequent row until restart. Wrap your detector + emit in a
  swallow-all `try/catch`.

---

## 4. The integration test

The integration test is the proof that the consumer end-to-end actually works.
Three things it must assert:

1. **Detection.** Synthetic burst → `runbook.triggered` fires once with the
   expected `evidence_count` and recommended SQL.
2. **Token scope.** A subscriber-role token cannot be widened to the audit
   channel. R1 asserts `mintToken({ ..., allowed_channels: ['genie_events.audit'] })`
   throws `RBACError`.
3. **Survivability.** The consumer survives a stop/restart with the same
   `subscriberId` — cursor recovers from `~/.genie/state/consumer-<id>.json`,
   idempotency suppresses double-fire on the same window.

### Bypassing emit in tests

Tests seed rows directly via `sql.json()` rather than calling `emitEvent`. The
seeder helper looks like this (full version in
[`test/observability/replay-dataset/index.ts`](../test/observability/replay-dataset/index.ts)):

```ts
async function seedMailboxDelivery(sql: Sql, args: { from: string; to: string }) {
  const data = {
    from: args.from, to: args.to, channel: 'tmux',
    outcome: 'delivered', duration_ms: 4,
    _severity: 'info', _kind: 'span', _source_subsystem: 'r1-replay-test', _schema_version: 1,
  };
  await sql`
    INSERT INTO genie_runtime_events
      (repo_path, subject, kind, source, agent, team, text, data,
       severity, schema_version, duration_ms, source_subsystem, created_at)
    VALUES
      ('r1-test', 'mailbox.delivery', 'system', 'sdk', 'system', NULL,
       'mailbox.delivery', ${sql.json(data)},
       'info', 1, 4, 'r1-replay-test', now())
  `;
}
```

Why bypass `emit.ts`? The test isolates the consumer's behavior. Going through
`emit.ts` adds queue + flush + Zod redaction in the call path — a regression in
any of those breaks the consumer test for unrelated reasons. The acid-test
suite ([`docs/observability-acid-tests.sql`](observability-acid-tests.sql))
follows the same pattern: each pattern's seeder writes raw rows, then the SQL
query reconstructs the evidence. If you want to test `emit.ts` itself, do it
in `test/lib/emit.test.ts`; if you want to test a consumer, seed directly.

### Test database isolation

Use `setupTestDatabase()` from `src/lib/test-db.ts` — each test file gets its
own PG database, cloned from the `genie_template` DB that the preload built
once at the start of `bun test`. DB-level isolation sidesteps NOTIFY leakage
for free (NOTIFY is instance-scoped, but each clone is effectively its own
namespace for the test's lifetime). Per-test cleanup is `TRUNCATE
genie_runtime_events* RESTART IDENTITY CASCADE` — `TRUNCATE` bypasses the
audit-WORM trigger that guards `DELETE`/`UPDATE`.

---

## Adding rule R2

To add a new runbook rule, copy `src/consumers/runbook-r1/` to
`src/consumers/runbook-r2/`, then change four things:

1. **Detector knobs** — `fromRole`/`toRole`/`windowMs`/`threshold` for R2's
   pathology (or write a different detector if the rule is shape-different).
2. **Token narrowing** — `allowed_types` and `allowed_channels` for whatever
   subset of the stream R2 reads.
3. **`runbook.triggered.rule`** — bump the literal from `'R1'` to `'R2'` in the
   detector's return.
4. **`recommended_sql`** — what the operator runs to clear the pathology.

Add the matching integration test under `test/observability/runbook-r2.test.ts`
and seed via the same `sql.json()` pattern.

If R2's rule reads from a different prefix (say, `executor.invoke` for an
executor-stuck rule), update `kind` in the `runEventsStreamFollow` options and
make sure the token's `allowed_channels` includes that prefix.

---

## Checklist

Before shipping a new consumer:

- [ ] Detector has unit tests for: below threshold, fires-once, idempotency, sliding-window eviction, decoy-rejection, finding-payload-shape.
- [ ] Token mint helper rejects scope escalation (RBACError test).
- [ ] Consumer wrapper handles `row.subject` filter + `data.from`/`data.to` extraction defensively (no throws on malformed rows).
- [ ] `runbook.triggered` carries `rule`, `evidence_count`, `recommended_sql` — and **does not auto-execute** the SQL.
- [ ] Integration test uses `setupTestDatabase` + per-test `TRUNCATE` + direct `sql.json()` seeding.
- [ ] Restart test asserts no double-fire after stop/start with same `subscriberId`.
- [ ] If your rule is sensitive to wall-clock time, the detector takes
      `createdAt` as a parameter (do not call `Date.now()` inside).

---

## References

- Wish §Group 7 — `.genie/wishes/genie-serve-structured-observability/WISH.md`
- Reference R1 source — [`src/consumers/runbook-r1/`](../src/consumers/runbook-r1)
- Reference R1 test — [`test/observability/runbook-r1.test.ts`](../test/observability/runbook-r1.test.ts)
- Stream transport — [`src/term-commands/events-stream.ts`](../src/term-commands/events-stream.ts)
- RBAC + tokens — [`src/lib/events/tokens.ts`](../src/lib/events/tokens.ts), [`src/lib/events/rbac.ts`](../src/lib/events/rbac.ts)
- Acid-test pattern doc — [`docs/observability-acid-tests.sql`](observability-acid-tests.sql)
