# Design: BUGLESS GENIE — self-healing observability (umbrella roadmap)

| Field | Value |
|-------|-------|
| **Slug** | `genie-self-healing-observability` |
| **Role** | Umbrella / parent roadmap — coordinates sub-projects A, B, C, D |
| **Date** | 2026-04-21 |
| **WRS** | 100/100 |
| **Output type** | Roadmap doc (NOT a wish) — each of A/B/C/D has its own wish |

> This document is the umbrella. It is not executed directly. Each sub-project owns its own brainstorm → DESIGN → WISH → execution; this roadmap locks sequencing, cross-cutting contracts, autonomy ceiling, and finish-line criteria.

---

## Problem

Genie accumulates undetected state-drift and silent-failure bugs across multiple subsystems (agents, teams, wishes, dispatch, filesystem↔PG) faster than humans can trace and fix them; there is no observable substrate to name bugs at the source and no autonomous loop to heal known pathologies, so "BUGLESS GENIE" cannot be achieved by manual effort.

---

## Scope

### IN (this roadmap's responsibility)
- **Coordinate** the four sub-projects A, B, C, D so they roll up to a coherent BUGLESS-GENIE deliverable.
- **Lock sequencing** (D3): A first as substrate, then B / C / D in parallel.
- **Lock rollout shape** (D4): four paralleling wishes linked to this roadmap, not one mega-wish.
- **Lock finish-line semantics** (D1, D7, D8): hybrid — targeted per-pathology ship-gate + empirical 14d rolling-window labelling gate.
- **Lock autonomy ceiling for B** (D5): Tier 3 auto-PR + auto-merge on `dev`, keyed on corrected standing law §19 v2 and enforced by the hook change shipped in PR #1251.
- **Lock circuit-breaker layers** (D6): five mandatory defences between B's auto-fix and production.
- **Track** shared contracts: event-type registry in A, precedent-PR index (`.genie/auto-heal-precedents/`), BUGLESS-clock script.

