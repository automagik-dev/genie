# Design: Token-Efficiency Rebaseline — deliver the pins, measure, then re-platform /work on workflows

| Field | Value |
|-------|-------|
| **Slug** | `token-efficiency-rebaseline` |
| **Date** | 2026-07-11 |
| **WRS** | 100/100 |
| **Parent** | [genie-token-efficiency-program](../genie-token-efficiency-program/DESIGN.md) (umbrella, 2026-07-09) — this rebaseline re-sequences its remainder against post-07-09 reality |

## Problem

The umbrella program's #1 lever — pinned role agents so dispatches stop inheriting the session's
Fable-max tier — has been code-complete since 07-09 but **never took effect**: the seven role-agent
files ship only inside the genie Claude Code plugin, which is disabled in the user's settings
(`"genie@automagik": false`), and `genie update`'s file-copying engine (agent-sync) fans skills and
workflows but never agents. Every dispatch has therefore run at the most expensive tier while burn sat
at $658–$3.4k/day (LangWatch, 07-08→07-11), and the 40%-reduction success criterion's clock never
started. Meanwhile the day-2 LangWatch pull proved a second co-equal lever: **cache re-send is 95.6% of
all processed tokens** — context volume, not generation, is the bill.

## Scope

### IN
1. **Delivery fix (wish 1 — small):** `genie update` (agent-sync engine) fans the seven role-agent files
   into `~/.claude/agents/` with the managed-dir stamp + backup discipline it already uses for skills;
   `genie doctor` reports missing/stale role agents; day-3 QA re-runs the LangWatch comparison to confirm
   the pins fire mechanically. (Interim unblock already applied 2026-07-11: files hand-copied on this host.)
2. **Measurement (wish 2):** `genie spend` Phase 1 per the fully-ratified genie-spend DRAFT — CLI
   shell-out to the proven `langwatch` recipes; key from CC settings env with genie-config override;
   on-demand only; Felipe-only CLI consumer; no doctor burn check; `--composition` view
   (prompt/completion/cache-read/cache-write) added on day-2 evidence; every output labels
   trace-level vs span-level lens + pull timestamp.
3. **Workflow re-platform (wish 3 — the OUT flip):** structured /work wave dispatch moves to Workflow
   scripts where every `agent()` call pins `model`+`effort` and carries a context-diet brief (group +
   acceptance + relevant files only — umbrella Decision 5); review fan-out follows the same pattern
   (council.js already proves the substrate). Pinned role agents remain the surface for ad-hoc/
   interactive dispatch (hybrid ruling). *Wish-author note (plan-review LOW): wave dispatch and review
   fan-out are one abstraction here but may split into two execution groups — split at /wish time if
   sizing demands.*
4. Re-sequenced umbrella remainder recorded: after wishes 1–3 → always-on identity (G5, wish-ready) →
   dispatch contract + convergence (G2/G3) → delegate (G6) → brainstorm domain-map (G8) → dream
   replatform (G9) → worktree isolation (G10).

