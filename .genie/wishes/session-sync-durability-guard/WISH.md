# Wish: Session-Sync Durability Guard

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `session-sync-durability-guard` |
| **Date** | 2026-04-22 |
| **Author** | genie (with Felipe) |
| **Appetite** | small (~1–2 engineer-hours) |
| **Branch** | `wish/session-sync-durability-guard` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |
| **Parent trace** | `/home/genie/workspace/agents/genie/brain/reflections/2026-04-22-session-backfill-trace.md` |
| **Issue** | Stale `session_sync` marker blocked Claude-session backfill indefinitely; `updateSyncState` never populated `started_at`; no schema guard caught it. |

## Summary

Prevent the session-backfill from ever getting stuck behind a stale `session_sync.status='complete'` marker that reports finished work without a real run. Fix the two bugs that let the condition exist: (1) `updateSyncState` in `session-backfill.ts` never writes `started_at` on the initial INSERT, and (2) the schema accepts a 'complete' row with `started_at=NULL`, which is semantically impossible for a real run. Both must be fixed together — the schema guard alone would reject writes from the current buggy code, so the code fix lands first in the same PR.

Context: 2026-04-22 investigation found `session_sync` with `status='complete'`, `processed_files=535`, `started_at=NULL`, but only 1 row in `sessions`. Manual reset (`DELETE FROM session_sync`) + daemon restart triggered the backfill cleanly → 709 JSONLs ingested, 56K content rows, 40K tool_events. Without these fixes, any future stale marker (migration test, dev reset, partial failure) will silently re-break Claude observability.

## Scope

### IN

- Modify `updateSyncState` in `src/lib/session-backfill.ts` to populate `started_at = now()` on the initial INSERT when `status='running'` and the row does not already exist (ON CONFLICT → keep original `started_at` on subsequent updates).
- Add a new migration `048_session_sync_require_started_at.sql` (or next available number) that:
  - Backfills `started_at = updated_at` for any existing row where `started_at IS NULL` (so the migration is idempotent against current disk state).
  - Alters `session_sync.started_at` to `NOT NULL`.
  - Adds a CHECK constraint ensuring `status='complete' OR status='failed'` implies `updated_at >= started_at` (so a 'complete' row cannot claim zero-time execution).
- Unit tests in `src/lib/__tests__/session-backfill.test.ts` (or extend existing):
  - `updateSyncState` writes `started_at=now()` on first insert.
  - Subsequent updates do not overwrite `started_at`.
  - `shouldSkipBackfill` still returns true for legitimate 'complete' rows (regression guard).
- Integration test (Bun test against a temp PG schema): simulate a fresh run + a resumed run, assert `started_at` is stable across updates and the CHECK constraint rejects zero-time 'complete'.

### OUT

- **Cost extraction from JSONL `usage` field into PG** — separate wish, feature work, bigger scope. (Follow-up: `session-cost-extraction`.)
- **Retry semantics** — adding automatic retry for failed backfills or exponential backoff. Current "restart daemon to retry" workflow is fine for this wish.
- **Filewatch reliability improvements** — a separate observability stream; scope creep.
- **UI/dashboard surfaces** for `session_sync` state — the `onboarding-unification` brainstorm covers that.
- **Legacy marker migration beyond backfill=NULL** — if other `session_sync` rows exist with bad data (not found in the trace), they stay untouched. The migration only backfills `started_at` from `updated_at`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Fix code + add schema guard in ONE wish | Schema-only change rejects writes from current code — must land together. |
| 2 | Backfill `started_at = updated_at` for existing rows, then apply NOT NULL | Avoids blocking migration on a legitimate historical row; trace confirmed no other rows exist so blast radius is tiny. |
| 3 | Add CHECK constraint `status IN ('complete','failed') ⇒ updated_at >= started_at` | Catches the observed pathology (marker reports success for work that never happened). Zero false positives expected. |
| 4 | Keep `shouldSkipBackfill` logic unchanged — only fix the upstream marker generation | Minimal-change principle; the skip logic is correct, it just trusted bad data. |
| 5 | No observability telemetry for marker writes added | One-shot fix; future stale markers would get caught by CHECK constraint + be obvious in DB queries. |

## Success Criteria

