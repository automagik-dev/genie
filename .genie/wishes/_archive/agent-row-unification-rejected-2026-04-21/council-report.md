# Council Report: agent-row-unification

**Session:** `council-1776750580` | **Members:** 5 | **Round 1:** 5/5 | **Round 2:** 5/5
**Date:** 2026-04-21

## Executive Summary

The council was convened to review the `agent-row-unification` wish, which proposes eliminating the dual-row pattern in the `agents` PG table via a flagged staged migration (Phase A/B/C, 7 groups, rollback archive). **Four of five members independently concluded the wish is over-engineered for a problem whose magnitude is unmeasured and whose runtime regression is unobservable** — a rare consensus arrived at from distinct rubrics (challenge-assumptions, simplicity, operations reality, measurement). The single most important insight came from cross-pollination in Round 2: **questioner's one-line predicate fix (`turn-close.ts:122` → `WHERE id = ${row.agent_id}`) is necessary but not sufficient** (architect verified via executor FK analysis), and the real architectural debt is not dual-row but runtime state still living on `agents` instead of `executors` where migration `012_executor_model.sql` intended. The emerging recommendation is to surgically fix turn-session-contract's Gap #1 + Gap #2 in ≤50 lines, file a sibling wish `agents-runtime-extraction` for the deeper cleanup, and defer or delete the dual-row migration pending measurement of its actual blast radius.

## Council Composition

| Member | Lens | Provider | Model |
|--------|------|----------|-------|
| architect | Systems thinking, backwards compat (Linus) | claude | haiku (registry default overrode `--model opus` request) |
| questioner | Challenge assumptions, foundational simplicity (Dahl) | claude | haiku |
| operator | Ops reality, on-call ergonomics (Hightower) | claude | haiku |
| simplifier | Complexity reduction, delete code (Holowaychuk) | claude | haiku |
| measurer | Observability, measure-don't-guess (Cantrill) | claude | haiku |

**Note on models:** Orchestrator requested `--model opus` per user directive; the agent registry default (`haiku`) overrode. Council output quality nevertheless exceeded expectations — substantive, specific, file/line-cited. Worth flagging as a separate tooling gap: `genie spawn --model` should either win or emit a warning when overridden by registry defaults.

## Situation Analysis

### architect (Linus — Systems Thinking)

**Initial perspective (Round 1):**
"The wish fixes the wrong layer." Diagnosed that the real architectural problem is `agents` table carrying 46 columns of runtime state (`005_pg_state.sql:10-47`) that `012_executor_model.sql:3` explicitly promised to move ("Slims: agents to durable identity only") — and never did. Dual-row collapse closes Gap #1 but cements the agents↔executors duplication for another 2 years. Proposed D8: deprecate runtime columns on agents post-G4; file follow-on wish `agents-runtime-extraction` now to prevent burial. *"One wish per abstraction. Ship this one clean; file the follow-on before you forget."*

**After deliberation (Round 2):**
Strongest point conceded: questioner's predicate-bug diagnosis at `turn-close.ts:90-94` vs `:119-123`. But proved questioner's fix is **incomplete** — executor FKs point at the UUID skeleton row, not the concrete name-keyed row, so `UPDATE ... WHERE id = ${row.agent_id}` terminalizes the wrong row while the name-keyed zombie stays in `state='spawning'`. This strengthens the "wrong layer" argument: moving runtime to executors makes the concrete row addressable by schema construction, not WHERE-clause vigilance. Converges with simplifier on "kill the flag" but diverges on G6 — keeps `genie doctor` observability as the tripwire for destructive migration.

### questioner (Dahl — Challenge Assumptions)

**Initial perspective (Round 1):**
"Not convinced we are solving the right problem, or that a migration is the solution." Gap #1 is a one-line predicate bug at `turn-close.ts:119-123` — the `agent_id` is already SELECTed at lines 90-94, so the fix is `WHERE id = ${row.agent_id}` + add `state='done'`. Gap #2 is independent — `isLegitimatelyClosed(executor)` checking `closed_at IS NOT NULL`. Neither requires row unification. Proposed "zero-dependency version": delete the word "migration" from the wish. Keep G4c + G4d. ~40 lines of diff, zero schema change, zero flag, zero soak. *"Could we delete code instead of adding 7 execution groups?"*

**After deliberation (Round 2):**
Position refined (not changed). Concedes to architect that the sibling `agents-runtime-extraction` wish should be filed now. Hardens the skip-migration position: "If runtime should live only on executors, then G1–G3's collapse is work against the follow-on. Doing the collapse first pays for state that will be torn out." Notes four council lenses converging: "this wish is scaffolding for a change no one has measured, justified, or observed."