### OUT
- Re-enabling the Claude Code plugin as a delivery path (duplicate skill listings; plugin-less
  architecture stays; the disabled plugin's eventual removal from the flow is its own later cleanup).
- All umbrella OUTs carry: Sonnet in the matrix, agent-teams task truth, opencode adapter, pm
  methodology, learn→brain execution, docs restructure.
- genie-spend Phase 2 (outcome-label join) — stays sequenced after Phase 1 per the umbrella.
- Scheduled spend snapshots / omni digests (deferred to dream-replatform per ratification).

## Approach

Fix → Spend → Workflows (Felipe-ratified 2026-07-11). Deliver the pins through the updater's existing
fan-out engine (one bounded change, bare agent names match the acceptance test, `~/.claude/agents/` is
live-watched so updates land without restart), start the measurement loop on the ratified recipes, and
only then re-platform /work waves on Workflow scripts — so the biggest change lands with the spend loop
already watching it. *Amendment (Felipe-directed 2026-07-11): the parallel
`genie-execution-optimization-dashboard` lab benchmarks fragmented vs packed vs packed+effort-routed
session strategies — wish 3 must NOT pre-commit to maximal fan-out; it lands after the lab's benchmark
picks an arm, and implements the winning shape.* Alternatives considered: re-enable the plugin (rejected — duplicate skill listings,
namespaced agent names, keeps a dead dependency alive); workflows before measurement (rejected —
re-platforming on vibes is the failure mode the umbrella was built to kill); measurement first
(rejected — the delivery fix is tiny and every unpinned day costs real money).

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Role agents delivered by `genie update` fan-out into `~/.claude/agents/`, not by the plugin | Root cause was the disabled plugin; fan-out uses shipped machinery, yields bare names (matches routing-matrix acceptance test), live-watched dir, no duplicate listings. Felipe-ratified. |
| 2 | Hand-copy applied 2026-07-11 as interim unblock on this host | Savings start immediately; the real fix rides the next release. Day-3 QA must verify via a fresh session, not this host's hand-copy alone. |
| 3 | Sequencing: Fix → Spend → Workflows | Felipe-ratified; matches data (delivery fix is days-cheap; spend loop is ratified and proven; the workflow re-platform is the big lever and lands under measurement). |
| 4 | genie-spend Phase 1 config ratified: CC settings env + config override; on-demand only; Felipe-only CLI; NO doctor burn check | Felipe-ratified 2026-07-11; doctor stays install-health-focused. |
| 5 | /work wave dispatch re-platforms on Workflow scripts with per-`agent()` model+effort pins and context-diet briefs; pinned agents cover ad-hoc dispatch (hybrid) | Felipe-ratified; council.js proves the substrate; workflow agents carry small fresh contexts, attacking the 95.6% cache-read finding directly; flips the umbrella's "later experiment" OUT with new evidence. |
| 6 | Spend reports must label cost lens (trace-level day totals vs span-level model shares) + pull timestamp | Day-2 pull proved the two lenses differ ~1.7× and late ingestion shifts totals; unlabeled numbers would mislead. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | Fan-out into `~/.claude/agents/` collides with user-authored agents | Medium | Managed-dir stamp (`.genie-sync.json`) + backup-first replacement, same contract as skills; doctor surfaces orphans |
| 2 | Pins fire but burn doesn't fall 40% because cache re-send (context volume) dominates | High | Wish 3 exists precisely for this; spend `--composition` view tracks the cache-read fraction as its own success signal |
| 3 | Workflow re-platform degrades /work quality (orchestrator loses conversational recovery) | High | Umbrella escalation discipline carries; per-group fix loops stay; re-platform ships behind measurement with the ~11%-Fable-share benchmark wish as reference |
| 4 | LangWatch CLI/API drift breaks spend recipes | Low | Recipes archived with command shapes in QA files; genie spend shells out (no REST); failures degrade to error, not wrong numbers |
| 5 | Assumption: `~/.claude/agents/` agents are honored with `model`+`effort` frontmatter equally to plugin agents | — | **CONFIRMED live 2026-07-11 ~20:15Z**: fresh headless session lists all seven bare-named after the hand-copy (docs confirmation: cc-guide pull same day); day-3 QA still verifies model×effort fingerprints via LangWatch |
| 6 | Hand-copied files drift from source until the fan-out ships | Low | Next `genie update` with the fix adopts them under the managed stamp; doctor flags staleness |
| 7 | Hosts with the genie plugin ENABLED would get duplicates: `genie:*` (plugin) + bare names (fan-out) | Medium | Wish 1 must probe `enabledPlugins` and, when the plugin is enabled, warn (doctor) and document the resolution (skip fan-out or instruct disable) — mirror of the duplicate-listing reason option (a) was rejected |

## Success Criteria

- [ ] Fresh session lists all seven role agents (`engineer-trivial/standard/complex`, `fixer`,
      `reviewer`, `final-gate`, `scout`) as subagent types with bare names — **and** `genie doctor`
      reports them as **genie-managed (`.genie-sync.json` stamped by `genie update`), not merely
      present**, so the pre-existing hand-copy cannot false-PASS the fan-out fix; equivalent proof: QA
      on a clean host without the hand-copy. (Interim surfacing already verified 2026-07-11 ~20:15Z via
      fresh headless session — that proves the surface, not the fan-out.)
- [ ] Day-3 LangWatch pull: the **mechanical fingerprint check is the primary test** — dispatched
      engineering traces carry the pinned `model×effort` per role. Fable token share trending down from
      51.7% toward the ~11% gate-only benchmark is directional only (denominators are small and
      thread-concentrated: 67 traces, top-3 threads = 80.7% of cost — check the trend with top-3
      excluded before reading it). (verify: re-run the day-2 recipe set.)
- [ ] `genie spend` answers $/day, $/model×effort, top sessions, composition in <5s with lens +
      timestamp labels (verify: live run against langwatch.khal.ai).
- [ ] One real wish executes its waves via Workflow scripts with per-agent pins and context-diet briefs;
      its per-wish Fable token share lands at **≤~11% (the properly-pinned-wish benchmark)** — and the
      QA attributes cache-read volume to **orchestrator vs worker spans**, since workers being cheap by
      construction must not mask an unchanged orchestrator-thread bill (verify: LangWatch thread
      analysis of that wish's session).
- [ ] Umbrella INDEX entry updated with the re-sequenced remainder so the program's status is readable
      without this brainstorm's history.

## Next Step

Run `/wish` on wish 1 (routing-delivery-fix); genie-spend DRAFT is wish-ready in parallel.
