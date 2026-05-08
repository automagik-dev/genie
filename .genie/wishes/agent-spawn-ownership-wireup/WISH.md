# Wish: Spawn Ownership Wireup

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `agent-spawn-ownership-wireup` |
| **Date** | 2026-05-08 |
| **Author** | Felipe (reframed by Genie 2026-05-08) |
| **Appetite** | small |
| **Branch** | `wish/agent-spawn-ownership-wireup` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — reframed from earlier "agent-spawn-ownership-resume-ontology" draft after /review. See "Reframe note" below._ |
| **Supersedes scope of** | the earlier 5-group draft of this wish (G3/G4 already shipped — see Reframe note) |
| **Sibling** | `project-board-agent-routing` (covers board/timeline; this wish is the upstream data-model fix it depends on) |

## Reframe note

The original draft mixed three concerns:

1. **Spawn ownership wireup** — write `reports_to` at agent creation. *Not done.*
2. **Team leader/members canonical ids** — *already shipped* in migration 061 + `src/lib/team-manager.ts:913-921` + `src/lib/pg-seed.ts:398`.
3. **Daemon auto-resume vs manual recovery split** — *already shipped* in `src/lib/should-resume.ts:50-62, 132, 153-181, 209-247` + migration 055.

This reframe drops #2 and #3 from scope (they exist) and keeps only #1, the genuinely missing delta. Appetite goes from `large` to `small`.

## Summary

Every spawn path that creates a durable agent identity calls `findOrCreateAgent(name, team, role?)` in `src/lib/agent-registry.ts`. That function has no owner parameter, and its `INSERT` writes the column tuple `(id, custom_name, team, role, started_at, state, created_at, updated_at)` — `reports_to` is omitted, so it defaults to NULL. Because the schema's `agents.kind` is a generated column derived from `reports_to` (`migrations/049_agents_kind_generated.sql`), every UUID-minted spawn defaults to `kind='permanent'` — wrong by intent for quickies, team workers, and delegated task agents.

A repo-wide grep (`grep -rn "findOrCreateAgent\b" src/ --include="*.ts" | grep -v test`) finds **11 non-test call sites** across 7 files, none of which currently passes ownership context. (Original draft listed only 3 — undercount.)

Migration 061's backfill only nulled FK-violating values; it did not *infer* ownership. So the live database has an unknown number of orphan UUID workers misclassified as permanent.

This wish does two things and stops:

1. Thread spawner identity through `findOrCreateAgent` and **every** non-test call site so new spawns write `reports_to` correctly.
2. Add an inference-backfill migration plus an audit report listing rows that cannot be safely repaired.

## Scope

### IN

- Add an optional `reportsTo` (or equivalent owner) parameter to `findOrCreateAgent` and write it on `INSERT`.
- Update **all 11 non-test `findOrCreateAgent` call sites** to pass the spawner's canonical agent id (resolved from `GENIE_AGENT_ID` / ambient agent / parent session). Full enumeration in Group 1 below.
- Add a CI grep guard (test or precommit script) that fails if a new caller passes only `(name, team[, role])` without `reportsTo`, so this regression cannot recur.
- Add a backfill migration that sets `reports_to` for orphan UUID workers where ownership is unambiguous (single matching team leader, single matching parent session).
- Add an audit query/CLI surface that lists orphans which cannot be safely inferred — operator decides, no guessing.
- Tests: spawn from `dir:felipe` writes `reports_to='dir:felipe'` and yields `kind='task'`; spawn from inside a team writes the team's owner/leader id; explicit registered identities still come up `kind='permanent'`.

### OUT

- Resume policy changes — already shipped (see Reframe note).
- Team leader/members canonical id enforcement — already shipped.
- Project-board task timeline / `genie done --report` plumbing — that lives in sibling wish `project-board-agent-routing`.
- Backfill that *guesses* ambiguous owners — audit only, never invent.
- Provider redesign for Claude / Codex / Claude SDK.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | The spawner is the default `reports_to` for new UUID agent rows. | Matches the user's mental model: "Felipe started this work, so Felipe owns recovery/escalation." |
| 2 | Spawner identity resolves in priority order: explicit param > `GENIE_AGENT_ID` env > parent session's agent id > none. | Lets callers override; matches existing conventions used elsewhere in `term-commands/agents.ts`. |
| 3 | If no owner can be resolved, the spawn must either be an explicit registered identity (e.g., `dir:<name>`) or fail loudly. | Silent permanent rows are exactly the bug we're fixing; don't replace one silent default with another. |
| 4 | Backfill infers, never guesses. | Bad guesses attach work to the wrong owner and cause context leakage. |

## Success Criteria