### OUT (explicit non-scope)
- Re-designing sub-project A's event substrate. A already has its own DESIGN at WRS 100 and a WISH in flight; this roadmap respects it.
- Implementing any detector, fix, parser refactor, or ghost-hygiene migration. Implementation happens inside each sub-wish.
- Collecting additional field evidence. Existing evidence (6 patterns + 5 dispatch bugs + Pattern 9 trace + Bug #1 trace) is sufficient for v0 decomposition.
- Choosing between small / medium / large appetite (F3). Felipe's "BUGLESS GENIE" framing resolves this unambiguously to **large** — all four sub-projects.
- Work on Claude Code team config, non-genie CLIs, or AGENTS.md cleanup. Those belong to separate learning/config tasks.

---

## Approach

### One-paragraph summary
Decompose into four independently-shippable sub-projects with explicit roles: **A** (typed event substrate), **B** (self-healing consumer with Tier 3 autonomy), **C** (dispatch robustness), **D** (ghost hygiene invariants). A ships first because B/C/D cannot measure their own progress without it. B/C/D then race in parallel. Every known pathology earns a four-artefact ship gate (event type in A, detector in B, fix PR merged to dev, regression test in CI). "BUGLESS GENIE" is claimed only after 14 consecutive days of zero `pathology_*` events in production, computed by a nightly script that owns the counter.

### Why this shape, not the alternatives

| Candidate shape | Why rejected |
|-----------------|--------------|
| Pure sequential A → B → C → D | Wastes months of elapsed time during which B/C/D are fully specifiable and pain is mounting. Felipe's "SO MANY FUCKING BUGS" reads as urgency, not careful single-threading. |
| All four parallel now | B's detectors need A's event types as input; building B blind to the substrate it consumes is guaranteed rework. |
| One mega-wish with 4 waves | Scope creep risk is mechanical — a single wish with A+B+C+D as waves hits the wave-parser fragility that is itself Bug A in the list. Four paralleling wishes route around our own parser bug. |
| Only B (small appetite) | Doesn't satisfy Felipe's north-star framing. Ghost teams (D) and dispatch zombies (C) are not healable by B alone; they're structural defects. |
| Only A+B (medium appetite) | Same — leaves the dispatch-parser class of bugs permanent. |

### Why A-first is the natural substrate
- B needs A's `pathology_<n>_*` event types to detect anything. Without typed events, B is back to parsing prose-logs — the exact misfeature we're trying to eliminate.
- C's dispatch-fix regressions need A's correlation IDs to prove "fix prevents the bug's trace signature from reoccurring." Without A, C's regression tests are brittle string-match.
- D's invariant probes (filesystem↔PG, view-vs-table drift) emit findings; without A they are just more log lines, unsubscribable.

### Isolation-by-design principles applied
- **Single purpose** — each sub-project does one thing: A = emit structure, B = consume & heal, C = make dispatch SSOT, D = kill ghosts. No cross-subsystem responsibilities.
- **Well-defined interfaces** — A exposes a typed event stream; B subscribes; C writes wish_groups state through a single path; D owns schema migrations + a recomputed `teams_view`. Every cross-wire is a named contract, not a shared cache.
- **Independent testability** — B can be tested with recorded A-events (no live detection needed). C's parser can be tested off-disk. D's invariants can be tested with fixture DBs.
- **Dependency visible in interface** — B's manifest declares the A event types it consumes. Any A-change that renames a type forces a B-side update, visible in PR review.

---

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Hybrid finish-line: targeted gates ship, empirical 14d gate labels | Targeted alone is blind to unknown-unknowns; empirical alone cannot be ticked off group-by-group. Hybrid gives both forward motion and honesty. |
| D2 | This brainstorm crystallizes into an **umbrella DESIGN**, not a WISH. Each sub-project has its own WISH. | Existing A DESIGN already names this slug as parent — structure is pre-declared. Umbrella tracks; sub-wishes execute. |
| D3 | **A first** (substrate), **then B / C / D parallel** | Matches `experiment-before-converging` — A is a one-substrate / N-consumer shape. B/C/D are independent downstreams. |
| D4 | Four paralleling wishes, not one mega-wish | Sidesteps our own wave-parser fragility (Bug A). Each wish independently shippable and independently `genie work`-able. |
| D5 | B's autonomy ceiling is **Tier 3** — auto-PR + auto-merge on `dev`; main stays humans-only | Without T3, the "self release microfix loop" Felipe asked for has a human gate between fix and ship, breaking the autonomous property. Main guarded by corrected §19 v2 and hook change shipped in PR #1251. |
| D6 | All five circuit-breaker layers (R1-R5) **mandatory** for v0 of B | Tier 3 autonomy without layered defense = self-mutating production system. Cost of layered design is zero compared to cost of a runaway merge loop. |
| D7 | Per-pathology ship gate requires **four artefacts**: event type, detector, fix merged, regression test | Makes "shipped" deterministic and CI-observable. No ambiguity about whether a pattern is handled. |
| D8 | BUGLESS-GENIE label claim requires **14 consecutive days of zero `pathology_*` events**, computed by a script as SSOT | Clock owned by code, not by humans reading logs. Same script answers "where are we on BUGLESS-GENIE today?" |

---

## Sub-project boundaries (contract between this roadmap and each wish)

### A — `genie-serve-structured-observability`
- **Owns:** typed event substrate, emit.ts, 4-channel trace correlation, RBAC, retention tiers, consumer CLI.
- **Must provide to B/C/D:** a registry of `pathology_<n>_<slug>` event types for all 11 known pathologies + a subscribe API.
- **Status:** DESIGN ✅, WISH in flight, Wave 3.2 partially shipped.
- **Doesn't own:** any self-healing action, any auto-PR logic, any auto-merge logic.

### B — `genie-bugless-self-healing` (to be created)
- **Owns:** detectors (one per pathology), auto-fix actions, precedent index at `.genie/auto-heal-precedents/`, Tier 3 auto-merge pipeline, circuit breakers R1-R5, BUGLESS-clock script.
- **Must consume from A:** `pathology_*` event types, `emit_anomaly` stream for R4.
- **Must respect from C, D:** their regression tests and SSOT writes — B never duplicates dispatch-state management or schema work.
- **Autonomy:** Tier 3 on `dev` only, keyed on §19 v2 + precedent-PR whitelist (R2).

### C — `genie-dispatch-robustness` (to be created)
- **Owns:** Wish-parser 2.0 (Zod), work-state SSOT, spawn↔state-machine coupling, health-check disambiguation ("fork ok" vs "bootstrap ok").
- **Must emit to A:** `pathology_<A..E>_*` events when the dispatch-layer bugs recur in the wild.
- **Related work in flight:** `wish-command-group-restructure` DRAFT already proto-C-scope.

### D — `genie-ghost-hygiene` (to be created)
- **Owns:** DB UNIQUE constraints, `teams_view` recomputation invariants, filesystem↔PG consistency probes, orphan detectors for anchors + subagents, reverse error-state propagation.
- **Must emit to A:** `pathology_1..6_*` events when the state-rot patterns recur.

---

## Success Criteria

### Meta-criteria (this roadmap)
- [ ] Umbrella DESIGN.md committed to repo and auto-reviewed via `/review` (plan review).
- [ ] Four sub-project brainstorms (A exists; B, C, D to be created) each link **Parent:** this DESIGN.
- [ ] Four sub-project wishes each declare `parent: genie-self-healing-observability` so cross-cutting progress is queryable.
- [ ] `§19 (v2)` standing law recorded in HANDOFF-V3.md (done §25) and enforced by the branch-guard hook (PR #1251 merged).

### Targeted gate — every known pathology gets four artefacts (D7)
Measured by presence of each artefact per pathology:

- [ ] **Pattern 1** (ghost teams from felipe-3 backfill) — event type + D-side detector + fix PR on dev + regression test.
- [ ] **Pattern 2** (`team ls` vs `team disband` drift) — same four.
- [ ] **Pattern 3** (anchor PG row with no tmux — CRITICAL) — same four.
- [ ] **Pattern 4** (duplicate anchors by customName) — same four.
- [ ] **Pattern 5** (orphan team-leads polling) — same four.
- [ ] **Pattern 6** (cascading subagent error state) — same four.
- [ ] **Bug A** (parser accepts `review` as Group) — same four.
- [ ] **Bug B** ("wave already dispatched" cache drift) — same four.
- [ ] **Bug C** (`status` vs `work#N` disagree) — same four.
- [ ] **Bug D** (`agent spawn` bypasses state machine) — same four.
- [ ] **Bug E** ("Agent ready (0.0s)" measures fork only) — same four.

### Empirical gate — BUGLESS GENIE labelling (D8)
- [ ] `scripts/bugless-genie-clock.ts` exists, is scheduled nightly, and writes the current zero-streak count to a known event type.
- [ ] The clock reports **zero** `pathology_*` events across all 11 types for **14 consecutive days** on production genie serve.
- [ ] A single `bugless_genie_achieved` event is emitted on the day the window closes, linking all 11 `pathology_shipped` events.

### Tier 3 autonomy gate (B's v0 ship)
- [ ] Branch-guard hook at `src/hooks/handlers/branch-guard.ts` allows `gh pr merge <n>` when `baseRefName === 'dev'` (shipped PR #1251).
- [ ] All five circuit breakers R1-R5 implemented in B's merge pipeline with tests for each failure mode.
- [ ] `GENIE_AUTO_MERGE=off` env-var kill switch verified to downgrade every auto-merge attempt to a regular PR.
- [ ] At least one precedent PR exists in `.genie/auto-heal-precedents/` before B's first auto-merge on dev.

---

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|-----------|
| 1 | A slips under its own scope and B/C/D start shipping before A's event types exist | High | Gate: B's wish explicitly `depends-on: genie-serve-structured-observability` at the event-registry milestone. C and D can start earlier (they emit, don't consume) but their regression-test artefacts wait for A. |
| 2 | Feedback loop — B auto-fixes a bug inside its own emit chain, creating a new bug of the same class | High | R5 in D6 — git-diff-based scope check rejects any fix whose files intersect `src/self-heal/**` or `src/events/**`. |
| 3 | Rate-limit R1 set too high; runaway loop still damages dev | Medium | R1 v0 is 10 merges/hr, deliberately low. Tunable via config but all changes require precedent-PR (R2). |
| 4 | Precedent whitelist grows so large it rubber-stamps everything | Medium | Precedent PRs are diffable, reviewable, and timestamp-stamped. Quarterly `.genie/auto-heal-precedents/` audit added to D7 gate checklist when >20 entries exist. |
| 5 | Empirical 14d gate never closes because new pathology classes keep appearing | Medium | This is a *feature*, not a bug. If new patterns emerge, the clock resetting is correct behaviour. If resets happen >3× in a quarter, trigger a root-cause review of the emit layer itself. |
| 6 | Tier 3 hook change (PR #1251) gets reverted or regressed by a later refactor | Medium | Test coverage (59 branch-guard tests incl. specific §19 v2 scenarios) on dev; any regression fails CI on the branch-guard test file. |
| 7 | B's detector for Pattern 3 (anchor PG row without tmux) produces false positives during normal spawn race | Low-Medium | Detector requires observation duration > 60s before emit. Fixture-tested with known race windows. |
| 8 | `scripts/bugless-genie-clock.ts` itself drifts from the event registry | Low | Unit-tested with a synthetic event log; added to CI as a tier-0 test. |
| 9 | Sub-wish parallelism exhausts engineer attention — four simultaneous wishes in dispatch at once | Low | Each sub-wish is independently shippable; no requirement they run simultaneously. Roadmap declares parallel-*capable*, not parallel-*mandatory*. |

### Assumptions
- A's DESIGN already at WRS 100 and its existing execution will deliver the event registry by the time B starts consuming.
- Felipe remains the sole reviewer of auto-heal precedents (R2). Anyone else authoring a precedent requires Felipe sign-off in the precedent PR's approval chain.
- The branch-guard hook shipped in PR #1251 is the canonical enforcement point and stays on every dev machine via the hooks config. If hooks are disabled per-machine, Tier 3 autonomy on that machine is implicitly unsafe — an operational assumption, not a code guarantee.
- `dev` branch remains an integration branch where breakage is acceptable. If `dev` is ever promoted to production-equivalent, Tier 3 autonomy must be re-evaluated against the new blast radius.

---

## Next steps after crystallization

1. **Auto-invoke `/review`** (plan review) on this DESIGN.md.
2. On SHIP verdict, open three new brainstorm directories: `.genie/brainstorms/genie-bugless-self-healing/`, `.genie/brainstorms/genie-dispatch-robustness/`, `.genie/brainstorms/genie-ghost-hygiene/`. Each DRAFT declares **Parent:** this roadmap.
3. A's WISH continues as-is; add an explicit `umbrella: genie-self-healing-observability` field to its front-matter so cross-wish queries work.
4. Update `.genie/brainstorm.md` jar: move `genie-self-healing-observability` entry to the **Poured** section with link to this DESIGN.
5. Follow-up standing law check: confirm `HANDOFF-V3.md` and all rules files reflect §19 v2 consistently; no lingering v1 references remain.

---

## Parent / relations

- **Parent:** none — this IS the umbrella.
- **Children:** `genie-serve-structured-observability` (exists), `genie-bugless-self-healing` (to be created), `genie-dispatch-robustness` (to be created), `genie-ghost-hygiene` (to be created).
- **Cross-cuts:** standing law §19 (v2); precedent index at `.genie/auto-heal-precedents/`.
- **Retrospective linkages:** `reference_bugless_genie_punch_list_2026_04_19.md`, `reference_bug1_trace_findings_2026_04_20.md`, `reference_pattern9_inbox_watcher_spawn_loop.md`, PR automagik-dev/genie#1251.
