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

_Populated by `/review` after execution completes._

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
