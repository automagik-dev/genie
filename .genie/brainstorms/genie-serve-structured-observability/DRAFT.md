# Brainstorm Draft: genie-serve-structured-observability

| Field | Value |
|-------|-------|
| **Slug** | `genie-serve-structured-observability` |
| **Date** | 2026-04-19 |
| **Status** | CRYSTALLIZED — WRS 100/100, see DESIGN.md |
| **Parent** | `genie-self-healing-observability` (umbrella, sub-project A) |
| **WRS** | 100/100 |

## Felipe's extended vision (verbatim, 2026-04-19)

> "A observability first, the rest will improve from the data. We deliver v0 improvements to unlock whats broken, and improve with data, always."
>
> "That event stream should tell you WHAT needs improvement and HOW, from slow operations, to stalled tasks, unlinked shit, ghost agents, loops, retries, etc... everything that provides info, from real genie usage, how to improve itself."
>
> "I wont ever have to report bugs, you will self improve from seeing what went wrong already."

> "A ideia inicial é ter uma central de eventos, no loops, no prs. I will spawn schedule genie agents to read the stream and act, trying different strategies before we hammer what works. We will write the software for us having a way to consume the serve events agentically using the cli in a non blocking way, same as other commands genie already has. We dont need any filter — our most important mission is to REGISTER ALL EVENT TYPES, like we would wire to use sentry, but instead of using sentry, we have our own event stream, because we want to have agents drink from the river directly."

> "we sold more than we're currently deliverying, so we need to catch up FAST, centralizing observability about genie itself, will lead to solving bugs faster, with agentic loops instead of human reports... I need thinking brains, to make this, THE BEST POSSIBLE WAY. MAKE IT ENTERPRISE, NOW."

## Problem (single sentence)

Genie has no structured, correlated, auto-diagnostic event stream — so bugs accumulate silently, Felipe is forced into the role of manual bug reporter, customers on v4.260418+ hit incidents like PR #1192 (escalation recursion that ran 181K events over 8 days undetected), and the system cannot propose its own improvements from its own runtime behavior.

## Goal

A **Sentry-grade enterprise event substrate** for genie's own runtime: every write, read, cache op, spawn lifecycle event, cross-subsystem handoff emits a typed, structured, redacted, trace-correlated record. No emit-site categorization. No auto-action at emit. No loops. No PRs. Zero downtime rollout.

The substrate is the product. Felipe (or scheduled genie agents he spawns) consume the raw stream via a non-blocking CLI, each trying different strategies to derive pathology patterns, before any convergence on "the" self-healing logic.

Design principle: **agents drink from the river directly.** Emitters emit cheap + wide + redacted. Consumers categorize, correlate, and decide.

Enterprise principle: **tenants must be able to deploy this without a secondary breach surface.** Redaction at emit, not at consumer. RBAC + signed tokens at subscribe. WORM audit tier isolated from debug noise. Dead-man's switch external to genie.

## Scope

