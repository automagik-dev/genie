# Detector Schema Audit — Self-Healing Observability B1

**Wish:** `genie-self-healing-observability-b1-detectors` (Group 1 / Phase 0)
**Upstream substrate:** #1213 (`genie-serve-structured-observability`, merged).
**Status after this migration:** shape decision locked, one additive column added.

## Context

`genie_runtime_events` (PG 038 partitioned parent) and its two sibling tables
(`genie_runtime_events_debug`, `genie_runtime_events_audit`) already carry a
rich superset schema driven by the closed event registry in
`src/lib/events/registry.ts`. Every event passes through the Zod registry
(`src/lib/events/schemas/*.ts`) before landing in the `data` JSONB column — so
pattern-specific evidence fields are enforceable *without* adding per-pattern
columns.

The wish proposes a common detector metadata shape of:

```
pattern_id       text
entity_id        text/uuid
observed_at      timestamptz
observed_state_json  jsonb
detector_version text
run_id           uuid
```

The audit below walks each of the eight rot patterns, maps its evidence fields
against what the current schema exposes, and classifies each as
`covered-by-existing-schema`, `needs-column-extension`, or `needs-sibling-table`.

## Baseline mapping (wish field → existing substrate column)

| wish field             | substrate column                      | notes |
|------------------------|---------------------------------------|-------|
| `pattern_id`           | `kind` (`detector.rot.<pattern_id>`)  | First dot-segment `detector` routes to `genie_events.detector` LISTEN channel (PG 040). |
| `entity_id`            | `subject` (TEXT)                      | Team id / agent id / broadcast event id — always present, already indexed via `idx_runtime_events_subject_id`. |
| `observed_at`          | `created_at` (TIMESTAMPTZ)            | Partition key; indexed. |
| `observed_state_json`  | `data` (JSONB, default `'{}'`)        | Zod-validated at emit time via registry. |
| `detector_version`     | *(new)* `detector_version` (TEXT)     | Added by migration 043. Indexed partial (`WHERE detector_version IS NOT NULL`). |
| `run_id`               | `trace_id` (UUID)                     | Already present (PG 028). Every event emitted in one detector sweep shares the trace. |

`severity`, `schema_version`, `source_subsystem` (='detector'), `span_id`,
`parent_span_id`, `dedup_key`, and `thread_id` are all already available for
detector use when relevant.

## Pattern-by-pattern walkthrough

### Pattern 1 — `backfill-no-worktree`
Evidence: `team_id`, `expected_worktree_path`, `fs_check_result`, `observed_at`.

| field                     | mapping                                              |
|---------------------------|------------------------------------------------------|
| `team_id`                 | `subject` (entity) + `team` column (denormalised)    |
| `expected_worktree_path`  | `data.expected_worktree_path` (validated by Zod)     |
| `fs_check_result`         | `data.fs_check_result` (enum in Zod)                 |
| `observed_at`             | `created_at`                                         |

Verdict: **covered-by-existing-schema**.

---

### Pattern 2 — `team-ls-drift`
Evidence: `team_id`, `team_ls_source_snapshot`, `team_disband_source_snapshot`, `delta`.

| field                              | mapping                  |
|------------------------------------|--------------------------|
| `team_id`                          | `subject` + `team`       |
| `team_ls_source_snapshot`          | `data.ls_snapshot`       |
| `team_disband_source_snapshot`     | `data.disband_snapshot`  |
| `delta`                            | `data.delta`             |

Verdict: **covered-by-existing-schema**.

---

### Pattern 3 — `anchor-orphan`
Evidence: `agent_id`, `agent_state`, `tmux_session_id`, `transcript_present`.

| field               | mapping                         |
|---------------------|---------------------------------|
| `agent_id`          | `subject` + `agent` column      |
| `agent_state`       | `data.agent_state`              |
| `tmux_session_id`   | `data.tmux_session_id`          |
| `transcript_present`| `data.transcript_present` (bool)|

Verdict: **covered-by-existing-schema**.

---

### Pattern 4 — `duplicate-agents`
Evidence: `custom_name`, `team_id`, `count`, `violating_agent_ids[]`.

