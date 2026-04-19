# Wish: Genie Serve Structured Observability

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `genie-serve-structured-observability` |
| **Date** | 2026-04-19 |
| **Design** | [DESIGN.md](../../brainstorms/genie-serve-structured-observability/DESIGN.md) |
| **Umbrella** | `genie-self-healing-observability` (sub-project A) |
| **Target repo** | `automagik-dev/genie` (`~/workspace/agents/genie-configure/repos/genie/`) |

## Summary

Ship a Sentry-grade enterprise event substrate for genie's own runtime — typed, Zod-validated, redacted, trace-correlated emission from every subsystem into a partitioned PG store with LISTEN/NOTIFY+cursor consumer transport, RBAC-gated signed subscription tokens, a 4-tier retention policy including a WORM audit tier, an external dead-man's switch, and a demonstrable runbook-R1 consumer that detects the #1192 escalation-recursion pattern from raw events alone. Rollout is zero-downtime (feature flag `GENIE_WIDE_EMIT`, dual-write to `audit_events` + enriched `genie_runtime_events` for 14 days minimum, flip default only after all 6 watcher-of-watcher metrics green). V0 merge is gated by a pen-test red-team exercise covering forge/exfil/schema-bomb/LISTEN-bomb.

## Scope

### IN
- PG schema evolution of `genie_runtime_events` (ADD columns, daily partitioning, sibling `_debug` + `_audit` tables) with never-rename/never-drop discipline.
- `src/lib/emit.ts` emission primitive: three functions (`startSpan`, `endSpan`, `emitEvent`), bounded async queue, batched COPY flusher, dedup key.
- Closed event registry `src/lib/events/registry.ts` with per-type Zod schemas, Tier A/B/C field-level redaction `.transform()`, `schema_version`.
- Instrumentation of 7 span types + 13 event types at every genie write/read/boundary identified in Phase 0 audit.
- Four-channel signed-token correlation: env var `GENIE_TRACE_TOKEN`, DB `parent_span_id`, prompt-injected `<genie-trace>` preamble, structured log key.
- Consumer CLI: `genie events stream --follow`, `genie events timeline <trace_id>`, `genie events list --v2 --since <dur>`, `genie events migrate --audit`.
- LISTEN/NOTIFY channel-namespaced (`genie_events.<prefix>`) with PG RLS + role-scoped LISTEN ACL.
- RBAC with four roles (`events:admin`/`operator`/`subscriber`/`audit`), signed short-lived JWT subscription tokens, IR commands (`revoke-subscriber`, `rotate-redaction-keys`, `export-audit --signed`).
- Audit tier on append-only INSERT-only DB role with HMAC chain tamper-evidence.
- External `@automagik/genie-watchdog` npm package with systemd-timer unit for dead-man's switch — no shared code or DB pool with genie.
- Six watcher-of-watcher meta events (`emit.rejected`, `emit.queue.depth`, `emit.latency_p99`, `notify.delivery.lag`, `stream.gap.detected`, `correlation.orphan.rate`).
- Back-pressure policy: debug silent-drop, info bounded-wait-then-drop, warn/error/fatal bounded-wait-then-disk-spill.
- Runbook-R1 reference consumer at `src/consumers/runbook-r1/` implementing #1192 escalation-recursion detection from raw events.
- CI enforcement: no raw INSERT outside `emit.ts`, no `.passthrough()`/`z.any()` in event schemas, synthetic secret-probe test, perf regression gate.
- Pen-test red-team suite at `test/pentest/observability/` covering forge/exfil/schema-bomb/LISTEN-bomb — must pass before v0 merge.
- Dual-write feature flag `GENIE_WIDE_EMIT` with 5-phase rollout plan documented in `docs/observability-rollout.md`.

### OUT
- Pathology category names encoded as event types (ghost/stale/loop as `.type`).
- Auto-PR generation, auto-`doctor --fix` loops, auto-issue creation.
- Filtering at emit-site (consumers filter; emitter emits everything typed).
- DB UNIQUE constraints preventing duplicate anchors (sub-project D).
- Wish-parser refactor (sub-project C).
- External-service observability (omni NATS, Claude API internals, tmux).
- UI / dashboard (CLI-first v0).
- Multi-tenancy as a deployed feature (RLS columns populated, but only one tenant value).
- Pre-v0 backfill of historical `audit_events` into enriched shape beyond 7-day migration helper window.
- Dropping the `audit_events` table or renaming columns (future wish after 90d of green).

## Decisions