### IN
- **Wide, typed emission across the genie runtime** — every write, every read that crosses a subsystem boundary, every cache op, every spawn/kill/resume, every hook dispatch, every wish/group/task state transition, every team-lead wake, every dispatch parse. Sentry-style "instrument everything worth naming."
- **Structured event shape** (typed, not free-text): `type`, `actor`, `entity`, `subject`, `severity` (first-class column), `trace_id`, `span_id`, `parent_span_id`, `schema_version`, `payload` (JSONB, Zod-validated, redacted per-field tier), `source_subsystem`, `timestamp`, `duration_ms` (for spans).
- **Three primitives, not one.** `startSpan(name, ctx) -> SpanHandle`, `endSpan(handle, outcome)`, `emitEvent(type, payload, ctx)` — spans cover durations, events cover points inside spans. Single file `src/lib/emit.ts`, imported by every subsystem.
- **Four-channel correlation propagation.** Server-minted opaque signed tokens carry `{trace_id, span_id, parent_span_id, session_id}`. Channels: (a) env var `GENIE_TRACE_TOKEN`, (b) DB `parent_span_id` column on every spawn/executor row, (c) prompt-injected `<genie-trace>token=...</genie-trace>` preamble in every Claude child session, (d) structured log line. All four, because each covers the other's failure mode. Forgery requires breaking the signing key (sentinel H4).
- **Async bounded queue + batched COPY.** Emit-site returns in ~5µs (queue push). Background flusher drains to PG in batches of 500 rows or every 100ms. Emit-site never blocks a business transaction.
- **Consumer CLI that is non-blocking.** `genie events stream --follow` (LISTEN/NOTIFY wake + cursor read), `genie events timeline <trace_id>` (causal tree view), `genie events list --v2 --since 5m` (opt-in wide output). Same ergonomics as today's `genie events list`.
- **Dual-write rollout.** Feature flag `GENIE_WIDE_EMIT` gates the enriched path. Both `audit_events` (legacy reader surface) AND enriched `genie_runtime_events` populated during transition. Flip default only after 14d green on all 6 watcher metrics.
- **Redaction pipeline at emit.** Zod `.transform()` per event type with Tier A (drop)/B (hash/tokenize)/C (raw) per field. Default tier of new field = A. CI fails build on `.passthrough()` / `z.any()` / direct INSERT into events tables.
- **4-tier retention** (debug 24h / operational 30d / warn+error 90d / audit forever WORM HMAC-chained). Daily partition rotation via `DETACH PARTITION`, O(1), never blocks writes.
- **RBAC + signed subscription tokens.** `events:admin`/`operator`/`subscriber`/`audit` roles. Short-lived (1h) JWTs minted by serve, declare `allowed_types`. PG row-level security + channel-namespaced LISTEN ACL so app-layer bypass fails closed.
- **Dead-man's switch.** External systemd timer, separate repo/package, no shared code or DB pool with genie. Polls `SELECT max(created_at) FROM genie_runtime_events` every 60s, alerts if newest > 5 min old.
- **6 watcher-of-watcher metrics.** emit.rejected, emit.queue.depth, emit.latency_p99, notify.delivery.lag, stream.gap.detected (id skip), correlation.orphan.rate. All emitted back into the same stream (dogfood).
- **Acid test:** the 6 rot patterns + 5 dispatch bugs documented in umbrella DRAFT are retroactively reconstructable from raw events via SQL queries alone — no tmux grep, no log archaeology.

### OUT
- **Pathology categories as event TYPES** — slow/stalled/ghost/loop/retry/drift are patterns *consumers derive*, not primitives the emitter knows about. Emitter sees `agent.lifecycle` span with `state_transition` events; consumer sees "this span never ended within 30s → ghost".
- **`suggestedImprovement` field, free-text or structured** — violates the "emitters don't opine" rule.
- **Any auto-action from the emitter** — no auto-PRs, no auto-issues, no serve-internal loop that reacts to its own events. Sub-project B territory.
- **Filters at emit-site** — emitter registers everything, consumer filters.
- **DB constraints preventing ghost creation** — sub-project D.
- **Parser / dispatch refactor** — sub-project C.
- **Observing external services** (omni NATS, Claude API, tmux internals) — start with genie's own process state.
- **Redesigning PG schema from scratch** — extend `genie_runtime_events` with ADD COLUMN + companion tables. Never rename, never drop.
- **Full OpenTelemetry / Prometheus rollout** — adopt OTEL vocabulary (trace_id, span_id, parent_span_id) but stay inside `genie events`.
- **UI / dashboard** — CLI-first, tailable stream only.
- **Multi-tenancy as deployed feature** — RLS columns and ACLs exist day 1, but single-tenant is the v0 target.
- **Pre-v0 backfill of historical `audit_events` into enriched shape** beyond the 7-day migration helper window.

## Decisions