- [ ] `findOrCreateAgent` accepts and persists an owner / `reportsTo` value on `INSERT`.
- [ ] All 11 non-test call sites pass an owner; no call site in `src/` writes a UUID `agents` row without `reports_to`. CI grep guard enforces this on future changes.
- [ ] A spawn under `GENIE_AGENT_ID=dir:felipe` produces an agent row with `reports_to='dir:felipe'` and (via the generated column) `kind='task'`.
- [ ] An explicitly registered `dir:<name>` agent still comes up `kind='permanent'`.
- [ ] The backfill migration sets `reports_to` for orphan UUID workers where inference is unambiguous, leaves the rest alone, and emits an audit list.
- [ ] An audit CLI surface (or query) prints unresolved orphans with enough context (custom_name, team, parent_session_id, recent executor) for an operator to decide.

## Execution Strategy

Single wave. Two groups, one PR.

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Add `reportsTo` to `findOrCreateAgent`, wire all 11 non-test call sites, ship tests + CI grep guard. |
| 2 | engineer | Backfill migration + orphan-audit surface. |

## Execution Groups

### Group 1: `findOrCreateAgent` ownership wireup

**Goal:** No new UUID `agents` row is written without `reports_to` being either set or explicitly justified.

**Deliverables:**

1. Extend `findOrCreateAgent(name, team, role?)` in `src/lib/agent-registry.ts` → `findOrCreateAgent(name, team, opts?: { role?: string; reportsTo?: string })`. Preserve back-compat: omitting `opts.reportsTo` writes NULL just as today (so no behavior change for callers updated in a follow-up).
2. Add `reports_to` to **both** the INSERT column list **and** the VALUES tuple in the function body. The `RETURNING` clause already lists it — no schema change needed.
3. Add a small helper `resolveSpawnOwner(ctx)` that resolves spawner identity in priority order from Decision 2 and returns either a canonical agent id or `null`. Live in `src/lib/agent-registry.ts` alongside `findOrCreateAgent`.
4. Update **all 11 non-test call sites** to call `resolveSpawnOwner(ctx)` and pass the result as `opts.reportsTo`. Full list (verify line numbers fresh on the execution branch — they drift across releases):
   - `src/term-commands/agents.ts` — quickie spawn, resume mint, team auto-spawn (3 sites)
   - `src/lib/protocol-router-spawn.ts` — protocol-router auto-spawn (1 site)
   - `src/lib/team-auto-spawn.ts` — team leader spawn (1 site)
   - `src/genie-commands/session.ts` — session lifecycle (4 sites, all `leaderName`-based)
   - `src/services/executors/claude-sdk.ts` — Omni claude-sdk path (1 site, `team='omni'`)
   - `src/services/executors/claude-code.ts` — Omni claude-code path (1 site, `team='omni'`)
5. CI grep guard: a unit test (or `scripts/lint-find-or-create-agent.ts`) that runs the equivalent of `grep -rn "findOrCreateAgent\b" src/ --include="*.ts" | grep -v test` and asserts that every match passes an `opts` object containing `reportsTo` (or is the function definition itself). The guard should fail loudly if a future contributor adds a 3-arg call.
6. Tests: assert each call site writes `reports_to` correctly on first creation, and does **not** overwrite `reports_to` on idempotent re-find.

**Acceptance Criteria:**

- [ ] `findOrCreateAgent` signature accepts an owner; INSERT column list and VALUES tuple both include `reports_to`.
- [ ] All 11 non-test call sites pass an owner derived from `resolveSpawnOwner(ctx)`.
- [ ] CI grep guard fails on a synthetic fixture that adds a new 3-arg caller and passes when removed.
- [ ] Test `agent-registry.test.ts` covers: (a) Felipe quickie writes `reports_to='dir:felipe'`, (b) team auto-spawn writes the team's leader id, (c) explicit `dir:<name>` registration stays `kind='permanent'`.
- [ ] Idempotent re-find returns the existing row unchanged — does not clobber a previously-set `reports_to`.

**Validation:**

```bash
cd /home/genie/workspace/repos/genie
bun test src/lib/agent-registry.test.ts src/term-commands/agents.test.ts
bun run typecheck
```

**depends-on:** none

---

### Group 2: Orphan backfill + audit

**Goal:** Repair existing rows where ownership is unambiguous; surface the rest.

**Deliverables:**