| Decision | Rationale |
|----------|-----------|
| Extend `genie_runtime_events` with ADD COLUMN, keep `audit_events` dual-written as legacy reader surface | Zero-downtime rollback; operator ground truth of two-table coexistence. |
| Three primitives (`startSpan`/`endSpan`/`emitEvent`), not one | Tracer council: durations and point events have different semantics; single primitive makes consumer queries awkward. |
| Server-minted signed correlation tokens propagated across 4 channels | Forgery requires breaking signing key; each channel covers another's failure mode. |
| Closed event registry + Zod schemas co-located + `schema_version` per type | Consumer queries pinned per version remain verifiable forever; CI lint closes the raw-INSERT bypass. |
| LISTEN/NOTIFY (wake) + id-cursor (authoritative read) | Idle cost = 1 PG connection; cursor recovers from NOTIFY backlog overflow without data loss. |
| 4-tier retention with WORM audit table | Uniform retention kills either signal or disk; audit isolation required for SOC2. |
| `command_success` demoted day 1 | 91.7% of current stream; deferring poisons consumer signal-to-noise before v0. |
| Redaction at emit via Zod `.transform()` with default-tier-A on new fields | Consumer-side redaction is too late once bytes hit JSONB; default-A prevents accidental author leak. |
| External dead-man's switch in separate package, no shared pool | Thing watching the watcher must not depend on what it watches. |
| Pen-test red-team gate before v0 merge | "We'll add security later" = un-redacted retrofit on 90 days of JSONB is a data-deletion incident, not a refactor. |

## Success Criteria

- [ ] PG migration runs cleanly on v4.260418+ enterprise installs with zero downtime; rollback via binary downgrade leaves no orphan columns blocking re-apply.
- [ ] `src/lib/emit.ts` exports three primitives; `grep -r 'INSERT INTO genie_runtime_events' src/ | grep -v src/lib/emit.ts` returns zero rows.
- [ ] All 7 span types and 13 event types have committed Zod schemas in `src/lib/events/schemas/` with Tier A/B/C field tagging.
- [ ] `GENIE_TRACE_TOKEN` env var propagates through `spawn`/`execFile`/hook dispatch; DB `parent_span_id` column populated on every child spawn row; `<genie-trace>` preamble present in Claude child prompts; log lines include `trace_id=` key.
- [ ] `genie events stream --follow` returns live events to 100 concurrent consumers with end-to-end p99 <50ms at 100 ev/s sustained; idle consumer burns zero queries.
- [ ] `genie events timeline <trace_id>` renders causal tree for CLI→serve→spawned-agent→hook→sub-agent in <4s.
- [ ] `command_success` events land in `genie_runtime_events_debug` with 24h TTL; 1/100 sample in main table; main-table signal density ≥90% measured after 24h dogfood.
- [ ] RBAC tokens signed, short-lived (1h), carry `allowed_types`; PG RLS + channel-namespaced LISTEN ACL enforced at DB layer (verified by test connecting with each role).
- [ ] Audit tier rows inserted via INSERT-only DB role; HMAC chain validated by `genie events export-audit --signed` tamper-evidence check.
- [ ] External `@automagik/genie-watchdog` installs as systemd-timer unit; probe fires alert within 5 min of stream going dark.
- [ ] Six watcher-of-watcher meta events emit at the documented cadences; dashboards show them non-null for 24h.
- [ ] Back-pressure policy: debug drops silently + counter event; warn/error spill to `~/.genie/data/emit-spill.jsonl` + `consumer.lagged` audit event.
- [ ] Runbook-R1 reference consumer detects synthetic #1192 replay; emits `runbook.triggered` with evidence + mitigation SQL payload; does NOT auto-execute.
- [ ] Pen-test suite at `test/pentest/observability/` passes all 4 scenarios: event forgery fails (signed token), env-var exfil fails (Tier-A redaction), schema-bomb DoS fails (64KB cap), LISTEN channel ACL bomb fails (role scoped).
- [ ] Perf gates: emit-site p99 <1ms; end-to-end <50ms @ 100 ev/s; partition rotation <500ms on 5M-row table; Zod <5% of one core @ 100 ev/s; 100-consumer no slowdown; PG backend count <150.
- [ ] Retroactive reconstruction SQL queries at `docs/observability-acid-tests.sql` pass for all 6 rot patterns + 5 dispatch bugs from umbrella DRAFT against synthetic replay dataset.
- [ ] `docs/observability-rollout.md` published with 5-phase rollout plan, rollback procedure, and watchdog install guide.
- [ ] Feature flag `GENIE_WIDE_EMIT` defaults OFF at release tag; flip-to-default PR requires 14d green on all 6 watcher metrics as CI evidence.

## Execution Strategy

### Wave 1 (parallel — foundation)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Schema evolution: ADD COLUMNS + partitioning + sibling tables + channel-namespaced triggers + feature flag |
| 2 | engineer | Emit primitive: `src/lib/emit.ts` + Zod registry + async queue + batched COPY + redaction pipeline + CI lint |

### Wave 2 (parallel — instrumentation + consumer, after Wave 1)

| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Wire 7 span types + 13 event types + 4-channel correlation propagation + command_success demotion |
| 4 | engineer | Consumer CLI: `genie events stream --follow`, `timeline`, `list --v2`, `migrate --audit` with LISTEN/NOTIFY + cursor |