### operator (Hightower — Ops Reality)

**Initial perspective (Round 1):**
Rollback skeleton is good, but serve behavior during G3 is unspecified (R5 at WISH.md:407 waves at "serve lock or planned maintenance" — pick one). The single biggest gap: **WHAT METRIC TRIGGERS ROLLBACK** — nowhere in the wish does anyone name a concrete observable threshold. Runbook G6 as "docs/runbooks/...md exists" is bureaucracy; real runbook answers who-gets-paged, decision-in-<5min, command-to-run. Demanded live-fire drill before G4a merge, 24h dev canary with `genie doctor` dual-row count convergence as merge gate. *"Without this, at 3am somebody is guessing."*

**After deliberation (Round 2):**
Position changed twice. (1) Adopts measurer's `genie_agents_dual_row_count` gauge as THE primary rollback signal. One dashboard, three tripwires. (2) Retracts G4a 24h-dev-canary IF flag is deleted. But holds firm: outage posture during G3 must be pinned ("serve drains to zero active spawns → migration runs → serve resumes; expected duration ≤N minutes at p99"); runbook must name a human owner, not a file. Pushes back on simplifier/questioner: can't go flagless until G1's insertion-sites audit proves no external callers exist; if audit shows unknowns, flag stays as circuit breaker. Endorses architect's sibling-wish filing now.

### simplifier (Holowaychuk — Delete Code)

**Initial perspective (Round 1):**
"Delete the flag. The flag IS the complexity you claim to be fixing." Trading dual-row for dual-PATH — +500 LoC of bifurcation tax. Three concrete cuts: G6 entirely (migrations ARE the apply script), G5 evidence package (test file IS the evidence), G4a + G7 + flag + archive table + failures table (all ceremony). Success criteria: 16 items is theater; reduce to 6. G4a→G4d sequencing "multiplies merge conflicts" (R10 admits this) — one PR, revertible as unit. *"The wish's goal is deleting `register()`. Every other thing is surrounding ritual."*

**After deliberation (Round 2):**
Position **changed**. Adopts questioner's deeper position: "Delete the migration. Keep the 40-line diff." Operator's demands are an inadvertent proof the migration isn't worth doing — stacking outage SLO + primary metric + live-fire drill + canary gate + named owner next to questioner's 40-line patch shows the migration costs more to OPERATE than dual-row costs to LIVE WITH. Concedes one measurer demand: `genie_agents_dual_row_count` gauge as forever-canary (alerts if anyone accidentally writes a name-keyed row in future). Final recommendation: "Kill Groups 1, 2, 3, 4a, 4b, 5, 6, 7. Ship G4c's predicate + G4d's boot-mode check + Architect's sibling wish filed. Six success criteria become three."

### measurer (Cantrill — Observability)

**Initial perspective (Round 1):**
"The wish is instrumentation-thin." Only `agent.unified` audit event is specified — a point event with no dimensions. No `agent.unification.started`, no `_batch_complete`, no `_rollback_triggered`. Failed merges get a row in `agent_unification_failures` but no event emission — operators are expected to poll SQL. No golden signal defined. 7-day soak measured in calendar days, not signals. Demanded minimum 5 signals: (1) `migration.batch` span with dimensions, (2) `genie_agents_dual_row_count` gauge + 2 siblings, (3) p50/p95/p99 histogram, (4) `baseline.json` artifact, (5) alert rule spec in runbook.

**After deliberation (Round 2):**
Position partially changed. Cantrill discipline self-applied: adopted questioner's "data should justify the operation" — `baseline.json` must exist BEFORE G3 is approved (not after), must include live dual-row pair count as a gate. If N<10 and half are stale test fixtures, migration is over-engineered. Dropped runbook-as-artifact demand (simplifier + operator converged). Three signals survive: gauge, span, baseline. Endorsed operator's "ghost-resume events within 60s of `genie done` > 0" as the single golden signal for rollback trigger.

## Key Findings

1. **The wish addresses a symptom, not the root cause** — architect's diagnosis that `agents` table carries runtime state that `012_executor_model.sql` promised to extract (but didn't) is the deepest finding. Dual-row collapse cements duplicated runtime columns across `agents` and `executors` for another 2 years. Questioner independently reached the same conclusion from the other direction: "doing the collapse first pays for state that will be torn out." **Consensus: file sibling wish `agents-runtime-extraction` before proceeding.**

