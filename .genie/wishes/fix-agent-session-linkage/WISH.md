# Wish: Fix Agent Session Linkage

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `fix-agent-session-linkage` |
| **Date** | 2026-05-01 |
| **Author** | felipe + Codex |
| **Appetite** | medium |
| **Branch** | `wish/fix-agent-session-linkage` |
| **Repos touched** | `genie` |
| **Design** | Direct wish from live DB investigation |

## Summary

Fix the agent observability bug where executor-owned Claude sessions are left as orphaned session rows. Live DB checks show this is not cosmetic: the everyday `felipe` instance has `1854` sessions, `1852` with no `executor_id`, and current executor `claude_session_id` values that match session rows still marked `orphaned`. This breaks agent views, tool attribution, cost joins, replay ownership, and any future unified observability surface.

**depends-on:** none

**blocks:** observability-signal-normalization, agent-observability-snapshot, genie-command-telemetry-boundary

## Scope

### IN

- Fix session ingestion so existing orphan session rows are updated when executor context becomes known.
- Backfill `sessions.executor_id`, `sessions.agent_id`, `team`, `role`, `wish_slug`, and `task_id` from `executors.claude_session_id` and agent metadata.
- Backfill `tool_events.agent_id`, `team`, `wish_slug`, and `task_id` from linked sessions.
- Stop writing empty strings for nullable observability fields during ingestion.
- Add dry-run and apply commands for production-safe repair.
- Add regression tests that reproduce "executor session exists but row remains orphaned".

### OUT

- New dashboards or app UI.
- New event taxonomy.
- Full executor state-machine redesign.
- Historical content redaction or deletion.
- Changes to Omni bridge ownership beyond preserving correct executor/session links.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Treat this as a P0 data linkage bug | The rows already exist and are matchable; leaving them orphaned makes every higher-level view wrong. |
| 2 | Repair linkable orphan rows by `sessions.id = executors.claude_session_id` | This is the strongest existing identity relationship and works on both sampled DBs. |
| 3 | Use dry-run before apply | The richer daily-use DB has 1800+ affected sessions; operators need a preview before mutation. |
| 4 | Normalize missing observability fields to SQL `NULL` | Empty strings hide missing attribution from partial indexes and ordinary `IS NULL` diagnostics. |

## Success Criteria

- [ ] Linkable executor sessions no longer remain `orphaned` with null `executor_id`.
- [ ] New ingestion updates existing orphan rows when worker context appears later.
- [ ] Tool events inherit agent/team/wish/task attribution from linked sessions.
- [ ] Empty-string attribution fields are no longer inserted for new rows.
- [ ] Repair command supports `--dry-run` and `--apply`.
- [ ] Regression tests cover tmux JSONL ingestion and SDK session capture.

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Diagnose and codify the broken linkage as tests and dry-run SQL |
| 2 | engineer | Fix ingestion and SDK capture upsert semantics |
| 3 | engineer | Add repair/backfill command with dry-run/apply |
| 4 | reviewer | Verify local and remote DB health queries after repair |

## Execution Groups

### Group 1: Repro and Diagnostics

**Goal:** Make the bug measurable and reproducible before changing behavior.

**Deliverables:**
1. Test fixture with an executor whose `claude_session_id` matches an existing orphan session.
2. Diagnostic query helper that reports linkable orphan sessions, missing tool attribution, and empty-string fields.
3. Documentation of current local and `felipe` remote baseline counts in the wish report.

**Acceptance Criteria:**
- [ ] Test fails on current code because the session remains orphaned.
- [ ] Diagnostic query reports affected counts without mutating data.
- [ ] Baseline includes local and remote `genie db query` evidence.

**Validation:**
```bash
bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
genie --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"
```

**depends-on:** none

---

### Group 2: Ingestion Fix

**Goal:** Ensure new and incrementally ingested sessions preserve executor and agent ownership.

**Deliverables:**
1. Update `session-capture.ts` so existing orphan sessions are upgraded when `workerMap` has context.
2. Update SDK session start to use `ON CONFLICT DO UPDATE` for missing linkage fields.
3. Insert nullable observability fields as `NULL`, not empty strings.
4. Preserve explicit non-null existing values and avoid overwriting better context with null.

**Acceptance Criteria:**
- [ ] Existing orphan session becomes linked after ingestion sees matching executor context.
- [ ] SDK session conflict path fills missing `executor_id` and `agent_id`.
- [ ] New tool events store null for missing optional fields.
- [ ] Existing linked session context is not downgraded.

**Validation:**
```bash
bun test src/lib/session-capture.test.ts src/services/executors/__tests__/sdk-session-capture.test.ts
bun run typecheck
```

**depends-on:** Group 1

---

### Group 3: Repair Command

**Goal:** Safely repair existing Genie Postgres data.

**Deliverables:**
1. `genie sessions repair-links --dry-run` prints candidate sessions and tool event counts.
2. `genie sessions repair-links --apply` updates `sessions` and `tool_events` in one transaction.
3. Audit event records repair totals without storing raw session content.
4. Command refuses apply if candidate count changed between preview and apply unless `--force` is passed.

**Acceptance Criteria:**
- [ ] Dry-run mutates zero rows.
- [ ] Apply links sessions by `executors.claude_session_id`.
- [ ] Apply backfills tool event attribution from linked sessions.
- [ ] Command is idempotent.

**Validation:**
```bash
genie --no-tui sessions repair-links --dry-run
genie --no-tui sessions repair-links --apply
genie --no-tui db query "select count(*) from sessions s join executors e on s.id = e.claude_session_id where s.executor_id is null"
```

**depends-on:** Group 2

---

### Group 4: Cross-Instance Verification

**Goal:** Prove the bug is fixed on both a local dev DB and the richer `felipe` instance.

**Deliverables:**
1. Before/after query transcript for local DB.
2. Before/after query transcript for `ssh felipe` DB.
3. Short report at `.genie/wishes/fix-agent-session-linkage/REPORT.md`.

**Acceptance Criteria:**
- [ ] Linkable orphan session count is zero after apply on test DB.
- [ ] Tool events with missing attribution decrease for sessions that are now linkable.
- [ ] No unrelated session content rows are modified.

**Validation:**
```bash
ssh felipe 'export PATH=/home/genie/.bun/bin:/home/genie/.local/share/fnm/node-versions/v24.14.1/installation/bin:$PATH; cd /home/genie/workspace/repos/genie && genie --no-tui sessions repair-links --dry-run'
```

**depends-on:** Group 3

---

## QA Criteria

- [ ] `genie sessions list` shows linked agent/executor ownership for repaired sessions.
- [ ] `genie log <agent>` can include session/tool history from repaired rows.
- [ ] Re-running repair is idempotent.
- [ ] The command is safe on a DB with zero affected rows.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Some orphan sessions are genuinely not owned by an executor | Medium | Only repair rows with exact `sessions.id = executors.claude_session_id`. |
| Tool attribution backfill could overwrite better historical context | Medium | Use `COALESCE(existing, session_context)` and never replace non-empty values. |
| Remote DB has stale executors pointing at reused session IDs | Low | Dry-run reports duplicate matches and refuses apply on ambiguity. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```text
src/lib/session-capture.ts
src/services/executors/sdk-session-capture.ts
src/term-commands/sessions.ts
src/lib/session-link-repair.ts
src/lib/session-capture.test.ts
src/services/executors/__tests__/sdk-session-capture.test.ts
.genie/wishes/fix-agent-session-linkage/REPORT.md
```
