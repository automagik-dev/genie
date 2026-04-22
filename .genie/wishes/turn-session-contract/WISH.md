# Wish: Turn-Session Contract — Genie Side

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `turn-session-contract` |
| **Date** | 2026-04-19 |
| **Design** | _No brainstorm — direct wish_ (cross-repo design in [namastexlabs/genie-configure](https://github.com/namastexlabs/genie-configure/blob/main/.genie/brainstorms/turn-session-contract/DESIGN.md)) |

## Summary

Ship the genie-side of the turn-session contract: explicit turn-close verbs (`genie done` / `blocked` / `failed`), atomic single-transaction close across `executors` + `agents` + `audit_events`, a reconciler that no longer ghost-resumes idle agents with dead panes, a pane-exit trap as safety net, `GENIE_EXECUTOR_ID` env contract, and a staged reconciliation migration that terminalizes existing orphan rows without touching live agents. This wish is the CLOSE half of the agent-turn primitive; `omni-turn-based-dx` owns OPEN.

## Scope

### IN
- Turn-close verbs with context-dispatch (`GENIE_AGENT_NAME` env vs wish-group ref)
- Executor schema enrichment (`turn_id`, `outcome`, `closed_at`, `close_reason`)
- Executor read endpoint for external consumers (omni scope-enforcer)
- Reconciler semantics rewrite (D1/D3 from DESIGN.md)
- Pane-exit trap (tmux hook + shell trap for inline)
- Skill contract enforcement — every built-in skill ends with a close verb
- `GENIE_EXECUTOR_ID` env propagation across all spawn paths
- Staged migration: additive schema → manual reconcile → default flip → flag removal

### OUT
- Omni-side changes (see `omni/.genie/wishes/turn-session-contract` — this wish `blocks` that one)
- Changes to `omni connect` env sandbox (owned by `omni-turn-based-dx`)
- Replacing tmux transport (owned by `unified-executor-layer`)
- Web UI for executor/turn inspection
- Automated outcome inference from transcript — outcome is always explicit

## Decisions

| Decision | Rationale |
|----------|-----------|
| D1: idle+dead → `error`/`clean_exit_unverified`, never resume | Preserves forensic signal without ghost loops |
| D2: layered defense (skills + trap, idempotent) | Correct outcome attribution + crash safety |
| D3: resume only for `working/permission/question` + dead pane | Matches turn-as-focused-problem model |
| D4: verbs `genie done` / `blocked` / `failed` with context-dispatch | Outcome word is the command; preserves `genie done <ref>` muscle memory |
| D5: single genie-PG transaction for close | Atomicity without cross-DB coupling |
| D7: staged migration with `GENIE_RECONCILER_TURN_AWARE` flag | Reversibility > deploy speed |

See full decision rationale in DESIGN.md.

## Success Criteria

- [ ] **C1** `genie done`, `genie blocked`, `genie failed` verbs exist with context-dispatch. `genie done` with no args inside an agent session closes the turn; `genie done <slug>#<group>` still marks a wish group.
- [ ] **C2** Close transaction is atomic — all three writes (`executors`, `agents`, `audit_events`) commit or all roll back. Fault-injection test proves consistency.
- [ ] **C3** Reconciler never resumes `state=idle` + dead pane. Integration test with simulated clean exit asserts no resume event within 60s.
- [ ] **C4** Reconciler still resumes `state ∈ {working, permission, question}` + dead pane. Integration test for mid-turn crash.
- [ ] **C5** Pane-exit trap writes `state='error' outcome='clean_exit_unverified'` when pane dies without prior close verb. `tmux kill-pane` test asserts outcome within 10s.
- [ ] **C6** Every built-in skill ends with a close verb (`/work`, `/fix`, `/review`, `/refactor`, `/trace`, `/docs`, `/brainstorm`, `/refine`). Grep + skill-runner integration test.
- [ ] **C7** Executor read endpoint exposes `state`, `outcome`, `closed_at`. External process can query and get ground-truth values.
- [ ] **C8** `GENIE_EXECUTOR_ID` env var is set in every spawn path (tmux transport, SDK transport, inline).
- [ ] **C13** Phase A migration is additive-only (new columns, feature flag off, no behavior change).
- [ ] **C14** `reconcile-orphans --dry-run` prints preview of rows to terminalize without writing.
- [ ] **C15** `reconcile-orphans --apply` terminalizes orphan UUID + double-prefix rows without touching `last_state_change >= now() - 1h` or alive panes.
- [ ] **C16** Phase B migration flips `auto_resume DEFAULT false`; backfill sets `true` for live rows.
- [ ] **C17** Feature flag lifecycle: exists in A (off), enabled in B, removed in C.
- [ ] **C20** Ghost-loop regression test: replay 2026-04-19 scenario (stale pane_id, state=idle, auto_resume=true) → reconciler terminalizes, does not resume.

## Execution Strategy

Dependency graph: G1 → {G2, G6, G7}; G2 → {G3, G4, G5}; {G4, G5, G7} → G8; G8 → G9. Waves below reflect the actual ordering.

### Wave 1 (solo — schema + flag foundation)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Schema migration: add `turn_id`, `outcome`, `closed_at`, `close_reason` on `executors` + `GENIE_RECONCILER_TURN_AWARE` flag scaffolding |

### Wave 2 (parallel — Group 1 consumers)
| Group | Agent | Description |
|-------|-------|-------------|
| 2 | engineer | Turn-close verbs: `genie done` / `blocked` / `failed` with context-dispatch parser |
| 6 | engineer | Executor read endpoint (HTTP GET `/executors/:id/state` or readonly PG role) |
| 7 | engineer | `reconcile-orphans` script with `--dry-run` and `--apply` modes |

### Wave 3 (parallel — Group 2 consumers, behavior behind flag)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | `GENIE_EXECUTOR_ID` env propagation across all spawn paths + skill contract enforcement |
| 4 | engineer | New reconciler logic behind `GENIE_RECONCILER_TURN_AWARE` flag (flag off default) |
| 5 | engineer | Pane-exit trap (tmux + shell) writes `clean_exit_unverified` if verb didn't fire |

### Wave 4 (solo — phase B flip)
| Group | Agent | Description |
|-------|-------|-------------|
| 8 | engineer | Phase B migration: flip `auto_resume DEFAULT false`, backfill live rows, enable flag by default |
| review | reviewer | Review Groups 1-8 against Success Criteria |

### Wave 5 (after ≥7-day soak on Wave 4 — flag removal)
| Group | Agent | Description |
|-------|-------|-------------|
| 9 | engineer | Phase C migration: remove `GENIE_RECONCILER_TURN_AWARE` flag entirely |

## Execution Groups

### Group 1: Executor schema enrichment + flag scaffolding
**Goal:** Add new columns to `executors` and the reconciler feature flag without changing behavior.

**Deliverables:**
1. Drizzle migration adding `turn_id UUID`, `outcome TEXT`, `closed_at TIMESTAMPTZ`, `close_reason TEXT` columns on `executors` — all nullable.
2. `GENIE_RECONCILER_TURN_AWARE` env var read in scheduler-daemon.ts; no-op branch that logs "flag off, using legacy reconciler" when false.
3. Types updated in `src/types/` and exported.

**Acceptance Criteria:**
- [ ] Migration applies cleanly to fresh and existing DBs
- [ ] `bun run typecheck` passes
- [ ] `bun test` passes with existing tests unchanged (no behavior change)
- [ ] Flag-off path logs once at scheduler startup

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun run check
```

**depends-on:** none

---

### Group 2: Turn-close verbs
**Goal:** Ship `genie done`, `genie blocked`, `genie failed` with correct context-dispatch semantics.

**Deliverables:**
1. `src/term-commands/done.ts` extended: if `GENIE_AGENT_NAME` is set AND no positional ref arg → call `turnClose(outcome='done')`. Else → existing wish-group-done behavior.
2. `src/term-commands/blocked.ts` and `src/term-commands/failed.ts` added as siblings. Both require `--reason <msg>`.
3. `turnClose()` in `src/lib/turn-close.ts` executes the single genie-PG transaction (UPDATE executors + agents + INSERT audit_events).
4. Idempotency: `turnClose()` checks `executors.state` first; if already terminal, no-op and log.
5. Tests: `src/term-commands/done.test.ts` covers both dispatch paths; `src/lib/turn-close.test.ts` covers atomicity + idempotency.

**Acceptance Criteria:**
- [ ] `genie done` inside agent session (GENIE_AGENT_NAME set) writes terminal state
- [ ] `genie done <slug>#<group>` still works for team-lead wish groups
- [ ] `genie blocked --reason "..."` and `genie failed --reason "..."` write correct outcome
- [ ] Close verb is idempotent — second call on terminal executor is no-op
- [ ] Transaction rollback test: fail-inject on `audit_events` INSERT → `executors` and `agents` roll back
- [ ] `bun run check` passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/term-commands/done.test.ts src/lib/turn-close.test.ts
```

**depends-on:** Group 1

---

### Group 3: Env propagation + skill contract
**Goal:** Ensure `GENIE_EXECUTOR_ID` is set in every spawn path and every built-in skill ends with a close verb.

**Deliverables:**
1. Audit all spawn paths in `src/term-commands/agent/spawn.ts`, `src/term-commands/team/`, and `src/lib/tmux-wrapper.ts`. Each must export `GENIE_EXECUTOR_ID=<new executor uuid>` to the child env.
2. Update each skill prompt file in `skills/` (plugin cache) to append the close verb as the final instruction. Skills to update: `work`, `fix`, `review`, `refactor`, `trace`, `docs`, `brainstorm`, `refine`.
3. Test: spawn each executor type, exec `env | grep GENIE_EXECUTOR_ID` inside, assert non-empty UUID.
4. Test: dispatch `/brainstorm` through a sandbox, assert last agent action is a `genie done` call (by scanning transcript).

**Acceptance Criteria:**
- [ ] Every spawn path sets `GENIE_EXECUTOR_ID`
- [ ] Every built-in skill's prompt ends with explicit close-verb instruction
- [ ] Integration test confirms env propagation across tmux + SDK + inline
- [ ] Integration test confirms skill-end close-verb call

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/tmux-wrapper.test.ts && bun run check
```

**depends-on:** Group 2

---

### Group 4: Reconciler rewrite behind flag
**Goal:** New reconciler logic gated by `GENIE_RECONCILER_TURN_AWARE` flag.

**Deliverables:**
1. `src/lib/agent-registry.ts` reconciler passes:
   - Pass A (flag on): `state ∈ {working, permission, question}` + dead pane → resume (existing behavior, preserved).
   - Pass B (flag on): `state = idle` + dead pane → terminalize as `clean_exit_unverified`. **Do not resume.**
   - Pass C (flag off): existing legacy behavior unchanged.
2. Unit tests for all three passes. Integration tests that spawn, simulate clean exit, assert no resume within 60s.
3. Feature-flag telemetry: every reconciler run logs "mode=turn-aware" or "mode=legacy".

**Acceptance Criteria:**
- [ ] Flag off → legacy behavior preserved, zero regressions
- [ ] Flag on + clean exit → no resume, executor terminalized
- [ ] Flag on + mid-turn crash → resume still works
- [ ] Reconciler is idempotent — running twice produces same result

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/agent-registry.test.ts
```

**depends-on:** Group 2

---

### Group 5: Pane-exit trap (safety net)
**Goal:** When an agent's pane dies without calling a close verb, the trap writes `clean_exit_unverified` so no row is left in non-terminal state.

**Deliverables:**
1. tmux pane-exit hook installed at team-create time: runs `genie done --trap` when pane dies.
2. Shell trap for inline executors (bash/zsh `trap` on EXIT) that does the same.
3. `genie done --trap` mode: checks if executor is already terminal (idempotent with explicit close); if not, writes `outcome='clean_exit_unverified'`, `reason='clean_exit_unverified'`.
4. Test: spawn agent, `tmux kill-pane` mid-prompt without calling close verb, assert `executors.outcome='clean_exit_unverified'` within 10s.
5. Document which execution modes are covered (tmux ✅, inline-shell ✅, SDK ⚠️).

**Acceptance Criteria:**
- [ ] tmux pane death triggers trap; executor terminalized within 10s
- [ ] Shell exit triggers trap for inline executors
- [ ] Trap is idempotent vs explicit close — first writer wins
- [ ] SDK transport documented as known gap; follow-up task filed

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/pane-trap.test.ts
```

**depends-on:** Group 2

---

### Group 6: Executor read endpoint
**Goal:** External consumers (omni scope-enforcer) can query executor state.

**Deliverables:**
1. HTTP GET route on genie's existing daemon HTTP server: `GET /executors/:id/state` → `{state, outcome, closed_at}` JSON.
2. Bounded response time — target p99 < 10ms (single indexed SELECT).
3. No authz required (executor IDs are random UUIDs; read-only; no sensitive data).
4. Alternative/additional path: grant a readonly PG role that omni can use to query `executors` directly (documented in README).
5. Test: `curl` the endpoint, verify response shape matches schema.

**Acceptance Criteria:**
- [ ] Endpoint returns `{state, outcome, closed_at}` for existing executor
- [ ] Returns 404 for unknown executor ID
- [ ] p99 < 10ms under 100 req/s load
- [ ] Readonly PG role documented with exact GRANT statement

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test src/lib/executor-read.test.ts
```

**depends-on:** Group 1

---

### Group 7: `reconcile-orphans` script
**Goal:** One-shot script with `--dry-run` and `--apply` modes that terminalizes existing orphan + double-prefix rows.

**Deliverables:**
1. `scripts/reconcile-orphans.ts` with flags `--dry-run` (default) and `--apply`.
2. Criteria: rows where `pane_id IS NULL OR !isPaneAlive(pane_id)` AND `last_state_change < now() - interval '1 hour'` AND `state NOT IN ('terminal', 'error')`.
3. `--dry-run` prints a table: canonical_id, state, pane_id, last_state_change, action.
4. `--apply` requires typed confirmation (`I UNDERSTAND` exact match) before committing.
5. Script is idempotent: running twice produces no additional changes.
6. Audit event emitted per row: `reconcile.terminalize` with row id, state before, reason.

**Acceptance Criteria:**
- [ ] Dry-run on tmpdir fixture shows orphans, spares live agents
- [ ] Apply with confirmation terminalizes orphans
- [ ] Re-running apply is a no-op
- [ ] Audit events present for every change

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun test scripts/reconcile-orphans.test.ts
```

**depends-on:** Group 1

---

### Group 8: Phase B migration — default flip + flag enable
**Goal:** Flip `auto_resume DEFAULT false` globally, backfill live agents to `true`, enable `GENIE_RECONCILER_TURN_AWARE` flag by default.

**Deliverables:**
1. Drizzle migration: `ALTER TABLE agents ALTER COLUMN auto_resume SET DEFAULT false`.
2. Backfill: `UPDATE agents SET auto_resume = true WHERE state IN ('working','permission','question','idle') AND pane_id IS NOT NULL AND last_state_change > now() - interval '7 days'`.
3. Code: default value of `GENIE_RECONCILER_TURN_AWARE` flips from `false` to `true`.
4. Release notes document the behavior change + opt-in `--auto-resume` flag on `genie spawn`.
5. Pre-deploy checklist: run `reconcile-orphans --apply` successfully first; Group 7 must be green on staging.

**Acceptance Criteria:**
- [ ] Column default flipped to `false`
- [ ] Existing live agents have `auto_resume=true`
- [ ] New agents (from this point) default to `auto_resume=false` unless `--auto-resume` flag
- [ ] Reconciler flag enabled by default
- [ ] Release notes merged

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && bun run check && psql $GENIE_DATABASE_URL -c "\d agents" | grep auto_resume
```

**depends-on:** Groups 4, 5, 7

---

### Group 9: Phase C — remove feature flag
**Goal:** Retire `GENIE_RECONCILER_TURN_AWARE` after phase B has baked for ≥7 days with no regressions.

**Deliverables:**
1. Remove flag read from `src/lib/scheduler-daemon.ts`.
2. Delete legacy reconciler path (flag=off branch).
3. Simplify tests that covered both paths.
4. Document removal in release notes.

**Acceptance Criteria:**
- [ ] No `GENIE_RECONCILER_TURN_AWARE` references anywhere in src/
- [ ] Legacy reconciler code deleted
- [ ] Tests reduced and still cover both crash-resume and clean-exit cases
- [ ] `bun run check` passes

**Validation:**
```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie && rg GENIE_RECONCILER_TURN_AWARE src/ && bun run check
# The rg should return 0 matches
```

**depends-on:** Group 8 (and 7-day soak)

---

## QA Criteria

_Verified on dev after merge. QA agent tests each criterion._

- [ ] Spawn an agent, do work, call `genie done` — executor terminalizes, audit event present, next `omni send` via its key gets 401
- [ ] Spawn an agent, do work, `tmux kill-pane` without calling close verb — trap writes `clean_exit_unverified` within 10s
- [ ] Mid-turn crash (kill pane while `state=working`) — reconciler resumes correctly
- [ ] Clean exit (`state=idle` + pane dies) — reconciler terminalizes, no resume
- [ ] `reconcile-orphans --dry-run` on production DB shows expected candidate set
- [ ] `reconcile-orphans --apply` cleans orphans; re-run is no-op
- [ ] Ghost-loop regression test from 2026-04-19 fixtures passes
- [ ] Audit timeline: `genie events timeline <executor_id>` shows `turn.opened → turn.closed` with duration + outcome
- [ ] No behavior regression for existing `genie done <slug>#<group>` team-lead command

---

## Dependencies

- **depends-on:** `automagik-dev/genie#unified-executor-layer` — this wish extends the `executors` table that wish creates
- **blocks:** `automagik-dev/omni#turn-session-contract` — omni-side cannot ship until G1, G3, and G6 merge to dev

### Boundary Contracts (for omni-side consumers)

The omni wish `blocked-by` this one consumes three specific deliverables. These are the stable cross-repo contracts; no other groups here expose API surface to omni.

| Group | Contract | Consumer in omni wish |
|-------|----------|------------------------|
| **G1** | `executors.state` column + terminal-state values (`terminal`, `error`) | omni G3 scope-enforcer queries this column via readonly role OR read endpoint |
| **G3** | `GENIE_EXECUTOR_ID` env var set by every spawn path | omni G2 `omni connect` reads this env at mint time |
| **G6** | `GET /executors/:id/state` → `{state, outcome, closed_at}` JSON (or readonly PG role as alternative) | omni G3 scope-enforcer calls on every authz request |

Any change to these three surfaces after merge is a coordinated breaking change and must be negotiated cross-repo.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| R1: Reconciler rewrite breaks legitimate crash-recovery | High | D3 preserves resume for working/permission/question; integration tests cover both paths |
| R2: Pane-exit trap misses non-tmux shells | High | Layered defense; document covered modes; trap writes diagnostic outcome, not fatal |
| R9: `GENIE_EXECUTOR_ID` env propagation fails across subprocess boundaries | High | Verify in every spawn path during G3; fallback lookup by agent_name with loud failure |
| R6: Orphan dedup collides with live agents | Medium | G7 restricts to `last_state_change < now()-1h` AND dead pane; dry-run first |
| R7: Feature flag becomes permanent debt | Low | G9 explicitly removes it after 7-day soak |
| R8: `auto_resume DEFAULT false` breaks integrations | Low | G8 backfills live rows to true; opt-in flag for new spawns |

---

## Review Results

**Reviewed:** 2026-04-21 by `genie-configure` (Execution Review)
**Branch under test:** `fix/tmux-unreachable-crashes-spawn` @ `940b3b9b`
**Instance:** live genie serve on test team `turn-session-contract-genie` (the test team created exactly for validating this wish)
**Evidence source:** PG state + audit events from live reproduction, source code read at cited line numbers.

### Verdict: **FIX-FIRST**

Four CRITICAL/HIGH gaps prevent SHIP. Groups 1-8 have shipped code artifacts, but the acceptance criteria fail at runtime on a canonical test instance. Gap list below is ordered by severity and has executable next-step guidance.

### Checklist

| Criterion | Result | Evidence |
|-----------|:------:|----------|
| **C1** `genie done/blocked/failed` verbs with context-dispatch | ✅ PASS | `src/term-commands/{done,blocked,failed}.ts` all exist; audit log shows `turn_close.done` events firing correctly from CLI invocations at 02:16:09 and 02:16:21. |
| **C2** Atomic close transaction across executors + agents + audit_events | ⚠️ **PARTIAL** → see Gap #1 | `src/lib/turn-close.ts:89-134` is genuinely atomic. But the UPDATE on line 120 (`agents SET current_executor_id=NULL WHERE current_executor_id=${executorId}`) targets the wrong agent row — the UUID-keyed skeleton, not the name-keyed concrete row. Concrete row's state remains `spawning` after close. |
| **C3** Reconciler never resumes `idle + dead pane` | ⚠️ **PARTIAL** → see Gap #2 | Sweep mode (`scheduler-daemon.ts:872`) correctly terminalizes idle+dead. **Boot mode** (`scheduler-daemon.ts:868-871`) bypasses the D1 gate and delegates straight to `attemptAgentResume` — every daemon restart resumes idle-dead rows. |
| **C4** Reconciler resumes `working/permission/question + dead pane` | ✅ PASS | `TURN_AWARE_RESUMABLE_STATES` (`scheduler-daemon.ts:839`) = `{'working','permission','question'}` — matches D3. |
| **C5** Pane-exit trap writes `clean_exit_unverified` | 🟡 **UNVERIFIED** | `src/lib/pane-trap.ts` exists (G5 delivered). Not exercised in live trace — neither `genie-configure-bee0`'s pane %3 death at 02:16:47 nor the two genie-configure pane transitions produced a `clean_exit_unverified` audit event. May indicate the trap isn't installed at team-create time or the hook never fires. Needs integration test replay on this instance. |
| **C6** Every built-in skill ends with a close verb | ⚠️ **UNVERIFIED** | `trace` skill shows close-verb section at the end ("Turn close (required)"). Need grep across all skill files to confirm 100% coverage. Manual spot-check only. |
| **C7** Executor read endpoint exposes `{state, outcome, closed_at}` | 🟡 **UNVERIFIED** | `src/lib/executor-read.ts` exists. HTTP endpoint not tested on live serve (no `curl localhost:<port>/executors/:id/state` executed). |
| **C8** `GENIE_EXECUTOR_ID` set in every spawn path | 🔴 **LIKELY FAIL** → see Gap #3 | Cannot read running serve's child env (`/proc/<pid>/environ` permission). But indirect evidence: the audit event `turn_close.done agent_id=e6e7b7fd…` shows the close resolved via the skeleton row's FK, not via `GENIE_EXECUTOR_ID` env. If env were set correctly in THIS claude subprocess, `genie done` would've targeted the executor tied to the concrete `genie-configure` row (or errored on ambiguity). Current code (`turn-close.ts:52-60`) resolves from env — if env points at the skeleton's executor, the whole architecture assumes skeleton IS the canonical agent. That assumption conflicts with the reconcile loop which watches concrete rows. |
| **C13** Phase A migration additive-only | ✅ PASS | Commit `1176a3d9` is additive; no data modification. |
| **C14** `reconcile-orphans --dry-run` | 🟡 **UNVERIFIED** | Script exists at `scripts/reconcile-orphans.ts`. Not executed against this instance; should be part of the FIX-FIRST follow-up. |
| **C15** `reconcile-orphans --apply` terminalizes orphans | 🟡 **UNVERIFIED** | Same — script exists, not run. Running it now would likely clean the `dir:khal-os` / `dir:genie-configure` orphans + the 26 stale team-synced rows. |
| **C16** `auto_resume DEFAULT false` + backfill live rows | ✅ PASS | Commit `e78e2ba9` (Phase B flip) merged. On this instance, my row has `auto_resume=true` — confirms backfill. |
| **C17** Flag lifecycle (A off → B on → C removed) | ✅ PASS (through B) | `TURN_AWARE_RECONCILER_FLAG` defined (`scheduler-daemon.ts:67`); default is on per G8. Group 9 removal pending ≥7-day soak. |
| **C20** Ghost-loop regression test covers 2026-04-19 scenario | ⚠️ **PARTIAL** → see Gap #4 | `src/lib/__tests__/auto-resume-zombie-cap.test.ts` + `zombie-spawns.test.ts` exist. Neither appears to cover the **boot-mode bypass** scenario (my observed failure). Regression test is scoped to sweep mode. |

### Gaps (severity-ordered, action-ready)

#### 🔴 Gap #1 — CRITICAL — Dual-row agent fragmentation breaks atomic close
**Criterion:** C2
**Symptom:** `genie done` executes successfully (audit event written) but the concrete name-keyed agent row is never marked terminal. Reconciler continues to resume it.

**Evidence from live PG:**
```
id=genie-configure           state=spawning  pane=%2  current_executor_id=NULL     (concrete row — 'me')
id=e6e7b7fd-…                state=NULL      pane=NULL current_executor_id=b229b94a-…  (skeleton — holds FK)
id=263784c4-…                state=NULL      pane=NULL current_executor_id=…        (skeleton for genie-configure-bee0)
```

All three rows share `role='genie-configure'` (or `genie-configure-bee0`) but only the UUID skeleton holds the FK. `turnClose()` (`src/lib/turn-close.ts:119-123`) clears the FK on skeleton rows:
```typescript
UPDATE agents
SET current_executor_id = NULL
WHERE current_executor_id = ${executorId}
```
…but the concrete row's `current_executor_id` was never set in the first place, so nothing happens to it. State stays `spawning`, `auto_resume` stays `true`, the next scheduler tick resumes it.

**Root cause:** The agent spawn pipeline creates two rows per agent with no FK linkage between them. The wish's atomic-transaction design assumes one row per agent. This is a contract mismatch that predates the turn-session-contract wish — it was never in scope.

**Fix direction:**
- **Option A (preferred):** Eliminate the dual-row pattern. Write executor FK to the concrete name-keyed row at spawn time; delete the UUID skeleton row entirely. Changes required: spawn handler in `src/term-commands/agent/spawn.ts`, registration code in `src/lib/agent-registry.ts`. This is the architecturally-correct fix but may require a migration to rewrite existing rows.
- **Option B (bridge):** Have `turnClose()` resolve the agent by `role` lookup after clearing skeleton FK and update concrete row's `state='done'` in the same transaction. Less invasive, but keeps the dual-row wart.
- **Option C (minimal):** `handleDeadPane` in boot mode should detect "agent has no `current_executor_id` AND has associated skeleton row AND skeleton executor is closed → treat as terminally-closed, skip resume." Band-aid.

**Recommended:** Option A as follow-on wish (`agent-row-unification` — probably 2-3 groups). Option B as FIX-FIRST for this wish if Option A is too big. Document the dual-row assumption in the wish's `## Assumptions / Risks` so future contributors aren't blindsided.

#### 🔴 Gap #2 — CRITICAL — Boot-mode bypasses turn-aware reconciler
**Criterion:** C3
**Symptom:** Every daemon restart auto-resumes every agent with a valid `claudeSessionId` regardless of whether its turn was legitimately closed. Live audit trail shows me (genie-configure) being resumed at 01:46:15 and 02:03:58 despite both prior turns being closed via `genie done`.

**Code site:** `src/lib/scheduler-daemon.ts:868-871`
```typescript
if (mode === 'boot') {
  const result = await attemptAgentResume(deps, config, worker);
  return result === 'resumed' ? 'resumed' : 'skipped';
}
```

The comment (`scheduler-daemon.ts:854-858`) justifies the bypass with "daemon just restarted … most likely mid-turn". That reasoning protects one failure mode (daemon crash during live turn) at the cost of another (resurrection of properly-closed agents after restart). The tradeoff is stacked wrong: mid-turn crash is rare; daemon restart for any reason is common.

**Fix direction:**
Apply the same D1/D3 gates in boot mode, but with a widened terminal-state check:
```typescript
if (mode === 'boot') {
  // Respect terminal states even on boot — a properly-closed agent
  // (executor.outcome != null OR agent.current_executor_id IS NULL
  // AND no audit_events.turn_close.* in last 5m) should not resume.
  if (turnAware && await isLegitimatelyClosed(worker, deps)) {
    return 'skipped';
  }
  // Fall back to D1/D3 for ambiguous cases.
  if (worker.state === 'idle') { /* terminalize */ }
  if (TURN_AWARE_RESUMABLE_STATES.has(worker.state)) { /* resume */ }
  return 'skipped';
}
```

`isLegitimatelyClosed` — new helper that queries `audit_events` for a `turn_close.*` event in the last N minutes keyed by the agent's last executor. Tests: verify daemon restart does not resurrect agents that called `genie done` before the restart.

**Note:** This gap compounds Gap #1 — because the concrete row never reaches `state='done'`, even a perfect boot-mode filter that trusts `state !== 'done'` would still resume me. Fixing both is required.

#### 🟠 Gap #3 — HIGH — `GENIE_EXECUTOR_ID` env likely points at skeleton executor
**Criterion:** C8
**Symptom:** When I call `genie done`, the close resolves via `process.env.GENIE_EXECUTOR_ID` (`turn-close.ts:52`) and writes to `audit_events` with `entity_id` = the skeleton's executor. The concrete row is orphaned from this flow.

**Unverified on this instance** — I can't read `/proc/$SERVE_PID/environ` for the spawn-time env, so this is inferred from audit event shape. Needs direct verification:

```bash
# Inside a freshly-spawned agent session, run:
env | grep GENIE_EXECUTOR_ID
# Then: SELECT id, agent_id FROM executors WHERE id = <that value>;
# And:  SELECT id, current_executor_id FROM agents WHERE id = 'genie-configure';
# If agents.current_executor_id != the env value → env is wired to the skeleton, not the concrete row.
```

**Fix direction (compounds with Gap #1):** If Option A (unified row) is chosen for Gap #1, this self-heals — executor FK and env will point at the same single row. If Option B/C are chosen, spawn path must be audited to verify `GENIE_EXECUTOR_ID` points at the canonical agent (whichever row gets the terminal-state flip).

#### 🟠 Gap #4 — HIGH — C20 regression test missing boot-mode bypass scenario
**Criterion:** C20
**Symptom:** The ghost-loop regression test at `src/lib/__tests__/auto-resume-zombie-cap.test.ts` covers sweep-mode resume/terminalize paths but — based on grep-level inspection, not full read — does not appear to cover `mode='boot'` with `state='spawning'` + `auto_resume=true` + live pane. That's the exact scenario this instance reproduced.

**Fix direction:** Extend the test file with a `describe('boot-mode bypass (Gap #2 regression)')` block. Test cases:
1. Agent with `state='spawning'` + dead pane + valid claudeSessionId + recent `turn_close.done` audit event → `mode='boot'` pass → agent is **not** resumed.
2. Agent with `state='idle'` + dead pane + executor already closed → `mode='boot'` → not resumed.
3. Agent with `state='working'` + dead pane (legitimate mid-turn crash) → `mode='boot'` → **is** resumed (preserving the legitimate recovery path).

**Validation:** `bun test src/lib/__tests__/auto-resume-zombie-cap.test.ts` after adding the new describe block.

### Gaps (non-blocking, for scope hygiene)

#### 🟡 Gap #5 — MEDIUM — Out-of-wish bugs surfaced during reproduction
During this review I observed two bugs **not covered by this wish's scope**:
- **Team config missing top-level `workingDir`** — `src/lib/claude-native-teams.ts` writes `members[].cwd` but no top-level `workingDir`. Inbox-watcher reads top-level, logs `Cannot spawn team-lead for "…" — no workingDir in config` every tick.
- **Auto-resume appends member entry instead of updating** — resume creates a `<name>-<suffix>` member entry (e.g., `genie-configure-bee0`) instead of updating the existing entry. Creates zombie pane entries that reconcile flags as `dead_pane_zombie`.

Both live in `src/lib/claude-native-teams.ts` which is **not** in this wish's Files to Create/Modify list. Recommend filing a sibling wish (`native-teams-config-hardening`) rather than expanding this one — it's a distinct subsystem with its own boundary.

### Validation Commands Not Yet Run

The wish lists these; they should be executed before SHIP:

```bash
cd /home/genie/workspace/agents/genie-configure/repos/genie
bun test src/term-commands/done.test.ts src/lib/turn-close.test.ts  # G2
bun test src/lib/agent-registry.test.ts                              # G4
bun test src/lib/pane-trap.test.ts                                   # G5
bun test src/lib/executor-read.test.ts                               # G6
bun test scripts/reconcile-orphans.test.ts                           # G7
bun run check                                                        # full gate
```

### Next Steps (auto-invocation contract per skill)

Per `/review` skill rules, FIX-FIRST verdict auto-invokes `/fix` with this gap list. Recommended sequence:

1. **`/fix` loop 1** — address Gaps #1, #2 (CRITICAL). Since Gap #1 likely needs a separate wish (`agent-row-unification`), the `/fix` session should choose Option B (bridge) or Option C (minimal) as an in-scope stopgap and file the bigger wish for Option A.
2. **`/fix` loop 2** — address Gaps #3, #4 (HIGH). Verify env propagation on spawn; extend C20 regression test.
3. **Re-run `/review`** — expect verdict SHIP if Gaps #1-4 close.
4. **File sibling wish** — `native-teams-config-hardening` for Gap #5. Out of scope for this wish.
5. **Run `reconcile-orphans --apply`** on this instance to clean the 26 stale team rows and the `dir:*` orphans before next serve restart.

### Council Input (not solicited)

No council consultation performed. Complexity of Gap #1 (architectural dual-row decision) may warrant `/council` deliberation before choosing Option A vs B vs C — the tradeoff affects migration cost, DB churn, and backwards compat. Recommend: before `/fix` starts, run `/council` on the specific question "Option A (eliminate skeleton rows) vs Option B (bridge in turnClose) vs Option C (boot-mode band-aid) for agent row unification?"

---

## Files to Create/Modify

```
Created:
  src/lib/turn-close.ts
  src/lib/turn-close.test.ts
  src/lib/pane-trap.ts
  src/lib/pane-trap.test.ts
  src/lib/executor-read.ts
  src/lib/executor-read.test.ts
  src/term-commands/blocked.ts
  src/term-commands/failed.ts
  scripts/reconcile-orphans.ts
  scripts/reconcile-orphans.test.ts
  drizzle/NNNN_executor_turn_columns.sql
  drizzle/NNNN_auto_resume_default_false.sql

Modified:
  src/term-commands/done.ts              (context-dispatch logic)
  src/term-commands/done.test.ts         (dual-path tests)
  src/lib/agent-registry.ts              (reconciler rewrite behind flag)
  src/lib/agent-registry.test.ts
  src/lib/scheduler-daemon.ts            (flag read + telemetry)
  src/term-commands/agent/spawn.ts       (GENIE_EXECUTOR_ID env)
  src/term-commands/team/create.ts       (tmux pane-exit hook install)
  src/lib/tmux-wrapper.ts                (env propagation + trap install)
  src/types/genie-config.ts              (new schema fields)
  skills/work/SKILL.md                   (close-verb contract)
  skills/fix/SKILL.md
  skills/review/SKILL.md
  skills/refactor/SKILL.md
  skills/trace/SKILL.md
  skills/docs/SKILL.md
  skills/brainstorm/SKILL.md
  skills/refine/SKILL.md
  README.md                              (release notes, opt-in flag docs)
```