| field                     | mapping                           |
|---------------------------|-----------------------------------|
| `custom_name`             | `subject` (use the name as entity)|
| `team_id`                 | `team`                            |
| `count`                   | `data.count`                      |
| `violating_agent_ids[]`   | `data.violating_agent_ids`        |

Verdict: **covered-by-existing-schema**. Arrays in `data` are native JSONB.

---

### Pattern 5 — `zombie-team-lead`
Evidence: `agent_id`, `last_poll_ts`, `last_dispatch_ts`, `idle_seconds`.

| field              | mapping                     |
|--------------------|-----------------------------|
| `agent_id`         | `subject` + `agent`         |
| `last_poll_ts`     | `data.last_poll_ts`         |
| `last_dispatch_ts` | `data.last_dispatch_ts`     |
| `idle_seconds`     | `data.idle_seconds`         |

Verdict: **covered-by-existing-schema**.

---

### Pattern 6 — `subagent-cascade`
Evidence: `parent_agent_id`, `child_agent_ids[]`, `parent_state`, `child_states[]`.

| field                | mapping                      |
|----------------------|------------------------------|
| `parent_agent_id`    | `subject` + `agent`          |
| `child_agent_ids[]`  | `data.child_agent_ids`       |
| `parent_state`       | `data.parent_state`          |
| `child_states[]`     | `data.child_states`          |

Verdict: **covered-by-existing-schema**.

---

### Pattern 7 — `dispatch-silent-drop` (cross-ref #1218)
Evidence: `broadcast_event_id`, `team_members[]`, `wake_count`, `silent_member_ids[]`.

| field                   | mapping                                       |
|-------------------------|-----------------------------------------------|
| `broadcast_event_id`    | `subject` + `parent_event_id` (BIGINT FK)     |
| `team_members[]`        | `data.team_members`                           |
| `wake_count`            | `data.wake_count`                             |
| `silent_member_ids[]`   | `data.silent_member_ids`                      |

Verdict: **covered-by-existing-schema**. `parent_event_id` is especially
useful here: it links the detector event back to the dispatch span.

---

### Pattern 8 — `session-reuse-ghost` (cross-ref #1215)
Evidence: `agent_id`, `custom_name`, `prior_team_id`, `transcript_topic_hash`, `current_topic_seed_hash`.

| field                      | mapping                             |
|----------------------------|-------------------------------------|
| `agent_id`                 | `subject` + `agent`                 |
| `custom_name`              | `data.custom_name`                  |
| `prior_team_id`            | `data.prior_team_id`                |
| `transcript_topic_hash`    | `data.transcript_topic_hash`        |
| `current_topic_seed_hash`  | `data.current_topic_seed_hash`     |

Verdict: **covered-by-existing-schema**.

## Decision

**Extend `genie_runtime_events` (and `_debug` / `_audit` siblings) with ONE
additive column: `detector_version TEXT`.**

Rationale:

1. Seven of the eight pattern evidence bundles map 1-to-1 against existing
   columns plus `data` (JSONB). No pattern requires a dedicated column outside
   the JSONB payload — Zod registry entries in Group 2 will enforce the shape.
2. `run_id` is already carried by `trace_id` (UUID, indexed). One detector
   sweep = one trace; every emitted event shares it. We avoid adding a
   duplicate column.
3. `pattern_id` slots into `kind` using the registry prefix
   `detector.rot.<pattern>`. PG 040's channel-split trigger routes every
   detector emission onto `genie_events.detector`, so consumers subscribe
   once and fan out by `kind`.
4. `detector_version` (TEXT) does NOT fit any existing column — `schema_version`
   is a per-event-type INTEGER (see PG 037), semantically distinct from
   "which release of the detector emitted this row." Adding `detector_version`
   as a TEXT column (with a partial index) keeps it first-class queryable for
   regression isolation ("show me every rot event emitted by detector v2.3.0").
5. No sibling table is justified: detector events are mainline operational
   telemetry — they want the same partitioning, retention, audit chain
   (when `tier='audit'`), and notify routing as any other event. A sibling
   would fragment the consumer surface for zero benefit.

## Consequence

Groups 2-5 of this wish (detector modules, scheduler, runbook, DLQ
integration) emit via the existing `emit()` API with `kind` prefixed
`detector.rot.*`, `source_subsystem='detector'`, and the new
`detector_version` column populated. No new table, no new trigger, no new
notify channel.