1. New migration `src/db/migrations/NNN_backfill_reports_to_for_orphans.sql` (NNN = next free number on execution branch — currently 063 is taken on canonical, pick 064 or whatever's free). Migration must:
   - Target rows where `reports_to IS NULL` AND `id` does NOT match the registered-row pattern (excludes `dir:<name>` rows by construction).
   - Set `reports_to` only when inference is **unambiguous** (each rule = one `UPDATE … WHERE` with `EXISTS … HAVING COUNT(*) = 1`):
     - **By team leader** — if the row has a `team`, the team has exactly one current `leader`, and that leader is a registered (`dir:`) row.
     - **By parent_session_id** — if `parent_session_id` resolves to exactly one agent row with a registered owner.
   - **DROPPED rule (was in earlier draft):** "by executor parentage / `audit_events` ambient agent id." Verification needed before relying on it: confirm `audit_events` actually persists the spawning ambient agent at the right granularity. If yes, add as a third rule in a follow-up wish; if not, this rule is a no-op and shouldn't ship.
   - Leave all other rows untouched.
2. Audit surface — extend the existing `auditAgentKind` function in `src/lib/agent-registry.ts` (or add a peer `auditOwnerlessOrphans()`) that returns rows still NULL after backfill, with diagnostic context (custom_name, team, parent_session_id, last_executor_id).
3. Optional CLI flag: `genie agents audit --orphans` (or pipe through existing `genie agents audit`) to print the orphan list.

**Acceptance Criteria:**

- [ ] Migration is idempotent: re-running on an already-repaired DB makes zero changes.
- [ ] Migration is safe on a fresh install (no rows match → no-op).
- [ ] Migration assumes the `agents.id` invariant from migration 061 is in place — execution branch must include 061 (it's already in `dev`/`main` per current canonical). If not, migration aborts with a clear precondition message.
- [ ] After running, no row that was already non-NULL is overwritten.
- [ ] Audit surface lists the residue with enough context for an operator to assign ownership manually.
- [ ] `bun test` for migration + audit passes.

**Validation:**

```bash
cd /home/genie/workspace/repos/genie
bun test src/db/migrations/__tests__ src/lib/agent-registry.test.ts
# manual: run on a live dev snapshot, assert orphan count drops, residue is reasonable
```

**depends-on:** Group 1

---

## QA Criteria

- [ ] Spawn quickie under `GENIE_AGENT_ID=dir:felipe` → `agents` row has `reports_to='dir:felipe'`, `kind='task'`, and is manually recoverable (auto-resume policy is already correct — sanity check, not a deliverable here).
- [ ] Spawn under a team → `reports_to` matches the team owner / leader (whichever the helper picks per Decision 2).
- [ ] Re-spawn the same name+team → no clobber of existing `reports_to`.
- [ ] Run backfill migration on a dev DB snapshot → orphan count strictly decreases, no overwrites of pre-set values, audit output non-empty for known-ambiguous rows.
- [ ] Fresh install + smoke test still green.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Ambient spawner identity resolves to a non-registered / transient row, so `reports_to` becomes a UUID instead of `dir:<name>`. | Medium | Helper prefers the nearest registered ancestor; fall back to UUID only when no registered ancestor exists. Test the fallback. |
| Backfill inference attaches a row to the wrong owner. | High | Inference rules require *exactly one* match; ambiguous cases land in audit, not in the UPDATE. |
| Existing tests expect the old `findOrCreateAgent` 3-arg signature. | Low | Add the new param as optional; back-compat preserved. |
| Caller enumeration drifts as code moves. | Medium | G1 deliverable #5 is the CI grep guard. Wish itself lists 11 known callers across 7 files; line numbers intentionally omitted because they drift across releases — anchor by file + function instead. |
| `audit_events` schema may not retain ambient spawner ids at the granularity G2 originally assumed. | Medium | G2 dropped the `audit_events`-based rule on purpose. Verification + reinstatement deferred to a follow-up wish if needed. |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
src/lib/agent-registry.ts                          # signature + INSERT + resolveSpawnOwner + audit fn
src/term-commands/agents.ts                        # 3 call sites
src/lib/protocol-router-spawn.ts                   # 1 call site
src/lib/team-auto-spawn.ts                         # 1 call site
src/genie-commands/session.ts                      # 4 call sites
src/services/executors/claude-sdk.ts               # 1 call site (Omni)
src/services/executors/claude-code.ts              # 1 call site (Omni)
src/db/migrations/NNN_backfill_reports_to_for_orphans.sql   # backfill (pick next free migration number on execution branch)
src/lib/agent-registry.test.ts                     # ownership wireup tests + idempotent re-find test
src/db/migrations/__tests__/backfill_reports_to.test.ts     # backfill tests (idempotency, fresh install, residue)
scripts/lint-find-or-create-agent.ts               # CI grep guard (or equivalent unit test)
docs/agent-spawn-ownership.md                      # one-pager: ownership model + backfill semantics
```
