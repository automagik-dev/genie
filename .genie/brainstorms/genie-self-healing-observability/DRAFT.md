# DRAFT: genie-self-healing-observability (umbrella roadmap)

| Field | Value |
|-------|-------|
| **Slug** | `genie-self-healing-observability` |
| **Role** | Umbrella / parent roadmap that coordinates sub-projects A/B/C/D |
| **Status** | BRAINSTORM — simmering |
| **Date opened** | 2026-04-21 |
| **Initiator** | felipe |
| **Mode** | RICH CONTEXT — depth authorized |

---

## Felipe's framing (verbatim, primary source)

> "genie has SO MANY FUCKING BUGS, its barely working, we need to find a way to create self release microfix loops, until everything is crystal clean, no bugs, no weird loops, no ghost respawns, no ghost teams, every message arrives the destination. BUGLESS GENIE."
>
> "Improve our genie serve logs observability, in a way that you will know the source of the bug, when it happens next, so that genie becomes fully self healing."

Two sentences. One is the north star (**BUGLESS GENIE**). One is the mechanism (**observability so bugs name themselves, then auto-heal**).

---

## Existing decomposition (inherited from sub-project A's DESIGN)

Sub-project A (`genie-serve-structured-observability`, WISH DRAFT, Wave 3 partially shipped as B1 detector waves) already crystallized at WRS 100 and **explicitly names this slug (`genie-self-healing-observability`) as its parent**. A's OUT scope pre-declares the other three:

| Sub-project | Name | Scope seed (from A's OUT list) |
|-------------|------|-------------------------------|
| **A** | `genie-serve-structured-observability` | Typed event substrate, emit.ts, 4-channel trace correlation, RBAC, retention tiers, consumer CLI. **Status: DESIGN ✅, WISH in-progress, B1 detector waves shipping.** |
| **B** | self-healing microfix loops | Consumers of A's event stream that react (auto-doctor-fix, auto-PR, auto-issue). A declares "Any auto-action reacting to its own events" as B's territory. |
| **C** | dispatch robustness | Wish-parser 2.0 (Zod), work-state SSOT, spawn↔state-machine coupling, health-check disambiguation. |
| **D** | ghost hygiene by default | DB UNIQUE constraints, teams_view recomputation, orphan detectors, state propagation, filesystem↔PG consistency. |

**Interpretation:** the decomposition is *already* canonical. This brainstorm's job is **not** to invent it — it's to lock sequencing, appetite, success criteria, and cross-cutting dependencies so A+B+C+D roll up to a coherent BUGLESS-GENIE deliverable.

---

## Evidence collected in recent sessions (input, not scope)

### Part 1 — 6 patterns of state rot (from Bug #1 trace + live observations)

| # | Pattern | Primary home | Secondary interest |
|---|---------|--------------|-------------------|
| 1 | Teams backfilled without worktree (5 ghosts from `felipe-3`, identical timestamp) | **D** (filesystem↔PG consistency) | A (stream surfaces the anomaly) |
| 2 | Drift between `team ls` and `team disband` — 4/5 ghosts not found on disband | **D** (SSOT / view recomputation) | A (correlation of divergent reads) |
| 3 | Anchor PG row with no tmux session — "error (0/3 resumes)" + "Session not found" on resume (**CRITICAL — root of phantom spawn**) | **D** (lifecycle invariant) | C (spawn returns success without substrate), A |
| 4 | Duplicate anchors by customName — engineer×2, reviewer×2, fix×4 | **D** (UNIQUE constraint) | — |
| 5 | Orphan team-leads in polling loop (27+ min idle, ScheduleWakeup zombie) | **B** (idle-detector consumer) | D (auto-disband) |
| 6 | Cascading subagent error state with no reverse propagation | **D** (state tree invariant) | B (parent_recovered event consumer) |

### Part 2 — 5 dispatch bugs (from wish-command-group-restructure session)

| Bug | Summary | Primary home |
|-----|---------|--------------|
| A-bug | Wish parser accepts `review` as Group name, `genie work` dies zombie | **C** (Zod schema) |
| B-bug | "wave already dispatched" cache immune to `genie reset` | **C** (eliminate cache, derive from wish_groups) |
| C-bug | `status` reports ready but `work …#1` reports "already in progress" | **C** (SSOT for wish_group state) |
| D-bug | `genie agent spawn` bypasses state machine | **C** (coupling when `--team` + slug present) |
| E-bug | "✓ Agent ready (0.0s)" measures fork, not bootstrap — same line shown on phantom spawns | **C** + **A** (health-check primitive + visibility) |

### Part 3 — 5 architectural root-cause hypotheses

| # | Hypothesis | Primary lever |
|---|-----------|---------------|
| 1 | No single source of truth — each subsystem (agents, teams, wishes, groups, executors) owns storage + cache + view; nothing validates cross-cutting invariants. | **D** (view recomputation, invariant guards) |
| 2 | No write path is idempotent + deduped — backfills insert duplicates, spawns create UUID orphans, resume resets counter without cleaning subproduct. | **D** + **C** |
| 3 | Logs are human prose, not observable streams — `genie events` exists but is too fine-grained (success every 80ms) with no bug-cause correlation. | **A** (exactly its scope) |
| 4 | No periodic self-check — `genie doctor` checks service health, not state consistency. Nothing detects "Pattern N just happened again". | **B** (doctor plugins + auto-fix queue) |
| 5 | Wish-parser fragility kills dispatch in production — any char wrong in WISH.md leaves `genie work` zombie. | **C** (Zod schema + linter) |

---

## Related work already in flight (must respect, must not duplicate)

- **A WISH `genie-serve-structured-observability`** — DRAFT, Wave 3.2 partially shipped as "B1 detector waves" (PRs #1236, #1237, #1239 merged, #1192 in flight). Do **not** re-decide A's scope here.
- **Bug #1 trace** (`reference_bug1_trace_findings_2026_04_20.md`) — `genie done` silent no-op → belongs in C or D depending on root cause; DB is now fresh so re-trace is feasible.
- **Pattern 9** (`reference_pattern9_inbox_watcher_spawn_loop.md`) — inbox-watcher silent drop after 3 failures → B1-adjacent healing primitive, also standalone fix candidate.
- **Wish `wish-command-group-restructure`** — DRAFT for Zod-schema parser → proto-C scope.

---

## Open forks (what this brainstorm must decide)

### F1. Umbrella framing confirmation
Is this brainstorm:
- **(a) Roadmap crystallization** — lock sequencing, success criteria, cross-cutting contracts. Each sub-project keeps its own brainstorm → wish → execution.
- **(b) Fresh deep-dive on one vertente** — replace or supersede an existing sub-brainstorm.

*Working hypothesis: (a). Existing A DESIGN declares this slug as its parent; decomposition is already canonical.*

### F2. Sequencing between A / B / C / D
Three shapes viable:
- **Pure sequential** — A (shipping) → B → C → D. Slowest. Safest. Each sub-project fully informs the next.
- **A-first then B/C/D parallel** — A is the substrate; once emit.ts + consumer CLI land, B/C/D can race as independent sub-projects. *Felipe's own lean.*
- **All parallel now** — A+B+C+D simultaneously, accepting that B will be blind to A's stream until late. Highest risk of rework.

*Working hypothesis: A-first then B/C/D parallel — matches `experiment-before-converging` memory law (substrate + N consumers).*

### F3. Appetite / finish-line definition
- **Small** — only B consumer `doctor --fix` covering Patterns 1/2/4/5 (low-risk auto-heal). Ships fast. Doesn't touch C or D.
- **Medium** — A + B. Observability + auto-heal loop. Leaves dispatch fragility and ghost hygiene to the dispatch-level humans for now.
- **Large** — A + B + C + D. Full BUGLESS GENIE. Parser 2.0, SSOT everywhere, auto-heal, auto-PR, 0 ghosts.

Felipe's quote ("BUGLESS GENIE, no bugs, no weird loops, no ghost respawns, no ghost teams, every message arrives the destination") reads as **Large** with explicit criteria. But explicit is better than assumed.

### F4. "Done" test — observable vs targeted
- **(a) Empirical** — BUGLESS GENIE = 14 consecutive days where A's event stream surfaces zero occurrences of Patterns 1-6 + dispatch Bugs A-E. Self-attesting via A. Requires B to exist as a long-running watcher to even measure.
- **(b) Targeted** — BUGLESS GENIE = every known pattern has a ship-confirmed detector + fix + regression test. Deterministic. Can be ticked off group-by-group. Each sub-project ships independently.

(a) is rigorous but slow + requires B to be substantive. (b) is tangible but defines "done" as "we fixed the ones we knew about" — blind to unknown unknowns.

*Working hypothesis: hybrid — (b) gates ship, (a) gates claiming "BUGLESS".*

### F5. Rollout shape
- **One mega-wish** — A+B+C+D as a single `genie-self-healing-observability` WISH with 4 waves. Easy to track. Hard to execute (too many groups, too much scope creep risk).
- **Four paralleling wishes** — each sub-project gets its own WISH linked to this umbrella brainstorm. Dependencies declared via `depends-on`. Easier execution. Harder to see "BUGLESS GENIE is X% done".

*Working hypothesis: four paralleling wishes. A already exists. This brainstorm's DESIGN crystallizes into an umbrella tracker doc, not a wish.*

---

## What this brainstorm is NOT

- **NOT** re-designing A. A is crystallized.
- **NOT** implementing anything. Pure design.
- **NOT** a single-wish brainstorm. It crystallizes into an umbrella DESIGN that spawns 3 child brainstorms (B, C, D) each of which becomes its own wish.
- **NOT** collecting more field evidence. Evidence above is sufficient.

---

## Decisions Locked

### D1 — Finish-line definition (F4)
**Hybrid (H).** Each sub-wish ships gated by targeted acceptance — detector + fix + regression test per known Pattern/Bug. Right to claim BUGLESS-GENIE label only after A's event stream records **zero** occurrences of the 11 mapped pathologies for 14 consecutive days in production. Targeted is the shipping gate; empirical is the labelling gate.

**Consequences:**
- B (self-healing consumer) is **mandatory**, not optional — without B there's no long-running watcher to measure the empirical gate.
- A's event registry must carry **explicit type tags** for each of the 11 pathologies so the 14d counter is mechanically computable (not prose-pattern-matched).
- 14d window starts when the last sub-wish (A, B, C, or D) merges its last ship-confirmed fix to dev. Any regression resets the clock.

### D2 — Umbrella framing (F1)
**(a) Roadmap crystallization.** This brainstorm does NOT replace sub-brainstorms. DESIGN.md at crystallization is an umbrella roadmap doc, not a wish. Each of B/C/D gets its own brainstorm → DESIGN → WISH → execution. A already exists.

### D3 — Sequencing (F2)
**A-first, then B/C/D parallel.** Matches `experiment-before-converging` law: A is substrate; B/C/D are independent consumers/fixers. No hidden cross-deps identified yet — to validate in next turn.

### D4 — Rollout shape (F5)
**Four paralleling wishes** linked to this umbrella DESIGN via `Parent` field. A's wish already exists. B/C/D each get their own. Dependencies declared via `depends-on` if any surface.

### D5 — B's autonomy ceiling
**Tier 3 — auto-PR + auto-merge on dev.** B may open PRs and merge them on `dev` when:
- The fix matches a pre-approved pattern signature (established by Felipe-approved precedent PR).
- Regression test is green.
- CI is green.
- Circuit breakers (see Risks) are not tripped.

Main/master merges remain humans-only via GitHub UI. Cross-cut with corrected standing law **§19 (v2, 2026-04-21)**.

**Trigger for law correction:** Felipe, 2026-04-21 inside this brainstorm — _"DEV é um lugar onde vc tem total liberdade, main, somente CRIAR pr... arruma ai, arruma no genie também pq isso é um misconception."_

**Law-correction artifacts (shipped same session):**
- `HANDOFF-V3.md §25` — new §19 (v2) documented on the felipe-agent side.
- **PR automagik-dev/genie#1251** — `fix/branch-guard-allow-dev-merge` branch — hook now resolves PR's `baseRefName` at check time, allows merge when base=dev, denies otherwise with fall-closed on resolve failure. 59 tests pass. **Merged 2026-04-21.**

**Why this matters for the umbrella:** T3 + §19 (v2) is what unlocks the "self release microfix loops" from Felipe's original BUGLESS-GENIE mandate. Without T3 the loop has a human-approval gate between fix and ship that breaks the self-healing property. Without §19 (v2) T3 is blocked by the very hook that's supposed to protect the system.

### D6 — Risks / circuit breakers for Tier 3 (v0 scope of B)
All five layers **mandatory** for B's v0 release. Tier 3 autonomy without all five = uncontrolled self-mutating production system. Any layer missing blocks v0 ship.

| # | Layer | Scope | Mechanism | Failure mode it prevents |
|---|-------|-------|-----------|--------------------------|
| R1 | **Rate limit** | ≤ 10 auto-merges/hr per running B instance, counted across all patterns combined | Track merge attempts in PG; refuse merge when window count ≥ 10; emit `auto_merge_rate_limited` event | Runaway merge storm if a detector fires on its own fix's side-effects |
| R2 | **Pattern whitelist** | Auto-merge allowed only for pathologies with a Felipe-signed **precedent PR** recorded in `.genie/auto-heal-precedents/<pathology>.md` | Detector reads precedent file at check time; refuses merge if none found; emits `auto_merge_missing_precedent` with proposed PR URL | Novel auto-fixes shipping without human review of the class |
| R3 | **Kill-switch env var** | `GENIE_AUTO_MERGE=off` forces B to downgrade every auto-merge into a regular PR (no self-merge) without restart | Read env at every merge check; log both the attempt and the downgrade | Emergency human override that cannot fail-open |
| R4 | **A-signal pause** | If A's event stream shows an anomaly spike (e.g. emit-rate > 3σ over 10 min baseline) B stops auto-merging for the following 30 min | B subscribes to an `emit_anomaly` event type in A's registry; pause is per-B-instance | B making things worse during substrate instability |
| R5 | **Feedback-loop detector** | B refuses to auto-fix any pathology whose root-cause file is inside B's own implementation tree (`src/self-heal/**`) or inside A's emit chain (`src/events/**`) | Git diff on candidate fix; reject if any touched path matches | B auto-merging a fix for a bug it caused, re-triggering itself |

**Kill-switch tier is inverted:** R3 must work even when PG is down or A is unreachable (env-var check only). The other four layers require functional substrate.

### D7 — Targeted ship-gate criteria (per pathology, deterministic)
Every known pathology (6 state-rot patterns + 5 dispatch bugs = 11 total) gets **four** artefacts before it counts as shipped:

1. **Explicit event type** in A's registry — named `pathology_<n>_<slug>` (e.g. `pathology_3_anchor_no_tmux`). B's detector emits this type every time it observes the pattern.
2. **Automated detector** in B's plugin set — runs on every A-event batch; unit-tested with fixture data reproducing the pattern at least once.
3. **Fix PR merged to dev** — either human-authored (v0 B state) or auto-merged via Tier 3 once precedent is filed.
4. **Regression test** in the CI suite that fails on main when the bug is reintroduced; test references the pathology event type by name.

**A pathology is "shipped"** when all four exist and the most recent CI run on `dev` is green on its regression test.

### D8 — Empirical BUGLESS-GENIE labelling gate (rolling window)
The "BUGLESS GENIE" label may be claimed only when:

1. **All 11 pathologies shipped** per D7 (targeted gate fully satisfied).
2. **A's event stream** records **zero** `pathology_*` events across all 11 types for **14 consecutive days** on production genie serve.
3. The 14-day counter **resets on any new `pathology_*` event**, including one detected for a *new* pattern class added to the registry after v0 ship.
4. The counter is computed by a query script — NOT by human-read log inspection. Script lives at `scripts/bugless-genie-clock.ts` and is run nightly; its output is the only valid source.

**When BUGLESS-GENIE is claimed:** B emits a single `bugless_genie_achieved` event with the timestamp of day-14 + links to all 11 pathology `pathology_shipped` events. Felipe then chooses whether to broadcast it.

**Open pathology classes** (known-unknowns — addressed if/when observed):
- **Pattern 9** — inbox-watcher silent drop after 3 spawn failures (already traced, candidate for D7 artefact chain).
- **Future patterns** — added to registry via precedent-PR mechanism (R2).

## WRS Trail (append-only)

| Turn | WRS | Problem | Scope | Decisions | Risks | Criteria | Note |
|------|-----|---------|-------|-----------|-------|----------|------|
| 0 | 60/100 | ✅ | ✅ | ░ | ░ | ░ | Problem + Scope locked by seed + existing A DESIGN. Decisions/Risks/Criteria open (F1-F5). |
| 1 | 80/100 | ✅ | ✅ | ✅ | ░ | ░ | D1 Hybrid finish-line locked → implies D2 umbrella + D3 A-first-then-parallel + D4 4-paralleling-wishes (all inherit from H). Risks + Criteria next. |
| 2 | 100/100 | ✅ | ✅ | ✅ | ✅ | ✅ | D5 Tier 3 locked + PR #1251 merged (§19 v2 live). D6 5-layer circuit breaker for B's v0. D7 4-artefact targeted gate per pathology. D8 empirical 14d rolling gate with script as SSOT. Crystallize. |