### Wave 3 (parallel — hardening, after Wave 2)

| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | RBAC + signed tokens + PG RLS + channel ACL + audit-tier WORM + IR commands |
| 6 | engineer | External `@automagik/genie-watchdog` package + 6 watcher meta events + back-pressure + spill journal |

### Wave 4 (sequential — gates)

| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Runbook-R1 reference consumer + retroactive-reconstruction SQL suite for 6 rot + 5 dispatch |
| 8 | engineer | Pen-test red-team suite + perf regression gate + rollout docs + flip-default PR |
| review | reviewer | Final review against all acceptance criteria + SHIP/FIX-FIRST verdict |

## Execution Groups

### Group 1: Schema Evolution + Feature Flag

**Goal:** Extend PG schema with OTEL-correlation columns, sibling tables, daily partitioning, and channel-namespaced LISTEN triggers without breaking any current `genie events` reader.

**Deliverables:**
1. Migration `011_runtime_events_otel_columns.sql` — `ALTER TABLE genie_runtime_events ADD COLUMN IF NOT EXISTS` for `trace_id`, `span_id`, `parent_span_id`, `severity`, `schema_version`, `duration_ms`, `dedup_key`, `source_subsystem`; CHECK constraint on severity; 5 new indexes via `CONCURRENTLY`.
2. Migration `012_runtime_events_partition.sql` — convert to `PARTITION BY RANGE (created_at)`, create 30 rolling daily partitions, nightly cron creates next-day partition + detaches oldest.
3. Migration `013_runtime_events_siblings.sql` — `CREATE TABLE genie_runtime_events_debug` (24h TTL truncatable) + `genie_runtime_events_audit` (append-only, REVOKE UPDATE/DELETE, HMAC-chain trigger).
4. Migration `014_listen_channel_split.sql` — drop single-channel `pg_notify` trigger; replace with per-prefix `pg_notify('genie_events.' || split_part(kind,'.',1), id::text)`; grant LISTEN per-channel by PG role.
5. Phase 0 audit doc `docs/EVENT-EMITTERS-INVENTORY.md` — `rg "audit_events\\b|genie_runtime_events"` inventory.
6. Feature flag scaffold: `GENIE_WIDE_EMIT` env check in bootstrap, documented in `docs/observability-rollout.md` (phase 0 only; content fills in G8).

**Acceptance Criteria:**
- [ ] `bun test src/db/migrations/` passes; each migration is idempotent (`IF NOT EXISTS`, `DO NOTHING` on reapply).
- [ ] `genie events list --since 5m` output shape unchanged (no new columns bleed into legacy reader).
- [ ] `genie doctor` reports partition health (count of daily partitions, next rotation timestamp).
- [ ] `SELECT pg_size_pretty(pg_total_relation_size('genie_runtime_events'))` reports <500MB on 3.5M-row synthetic dataset.
- [ ] Rolling back to prior binary does not error on missing columns (backward-compat verified via `npm i @automagik/genie@4.260418 && genie events list`).
- [ ] Phase 0 inventory doc lists every call site that writes to either events table today.

**Validation:**
```bash
bun test src/db/migrations/ && bun run check && genie doctor --observability --json | jq -e '.partition_health == "ok"'
```

**depends-on:** none

---

### Group 2: Emit Primitive + Zod Registry + Redaction

**Goal:** Single emission library `src/lib/emit.ts` exposing `startSpan`/`endSpan`/`emitEvent`, routed through a bounded async queue + batched COPY flusher, with a closed Zod-validated event registry carrying Tier A/B/C field-level redaction.

**Deliverables:**
1. `src/lib/emit.ts` — three exported primitives; internal `queue` with cap 10K, `flusher` running every 100ms or 500-row batches via PG `COPY ... FROM STDIN`; fire-and-forget return on emit call.
2. `src/lib/events/registry.ts` — closed registry exporting `EventRegistry = { [type]: { schema, tier_defaults, schema_version } }`.
3. `src/lib/events/schemas/` — one file per event/span type with Zod schema, `.transform()` redactor, Tier A/B/C field tagging. For Group 2 only: scaffold files for 20 types, 5 fully implemented as exemplars (`cli.command` span, `agent.lifecycle` span, `error.raised` event, `state_transition` event, `schema.violation` meta).
4. Redaction helpers: `src/lib/events/redactors.ts` — `hashEntity(k,v)` HMAC-SHA256, `stripEnvVars(text)`, `tokenizePath(p)`, `dropSecretShaped(str)`.
5. Dedup key generator internal to `emit()` — SHA256 of `(type, entity_id, payload_digest, minute_bucket)`.
6. CI lint rule `scripts/lint-emit-discipline.ts` — fails on: direct `INSERT INTO genie_runtime_events*`, `.passthrough()`, `z.any()`, or schema file without tier tagging; wired into `bun run check`.
7. Synthetic secret-probe test `test/observability/redaction.test.ts` — emits event with `ANTHROPIC_API_KEY=sk-test-12345` in payload; asserts the key is absent from the written row.
8. Bench harness `test/observability/emit-bench.ts` — measures emit-site p99 and end-to-end p99 under 100 ev/s sustained.

