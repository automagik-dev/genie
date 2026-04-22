# Wish: Agent Row Unification

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `agent-row-unification` |
| **Date** | 2026-04-21 |
| **Design** | _No brainstorm — direct wish_ (origin: `turn-session-contract` Execution Review, Gap #1) |

## Summary

Retire the legacy `register()` code path in `src/lib/agent-registry.ts` that inserts name-keyed agent rows alongside the UUID-keyed identity rows created by `findOrCreateAgent()`. Merge runtime state columns (`pane_id`, `session`, `state`, `claude_session_id`, etc.) onto the identity row so every agent is represented by exactly one row. Migrate existing dual-row data by consolidating pairs matched on `(custom_name, team)` into their identity row, then dropping the legacy rows. This closes the turn-session-contract Gap #1 (`genie done` can't flip the correct state row because executor FK and runtime state live on different rows) and eliminates an entire class of ghost-resume loops where closed executors can't mark their concrete agents terminal.

## Scope

### IN
- Migrate existing dual-row data: for each `(custom_name, team)` pair, merge the legacy row's runtime columns onto the identity row and delete the legacy row.
- Delete `register()` from `src/lib/agent-registry.ts`.
- Refactor all `register()` callers to use `findOrCreateAgent()` + new `updateAgentRuntime()` (or equivalent single-row UPSERT on the identity PK).
- Extend `findOrCreateAgent()` (or add `ensureAgentWithRuntime()`) to accept the runtime fields `register()` currently sets, idempotent by `(custom_name, team)` lookup.
- Update `turnClose()` in `src/lib/turn-close.ts` to flip `state='done'` on the identity row (not via `current_executor_id` FK chase) so a closed turn marks the canonical agent terminal.
- Update `reconcileDeadPaneZombies`, `runAgentRecoveryPass`, `attemptAgentResume`, and the turn-aware reconciler's D1/D3 rules to operate on identity rows only.
- Delete the `dir:<name>` row creation path if it's the same legacy code; otherwise migrate it to use identity rows.
- Add a regression migration `NNNN_unify_agent_rows.sql` that merges and deletes in a single transaction.
- Cross-team collision logic (the 2026-04-19 incident code at `agent-registry.ts:235-264`) preserved but moved to `findOrCreateAgent()`.
- Tests: unit tests for the merge migration, integration tests for spawn → turn-close → reconcile on a unified row, regression test for the ghost-resume-after-done scenario (`turn-session-contract` Gap #1 symptom).

### OUT
- The `dir:*` registration from `agent-directory.json` as a user-facing concept stays — only the PG row representation changes.
- Omni-side changes. This is a genie-internal schema change.
- Web UI for agent inspection (separate wish).
- Tmux pane ownership / pane_id semantics change — `pane_id` stays on agent rows, just consolidated onto the identity row.
- Executor schema changes — `executors.agent_id` keeps pointing at UUIDs; the migration ensures every executor's `agent_id` resolves to a valid identity row.

## Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| D1 | Identity row (UUID-keyed, from `findOrCreateAgent`) becomes the ONLY row. Legacy name-keyed row is eliminated. | Single source of truth. Executor FK, runtime state, team membership, and identity live in one place. Eliminates the "which row do I update?" ambiguity. |
| D2 | Migration merges legacy → identity, not the other way. Legacy rows are deleted. | Identity rows already carry stable UUIDs that executors FK to (via `executors.agent_id`). Flipping direction would orphan the executor FK chain. |
| D3 | `register()` deleted; `findOrCreateAgent()` extended to take optional runtime fields and UPSERT by `(custom_name, team)`. | Fewer public functions, single path. Readers don't have to wonder which one is canonical. Ergonomist principle: *APIs before implementations.* |
| D4 | Migration is additive first (Phase A adds helper + runs a dry-run count), destructive second (Phase B deletes). Feature flag `GENIE_UNIFIED_AGENT_ROWS` gates the new path. | Reversibility > deploy speed (same pattern as turn-session-contract). |
| D5 | Cross-team collision logic from `register()` (lines 235-264) moved verbatim to `findOrCreateAgent()`. | The 2026-04-19 cross-team incident comment is battle-tested guardrail code. Don't lose it. |
| D6 | Migration runs per-pair transaction. A failed merge on one pair does not abort the batch. | A malformed legacy row shouldn't block 1,000 good merges. Failed pairs are logged to an `agent_unification_failures` table for operator review. |
| D7 | Executor FK `executors.agent_id → agents.id` stays as-is. Migration verifies every executor's `agent_id` resolves post-merge. | If it doesn't resolve, the executor is orphaned and the migration rolls back the pair. |

## Success Criteria

- [ ] **C1** Every agent in `agents` has exactly one row (no duplicates by `custom_name + team`). Post-migration SELECT verifies.
- [ ] **C2** Every `executors.agent_id` FK resolves to a valid `agents.id` row. No orphaned executors.
- [ ] **C3** `turnClose()` writes `state='done'` on the identity row directly (via executor's `agent_id`), not via reverse-FK lookup. Integration test: call `genie done` with a spawned agent, assert `agents.state='done'` within the same transaction.
- [ ] **C4** The `genie done` → reconcile resurrection loop (turn-session-contract Gap #1) no longer reproduces. Regression test spawns agent, calls `genie done`, simulates daemon restart, asserts no auto-resume event within 60s.
- [ ] **C5** `register()` function is deleted from `src/lib/agent-registry.ts`. `rg 'register\(' src/` returns zero matches for direct calls (excluding `findOrCreateAgent`).
- [ ] **C6** All existing callers of `register()` now use `findOrCreateAgent()` (with optional runtime fields) or `updateAgentRuntime()`.
- [ ] **C7** Migration `NNNN_unify_agent_rows.sql` applies cleanly to both fresh and populated DBs.
- [ ] **C8** Migration is idempotent — running twice merges nothing new the second time.
- [ ] **C9** Cross-team collision logic preserved — test that reproduces the 2026-04-19 incident still fails loudly.
- [ ] **C10** Feature flag `GENIE_UNIFIED_AGENT_ROWS` gates the new writer path in Phase A; removed in Phase C.
- [ ] **C11** `agent_unification_failures` table captures any pair that couldn't be merged (with reason).
- [ ] **C12** `bun run check` passes with zero regressions.
- [ ] **C13** `bun test` passes; no existing tests broken by the migration.
- [ ] **C14** `auto-resume-zombie-cap.test.ts` gets a new `describe('unified-row contract')` block verifying the ghost-loop is closed.

## Execution Strategy

Dependency graph: `G1 → G2 → G3 → G4a → G4b → G4c → G4d → G5`; G6 runs in parallel with G3/G4*. G7 (flag removal) blocks on 7-day soak after G5. Each sub-group in G4 is a separate PR — progressive, individually reverting.

### Wave 1 (solo — schema + helpers)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Extend `findOrCreateAgent()` + add `updateAgentRuntime()`. Add `GENIE_UNIFIED_AGENT_ROWS` flag scaffolding with XOR semantics. Audit + document all `INSERT INTO agents` sites. No behavior change when flag off. |

### Wave 2 (parallel — consumers migrate + ops tooling)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Migrate all `register()` call sites to the new API behind XOR flag. Migrate test fixtures. |
| 6 | engineer | Dry-run / apply / rollback scripts + runbook + `genie doctor` integration. |

### Wave 3 (solo — destructive migration)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | Phase B migration: FK rewrite + archive + per-pair merge + post-migration FK verification. Writes to `agent_unification_failures` on conflict. Rollback script smoke-tested. |

### Wave 4 (sequential — flip, delete, rewrite) — each sub-group is its own PR
| Group | Agent | Description |
|-------|-------|-------------|
| 4a | engineer | Flip `GENIE_UNIFIED_AGENT_ROWS` default to `true`. No code deletion. |
| 4b | engineer | Delete `register()` + remove flag branches. Dead-code pass. |
| 4c | engineer | Rewrite `turnClose()` to flip identity-row state directly. Closes turn-session-contract Gap #1. |
| 4d | engineer | Rewrite reconcile loops to read identity row. Boot-mode terminal-state check. Closes turn-session-contract Gap #2. |

### Wave 5 (parallel — evidence + review)
| Group | Agent | Description |
|-------|-------|-------------|
| 5 | engineer | Evidence package for turn-session-contract's next review cycle. **Does not** edit parent wish. |
| review | reviewer | Plan + execution review against criteria. |

### Wave 6 (after ≥7-day soak — cleanup)
| Group | Agent | Description |
|-------|-------|-------------|
| 7 | engineer | Remove `GENIE_UNIFIED_AGENT_ROWS` flag + `isUnifiedAgentRowsEnabled()` helper. Drop `agents_legacy_archive` table (if all archived rows older than soak window). |

## Execution Groups

### Group 1: API extension + flag scaffolding
**Goal:** Add the unified-row writer surface without changing current behavior.

**Deliverables:**
1. Extend `findOrCreateAgent(name, team, role)` signature to `findOrCreateAgent(identity, runtime?)` where `runtime` is an optional `AgentRuntime` type with `paneId`, `session`, `state`, `claudeSessionId`, `wishSlug`, `taskId`, etc.
2. New `updateAgentRuntime(agentId, runtime)` helper that UPDATEs identity row with runtime fields by `id`.
3. `GENIE_UNIFIED_AGENT_ROWS` env flag read in `src/lib/agent-registry.ts`. **XOR semantics**: flag off → only legacy `register()` runs (current behavior preserved); flag on → only `findOrCreateAgent()+updateAgentRuntime()` runs. Never both simultaneously — DB state is predictable at every moment.
4. Cross-team collision check (the 2026-04-19 incident logic from `register()` lines 235-264) moved to `findOrCreateAgent()`.
5. Unit tests covering: new signature, runtime UPSERT, collision rejection.

**Acceptance Criteria:**
- [ ] `bun run typecheck` clean
- [ ] `findOrCreateAgent(name, team, role, runtime)` returns identity row with runtime fields persisted
- [ ] Cross-team collision test passes
- [ ] Flag-off path preserves legacy `register()` behavior bit-for-bit
- [ ] **Audit complete:** `rg "INSERT INTO agents" src/ scripts/` enumerates all insertion sites. Count matches manual review.
- [ ] **Decision document:** `.genie/wishes/agent-row-unification/insertion-sites-audit.md` records every site found, classifies each as (a) in-scope for migration, (b) test-fixture for update, or (c) out-of-scope legacy to preserve. If a third `dir:*` registration path (from `agent-directory.json`) is distinct, document whether it joins this wish or spawns a sibling wish.

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/agent-registry.test.ts && bun run check && test -f .genie/wishes/agent-row-unification/insertion-sites-audit.md
```

**depends-on:** none

---

### Group 2: Caller migration behind flag
**Goal:** Every call to `register()` also calls `findOrCreateAgent()+updateAgentRuntime()` when flag is on.

**Deliverables:**
1. Audit all `register()` call sites from Group 1's `insertion-sites-audit.md`. Current known: `src/lib/claude-native-teams.ts`, `src/term-commands/agent/spawn.ts`, `src/hooks/handlers/session-sync.ts`, tmux wrapper.
2. Each call site gets a `if (isUnifiedAgentRowsEnabled()) { findOrCreateAgent+updateRuntime } else { register() }` branch, respecting **XOR flag semantics** (see G1). Only one path runs per flag state.
3. **Migrate test fixtures.** Direct-INSERT sites in test files — `src/__tests__/tui-spawn-dx.integration.test.ts:66`, `src/db/migrations/044_phase_b_flip_defaults.test.ts:63/78/94/114`, `src/lib/pg-seed.test.ts:126/133` — are updated to use the unified-row shape OR explicitly flagged as legacy-only fixtures with an env guard that forces `GENIE_UNIFIED_AGENT_ROWS=0` for that test.
4. Integration test: spawn a fresh agent with flag on, verify exactly one row exists in `agents` table, verify runtime fields populated.
5. Integration test: spawn same agent name in different team with flag on, verify cross-team collision rejects loudly.

**Acceptance Criteria:**
- [ ] Every `register()` call site has an if/else branch with XOR flag semantics
- [ ] Flag-on spawn produces exactly one row; flag-off produces exactly one row (the legacy row). **No dual rows in either flag state.**
- [ ] Test fixtures migrated per Deliverable #3 — `rg "INSERT INTO agents" src/ test/` returns no new direct-INSERTs
- [ ] `bun run check` passes under both `GENIE_UNIFIED_AGENT_ROWS=1` and `GENIE_UNIFIED_AGENT_ROWS=0`
- [ ] Existing tests unchanged (no behavioral regression under flag off)

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && GENIE_UNIFIED_AGENT_ROWS=1 bun test src/__tests__/tui-spawn-dx.integration.test.ts && bun run check
```

**depends-on:** Group 1

---

### Group 3: Merge migration (Phase B — destructive)
**Goal:** Consolidate existing dual-row pairs into identity rows, drop legacy rows.

**Deliverables:**
1. Migration `NNNN_unify_agent_rows.sql`:
   - Find all pairs: `(legacy.id = legacy.custom_name)` AND `(identity.custom_name, identity.team) = (legacy.custom_name, legacy.team)` AND `identity.id` is a UUID.
   - **For each pair, in a single transaction, in this order:**
     1. **Copy legacy row into `agents_legacy_archive`** (preserves rollback capability for the 7-day soak window).
     2. **Update `executors.agent_id`** for any executor referencing the legacy row's id: `UPDATE executors SET agent_id = <identity.id> WHERE agent_id = <legacy.id>`. If any executor rows are updated, log a warning audit event — this instance has pre-`findOrCreateAgent()` executors that were pointing at legacy rows.
     3. **Merge runtime fields** from legacy into identity row (pane_id, session, state, claude_session_id, wish_slug, task_id, etc.). `last_state_change`-based winner on conflicting fields.
     4. **DELETE legacy row.**
     5. **Emit audit event** `agent.unified` with both IDs + runtime field source.
   - On constraint violation or unresolvable state, INSERT into `agent_unification_failures` with pair IDs + reason; roll back that pair only; continue batch.
   - **Post-migration verification (same transaction batch):** `SELECT COUNT(*) FROM executors e LEFT JOIN agents a ON e.agent_id = a.id WHERE a.id IS NULL` must equal 0. Orphaned executors abort the migration and trigger rollback for the batch window.
2. `agents_legacy_archive` table with same schema as `agents` plus `merged_at TIMESTAMPTZ DEFAULT now()`, `merged_into_id TEXT REFERENCES agents(id)`, `merge_reason TEXT`. Retained through Phase C soak, droppable by Group 7.
3. Dry-run script: `scripts/unify-agents-dry-run.ts` that prints a table of pairs-to-merge + count of executors that will be FK-rewritten, without mutating.
4. Apply script: `scripts/unify-agents-apply.ts` that requires typed confirmation (`I UNDERSTAND` match), runs in batches of 100, emits audit events, is resumable on crash.
5. Rollback script: `scripts/unify-agents-rollback.ts` that, given a merge batch id or timestamp range, copies rows from `agents_legacy_archive` back to `agents` and reverses `executors.agent_id` updates. **Smoke-tested before G4 runs; not invoked unless G4 introduces a regression.**
6. Test fixtures: seeded dual-row pairs in a tmpdir PG (including executor FK pointing at legacy row), migration run, assert convergence + FK resolution + archive population.

**Acceptance Criteria:**
- [ ] Dry-run on fixture DB shows N pairs + M executor FK rewrites, mutates nothing
- [ ] Apply on fixture DB: `agents` row count reduces by N; `agents_legacy_archive` row count = N; zero orphaned executors post-migration
- [ ] Apply is resumable — kill mid-batch, re-run, converges without double-merging
- [ ] Re-running apply is a no-op once convergence is reached
- [ ] `agent_unification_failures` captures any unresolvable case with clear reason
- [ ] Audit event per merge: `agent.unified` with before/after row IDs and archive ref
- [ ] **Rollback script smoke test:** apply migration on fixture, run rollback, assert original dual-row state restored exactly

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/db/migrations/NNNN_unify_agent_rows.test.ts && bun run scripts/unify-agents-dry-run.ts --help
```

**depends-on:** Group 1

---

### Group 4a: Flip flag default to true
**Goal:** `GENIE_UNIFIED_AGENT_ROWS` defaults to on. No code deletion yet — legacy branches still callable via `=0` override.

**Deliverables:**
1. Change default return of `isUnifiedAgentRowsEnabled()` from `false` to `true` in `src/lib/agent-registry.ts`.
2. Update telemetry logger to include flag state at serve startup.
3. Release note: "Phase B active — agent rows now unified by default. Run `GENIE_UNIFIED_AGENT_ROWS=0` to temporarily revert if regression discovered."

**Acceptance Criteria:**
- [ ] Default flag state is `true` when env var unset
- [ ] Startup log reports `unified_agent_rows=on`
- [ ] Existing tests pass (they exercise both paths via explicit env override)
- [ ] `bun run check` passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun run check && unset GENIE_UNIFIED_AGENT_ROWS && bun test src/lib/agent-registry.test.ts
```

**depends-on:** Groups 2, 3

---

### Group 4b: Delete `register()` + remove flag branches
**Goal:** Legacy code path physically deleted from source. Flag state becomes irrelevant (only the unified path exists).

**Deliverables:**
1. Delete `register()` function from `src/lib/agent-registry.ts`.
2. Remove all `if (isUnifiedAgentRowsEnabled())` / `else` branches from callers audited in Group 2 — keep only the unified path.
3. Mark `isUnifiedAgentRowsEnabled()` as deprecated (always returns true); remove in Group 7.
4. Update imports — `register` no longer exported.

**Acceptance Criteria:**
- [ ] `rg 'function register\(' src/` returns zero matches
- [ ] `rg 'agents\.register\(' src/` (after lib rename) returns zero matches
- [ ] `rg 'if \(isUnifiedAgentRowsEnabled' src/` returns zero matches
- [ ] `bun run check` passes with no unused-import warnings
- [ ] `bun run dead-code` (knip) returns no new regressions tied to the deletion

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && rg 'function register\(' src/ ; bun run check && bun run dead-code
```

**depends-on:** Group 4a

---

### Group 4c: Rewrite `turnClose()` to flip identity row directly
**Goal:** Close verbs mark the canonical agent terminal without chasing reverse-FK links. Closes turn-session-contract Gap #1.

**Deliverables:**
1. Rewrite the UPDATE inside `turnClose()` (`src/lib/turn-close.ts`):
   - **Before:** `UPDATE agents SET current_executor_id=NULL WHERE current_executor_id=${executorId}`
   - **After:** `UPDATE agents SET state='done', current_executor_id=NULL WHERE id=(SELECT agent_id FROM executors WHERE id=${executorId})`
2. Keep the atomic transaction envelope; the SELECT and UPDATE stay in the same transaction.
3. Add defensive check: if the inner SELECT returns NULL (executor has no agent_id — should never happen post-G3), emit a warn-level audit event and skip the agent update (but still close the executor).
4. Update `turn-close.test.ts`: new tests for (a) state flips to 'done' post-close, (b) defensive skip when executor has NULL agent_id, (c) atomic rollback when the UPDATE targets a non-existent agent row.

**Acceptance Criteria:**
- [ ] Agent row state flips to `'done'` in same transaction as executor close
- [ ] Defensive-path test passes (NULL agent_id)
- [ ] Atomic rollback test passes (inject failure, verify no partial writes)
- [ ] `bun test src/lib/turn-close.test.ts` passes
- [ ] `bun run check` passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/turn-close.test.ts && bun run check
```

**depends-on:** Group 4b

---

### Group 4d: Reconcile loop reads identity row + boot-mode terminal check
**Goal:** Reconciler + auto-resume consistently treat the identity row as canonical. Closes turn-session-contract Gap #2 (boot-mode bypass).

**Deliverables:**
1. Update `reconcileDeadPaneZombies`, `runAgentRecoveryPass`, `handleDeadPane`, `attemptAgentResume` in `src/lib/scheduler-daemon.ts` and `src/lib/agent-registry.ts` to read identity row state directly (no more legacy-row fallbacks).
2. **Boot-mode terminal-state check** (closes turn-session-contract Gap #2): before running `attemptAgentResume()` in `mode === 'boot'`, query the agent's `current_executor_id` — if that executor has `closed_at IS NOT NULL` OR `outcome IS NOT NULL`, skip resume (agent was legitimately closed pre-restart).
3. New helper `isLegitimatelyClosed(agent, deps)` that encapsulates the check for reuse across sweep + boot.
4. Update `scheduler-daemon.test.ts`: new tests for (a) boot-mode on properly-closed agent does not resume, (b) boot-mode on mid-turn agent does resume, (c) sweep-mode unchanged.

**Acceptance Criteria:**
- [ ] Boot-mode test: spawn agent → `genie done` → restart daemon → no resume event within 60s
- [ ] Boot-mode test: spawn agent → simulate mid-turn crash (state='working', no close verb) → restart daemon → resume fires
- [ ] Sweep-mode tests unchanged
- [ ] `isLegitimatelyClosed()` unit test covers: closed executor, open executor, NULL executor_id, missing executor row
- [ ] `bun run check` passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/scheduler-daemon.test.ts src/lib/__tests__/auto-resume-zombie-cap.test.ts && bun run check
```

**depends-on:** Group 4c

---

### Group 5: Evidence package for turn-session-contract Review Results
**Goal:** Produce the evidence package that turn-session-contract's next `/review` cycle will consume to close Gaps #1, #3, #4. **This group does not edit the parent wish's Review Results section** — avoids circular ownership. The parent wish's reviewer owns that edit.

**Deliverables:**
1. Evidence doc: `.genie/wishes/agent-row-unification/turn-session-contract-evidence.md` that enumerates, for each parent-wish gap (#1, #3, #4):
   - Which Group here (G4c, G4d, etc.) closes it.
   - Proof command + expected output (e.g., `bun test src/lib/__tests__/auto-resume-zombie-cap.test.ts -t "boot-mode bypass"` → pass).
   - Live-instance verification steps an operator can run post-deploy.
2. Extend `src/lib/__tests__/auto-resume-zombie-cap.test.ts` with a `describe('unified-row contract — turn-session-contract Gap #1/#2/#4 coverage')` block.
3. Live-instance reproduction script: `scripts/ghost-resurrection-repro.ts` that seeds a dual-row state, walks through `spawn → done → restart → assert no resume`, emits PASS/FAIL for Gap #1.
4. Cross-reference: add a bidirectional link in both wishes' `Dependencies` sections pointing at this evidence doc.

**Acceptance Criteria:**
- [ ] Evidence doc exists and enumerates every parent-wish Gap explicitly
- [ ] New `describe` block in zombie-cap tests passes under unified-row flag on
- [ ] Repro script runs green on a freshly-unified instance
- [ ] No write to `turn-session-contract/WISH.md` from this wish's branches (verified by git log)

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/__tests__/auto-resume-zombie-cap.test.ts && bun run check
```

**depends-on:** Group 4

---

### Group 6: Dry-run and operational runbook
**Goal:** Operators can run the migration confidently.

**Deliverables:**
1. `scripts/unify-agents-dry-run.ts` CLI: reads pairs, prints a table with counts and sample rows.
2. `scripts/unify-agents-apply.ts` CLI: typed-confirmation apply + resumable (checkpoint per 100 pairs).
3. Operational runbook in `docs/runbooks/agent-row-unification.md`: pre-check list, rollback, failure-table triage.
4. `genie doctor` extended to report dual-row count with remediation link.

**Acceptance Criteria:**
- [ ] Dry-run runs against local PG and prints sensible output
- [ ] Apply script is idempotent and resumable
- [ ] `docs/runbooks/agent-row-unification.md` exists with worked example
- [ ] `genie doctor` reports dual-row count when flag is on

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun run scripts/unify-agents-dry-run.ts --help && genie doctor
```

**depends-on:** Group 3 (parallel with Groups 4/5)

---

### Group 7: Phase C — flag removal + cleanup
**Goal:** Retire `GENIE_UNIFIED_AGENT_ROWS` after ≥7-day soak.

**Deliverables:**
1. Remove `GENIE_UNIFIED_AGENT_ROWS` flag read.
2. Migrate `agent_unification_failures` to permanent observability (or drop if empty).
3. Delete runbook's rollback section; keep the success path.
4. Release notes.

**Acceptance Criteria:**
- [ ] `rg GENIE_UNIFIED_AGENT_ROWS src/` returns zero
- [ ] `bun run check` passes
- [ ] Release notes merged

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && rg GENIE_UNIFIED_AGENT_ROWS src/ && bun run check
```

**depends-on:** Group 5 + 7-day soak

---

## Dependencies

- **depends-on:** `turn-session-contract` — this wish consumes the `executors.agent_id` FK that turn-session-contract established. Must merge on top of a working turn-session-contract branch.
- **depends-on:** `unified-executor-layer` (already merged, per turn-session-contract's reference).
- **blocks:** nothing directly, but **unblocks** turn-session-contract's SHIP — without this, Gap #1 cannot close cleanly.

### Boundary Contracts

The only cross-repo contract exposed by this wish: `agents.id` remains a string (UUID after migration, but the column type doesn't change). External consumers (omni, tools) that query `agents` by `id` are unaffected as long as they accept any string ID.

---

## QA Criteria

_Verified on dev after merge. QA agent tests each criterion._

- [ ] Spawn a fresh agent, verify exactly one row exists in `agents`
- [ ] Call `genie done` on that agent, verify `agents.state='done'` within 1s
- [ ] `tmux kill-pane` without `genie done`, verify pane-trap writes `clean_exit_unverified` to the same identity row
- [ ] Daemon restart (serve kill + restart) on a properly-closed agent → agent stays `state='done'`, no resume event
- [ ] Daemon restart on a mid-turn agent (state='working') → agent resumes correctly
- [ ] Cross-team collision test (2026-04-19 scenario) still rejects loudly
- [ ] Apply migration on a populated fixture DB — no orphaned executors, `agent_unification_failures` empty (or accounted for)
- [ ] `genie ls` shows unified rows with correct state/pane/session
- [ ] `executors.agent_id` is never NULL for non-skeleton executors
- [ ] No regression in turn-session-contract's existing QA criteria

---

## Assumptions / Risks

| ID | Risk | Severity | Mitigation |
|----|------|----------|------------|
| R1 | Live instances may have dual-row pairs where legacy runtime state is NEWER than identity row's metadata (e.g., identity row created stale, legacy row updated on resume) | HIGH | Migration copies legacy → identity; preserves the newer runtime state. `last_state_change` determines winner on conflict. |
| R2 | `register()` may have callers outside the obvious ones (hooks, tests, scripts) | HIGH | Group 2 does exhaustive grep + CI test run. `knip` configured to flag unused imports after deletion. |
| R3 | Some legacy rows may be orphaned (no matching identity row) | MEDIUM | Migration creates identity row from legacy data if missing, then merges. Logs to failures table. |
| R4 | Executor FK may point at legacy row (not identity row) in some edge cases | MEDIUM | Migration's FK-resolution verification catches this. Rollback pair + log. |
| R5 | tmux pane ownership changes during migration window | MEDIUM | Migration runs under `serve` lock or during planned maintenance. Dry-run first. |
| R6 | Code outside `src/lib/agent-registry.ts` may directly INSERT into `agents` with a name-keyed `id` | HIGH | Group 2 audit must grep for `INSERT INTO agents` across all of `src/`. Tests use the helper, not raw INSERT. |
| R7 | Phase C cleanup removes `agent_unification_failures` before operators review | LOW | 7-day soak + runbook step requires triage confirmation before Group 7 runs. |
| R8 | The `dir:<name>` registration pattern (from `agent-directory.json`) may be a third distinct code path | MEDIUM | Group 1 audit (`insertion-sites-audit.md`) must include this. If it's a third path, G1 decision doc records in-scope vs sibling-wish resolution. |
| R9 | Destructive merge in G3 has no natural rollback window — Phase C runs 7 days after. | MEDIUM (mitigated) | `agents_legacy_archive` table retains pre-merge rows for the entire soak. Rollback script restores them + reverses executor FK updates. Drop only after G7 runs post-soak. |
| R10 | Splitting G4 into 4 PRs multiplies merge conflicts if other work touches `agent-registry.ts` / `turn-close.ts` / `scheduler-daemon.ts` during the window | MEDIUM | Sequence G4a→G4b→G4c→G4d as a single-engineer serialized effort; coordinate with turn-session-contract merges; target all four PRs within 48h. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
Created:
  src/db/migrations/NNNN_unify_agent_rows.sql
  src/db/migrations/NNNN_unify_agent_rows.test.ts
  scripts/unify-agents-dry-run.ts
  scripts/unify-agents-dry-run.test.ts
  scripts/unify-agents-apply.ts
  scripts/unify-agents-apply.test.ts
  docs/runbooks/agent-row-unification.md

Modified:
  src/lib/agent-registry.ts            (delete register(); extend findOrCreateAgent + new updateAgentRuntime)
  src/lib/agent-registry.test.ts
  src/lib/turn-close.ts                 (flip state='done' on identity row directly)
  src/lib/turn-close.test.ts
  src/lib/scheduler-daemon.ts           (reconcile reads identity row; boot-mode respects executor terminal state)
  src/lib/scheduler-daemon.test.ts
  src/lib/__tests__/auto-resume-zombie-cap.test.ts  (new describe: unified-row contract)
  src/lib/claude-native-teams.ts        (caller migration)
  src/term-commands/agent/spawn.ts      (caller migration)
  src/hooks/handlers/session-sync.ts    (caller migration)
  src/__tests__/tui-spawn-dx.integration.test.ts (fixture update)
  .genie/wishes/turn-session-contract/WISH.md  (Review Results — close Gaps #1, #3, #4)
  README.md                             (release notes)
  CHANGELOG.md
```
