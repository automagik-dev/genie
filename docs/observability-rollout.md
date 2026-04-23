# Observability Rollout — Genie Serve Structured Observability

Wish: `genie-serve-structured-observability` · Sub-project A of `genie-self-healing-observability`.

This document is the operational contract for rolling the new event
substrate out. It describes the 5 phases, what ships in each, the acceptance
gates to advance, and the rollback procedure per phase. The doc also carries
the watchdog install guide, subscriber-token lifecycle, and IR playbook.

This wish (`genie-serve-obs-v2`) ships **Phases 0-3 inclusive, with
`GENIE_WIDE_EMIT=0` as the default**. Phase 4 (flip-default) is a **separate
PR** gated by `docs/templates/observability-v0-flip.md`. Do not merge the
flip-default PR until the Phase 3 acceptance criteria have been green for 14
consecutive days.

---

## Phase 0 — Schema evolution (Group 1, shipped)

**Status:** in this PR.

### What ships

- Migration `037_runtime_events_otel_columns.sql` adds eight OTEL-style
  columns to `genie_runtime_events`:
  - `span_id UUID`, `parent_span_id UUID`, `severity TEXT` (with CHECK),
    `schema_version INTEGER`, `duration_ms INTEGER`, `dedup_key TEXT`,
    `source_subsystem TEXT`.
  - Five new indexes, all `IF NOT EXISTS`.
- Migration `038_runtime_events_partition.sql` converts the table to
  `PARTITION BY RANGE (created_at)` with rolling daily partitions and three
  helper functions:
  `genie_runtime_events_create_partition(date)`,
  `genie_runtime_events_drop_old_partitions(retention_days)`,
  `genie_runtime_events_maintain_partitions(forward_days, retention_days)`.
- Migration `039_runtime_events_siblings.sql` creates
  `genie_runtime_events_debug` (24h TTL, truncatable) and
  `genie_runtime_events_audit` (append-only WORM, HMAC chain trigger).
- Migration `040_listen_channel_split.sql` replaces the single
  `genie_runtime_event` LISTEN channel with per-prefix
  `genie_events.<prefix>` channels, **dual-broadcasting** on the legacy
  channel so existing subscribers keep working.
- Feature flag `GENIE_WIDE_EMIT` (library `src/lib/observability-flag.ts`)
  defaults to **off**.

### Acceptance gates for Phase 0

| Gate | Verified by |
|---|---|
| `bun test` green with new migrations applied | Existing CI. |
| `genie events list --since 5m` output shape unchanged | Manual smoke; new columns are nullable and not selected by legacy reader. |
| Migrations idempotent on re-apply | `IF NOT EXISTS` + `DO $$ IF NOT is_partitioned …` guards. |
| Downgrade safety | Old binary reads `genie_runtime_events` — extra columns are ignored; partition parent behaves as a regular table from the client's perspective. |
| Phase 0 audit published | `docs/EVENT-EMITTERS-INVENTORY.md`. |

### Rollback for Phase 0

- **Column rollback:** none required. Columns are nullable additions;
  downgraded binaries ignore them.
- **Partition rollback:** if `genie_runtime_events_legacy_pre_partition`
  still exists (attached as the default partition), operators can DETACH +
  RENAME back in a single maintenance window:
  ```sql
  BEGIN;
    ALTER TABLE genie_runtime_events DETACH PARTITION genie_runtime_events_legacy_pre_partition;
    ALTER TABLE genie_runtime_events RENAME TO genie_runtime_events_partitioned;
    ALTER TABLE genie_runtime_events_legacy_pre_partition RENAME TO genie_runtime_events;
  COMMIT;
  ```
  The partitioned parent is then orphaned but harmless; drop it after verification.
- **LISTEN trigger rollback:** migration 040 dual-broadcasts on the legacy
  channel, so rolling back only removes the per-prefix channels — no
  subscriber action needed.

---

## Phase 1 — Emit primitive, flag-off (Group 2, next wave)

**Trigger:** Group 2 merges.

Introduces `src/lib/emit.ts` with three primitives (`startSpan`, `endSpan`,
`emitEvent`) plus the closed Zod registry, redaction pipeline, and the CI
lint rule that blocks raw `INSERT INTO genie_runtime_events*` outside
`emit.ts`. No runtime behavior change: the primitive is present but no
caller invokes it while the flag is off.