**Acceptance Criteria:**
- [ ] `emit()` returns in p99 <1ms measured via `test/observability/emit-bench.ts`.
- [ ] Under 100 ev/s sustained load, end-to-end (emit → consumer LISTEN) p99 <50ms.
- [ ] Redaction probe test passes (no secret leak).
- [ ] CI lint rejects any new PR that INSERTs into events tables outside `emit.ts`.
- [ ] Schema violations surface as `schema.violation` meta events, never throw out of business transactions.
- [ ] `bun run check` green.

**Validation:**
```bash
bun test test/observability/ && bun run check && bun run test/observability/emit-bench.ts --gate-p99-emit=1ms --gate-p99-e2e=50ms
```

**depends-on:** none

---

### Group 3: Vocabulary Wiring + Correlation Propagation

**Goal:** Implement the remaining 15 of 20 Zod schemas and wire `startSpan`/`endSpan`/`emitEvent` calls into every identified emission site per Phase 0 audit, with full 4-channel correlation propagation.

**Deliverables:**
1. Remaining 15 Zod schemas in `src/lib/events/schemas/` — `wish.dispatch`, `hook.delivery`, `resume.attempt`, `executor.write`, `mailbox.delivery` (spans); `session.id.written`, `session.reconciled`, `tmux.pane.placed`, `executor.row.written`, `cache.invalidate`, `cache.hit`, `runbook.triggered`, `consumer.heartbeat`, `permissions.grant`, `permissions.deny`, `team.create`, `team.disband` (events, last two at audit tier).
2. Correlation primitive `src/lib/trace-context.ts` — `mintToken(ctx)`, `parseToken(s)`, `propagateEnv()`, `injectPromptPreamble(prompt, token)`, `extractPromptPreamble(stream)`; HMAC-signed with `GENIE_TRACE_SECRET` env var.
3. Wire emit calls at every site in Phase 0 audit — minimum: all `src/executors/`, `src/team-commands/dispatch.ts`, `src/team-commands/state.ts`, `src/hooks/`, `src/scheduler-daemon.ts`, `src/mailbox/`, `src/lib/runtime-events.ts` call sites.
4. `command_success` demotion — every existing emit site for this type routes to `genie_runtime_events_debug` with `severity='debug'`; 1/100 sample retained via dedup-key hash mod.
5. Add `<genie-trace>` preamble injection in `src/executors/claude-code/spawn.ts` (or equivalent) so Claude children inherit trace context via their initial prompt.
6. Update `src/logger.ts` (or equivalent) to include `trace_id=` in every log line when a trace context is active.
7. `before/after` payloads required on `executor.row.written`, `session.id.written`, `session.reconciled` — implemented at the wrappers around PG writes.

**Acceptance Criteria:**
- [ ] After a synthetic `genie work <slug>` dogfood, `genie events timeline <trace_id>` renders full CLI→serve→spawn→hook chain.
- [ ] `command_success` events count in `genie_runtime_events` drops from 91.7% to ≤1% of total within 24h of dogfood.
- [ ] 15 new schemas pass Zod parse roundtrip tests.
- [ ] `correlation.orphan.rate` metric <1% on synthetic wave-dispatch load test.
- [ ] Retrofit to recapture every site in Phase 0 inventory — CI diff reports missing coverage if any inventory entry is un-instrumented.
- [ ] `bun run check` + `bun test src/lib/events/schemas/` green.

**Validation:**
```bash
bun test src/lib/events/schemas/ && bun run check && bash test/observability/dogfood-vocabulary.sh
```

**depends-on:** Group 1, Group 2

---

### Group 4: Consumer CLI + Transport

**Goal:** Ship `genie events stream --follow`, `genie events timeline <trace_id>`, `genie events list --v2`, and `genie events migrate --audit` backed by LISTEN/NOTIFY wake + id-cursor read.

**Deliverables:**
1. `src/term-commands/events-stream.ts` — `genie events stream --follow [--kind <prefix>] [--severity <level>] [--since <dur>]` — opens PG LISTEN for allowed channels, reads via `WHERE id > last_seen_id ORDER BY id LIMIT 500`; outputs NDJSON or pretty.
2. `src/term-commands/events-timeline.ts` — `genie events timeline <trace_id>` — renders causal tree by recursive CTE on `parent_span_id`; ASCII tree output; flag `--json` for machine consumption.
3. Extend `src/term-commands/audit-events.ts` — add `--v2` flag to `genie events list`, `--kind <prefix>` filter, new columns `TraceId | SpanId | Severity | Duration` in `--v2` output; legacy shape stays on default.
4. `src/term-commands/events-migrate.ts` — `genie events migrate --audit [--dry-run]` — backfills enriched rows from `audit_events` into `genie_runtime_events` with `correlation_id=NULL` and a sentinel source tag.
5. ID-cursor persistence — consumer stores `last_seen_id` in `~/.genie/state/consumer-<consumer-id>.json`; auto-resumes on reconnect.
6. Stream-gap detection — if `NEW.id > last_seen_id + 1` on any fetched batch, emit `stream.gap.detected{missing_count, range}`.
7. Consumer heartbeat — every 30s emit `consumer.heartbeat{consumer_id, last_event_id_processed, backlog_depth}`.

