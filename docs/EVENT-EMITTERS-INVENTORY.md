# Phase 0 Audit — Event Emitters Inventory

Wish: `genie-serve-structured-observability` · Group 1 deliverable · 2026-04-19

Every call site that writes to `audit_events` or `genie_runtime_events` today.
Used by Group 3 to confirm instrumentation coverage, and by CI to fail if an
emitter is added outside the approved primitive.

---

## Direct-SQL writers (the only call sites allowed to use raw SQL)

These are the four files that open a PG connection and INSERT rows into one of
the events tables. Everything else in the codebase funnels through them.

| File | Target table | Entry point | Rewrite plan |
|---|---|---|---|
| `src/lib/runtime-events.ts:237` (`publishRuntimeEvent`) | `genie_runtime_events` | public API | Group 3 routes through `emit.ts`; this function stays as legacy writer until dual-write flag flips (`GENIE_WIDE_EMIT=1`). |
| `src/lib/audit.ts:30` (`recordAuditEvent`) | `audit_events` | public API | Stays (legacy reader surface). Group 3 adds a parallel `emit.ts` call alongside each `recordAuditEvent` site. |
| `src/lib/audit-events.ts:59` (`insertAuditEvent`) | `audit_events` | internal — used by `src/lib/otel-receiver.ts` | Unchanged; pre-existing OTEL ingestion shim. |
| `src/lib/otel-receiver.ts:277` | `audit_events` | OTEL HTTP receiver | Unchanged; external producer path. |
| `src/lib/emit.ts:460` *(Group 2 scaffolding, already on disk)* | `genie_runtime_events` via `COPY` | batched flusher | The single authorized writer once Group 2 lands. CI lint in Group 2 rejects raw INSERTs introduced outside this file. |

### Deletes / retention

| File | Statement | Purpose |
|---|---|---|
| `src/lib/db.ts:189-190` | `DELETE FROM audit_events WHERE entity_type LIKE 'otel_%' …` and `DELETE FROM genie_runtime_events WHERE created_at < now() - interval '14 days'` | Boot-time retention on connect. |
| `src/lib/scheduler-daemon.ts:1919` | Same as above | Periodic retention sweep. |
| `src/term-commands/db.ts:264, 271` | `SELECT … FROM genie_runtime_events` and `DELETE FROM genie_runtime_events …` | `genie db prune` command (admin path). |
| `src/db/migrations/019_retention.sql` | One-shot retention seed | Migration. |

---

## Indirect writers via `recordAuditEvent` (→ `audit_events`)

`recordAuditEvent(entity_type, entity_id, event_type, actor, details)` is
fire-and-forget; every call below is additive.

| File | Count | Event types emitted (one per call) |
|---|---|---|
| `src/lib/team-manager.ts` | 5 | `created`, `backfilled`, `archived`, `unarchived`, `disbanded` |
| `src/lib/template-service.ts` | 5 | `template_created`, `template_updated`, `template_deleted`, `template_renamed`, `template_column_updated` |
| `src/lib/board-service.ts` | 8+ | `board_created`, `board_updated`, `board_deleted`, `column_added`, `column_removed`, `column_reordered`, `board_reconciled`, `card_*` |
| `src/lib/task-service.ts` | multiple | task lifecycle transitions |
| `src/lib/executor-registry.ts` | 3 | `state_changed`, `executor.ready`, `terminated` |
| `src/lib/auto-approve-engine.ts` | 1 | `decision.action` (dynamic) |
| `src/lib/agent-registry.ts` | multiple | agent lifecycle |
| `src/lib/omni-registration.ts` | few | omni enrollment |
| `src/term-commands/agents.ts`, `src/term-commands/agent/send.ts`, `src/term-commands/dir.ts`, `src/term-commands/import.ts`, `src/term-commands/msg.ts` | assorted | CLI-surface audit lines |
| `src/genie.ts` | few | top-level CLI audit lines |

---

## Indirect writers via `publishRuntimeEvent` / `publishSubjectEvent` (→ `genie_runtime_events`)

| File | Notes |
|---|---|
| `src/lib/mailbox.ts:126-127` | `genie.msg.<to>` subject events |
| `src/lib/event-router.ts:219` | Generic router (fan-out from hooks / SDK) |
| `src/lib/qa-runner.ts:91` | `genie.qa.<qaType>` subject events |
| `src/lib/scheduler-daemon.ts:217-218` | Daemon heartbeat + scheduler decisions |
| `src/lib/providers/claude-sdk-events.ts` | Claude SDK tool-use stream |
| `src/services/executors/claude-sdk.ts` | Executor-level session capture |
| `src/hooks/handlers/runtime-emit.ts` | Raw hook → event passthrough |
| `src/hooks/handlers/session-sync.ts` | Session-sync progress events |
| `src/term-commands/qa.ts` | QA CLI emission |

---

## LISTEN/NOTIFY subscribers

| File | Channel before Group 1 | Channel after Group 1 |
|---|---|---|
| `src/lib/event-listener.ts` | `genie_runtime_event` (single) | `genie_runtime_event` legacy **plus** new per-prefix `genie_events.<prefix>` (migration 040 dual-broadcasts) |
| `src/lib/event-router.ts` | subscribes through `event-listener` | unchanged |

---

## Schema evolution history (for reference)

| Migration | Change |
|---|---|
| `001_core.sql` | Created `audit_events`. |
| `007_observability.sql` | Sessions + session_content (not events-table itself). |
| `010_runtime_events.sql` | Created `genie_runtime_events` + single-channel NOTIFY. |
| `014_comms_protocol.sql` | Added `thread_id`. |
| `019_retention.sql` | Initial retention sweep seed. |
| `027_audit_events_notify.sql` | NOTIFY trigger on `audit_events`. |
| `028_events_trace_id.sql` | `trace_id`, `parent_event_id`. |
| **`037_runtime_events_otel_columns.sql`** *(Group 1)* | `span_id`, `parent_span_id`, `severity`, `schema_version`, `duration_ms`, `dedup_key`, `source_subsystem` + 5 indexes + severity CHECK. |
| **`038_runtime_events_partition.sql`** *(Group 1)* | Converts `genie_runtime_events` to `PARTITION BY RANGE (created_at)`; adds rolling-window maintenance functions. |
| **`039_runtime_events_siblings.sql`** *(Group 1)* | `genie_runtime_events_debug` (24h TTL) + `genie_runtime_events_audit` (WORM, HMAC chain). |
| **`040_listen_channel_split.sql`** *(Group 1)* | Per-prefix channel-split trigger, dual-broadcasting the legacy channel for rollback safety. |

---

## CI enforcement (landing in Group 2)

Once `scripts/lint-emit-discipline.ts` ships, the following regex is a build
fail outside the files listed in "Direct-SQL writers":

```
INSERT\s+INTO\s+genie_runtime_events
INSERT\s+INTO\s+audit_events
COPY\s+genie_runtime_events
```

This inventory is the allowlist input — Group 2's lint script consumes the
"Direct-SQL writers" table verbatim.

---

## How this inventory was produced

```bash
rg 'audit_events\b|genie_runtime_events' src/ --type ts --type sql
rg 'publishRuntimeEvent|publishSubjectEvent|recordAuditEvent' src/ --type ts
```

Reproduced on 2026-04-19 against branch `genie-serve-obs-v2`. Rerun the two
commands above before merging to pick up drift.
