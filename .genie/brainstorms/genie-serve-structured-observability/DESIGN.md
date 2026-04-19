# Design: Genie Serve Structured Observability

| Field | Value |
|-------|-------|
| **Slug** | `genie-serve-structured-observability` |
| **Date** | 2026-04-19 |
| **WRS** | 100/100 |
| **Parent** | `genie-self-healing-observability` (sub-project A) |
| **Draft log** | [DRAFT.md](./DRAFT.md) |

## Problem

Genie runtime has no structured, correlated, redacted event stream — bugs like PR #1192 (181K-event escalation recursion over 8 days) accumulate silently, customers experience incidents before we see them, and scheduled consumer agents cannot derive pathology patterns from the stream because the substrate doesn't exist.

## Scope

### IN
- Sentry-grade wide emission from every genie subsystem into a typed, Zod-validated, redacted, OTEL-correlated event substrate.
- `src/lib/emit.ts` exposing three primitives — `startSpan`, `endSpan`, `emitEvent` — routed through a bounded async queue + batched COPY flusher.
- Closed event-type registry at `src/lib/events/registry.ts` with per-type Zod schemas carrying payload contracts, Tier A/B/C field-level redaction `.transform()`, and `schema_version`.
- Four-channel server-minted signed-token correlation propagation: env var `GENIE_TRACE_TOKEN`, DB `parent_span_id` column, prompt-injected `<genie-trace>` preamble, structured log line.
- Extension of `genie_runtime_events` with columns (`trace_id`, `span_id`, `parent_span_id`, `severity`, `schema_version`, `duration_ms`, `dedup_key`, `source_subsystem`). Daily partitioning. Sibling tables `genie_runtime_events_debug` (24h TTL) and `genie_runtime_events_audit` (append-only WORM, HMAC-chained).
- Four-tier retention: debug 24h / operational 30d / warn+error 90d / audit forever.
- Consumer CLI: `genie events stream --follow` (LISTEN/NOTIFY + id-cursor), `genie events timeline <trace_id>` (causal tree), `genie events list --v2` opt-in reader.
- RBAC + short-lived signed subscription tokens (`events:admin`/`operator`/`subscriber`/`audit`), PG row-level security, channel-namespaced LISTEN ACL.
- External systemd-timer dead-man's switch (separate package, no shared code or DB pool).
- Six watcher-of-watcher meta metrics emitted back into the stream: `emit.rejected`, `emit.queue.depth`, `emit.latency_p99`, `notify.delivery.lag`, `stream.gap.detected`, `correlation.orphan.rate`.
- IR playbook commands: `genie events revoke-subscriber`, `genie events rotate-redaction-keys`, `genie events export-audit --signed`, `genie events migrate --audit`.
- Dual-write transition wrapped in feature flag `GENIE_WIDE_EMIT` (off at release tag, flipped only after 14d green).
- Demonstrable runbook rule R1 prototype consumer (escalation-recursion detector for #1192) as v0 acid-test gate.
- Pen-test gate before v0 merge: forge event, exfiltrate env-var, schema-bomb DoS, LISTEN-bomb — all four must fail.

### OUT
- Pathology categories encoded as event types (ghost/stale/loop as type names).
- Any auto-action at emit-site or in the serve process reacting to its own events (sub-project B).
- Auto-PR generation, auto-doctor-fix loops, auto-issue creation.
- Filtering at emit-site (consumers filter; emitter emits everything).
- DB UNIQUE constraints preventing duplicate anchors (sub-project D).
- Wish-parser refactor (sub-project C).
- External-service observability (omni NATS, Claude API internals, tmux).
- Full OpenTelemetry / Prometheus rollout (adopt vocabulary only).
- UI / dashboard (CLI-first v0).
- Multi-tenancy as a deployed feature (RLS columns exist but only one tenant value populated).
- Pre-v0 backfill of historical `audit_events` into enriched shape beyond 7-day migration helper window.

## Approach

### Layered architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Consumer layer (CLI + N racing agents)                       │
│  genie events stream --follow  |  genie events timeline <id> │
│         ↑ LISTEN/NOTIFY wake   ↑ SELECT id-cursor            │
├─────────────────────────────────────────────────────────────┤
│ RBAC layer                                                   │
│  Signed JWT tokens · allowed_types · PG RLS · channel ACL    │
├─────────────────────────────────────────────────────────────┤
│ Storage layer                                                │
│  genie_runtime_events (30d, partitioned daily)               │
│  genie_runtime_events_debug (24h, truncatable, sampled 1/100)│
│  genie_runtime_events_audit (forever, WORM, HMAC-chained)    │
│  audit_events (legacy reader surface, dual-written)          │
├─────────────────────────────────────────────────────────────┤
│ Emission layer (src/lib/emit.ts)                             │
│  startSpan · endSpan · emitEvent                             │
│  → bounded async queue (cap 10K)                             │
│  → batched COPY flusher (500 rows or 100ms)                  │
│  → Zod .safeParse() + redaction .transform()                 │
├─────────────────────────────────────────────────────────────┤
│ Correlation layer (server-minted signed token)               │
│  env var · DB parent_span_id · prompt preamble · log line    │
├─────────────────────────────────────────────────────────────┤
│ External observability (dead-man's switch)                   │
│  systemd timer · separate package · no shared pool           │
└─────────────────────────────────────────────────────────────┘
```

### Three emit primitives

```ts
// src/lib/emit.ts (conceptual)
export function startSpan<T extends SpanType>(type: T, ctx?: Context): SpanHandle<T>
export function endSpan<T>(h: SpanHandle<T>, outcome: {status: 'ok'|'error', error_code?: string}): void
export function emitEvent<T extends EventType>(type: T, payload: EventPayload<T>, ctx?: Context): void
```

**Span** = durational wrapper around a subsystem call (`cli.command`, `agent.lifecycle`, `wish.dispatch`, `hook.delivery`, `resume.attempt`, `executor.write`, `mailbox.delivery`). Emits a `.start` row + `.end` row with `duration_ms`.

**Event** = point-in-time inside or outside a span (`state_transition`, `error.raised`, `session.id.written`, `session.reconciled`, `tmux.pane.placed`, `executor.row.written`, `cache.invalidate`, `runbook.triggered`, `consumer.heartbeat`, `emitter.*` meta).

### Vocabulary (v0)

**Span types (7):** `cli.command`, `agent.lifecycle`, `wish.dispatch`, `hook.delivery`, `resume.attempt`, `executor.write`, `mailbox.delivery`.

**Event types (13+meta):** `state_transition`, `error.raised`, `session.id.written`, `session.reconciled`, `tmux.pane.placed`, `executor.row.written`, `cache.invalidate`, `cache.hit`, `runbook.triggered`, `consumer.heartbeat`, `permissions.grant`, `permissions.deny`, `team.create`/`team.disband` (audit), `schema.violation` (meta), `emitter.rejected`/`emitter.queue.depth`/`emitter.latency`/`emitter.shedding_load`/`notify.lag`/`stream.gap.detected`/`correlation.orphan.rate`/`consumer.lagged` (meta).

Each type has a committed Zod schema (`src/lib/events/schemas/<type>.ts`) carrying payload contract + Tier A/B/C field tagging + redaction `.transform()`. Schema evolution: minor = add optional field (schema_version bump patch); major = remove/rename field (bump major, 2 release deprecation). CI enforces: no raw INSERT outside `emit.ts`; no `.passthrough()` or `z.any()`; default new-field tier = A.

### Correlation propagation

Serve mints one opaque signed token per top-level operation (CLI command or hook fire). Token encodes `{trace_id, span_id, parent_span_id, session_id, issued_at, sig}` HMAC-signed with a per-deployment secret. Spawn boundaries propagate through four channels — they are **conjunctive**, not disjunctive:

1. **Env var** `GENIE_TRACE_TOKEN` survives `execFile`/`spawn` calls and hook dispatches.
2. **DB `parent_span_id`** column written on the spawn row so consumers can reconstruct ancestry without parsing preambles.
3. **Prompt preamble** `<genie-trace>token=...</genie-trace>` prepended to Claude child sessions — the child agent reports its own spans back to the stream tagged with the inherited trace.
4. **Structured log line** `trace_id=...` in every log emission for grep-based forensics and external aggregator compat.

Forgery requires breaking the signing key. Client-supplied tokens are validated at emit-site; invalid → emit `schema.violation` with original, drop.

### Storage evolution

```sql
-- Migration N+1 (ADD ONLY, reversible):
ALTER TABLE genie_runtime_events
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS span_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_span_id TEXT,
  ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('debug','info','warn','error','fatal')),
  ADD COLUMN IF NOT EXISTS schema_version TEXT NOT NULL DEFAULT '1.0',
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS dedup_key TEXT,
  ADD COLUMN IF NOT EXISTS source_subsystem TEXT;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_trace ON genie_runtime_events (trace_id, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_parent ON genie_runtime_events (parent_span_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_severity_time ON genie_runtime_events (severity, created_at);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_type_time ON genie_runtime_events (kind, created_at DESC);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_dedup ON genie_runtime_events (dedup_key) WHERE dedup_key IS NOT NULL;

-- Migration N+2 (partition by created_at::date):
-- Convert to PARTITION BY RANGE (created_at), create rolling 30-day partitions,
-- nightly CREATE NEXT PARTITION + DETACH OLDEST + archive-to-parquet.

-- Migration N+3 (sibling tables):
CREATE TABLE genie_runtime_events_debug (LIKE genie_runtime_events INCLUDING ALL);
CREATE TABLE genie_runtime_events_audit (LIKE genie_runtime_events INCLUDING ALL);
REVOKE UPDATE, DELETE ON genie_runtime_events_audit FROM genie_app_role;
-- + HMAC-chain trigger: each row references prior_hash; on insert, compute and store.

-- Migration N+4 (LISTEN channels):
-- Replace single pg_notify('genie_runtime_event') trigger with type-prefixed
-- pg_notify('genie_events.' || split_part(kind,'.',1), id::text) + revoke generic LISTEN for non-admin roles.
```

### Consumer transport

Hybrid LISTEN/NOTIFY + id-cursor:

1. Consumer connects and issues `LISTEN genie_events.<prefix>` per allowed_type prefix.
2. Emitter trigger `NOTIFY genie_events.<prefix>, NEW.id::text` (payload = id only, under 8KB cap).
3. Consumer on NOTIFY wake-up runs `SELECT * FROM genie_runtime_events WHERE id > $last_seen_id AND kind IN ($allowed) ORDER BY id ASC LIMIT 500` (id-cursor authoritative, LISTEN is wake signal only).
4. On disconnect/reconnect, consumer catches up from stored `last_seen_id`.
5. Id skip detected → emit `stream.gap.detected{missing_count}` meta event.

Idle consumer cost: 1 PG connection, zero queries. 100 concurrent consumers = 100 idle backends ≈ 800MB RAM, acceptable on current box (measured 32GB).

### Redaction pipeline

Zod `.transform()` per event type, enforced at emit primitive. Three tiers:

- **Tier A (drop at emit, never written):** raw user prompts, `initialPrompt`, WhatsApp message bodies, wish markdown body text, file contents, env-var values, secret-shaped tokens (`sk-`, `ghp_`, JWTs, connection strings), `claude_session_id`/`leadSessionId`, absolute paths under `/home/*`/`/root/*`.
- **Tier B (HMAC-SHA256 with per-tenant key, operator CLI can reverse):** entity IDs, agent custom names, team names, wish slugs, file paths (emit shape-depth-extension, not literal), stack-trace file paths.
- **Tier C (raw):** event type, numeric durations/counts, enum state transitions, UTC timestamps, schema_version, source_subsystem, severity.

Default tier of new field = A (opt-in emission). CI tests: (a) `grep -r '\.passthrough\|z\.any' src/lib/events/` returns zero, (b) synthetic emit probe with `ANTHROPIC_API_KEY=sk-test-12345` asserts key not in written row.

### Back-pressure policy (D10)

Queue cap 10K events. Overflow by severity:
- `debug` — dropped silently + `emitter.shedding_load` counter event 1/min
- `info` — bounded 50ms wait at emit-site, then drop + `emitter.shedding_load`
- `warn`/`error`/`fatal` — bounded 50ms wait, then spill to disk journal `~/.genie/data/emit-spill.jsonl`, emit `consumer.lagged` audit event + raise `emit-backpressure.critical` to watchdog

### Dead-man's switch

Separate package `@automagik/genie-watchdog` installed as systemd-timer unit on enterprise deployments. Every 60s: `psql -c "SELECT extract(epoch from (now() - max(created_at))) FROM genie_runtime_events;"`. If > 300s → SMS/email escalation channel configured at install. **Must not share code, npm dependencies, or DB connection pool with genie.** This is the Kelsey Hightower rule: the thing watching the watcher depends on nothing the watcher depends on.

### Demonstrable consumer (runbook R1)

V0 ships one reference consumer agent `src/consumers/runbook-r1/` that subscribes to `mailbox.delivery.sent` events and detects the #1192 escalation-recursion pattern — `count(*) WHERE from='scheduler' AND to='team-lead' AND created_at > now() - '10 min' > 50`. Emits `runbook.triggered` event with evidence + recommended mitigation SQL in the payload. Does NOT auto-execute. This is the acid test for the substrate: if R1 can be written cleanly as a consumer reading only raw events, the substrate works.

## Decisions

| Decision | Rationale |
|----------|-----------|
| **Extend `genie_runtime_events`**, not greenfield | Dual-write compat with `audit_events` reader surface; rollback = flag off + npm downgrade, zero data loss; operator's ground truth that two event tables already coexist. |
| **Three primitives** `startSpan`/`endSpan`/`emitEvent` | Tracer's insight that durations and points have different semantics; single primitive collapses them and makes consumer queries awkward. |
| **Four-channel signed-token correlation** | Covers each channel's failure mode: env var lost on re-prompt (prompt preamble catches); preamble lost on non-Claude subprocess (env var catches); DB column missing on failed spawn (log line catches); all three require the token to survive a crash (signed token prevents forgery). |
| **Closed event registry with Zod schemas** | Architect's never-rename rule + schema_version field = consumer queries pinned per version are verifiable forever. CI lint closes the bypass loophole. |
| **LISTEN/NOTIFY + id-cursor**, not polling-only or JSONL-tail | Idle cost drops from 400 queries/sec (100-consumer polling) to zero; id-cursor recovers from NOTIFY backlog overflow without data loss; JSONL-tail creates dual-write crash-consistency nightmare. |
| **4-tier retention** (debug 24h / op 30d / warn+ 90d / audit forever WORM) | Uniform retention kills either signal or disk; audit isolation required for SOC2 export; append-only WORM satisfies tamper-evidence. |
| **`command_success` demotion day 1** | Today 91.7% of stream; deferring this poisons consumer signal-to-noise before v0. |
| **Server-minted correlation tokens**, not client-supplied | Correlation-ID forgery = audit repudiation; server-mint + HMAC sig = attacker must break the key to forge attribution. |
| **Async bounded queue + batched COPY** | 1000× emit-site speedup (5ms → 5µs); 50× commit reduction (700K/day → 14K/day); decouples observability latency from business latency. |
| **Redaction at emit via Zod .transform()**, not consumer-side | Once raw bytes hit JSONB they are durable, replicated, backed up, subpoenable; consumer-side redaction is too late. |
| **Default tier of new field = A (dropped)** | Opt-in emission prevents accidental PII leak via a newly-added field that an emitter author forgot to tag. |
| **Dead-man's switch external and unshared** | The thing watching the watcher must not depend on what it watches; if genie dies + watchdog dies in same failure mode, nobody knows. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| Emitter perf tax on write paths | Low | Async queue + batched COPY; measured 100-1000× PG headroom; emit-site p99 gate <1ms. |
| Stream becomes haystack | Low | `command_success` demoted; Tier-A redaction; `--v2 --explain` surfaces which runbook rule each event contributed to. |
| PII leak in payloads | Medium | Zod `.transform()` redaction; default-tier-A; CI probe test; residual = mis-tagged new field by author. |
| Correlation discipline slips | Low | Server-minted signed token; 4-channel propagation; `correlation.orphan.rate` alerts >1% sustained. |
| v0 ships, nobody reads stream | Medium | Demonstrable runbook-R1 consumer in v0; `felipe-agent` bootstrap reads stream first action; residual = felipe's attention bandwidth. |
| Compromised experimental consumer → full exfil | High | RBAC + signed token with `allowed_types` allowlist; subscriber role can't read audit tier, can't un-hash Tier B. |
| Schema-bomb DoS | Medium | 64KB payload cap post-redaction; overflow → blob w/ content hash; `.safeParse()` never throws. |
| Audit trail forgery | Medium | Server-minted correlation + audit-tier INSERT-only DB role + HMAC chain tamper-evidence. |
| LISTEN backlog silent-drop | Medium | Id-cursor catch-up; `stream.gap.detected` on skip; `consumer.lagged` audit event on disconnect. |
| Dual-write divergence during transition | Medium | Both writes in single txn (atomic); `genie events migrate --audit --dry-run` surfaces rows present in one but not the other. |
| Cold npm migration at 3am | High | 5-phase rollout, ADD-only migration, flag off at release tag, flip requires 14d green on 6 watcher metrics, rollback = `npm i @automagik/genie@<prior>` with zero data loss. |

## Success Criteria

- [ ] 6 rot patterns + 5 dispatch bugs from umbrella DRAFT are reconstructable via SQL alone — specific queries in operator §2 pass against synthetic replay dataset.
- [ ] v0 vocabulary covers: 7 span types + 13 event types + 8 meta events, each with committed Zod schema + Tier A/B/C tagging.
- [ ] `genie events stream --follow` runs with 100 concurrent consumers, end-to-end p99 <50ms @ 100 ev/s, emit-site p99 <1ms, zero emitter back-pressure on business-transaction hot paths.
- [ ] Every event carries trace_id + span_id + parent_span_id; `genie events timeline <trace_id>` renders full causal tree (CLI → serve → spawned agent → hook → sub-agent) in <4s.
- [ ] Zod `.safeParse()` at emit primitive; schema violations emit `schema.violation` meta and drop payload — never silently swallowed, never throw out of business transaction.
- [ ] `command_success` demoted to `_debug` table 24h TTL; main-table signal density ≥90%.
- [ ] Runbook R1 reference consumer (escalation-recursion detector) ships in v0 `src/consumers/runbook-r1/`, detects synthetic #1192 replay, emits `runbook.triggered`.
- [ ] Enterprise hardening H1-H10 all shipped and gated by pen-test.
- [ ] Perf gates pass: emit-site p99 <1ms, end-to-end <50ms @ 100 ev/s, partition rotation <500ms on 5M rows, Zod <5% of one core @ 100 ev/s, 100-consumer no-slowdown, PG backend count <150.
- [ ] Dead-man's switch systemd-timer package ships separately; probe alerts within 5 min of stream going dark.
- [ ] Pen-test red-team exercise: forge event (fails), exfil env var (Tier-A drops), schema-bomb DoS (64KB cap blocks), LISTEN channel bomb (ACL blocks) — all four must fail before v0 merge.
- [ ] Zero-downtime rollout: feature flag off at release tag, flip default requires 14d green on all 6 watcher metrics, rollback = `npm i @automagik/genie@<prior>` with zero data loss.

## Appendix — Council provenance

Council reports consulted (all at `/tmp/council/`):
- `architect.md` — D2 extend-not-greenfield refined; closed registry rule; 7 concrete module boundaries.
- `measurer.md` — cardinality math; column promotions; materialized views `genie_events_red_1m`/`dedup_pressure_5m`.
- `tracer.md` — D6 three primitives; D9 spans + state_transition vocabulary; 4-channel propagation insight.
- `operator.md` — 5-phase rollout; three 3am walkthroughs against PR #1192/#1209/#1178; dead-man's switch as release-blocker; 5 runbook rules.
- `benchmarker.md` — measured baseline; LISTEN/NOTIFY+cursor recommendation with numbers; Zod budget; batched COPY; 6 anti-patterns.
- `sentinel.md` — T1–T5 threat model; Tier A/B/C redaction; H1-H10 non-negotiables; evidence of current leakage in last week's PRs (§5).

Umbrella rot evidence: `.genie/brainstorms/genie-self-healing-observability/DRAFT.md` (6 patterns + 5 dispatch bugs).
PR evidence base: `/tmp/genie-prs-last-week.md`.