**Acceptance Criteria:**
- [ ] `genie events stream --follow` returns first event within 5ms of NOTIFY wake on localhost PG.
- [ ] `genie events timeline <trace_id>` renders tree in <4s for a 500-event trace.
- [ ] 100 concurrent `genie events stream --follow` consumers: idle PG backends ≤150, no emit slowdown measurable (p99 emit still <1ms).
- [ ] `genie events list --since 5m` unchanged output; `genie events list --v2 --since 5m` adds new columns.
- [ ] `genie events migrate --audit --dry-run` reports row deltas without writing; full run is idempotent.
- [ ] Consumer survives PG restart: reconnects, resumes from persisted `last_seen_id`, emits `stream.gap.detected` if any gap exists.

**Validation:**
```bash
bun test src/term-commands/events-*.test.ts && bash test/observability/consumer-fanout-100.sh
```

**depends-on:** Group 1, Group 2

---

### Group 5: RBAC + Audit Tier + IR Commands

**Goal:** Enforce role-based access at DB + app layers, issue short-lived signed subscription tokens, isolate audit-tier emissions to an append-only WORM table with HMAC chain, and ship incident-response admin commands.

**Deliverables:**
1. DB roles migration `015_rbac_roles.sql` — create `events_admin`, `events_operator`, `events_subscriber`, `events_audit` PG roles; grant per-table SELECT/INSERT matching the matrix in DESIGN.md §3; GRANT INSERT ONLY on `genie_runtime_events_audit` to `events_audit` role.
2. Row-level security — `ALTER TABLE genie_runtime_events ENABLE ROW LEVEL SECURITY` + policy `USING (tenant_id = current_setting('app.tenant_id'))`; add `tenant_id` column defaulting to `'default'`.
3. Channel ACLs — revoke generic `LISTEN` from `PUBLIC`; grant per-prefix LISTEN rights per role.
4. Subscription token layer `src/lib/events/tokens.ts` — mint/verify JWT HMAC-signed with `GENIE_EVENTS_TOKEN_SECRET`; payload `{role, allowed_types, expires_at, tenant_id, subscriber_id}`; 1h TTL.
5. `genie events subscribe --role <role> --types <csv>` — returns a signed token; `genie events stream --follow` requires `GENIE_EVENTS_TOKEN=<tok>` env var.
6. Audit HMAC chain — trigger on `genie_runtime_events_audit` INSERT computes `hmac(prior_hash || row_digest, GENIE_AUDIT_HMAC_KEY)` stored in `chain_hash` column; `genie events export-audit --signed --since <dur>` re-verifies chain and emits signed bundle.
7. IR commands — `genie events revoke-subscriber <token-id>` (adds to revocation list in PG), `genie events rotate-redaction-keys` (generates new per-tenant HMAC key, preserves old for pre-rotation lookups), `genie events un-hash <hashed-id>` (admin-only, emits `audit.un_hash` event).
8. `events:admin` un-hash and `events:audit` export both emit an `audit:true` event (sentinel H6, audit-the-auditors).

**Acceptance Criteria:**
- [ ] Test connecting as `events_subscriber` role: can LISTEN only on allowed channels, SELECT only on non-audit tables; attempted INSERT on audit fails with permission denied.
- [ ] Subscription token without `allowed_types` allowlist is rejected at stream endpoint.
- [ ] Audit chain tamper test: manually UPDATE a chain_hash; `genie events export-audit --signed` detects and raises chain-break error with row id.
- [ ] `genie events rotate-redaction-keys` preserves pre-rotation hash lookups via key versioning; CI test covers round-trip.
- [ ] Every `admin` un-hash or `audit` export adds an `audit:true` row to the audit table.
- [ ] `bun test src/lib/events/tokens.test.ts` + `bun test src/lib/events/rbac.test.ts` green.

**Validation:**
```bash
bun test src/lib/events/{tokens,rbac,audit-chain}.test.ts && bash test/observability/rbac-matrix.sh
```

**depends-on:** Group 3, Group 4

---

### Group 6: Dead-Man's Switch + Watcher Metrics + Back-Pressure

**Goal:** Ship the external `@automagik/genie-watchdog` npm package with systemd-timer unit; instrument the six watcher-of-watcher meta metrics; implement tiered back-pressure with disk spill journal.