| # | Decision | Status | Resolution | Rationale |
|---|----------|--------|------------|-----------|
| D1 | Consumer identity | **RESOLVED** | N scheduled genie agents spawned by Felipe, racing strategies | Substrate over convergence; "agents drink from the river directly." |
| D2 | Emit layer: extend `genie_runtime_events` or greenfield? | **RESOLVED** | Extend existing table (ADD COLUMN for trace_id/span_id/parent_span_id/severity/schema_version/duration_ms), add sibling `genie_runtime_events_debug` for command_success noise + `genie_runtime_events_audit` append-only WORM for audit tier. Partition by day. | Operator surfaced ground truth: two tables already exist (`audit_events` legacy + `genie_runtime_events` enriched with pg_notify). Extending preserves existing consumers, enables dual-write, rollback = flag off + reinstall prior binary. Greenfield was architect's preference but violated zero-downtime rollout. |
| D3 | Correlation-id propagation mechanics | **RESOLVED** | Server-minted signed token carrying {trace_id, span_id, parent_span_id, session_id}. Propagates via 4 channels simultaneously: env var, DB parent_span_id column, prompt-injected `<genie-trace>` preamble (signed token, not raw IDs), structured log key. | Tracer: prompt-injection is highest-leverage for Claude child agents to self-report. Operator: prompt-injection is lossy on re-prompts. Sentinel: must be server-minted or audit trail is forgeable. All three satisfied by signed token multiplexed across 4 channels — any one failure doesn't orphan the chain; forgery requires breaking the signing key. |
| D4 | Retention policy | **RESOLVED** | 4-tier: debug 24h (`_debug` table truncatable), operational 30d (partitioned daily), warn/error 90d, audit forever (append-only WORM HMAC-chained, INSERT-only DB role). Native PG partitioning, never DELETE scans. | Convergent across benchmarker + operator + sentinel. Uniform retention kills either signal (if short) or disk (if long). Audit tier isolation required for SOC2 export. |
| D5 | Detection location (emit-site vs observer) | **RESOLVED** | Observer-side. | Emit-site registers typed raw events only. Pathology derivation is consumer responsibility. |
| D6 | Volume control / noise demotion | **RESOLVED** | `command_success` demoted to `genie_runtime_events_debug` table with 24h TTL in the SAME PR that introduces the `severity` column. Sample 1/100 retained in main table for stats. | Today 91.7% of stream is this one event type (1,437/1,571 in 24h dump). Deferring this poisons any consumer signal-to-noise before v0. Operator demanded day-one. |
| D7 | Non-blocking CLI consumer shape | **RESOLVED** | `LISTEN/NOTIFY` (PG trigger `pg_notify('genie_events.<type_prefix>', id::text)`) for wake + `SELECT WHERE id > last_seen_id ORDER BY id LIMIT N` cursor for read. Channel-namespaced so PG-level ACL restricts by role (sentinel). Payload = id only, under 8KB cap. | Benchmarker: idle cost = 1 PG connection vs 400 wasted polling queries/sec at N=100 consumers. Architect agreed. Sentinel's channel-namespacing makes RBAC fail-closed at DB layer. |
| D8 | Emission library surface | **RESOLVED** | `src/lib/emit.ts` exposing three primitives: `startSpan(name, ctx)`, `endSpan(handle, outcome)`, `emitEvent(type, payload, ctx)`. Zod registry `src/lib/events/registry.ts` co-located, keyed by type, carries payload schema + redaction `.transform()` + tier classification. Bounded async queue + batched COPY flusher. CI lint rule: no direct `INSERT INTO genie_runtime_events*` outside `emit.ts`. | Tracer: one primitive collapses spans-vs-events; three primitives model both. Architect: closed registry + never-rename rule prevents consumer ontology breakage. Benchmarker: async queue drops emit-site from ~5ms to ~5µs (1000×). Sentinel: single file = single audit chokepoint for redaction. |
| D9 | Vocabulary granularity | **RESOLVED** | **Spans** (wide, durational): `cli.command`, `agent.lifecycle`, `wish.dispatch`, `hook.delivery`, `resume.attempt`, `executor.write`, `mailbox.delivery`. **Events inside spans** (point-in-time): `state_transition`, `error.raised`, `session.id.written`, `session.reconciled`, `tmux.pane.placed`, `executor.row.written`, `cache.invalidate`, `runbook.triggered`, `consumer.heartbeat`, `emitter.*` meta. Every type has a Zod payload contract committed with the vocabulary (not just type names). | Tracer rejected flat `.start/.ready/.error` as Prometheus trap; Measurer's cardinality math holds on the span-based shape. Operator demanded payload contracts — without them cross-type joins collapse and the acid test fails. |
| D10 | Back-pressure policy | **RESOLVED** | Queue cap 10K events in-memory. Overflow: debug-severity dropped silently with a counter event `emitter.shedding_load` (emitted 1/min). Info/warn/error **never dropped** — emit-site blocks up to 50ms bounded wait, then spills to disk journal `~/.genie/data/emit-spill.jsonl`, then emits `consumer.lagged` audit event and raises `emit-backpressure.critical`. | Benchmarker: sync emit = DoS vector. Sentinel H8: silent drops = silent blind spots. Synthesis: tier-aware back-pressure satisfies both — debug drops, audit never. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| R1 | Emitter adds perf tax to every write path | Medium→Low | Async bounded queue drops emit-site cost to ~5µs; batched COPY on flusher; measured baseline tonight shows 100-1000× PG headroom. |
| R2 | Stream becomes new haystack — so noisy nothing gets read | High→Low | `command_success` demoted day 1; Tier-A redaction drops stack absolute paths and env values; `--v2` reader with `--explain` mode shows which runbook rule each event contributed to. |
| R3 | PII / secrets leak in `before/after` payloads | High→Medium | Zod redaction `.transform()` at emit primitive; default tier of new field = A (dropped); CI test asserts `ANTHROPIC_API_KEY=sk-test-12345` probe does not land in written row. Residual risk: new emit sites whose authors mistag a field as Tier C. |
| R4 | Correlation-id discipline slips and stream becomes useless | High→Low | Server-minted signed token = forgery requires breaking key; token threaded across 4 channels — any one channel failure still reconstructs trace. `correlation.orphan.rate` metric alerts when `parent_span_id` has no matching row within 60s at >1% sustained. |
| R5 | v0 ships and nobody reads the stream → lost effort | High→Medium | Demonstrable consumer prototype shipped IN v0 (runbook rule R1 implementation for #1192 escalation recursion) as acid-test gate; felipe-agent bootstrap reads stream first action every session. Residual: felipe's attention bandwidth. |
| R6 | Compromised experimental consumer = full environment exfil | Critical | Sentinel H3 RBAC: subscribers get `allowed_types` allowlist on signed short-lived token; subscribers can't read audit tier, can't un-hash Tier B identifiers. Compromise scope bounded to what consumer declared it wanted. |
| R7 | Schema-bomb DoS via attacker-controlled payloads | Medium | Sentinel H5: 64KB hard cap post-redaction; oversize → emit stub with content hash, blob stored separately with TTL; Zod `.safeParse()` (not `.parse()`) never throws out of emit path. |
| R8 | Audit trail forged by authenticated-but-malicious actor | High | Server-minted signed tokens (D3) + audit tier on append-only table with INSERT-only DB role (Sentinel H7); HMAC chain across audit rows detects tampering at export time. |
| R9 | LISTEN/NOTIFY backlog overflow silently drops events | Medium | Id-cursor fallback (D7) means consumer catches up from `last_seen_id` even if NOTIFY missed; `stream.gap.detected` metric fires on any id skip; `consumer.lagged` emitted as audit event on disconnect. |
| R10 | Two-table dual-write (`audit_events` + `genie_runtime_events`) diverges during migration | Medium | Dual-write wrapped in single DB transaction so both commit atomically or neither; `genie events migrate --audit --dry-run` helper surfaces rows present in one but not the other. |
| R11 | Enterprise npm customer hits cold `npx` migration at 3am mid-incident | High | Operator-enforced 5-phase rollout: ADD-only migration, feature flag off by default at release tag, flip default requires 14d green on 6 watcher metrics; rollback = `npm i @automagik/genie@<prior>` with zero data loss. |

**Assumptions:**
- PG 16+ available (native partitioning + BRIN indexes + `pg_notify` 8KB cap).
- Node/Bun runtime supports Zod 3.x + `p-queue` or equivalent bounded async queue.
- Single-tenant v0 (RLS columns + ACLs exist but only one tenant value populated).
- `felipe-agent`/scheduled consumer agents are trusted enough to hold `events:subscriber` tokens without additional sandboxing beyond the existing Claude agent model. Any agent with higher privilege needs `events:operator` + explicit audit-log of un-hash actions.

## Success criteria

- [x] Every one of the 6 rot patterns + 5 dispatch bugs documented 2026-04-19 is *retroactively reconstructable* from raw events via SQL queries alone — operator §2 provided working SQL for #1192, #1209, #1178. Sub-criteria in DESIGN.md.
- [x] v0 emission covers at minimum: team create/disband (audit), agent spawn lifecycle span + state_transition events + boot-ready, wish/group/task state transitions, hook dispatch (with payload hash), team-lead wakeup, cache invalidation, dispatch parse, error.raised with stack_hash, tmux.pane.placed, session.reconciled, executor.row.written with before/after, mailbox.delivery, consumer.heartbeat, 6× emitter.* meta events.
- [x] `genie events stream --follow` returns live structured events, non-blocking, 100 concurrent consumers supported, end-to-end p99 <50ms at 100 ev/s sustained, zero emitter back-pressure on the hot path.
- [x] Every event carries `trace_id` + `span_id` + `parent_span_id` sufficient for consumer-side trace reconstruction across CLI → serve → spawned-agent → hook → sub-agent.
- [x] Schema is Zod-validated at emit-site with `.safeParse()`; validation failures emit `schema.violation` meta event and drop the original — never silently swallowed, never throws out of the business transaction.
- [x] Legacy 80ms `command_success` noise demoted to sibling `_debug` table 24h TTL, with 1/100 sample retained in main table. Signal density rises from 8% to 90%.
- [x] One experimental consumer-agent prototype ships in v0: runbook rule R1 implementation (escalation recursion from #1192) — detects from raw events, emits `runbook.triggered`, recommends (but does not auto-execute) the mitigation SQL.
- [x] **Enterprise hardening H1-H10** all shipped: (H1) redaction pipeline, (H2) 3-tier retention + audit WORM, (H3) RBAC + signed tokens + RLS, (H4) server-minted correlation IDs, (H5) 64KB payload cap + overflow blob, (H6) audit-the-auditors (un-hash / export emits own audit event), (H7) append-only audit via INSERT-only DB role, (H8) fail-closed on consumer lag, (H9) IR playbook commands (`genie events revoke-subscriber`, `rotate-redaction-keys`, `export-audit --signed`), (H10) pen-test gate before v0 merge.
- [x] **Perf gates:** emit-site p99 <1ms; end-to-end <50ms @ 100 ev/s; partition rotation <500ms on 5M-row table; Zod <5% of one core @ 100 ev/s; 100 `genie events stream --follow` consumers = zero emit slowdown, PG backend count <150.
- [x] **Dead-man's switch** ships in same PR as emission layer, as external systemd timer, separate repo/package, no shared code or DB pool.
- [x] **3am test:** `genie events timeline $(genie events trace --entity <incident-agent>)` renders causal tree in <4 seconds without human pattern-match required.

## Open questions (resolved/queued)

**Q1 — RESOLVED.** Consumer identity = N racing experimental agents (not single convergent consumer).
**Q2 — RESOLVED.** Vocabulary granularity = spans + state_transition events inside; payload contracts committed with vocabulary.
**Q3 — RESOLVED.** Extend `genie_runtime_events` + sibling `_debug` + `_audit` tables (D2).
**Q4 — RESOLVED.** 4-channel server-minted signed token (D3).
**Q5 — RESOLVED.** 4-tier retention (D4).
**Q6 — RESOLVED.** LISTEN/NOTIFY + cursor fallback (D7).
**Q7 — RESOLVED.** Three primitives `src/lib/emit.ts` + registry (D8).
**Q8 — ENGINEERING-DEFER:** exact Zod payload contract per event type — deliverable in G2 of the wish, not blocking DESIGN.
**Q9 — ENGINEERING-DEFER:** `--append-system-prompt-file` redaction strategy for prompt content in `agent.spawn` events — deliverable in G2 redaction pipeline.

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

All 10 decisions resolved. 11 risks identified with council-validated mitigations (R1-R11). Criteria include retroactive reconstruction SQL proofs, enterprise hardening H1-H10, perf gates, and the 3am test. Scope IN/OUT locked. Problem statement sharpened by customer incident evidence.

## Crystallization receipts

Council reports: `/tmp/council/architect.md`, `measurer.md`, `tracer.md`, `operator.md`, `benchmarker.md`, `sentinel.md`.
PR evidence: `/tmp/genie-prs-last-week.md`.
Current PG baseline: `/tmp/events-1h.json`, `/tmp/events-24h-full.json`.
Next: `DESIGN.md` crystallized, then WISH.md written, `/review` auto-invoked.