### Rollback
Revert the PR. No runtime impact on subscribers.

---

## Phase 2 — Dual-write, flag-off internal (Group 3 + 4)

**Trigger:** Groups 3 and 4 merged; internal dogfood only (no customer
installs).

Instrumentation wires `emit.ts` into every call site from the Phase 0
inventory. The legacy writers stay. `GENIE_WIDE_EMIT` remains off in
CI and shipping binaries but is set to `1` on one internal dogfood
workspace. Consumer CLI lands (`genie events stream --follow`,
`timeline`, `list --v2`, `migrate --audit`).

### Acceptance before advancing to Phase 3

- 24 hours of dogfood at `GENIE_WIDE_EMIT=1` on one workspace.
- Main-table signal density ≥90% measured.
- `correlation.orphan.rate` <1%.

### Rollback
`GENIE_WIDE_EMIT=0` restores the legacy-only path without a restart.
Spill journal is drained on next flush.

---

## Phase 3 — Dual-write, flag-on customer (Groups 5 + 6 + 7)

**Trigger:** Phase 2 green for 7 days.

RBAC/tokens, audit-tier WORM, watchdog, back-pressure policy, and the
runbook-R1 reference consumer all land. `GENIE_WIDE_EMIT` default is **still
off**; customer installs opt-in via `GENIE_WIDE_EMIT=1`.

### Rollback
Same as Phase 2. Audit tier rows survive rollback (they are the ground truth).

---

## Phase 4 — Flip default (Group 8 gate, separate PR)

**Trigger:** 14 consecutive days of green on all six watcher-of-watcher
metrics (`emit.rejected`, `emit.queue.depth`, `emit.latency_p99`,
`notify.delivery.lag`, `stream.gap.detected`, `correlation.orphan.rate`).

Flip the default of `GENIE_WIDE_EMIT` to on. This is a **separate PR** with
`docs/templates/observability-v0-flip.md` as its checklist. **Not part of
this wish.**

### Rollback
The flip-default PR includes a revert commit prepared in the same branch
tip. Reverting restores flag-off behavior.

---

## Watchdog install guide

The watchdog is the "thing that watches the watcher." It runs in a separate
process, has its own `pg` client pool, and does not import any code from
genie. That separation is load-bearing: if genie's own event stream goes dark,
the watchdog's probe is what pages oncall.

### Install

```bash
npm i -g @automagik/genie-watchdog           # or: cd packages/watchdog && bun link
sudo watchdog --install                      # writes systemd .timer + .service
sudo systemctl daemon-reload
sudo systemctl enable --now genie-watchdog.timer
systemctl status genie-watchdog.timer
systemctl status genie-watchdog.service      # shows the most recent probe
```

### Configure alerts

`/etc/genie-watchdog/alerts.yaml` — SMS/email routing per deployment:

```yaml
probe:
  interval_seconds: 60
  stale_after_seconds: 300      # event-stream silence threshold
alerts:
  - kind: email
    to: oncall@example.com
    on: [stale, pg_unreachable]
  - kind: pagerduty
    integration_key: ${PD_KEY}
    on: [stale, pg_unreachable, backpressure_critical]
```

### Validate

```bash
# Dry run — probe PG but don't alert
watchdog --probe-once --dry-run

# Force stale state for an alerting test (staging only)
systemctl stop pgserve
# Wait 5 minutes; alert must fire
systemctl start pgserve
```

### Rollback

Uninstall the timer; the service is standalone.

```bash
sudo systemctl disable --now genie-watchdog.timer
sudo rm /etc/systemd/system/genie-watchdog.{timer,service}
sudo systemctl daemon-reload
```

---

## Subscriber token lifecycle

Every consumer (human, agent, external service) authenticates to the event
stream via a short-lived signed JWT. The substrate itself does not trust the
caller's identity — only the token.

### Mint a token

```bash
# Default 1h lifetime, role-scoped channel allowlist
genie events subscribe --role subscriber \
  --types 'agent.lifecycle,state_transition,mailbox.delivery'

# Returns:
#   token: <jwt>
#   expires_at: 2026-04-20T12:34:56Z
#   subscriber_id: sub-abc123def456
#   allowed_channels: [genie_events.agent, genie_events.state_transition, genie_events.mailbox]
```