- [ ] `src/lib/session-backfill.ts::updateSyncState` populates `started_at` on first INSERT when status='running'; preserves it on UPDATE.
- [ ] Migration `NNN_session_sync_require_started_at.sql` applies cleanly on dev (no rows blocked, NOT NULL + CHECK in place).
- [ ] Unit tests pass: first-insert populates `started_at`, update preserves it, CHECK rejects zero-time complete marker.
- [ ] `bun run check` passes (lint + typecheck + test).
- [ ] On a fresh DB, a single `startBackfill` run results in `session_sync.status='complete'`, `started_at` populated, `updated_at > started_at`, `sessions` count > 0.
- [ ] On a DB with a legitimate `status='complete'` row (started_at + updated_at valid, sessions populated), `shouldSkipBackfill` correctly returns true — no regression to the skip path.

## Execution Strategy

One wave, one group — scope is small enough to land in a single PR without parallelism.

### Wave 1 (sequential)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Code fix + migration + tests, opened as one PR to `dev`. |

## Execution Groups

### Group 1: Session-Sync Durability Fix

**Goal:** Ship the minimal code + schema change that makes a stale 'complete' marker with `started_at=NULL` structurally impossible.

**Deliverables:**
1. `src/lib/session-backfill.ts` — `updateSyncState` writes `started_at = now()` on INSERT when `status='running'`; `ON CONFLICT DO UPDATE` preserves the original `started_at`.
2. `src/db/migrations/NNN_session_sync_require_started_at.sql` — backfill NULL `started_at` from `updated_at`, add `NOT NULL` + `CHECK` constraint.
3. `src/lib/__tests__/session-backfill.test.ts` — 3 new tests covering first-insert populates, update preserves, CHECK rejects zero-time complete.
4. PR to `dev` with `Closes <trace-issue-if-filed>`, test plan, and migration dry-run output in the body.

**Acceptance Criteria:**
- [ ] Code: typecheck + lint + unit tests green.
- [ ] Migration: applies on a fresh PG and on the current dev DB without errors (use `genie db query` to dry-run the backfill step first if needed).
- [ ] Integration: manual end-to-end reproducer — wipe `session_sync`, restart daemon, verify `started_at` populates, check `shouldSkipBackfill` still behaves correctly on the resulting 'complete' row.

**Validation:**
```bash
bun run check
bun test src/lib/__tests__/session-backfill.test.ts
genie db query "SELECT id, status, started_at, updated_at FROM session_sync"
```

**depends-on:** none

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: after a fresh `DELETE FROM session_sync WHERE id='backfill'` + daemon restart, the new row shows `status='running'` with `started_at` populated within 5s.
- [ ] Integration: backfill finishes with `status='complete'`, `updated_at > started_at`, `sessions` count matches ccusage-reported session count within a reasonable delta.
- [ ] Regression: running `shouldSkipBackfill` against the post-completion row returns true (skip logic intact); `genie sessions sync` CLI still prints progress correctly.
- [ ] Regression: `session-filewatch` continues to write session rows on new JSONL activity after the backfill completes.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Migration fails on a non-genie DB with `session_sync` in a weird state | Low | Migration first backfills NULL → `updated_at`, then applies NOT NULL. Atomic, idempotent. |
| Adding `NOT NULL` during daemon restart causes transient failure if a row is being inserted | Low | Migration runs in a transaction; scheduler daemon retries on PG failure. |
| CHECK constraint false-positives on legitimate backfills that finish in <1ms | Very Low | `updated_at >= started_at` (not strict >), so equal timestamps pass. |
| Future updates to `updateSyncState` accidentally overwrite `started_at` | Medium | Unit test locks this behavior; any regression will fail CI. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/session-backfill.ts                         (modify — updateSyncState)
src/db/migrations/NNN_session_sync_require_started_at.sql   (create)
src/lib/__tests__/session-backfill.test.ts          (modify or create — 3 tests)
```

---

## Follow-up wishes (NOT in scope here)

- `session-cost-extraction` — parse `usage` field from JSONL turns during ingest, populate a new `session_turn_costs` table (or add `input_tokens/output_tokens/cost_usd` columns to `tool_events`). Unblocks PG as full cost source-of-truth; removes dependency on ccusage disk scan for the dashboard.
- `onboarding-unification` (paused at Phase 1 / Q10-Q11 in `.genie/brainstorms/onboarding-unification/DRAFT.md`) — resumes once this durability fix lands; dashboard can then safely rely on PG cost + tool data.