**Deliverables:**
1. New repo/package `@automagik/genie-watchdog` (scaffolded in `packages/watchdog/` in genie monorepo for v0; split to separate repo at v1) — standalone binary, no genie code import, own minimal `pg` client.
2. `watchdog --install` — writes `/etc/systemd/system/genie-watchdog.timer` + `.service` units running every 60s: `SELECT extract(epoch from (now() - max(created_at))) FROM genie_runtime_events;`.
3. Alerting config at `/etc/genie-watchdog/alerts.yaml` — SMS/email escalation per deployment; if PG unreachable OR result > 300, fire alert.
4. Six watcher meta events emitted into the stream: `emitter.rejected` (per Zod validation fail), `emitter.queue.depth` (periodic 10s), `emitter.latency_p99` (rolling window of 1000 emits), `notify.delivery.lag` (NOTIFY roundtrip probe), `stream.gap.detected` (id skip, from G4), `correlation.orphan.rate` (percent of child events whose parent_span_id has no match within 60s).
5. Back-pressure logic in `src/lib/emit.ts` (enhancement to G2):
   - debug overflow → drop silently, increment `emitter.shedding_load` counter, emit 1/min summary event
   - info overflow → bounded 50ms wait, then drop + shedding summary
   - warn/error/fatal overflow → bounded 50ms wait, spill to `~/.genie/data/emit-spill.jsonl` (append + fsync), emit `consumer.lagged` audit event, raise `emit-backpressure.critical` to watchdog
6. Spill journal drain — on next successful flush, replay spilled rows oldest-first with original timestamps preserved.
7. `genie doctor --observability` checks: watchdog installed? 6 watcher metrics non-null in last 5min? spill journal empty?

**Acceptance Criteria:**
- [ ] `watchdog --install` runs successfully on a clean systemd host; timer unit active within 60s.
- [ ] Kill the PG process → watchdog fires alert within 5 minutes; measured in CI via systemd-nspawn test.
- [ ] All 6 watcher meta events appear in `genie events list --kind='emitter.*' --since 1h` under synthetic load.
- [ ] Back-pressure test: saturate queue at 20K events/s for 10s — debug events dropped silently, warn/error events all present in spill journal + main table.
- [ ] Spill journal drains automatically on recovery; no event loss for warn+ severity.
- [ ] `genie doctor --observability --json` returns `{watchdog: "ok", watcher_metrics: "ok", spill_journal: "empty"}` after 1h steady-state.

**Validation:**
```bash
cd packages/watchdog && bun test && bun run check && bash test/observability/backpressure-saturation.sh
```

**depends-on:** Group 2

---

### Group 7: Acid Tests + Runbook R1 Reference Consumer

**Goal:** Prove the substrate works by (a) retroactively reconstructing all 6 rot patterns + 5 dispatch bugs via SQL against a synthetic replay dataset, and (b) shipping one reference consumer agent implementing the #1192 escalation-recursion detection rule end-to-end.