Roles:
- `events:admin` — full matrix incl. audit read + un-hash + export-audit
- `events:operator` — internal subsystems; read/write all non-audit tables
- `events:subscriber` — external consumer agents; read-only, no audit, no emitter meta
- `events:audit` — compliance reader; audit tier only

### Use a token

```bash
export GENIE_EVENTS_TOKEN=<tok>
genie events stream --follow --kind state_transition
```

The stream verifies the token on each reconnect. Tokens are cached locally
only by the subscriber process — rotation is as simple as re-running `genie
events subscribe`.

### Rotation cadence

| Environment | Cadence | Triggered by |
|---|---|---|
| Dev / local | On demand | Developer |
| Internal dogfood | 1 week | Ops bot |
| Customer prod | 1h automatic + on incident | Genie daemon |
| Admin tokens | Per-session, 15 min TTL | Break-glass only |

### Revocation (before expiry)

```bash
genie events revoke-subscriber <token_id> \
  --reason "leaked to public gist"
```

Revocations are persisted in `genie_events_revocations`. Active streams
re-check the revocation set on every LISTEN reconnect; long-lived streams
poll every 30s.

---

## Incident-Response (IR) playbook

Every IR command that touches the audit tier or un-hashes an entity id emits
an `audit:true` event into the audit table — "auditing the auditor." Treat
this as sentinel H6; if an admin action is not witnessed by an audit row,
the admin path itself is suspect.

### Symptom → action matrix

| Symptom | First command | Why |
|---|---|---|
| Subscriber token leaked | `genie events revoke-subscriber <token_id>` | Immediate revocation; active streams drop within 30s |
| Redaction key compromise suspected | `genie events rotate-redaction-keys` | Generates a new HMAC key; pre-rotation hashes still resolve via key versioning |
| Need to resolve `tier-a:entity:<hash>` | `genie events un-hash <hash>` (admin only) | Admin-only; emits `audit.un_hash` into WORM tier |
| Watchdog fired `stale` alert | `genie events stream --follow --since 10m` | Confirm the stream is actually dark vs. false positive |
| Watchdog fired `backpressure_critical` | `genie doctor --observability` then inspect spill journal at `~/.genie/data/emit-spill.jsonl` | Confirm warn+ events landed on disk; drain happens on next flush |
| SOC2 audit request | `genie events export-audit --signed --since 24h > audit.json` | HMAC-chain verified bundle; emits `audit.export` |
| Chain break detected | Stop writes, run `genie events export-audit --verify-only` | HMAC-chain trigger prevents writes but not reads — the verifier surfaces the bad row id |

### Break-glass: admin un-hash

```bash
# Un-hash a tier-A entity id for a live incident
genie events un-hash tier-a:entity:abc123def4567890 \
  --reason "incident INC-1234 requires attribution"

# Result: one row in genie_runtime_events_audit of type audit.un_hash with:
#   actor        = <admin role id>
#   entity_hash  = tier-a:entity:abc123def4567890
#   plaintext    = <resolved id, redacted from log output>
#   reason       = "incident INC-1234 ..."
#   audit_true   = true
```

### Key rotation

```bash
# Non-disruptive rotation — old key kept for pre-rotation hash lookups
genie events rotate-redaction-keys

# Forced rotation (destroys old key after 24h window)
genie events rotate-redaction-keys --force --destroy-after 24h
```

### Audit export

```bash
# Signed bundle for compliance hand-off
genie events export-audit --signed --since 24h > audit.json

# Verify a previously-exported bundle
genie events export-audit --verify-only < audit.json
```

---

## Change log

| Date       | Phase | Commit |
|---|---|---|
| 2026-04-19 | Phase 0 shipped | `genie-serve-obs-v2` wish (Group 1) |
| 2026-04-19 | Phase 1 shipped | Group 2 — emit primitive, Zod registry, CI lint |
| 2026-04-19 | Phase 2 shipped | Groups 3-4 — vocabulary wiring + consumer CLI |
| 2026-04-19 | Phase 3 shipped | Groups 5-7 — RBAC, watchdog, runbook-R1 |
| 2026-04-20 | Phase 3 gated  | Group 8 — pen-test + perf gate + this full-version doc |
| TBD        | Phase 4 flip   | Separate PR per `docs/templates/observability-v0-flip.md` |