2. **Gap #1's in-flight fix is smaller than the wish suggests, but not as small as it first appears** — questioner's one-line predicate fix (`turn-close.ts:122` change `WHERE current_executor_id = ${executorId}` to `WHERE id = ${row.agent_id}` + add `state='done'` to SET clause) is NECESSARY but INSUFFICIENT on this instance's data. Architect's Round 2 verification: executor FKs point at UUID skeletons, so the proposed UPDATE terminalizes the skeleton while the name-keyed concrete row stays `state='spawning'` → auto-resume continues. **Requires either (a) move runtime to executors (architect's proposal), or (b) dual-row collapse (the current wish), or (c) turnClose updates rows by `role` not just `id`.**

3. **The wish cannot observe its own success or failure in production** — measurer + operator converged independently: no named tripwire, no gauge, no baseline, no steady-state metric. "A migration whose success signal nobody can name in the wish should not run" (questioner's Round 2). The `agent.unified` audit event is a point event with no dimensions — proves a write happened, not that it merged correctly.

4. **XOR flag semantics create dual-PATH complexity equal to the dual-row complexity being fixed** — simplifier's R1 + R2: +500 LoC of bifurcation tax across test matrix (WISH.md:146), every caller site (WISH.md:137), plus G4a + G7 + archive + failures tables. Operator pushes back partially: flag is defensible as a circuit breaker IF G1's audit shows external/unknown `register()` callers; otherwise delete it. Architect concurs with simplifier on flag deletion but keeps `genie doctor` observability.

5. **Group 4's 4-way split is aspirational, not operational** — operator's R1 + R2: R10 (WISH.md:412) admits "multiplies merge conflicts"; "target all four PRs within 48h" is unverifiable; G4a flips default to TRUE while G4b/c/d legacy branches still callable, creating a window where production runs new default with escape hatch still present. Either collapse G4 back to a single atomic PR (simplifier) or pin an explicit rollback SLA at each sub-group boundary (operator).

6. **Four independent perspectives converged on "this is premature"** — questioner (no measured motivation), simplifier (more complexity than it removes), measurer (can't observe its own success), operator (no named tripwire). Only architect defended migration as potentially necessary, and even that was conditional on filing the sibling runtime-extraction wish to make the deeper fix visible.

## Recommendations

| Priority | Recommendation | Rationale | Risk if Ignored |
|----------|---------------|-----------|-----------------|
| **P0** | Ship the minimalist fix first: G4c predicate fix (`turn-close.ts:122` → `WHERE id = ${row.agent_id}` + `state='done'`) + G4d boot-mode `isLegitimatelyClosed(executor)` check + a dual-row-aware fallback UPDATE for the name-keyed row. Target: ≤50 LoC, one PR, no flag, no migration, no archive. | questioner + simplifier converged on this; architect's Round 2 proved the naive 40-line version is insufficient but the ≤50 LoC version with dual-row-aware fallback closes Gap #1 + Gap #2. Observable via existing `auto-resume-zombie-cap.test.ts` regression. | Shipping the full wish as drafted: 7 groups, 2-3 week cycle, +500 LoC bifurcation tax, ambiguous ops posture during G3, destructive migration for unmeasured blast radius. |
| **P0** | File sibling wish `agents-runtime-extraction` NOW, linked from both `turn-session-contract` and `agent-row-unification` dependencies. Scope: move `pane_id`, `session`, `state`, `claude_session_id`, `resume_attempts`, `window_id`, etc. off `agents` onto `executors`. | architect's strongest finding; questioner endorsed in R2; simplifier endorsed in R2; measurer noted metrics simplify under this abstraction. Filed-now prevents burial of the real architectural debt. | The 46-column `agents` row writing on every state tick becomes DB pressure at scale; future incident will surface the debt at the worst time. `012_executor_model.sql:3` promise stays unfulfilled indefinitely. |
| **P0** | Run a `scripts/count-dual-rows.ts` baseline capture BEFORE deciding whether to ship the full `agent-row-unification` wish or defer it. If N<10 pairs and most are stale test fixtures, DEFER the migration indefinitely. If N≥100 with divergent runtime state, re-evaluate with measured motivation. | measurer + questioner converged in R2: the wish asserts dual-row is a problem but produces zero cardinality data. "Data should justify the operation." | Running a 7-group migration for 8 stale rows is the textbook over-engineering failure mode. Without baseline, ship-or-defer decision is on vibes. |
| **P1** | IF the migration does ship (post-baseline justification), adopt measurer's minimum instrumentation (non-negotiable): `genie_agents_dual_row_count` gauge (golden signal, also acts as forever-canary post-migration), `migration.batch` span with dimensions (batch_id, pairs_count, duration_ms, fk_rewrites, failures, rolled_back), `baseline.json` artifact at wish root. Wire dual_row_count into `genie doctor`. | operator + measurer convergence on single-dashboard, three-tripwire minimum. Without these, on-call at 3am is guessing. | Migration ships blind — success/failure discovered via user reports, not metrics. |
| **P1** | IF migration ships, pin outage posture explicitly: "serve drains to zero active spawns → migration runs → serve resumes; expected duration ≤N min at p99". Name a human owner for the 7-day soak. Replace prose runbook with: tripwire alert IDs + one rollback command + `genie doctor` remediation hint + 30-min dev drill gate. | operator's non-negotiable; simplifier partially agrees (runbook as prose is theater, as doctrine+automation survives). | Unpinned outage posture means concurrent writers during migration — row-level lock contention or partial-merge data corruption. |
| **P2** | IF migration ships, delete the `GENIE_UNIFIED_AGENT_ROWS` flag per simplifier. Make `register()` internally call `findOrCreateAgent()` with runtime fields; ship flagless atomic migration in one PR. G1 insertion-sites audit proves no external callers exist as precondition. | simplifier R1+R2 + operator R2 conditional approval + architect R2 endorsement. "Dual-PATH" is genuine complexity, not risk mitigation. | Two code paths coexist for 7+ days, every caller site gates on flag — future engineers have to reason about which path is live. |
| **P2** | Collapse Group 4 sub-split (G4a/b/c/d → single G4). | simplifier + architect convergence; R10 (WISH.md:412) admits merge conflict cost of the split. | Four PRs × review cycles × merge conflict resolution > one PR with one revert button. |

## Next Steps

- [ ] **(Orchestrator, next `/review` cycle)** Read this council report + apply-layer changes, produce new `/review` verdict on the updated wish. Specifically reconcile: should the wish be DRASTICALLY scoped down per P0 #1, fully rejected in favor of the minimalist fix + sibling wish, or retained with P1/P2 hardening?
- [ ] **(User decision)** Between three paths: (a) **KILL** this wish, ship the ≤50 LoC minimalist fix as a standalone change, file `agents-runtime-extraction` for the deeper cleanup; (b) **DEFER** this wish pending baseline dual-row count measurement; (c) **HARDEN** this wish with the P1 + P2 changes (instrumentation, outage posture, flag deletion, G4 collapse).
- [ ] **(If path (a) or (b))** Draft `agents-runtime-extraction/WISH.md` covering the `012_executor_model.sql` follow-through. File before any further work on row-unification.
- [ ] **(Always)** Run `scripts/count-dual-rows.ts` (or equivalent inline query) against live instances + dev + CI fixtures. Capture to `baseline.json` regardless of which path is taken.
- [ ] **(If path (c))** Wire measurer's gauge + span + baseline into G1; delete G6 runbook prose; name human soak owner; pin outage posture.

## Dissent

**architect** held the minority position that the migration IS worth shipping — but conditional on the sibling wish being filed now. Quoting: *"Keep THIS wish as the tactical dual-row collapse (it unblocks turn-session-contract Gap #1 this sprint), BUT add an explicit Decision D8."* (Round 1). In Round 2, architect tempered this after verifying questioner's evidence: *"The questioner's evidence actually strengthens this: the concrete row is unaddressable by any executor FK because executor FKs point at skeletons."* Architect's position collapses to: either unify rows (this wish) OR move runtime to executors (follow-on wish) — you cannot close Gap #1 with a predicate fix alone. Therefore the minimalist P0 #1 above must include a dual-row-aware turnClose fallback (UPDATE by `role` across all rows sharing the identity's role), which is halfway to the full migration.

**operator** held a secondary minority: the `agents_legacy_archive` table (WISH.md:172) is necessary IF destructive merge ships, because `git revert` cannot undo DELETE rows. Simplifier's claim that revert + PG backup is equivalent depends on a pg_dump taken at the exact moment of migration, which is itself operational complexity the wish hasn't specified. Preserved: **if path (c) is chosen, the archive table is non-negotiable.**

**All five members converged on filing the sibling `agents-runtime-extraction` wish before or alongside any further work here.** That is the only unanimous finding.

---

*Council session: `council-1776750580` | Members: 5 | Round 1: 5/5 | Round 2: 5/5*