**Deliverables:**
1. `docs/observability-acid-tests.sql` — SQL queries for each of: rot patterns 1 (backfilled teams without worktree), 2 (team ls vs disband drift), 3 (PG-registered-but-no-session ghost anchors), 4 (duplicate custom-name anchors), 5 (zombie team-lead polling), 6 (orphan subagent cascade); and dispatch bugs A (parser "review" false-match), B (reset doesn't clear wave state), C (PG-vs-cache status drift), D (spawn bypass of state machine), E (Agent-ready timer mismeasure). Each query takes a `(time_range)` param and returns specific evidence rows.
2. `test/observability/replay-dataset/` — synthetic replay fixtures for each of the 11 patterns, built as sequences of typed events that reproduce the pathology without running the real subsystem.
3. `test/observability/acid-test.ts` — loads each fixture into a test DB, runs the SQL queries from (1), asserts each query returns the expected evidence count.
4. `src/consumers/runbook-r1/` — reference consumer agent:
   - `index.ts` — subscribes via signed token (scope `events:subscriber` + `allowed_types: ['mailbox.delivery.sent']`)
   - Detects sustained `count > 50 in 10min` WHERE `from='scheduler' AND to='team-lead'`
   - Emits `runbook.triggered{rule:'R1', evidence_count, correlation_id, recommended_sql: 'DELETE FROM mailbox WHERE to_worker=\'team-lead\' AND from_worker=\'scheduler\';'}`
   - Does NOT auto-execute the mitigation
5. Integration test `test/observability/runbook-r1.test.ts` — synthetic replay of #1192 pattern triggers the consumer; assert `runbook.triggered` emitted within 15s; assert recommended SQL is present in payload.
6. `docs/observability-consumers.md` — pattern doc showing how to write a consumer agent, using R1 as the worked example.

**Acceptance Criteria:**
- [ ] `bun test test/observability/acid-test.ts` passes all 11 patterns.
- [ ] `bun test test/observability/runbook-r1.test.ts` passes; R1 consumer is a working reference for future rules R2-R5.
- [ ] Consumer token scope test: R1 consumer cannot subscribe to `audit`-tier events with its subscriber token.
- [ ] R1 consumer survives PG restart; re-subscribes from last_seen_id; does not duplicate-fire within idempotency window.

**Validation:**
```bash
bun test test/observability/{acid-test,runbook-r1}.test.ts && psql -f docs/observability-acid-tests.sql -v pattern=all
```

**depends-on:** Group 3, Group 4, Group 5

---

### Group 8: Pen-Test Red-Team + Perf Gate + Rollout Docs

**Goal:** Ship the four mandated pen-test scenarios, wire performance regression gates into CI, publish the 5-phase rollout doc, and prepare the flip-default PR.

**Deliverables:**
1. `test/pentest/observability/forge-event.ts` — attempts to emit a forged event with a hand-crafted trace token that lacks a valid signature; assert `schema.violation` emitted and original payload dropped.
2. `test/pentest/observability/exfil-env-var.ts` — emits an event whose payload deliberately includes `ANTHROPIC_API_KEY=sk-real-looking-12345` and `/home/tenant/.secrets/`; asserts the key and the absolute path are ABSENT from the written row.
3. `test/pentest/observability/schema-bomb.ts` — emits an event with a 10MB payload; asserts emit returns normally (never crashes), written row shows `overflow: true` + content hash, no JSONB corruption in PG.
4. `test/pentest/observability/listen-bomb.ts` — attempts to `LISTEN genie_events.audit` with a `subscriber`-role token; asserts PG returns permission denied; attempts to flood NOTIFY with 100K rows/s; asserts watchdog detects queue saturation and raises critical alert within 60s.
5. Perf regression gate `test/perf/observability/gate.ts` — runs harness at 100 ev/s for 60s, asserts: emit p99 <1ms, end-to-end p99 <50ms, Zod CPU <5%, PG backend count <150, partition rotation on pre-seeded 5M-row table <500ms. Wired into `bun run check:perf`; runs on every PR touching `src/lib/events/` or `src/lib/emit.ts`.
6. `docs/observability-rollout.md` (full version) — 5 phases (ADD-only migration, dual-write flag-off, dual-write flag-on internal, dual-write flag-on customer, flip-default); rollback procedure per phase; watchdog install guide; subscriber-token lifecycle; IR playbook.
7. `docs/observability-contract.md` — public consumer-compat promises: schema evolution rules, never-rename, schema_version semantics, deprecation window.
8. Release-gate PR template `docs/templates/observability-v0-flip.md` — checklist for the PR that flips `GENIE_WIDE_EMIT` default to on: 14d green on 6 watcher metrics, all 4 pen-tests passing, perf gate green, pen-test CI log links.

**Acceptance Criteria:**
- [ ] All 4 pen-test scenarios pass in CI (`bun test test/pentest/observability/`).
- [ ] `bun run check:perf` is green and wired into PR CI on touched paths.
- [ ] `docs/observability-rollout.md` reviewed and merged; rollback procedure tested on a scratch PG instance.
- [ ] `docs/observability-contract.md` published and linked from README.
- [ ] Flip-default PR template exists and is used for the eventual enablement PR (not merged in this wish — this wish ships flag-off by default).

**Validation:**
```bash
bun test test/pentest/observability/ && bun run check:perf && bun run check
```

**depends-on:** Group 5, Group 6, Group 7

---

## QA Criteria

_Verified on dev after merge, before any customer-facing flip-default PR._

- [ ] `GENIE_WIDE_EMIT=0` (default) — all existing `genie events list/timeline/errors/summary` output shapes unchanged; zero regressions in `bun test`.
- [ ] `GENIE_WIDE_EMIT=1` on an internal workspace — 24h soak test produces ≥90% main-table signal density (measured `genie events list --kind!='command_success' --since 24h | wc -l` divided by total).
- [ ] Integration: run a full `genie team create --wish <slug>` to completion under `GENIE_WIDE_EMIT=1` — `genie events timeline <root_trace_id>` renders the full CLI→serve→team-lead→engineer→reviewer causal tree.
- [ ] Security: `genie events subscribe --role subscriber --types 'agent.lifecycle,state_transition'` returns a token; that token can LISTEN on allowed channels only; attempted LISTEN on `genie_events.audit` is rejected at DB layer.
- [ ] Tamper evidence: manually UPDATE a row in `genie_runtime_events_audit.chain_hash` via `events_admin` role; `genie events export-audit --signed` detects the break and surfaces the bad row id in error output.
- [ ] Watchdog dry-run: on a staging host with `watchdog --install`, stop the PG process; alert fires within 5 minutes.
- [ ] Rollback: with `GENIE_WIDE_EMIT=1` for 1 hour, flip to `GENIE_WIDE_EMIT=0` mid-flight; no stuck queue, no emit errors, no data loss — warn/error events still captured via legacy `audit_events` writer.
- [ ] Perf smoke on dev box (not CI): 10-minute sustained 100 ev/s synthetic load; all perf gates green.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Phase 0 audit misses an emitter call site → incomplete coverage | Medium | Inventory doc reviewed by two engineers; CI diff compares inventory against a `git grep` of INSERT call sites; missing coverage blocks G3 validation. |
| `<genie-trace>` prompt preamble conflicts with agent system prompts | Low-Medium | Preamble is the FIRST line with a stable marker; tracer report validates Claude's robustness to such markers; fallback to env var + DB still propagates trace without the preamble. |
| `events_admin` role compromise → full un-hash + audit export | High | Admin un-hash + export both emit `audit:true` events (self-witness); IR command `rotate-redaction-keys` bounds exposure to epoch; pen-test scenario covers the attempted forgery after compromise. |
| Flip-default done too early before 14d watcher green | High | Flip-default is its own PR with explicit checklist (template in G8); acceptance requires linked CI evidence of 14d green; not part of this wish. |
| `packages/watchdog` drifts from monorepo version discipline | Low | Watchdog has own `package.json` with tight `pg` dep pin; CI test that watchdog does NOT import any `src/` code from genie proper. |
| Partition rotation cron misfires → partition exhausted | Medium | `genie doctor --observability` checks next-partition-timestamp; alerts if <48h runway; watchdog probe also looks for INSERT failures. |
| Consumer fan-out exceeds 1000 → PG backend exhaustion | Medium | Measurement gate caps v0 at 100 concurrent consumers; architecture note in DESIGN for serve-side broker at v1 if N>1000. |
| JSONB GIN index on `payload->>'error_class'` causes write amplification | Low | Only one GIN index (on error_class) not on full payload; benchmark in G2 measures write overhead; drop index if overhead >5%. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

Target repo: `~/workspace/agents/genie-configure/repos/genie/` (automagik-dev/genie).

```
# New — schema + migrations
src/db/migrations/011_runtime_events_otel_columns.sql
src/db/migrations/012_runtime_events_partition.sql
src/db/migrations/013_runtime_events_siblings.sql
src/db/migrations/014_listen_channel_split.sql
src/db/migrations/015_rbac_roles.sql

# New — emission core
src/lib/emit.ts
src/lib/events/registry.ts
src/lib/events/redactors.ts
src/lib/events/tokens.ts
src/lib/events/audit-chain.ts
src/lib/events/rbac.ts
src/lib/events/schemas/<20 schema files>.ts
src/lib/trace-context.ts

# New — consumer + admin CLI
src/term-commands/events-stream.ts
src/term-commands/events-timeline.ts
src/term-commands/events-migrate.ts
src/term-commands/events-subscribe.ts
src/term-commands/events-admin.ts  # revoke, rotate, un-hash, export-audit

# Modified — existing
src/term-commands/audit-events.ts  # --v2 flag + --kind filter
src/logger.ts                       # trace_id= log key
src/executors/claude-code/spawn.ts  # <genie-trace> preamble injection
src/executors/**/*.ts               # startSpan/endSpan/emitEvent wiring
src/team-commands/dispatch.ts       # wish.dispatch span + correlation
src/team-commands/state.ts          # state_transition events + before/after
src/hooks/**/*.ts                   # hook.delivery span
src/scheduler-daemon.ts             # trace-context propagation
src/mailbox/*.ts                    # mailbox.delivery span
src/lib/runtime-events.ts           # route through emit.ts, deprecate direct-write
src/term-commands/doctor.ts         # --observability section

# New — watchdog
packages/watchdog/package.json
packages/watchdog/src/index.ts
packages/watchdog/src/install.ts
packages/watchdog/systemd/genie-watchdog.timer
packages/watchdog/systemd/genie-watchdog.service

# New — reference consumer
src/consumers/runbook-r1/index.ts
src/consumers/runbook-r1/detector.ts

# New — tests
test/observability/redaction.test.ts
test/observability/emit-bench.ts
test/observability/acid-test.ts
test/observability/runbook-r1.test.ts
test/observability/replay-dataset/<11 fixtures>
test/observability/dogfood-vocabulary.sh
test/observability/consumer-fanout-100.sh
test/observability/rbac-matrix.sh
test/observability/backpressure-saturation.sh
test/pentest/observability/forge-event.ts
test/pentest/observability/exfil-env-var.ts
test/pentest/observability/schema-bomb.ts
test/pentest/observability/listen-bomb.ts
test/perf/observability/gate.ts

# New — CI scripts
scripts/lint-emit-discipline.ts

# New — docs
docs/EVENT-EMITTERS-INVENTORY.md       # Phase 0 audit
docs/observability-rollout.md          # 5-phase plan + rollback
docs/observability-contract.md         # public consumer promises
docs/observability-acid-tests.sql      # SQL for 11 patterns
docs/observability-consumers.md        # how-to-write pattern
docs/templates/observability-v0-flip.md # flip-default PR checklist
```
