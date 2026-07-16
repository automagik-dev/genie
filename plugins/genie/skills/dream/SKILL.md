---
name: dream
description: "Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review PRs, wake up to results."
---

# dream — Overnight Batch Execution

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Pick SHIP-ready wishes, build a dependency-ordered plan, dispatch one worker subagent per wish, review PRs, merge to dev, run the QA loop, and write a wake-up report. The dream orchestrator dispatches — it never executes wish work directly.

This is a high-impact, explicit-only workflow. The user must approve the selected wishes, the generated plan, PR creation, and merge-to-`dev` authority. Never merge to `main` or `master`, deploy, send external messages, or expand scope without separate authority.

## When to Use
- Human wants to queue multiple wishes for autonomous overnight execution
- Multiple WISH.md files have persisted status `APPROVED`

## Flow
1. **Pick wishes** (Picker below); human confirms the selection.
2. **Generate `.genie/DREAM.md`** — dependency-ordered plan; human may edit before the run.
3. **Phase 1 — Execute:** dispatch workers layer by layer, collect outcomes.
4. **Phase 2 — Review + PR:** review every PR, fix valid gaps, CI green.
5. **Phase 3 — Merge + QA:** merge to dev in order, QA loop until criteria proven.
6. **Phase 4 — Report:** write `.genie/DREAM-REPORT.md`, the wake-up artifact.

## Picker
1. Read `.genie/wishes/*/WISH.md` and select only wishes whose Status field is exactly `APPROVED`. The brainstorm jar is historical/discovery context, never readiness authority. A Poured entry without an existing approved WISH.md is skipped and reported as drift. No matches → print `No APPROVED wishes found under .genie/wishes/` and stop.
2. List matches numbered by slug: `1. <slug> — <one-line description>`.
3. Human picks by number (`1 3 5`) or `all`.

## DREAM.md
1. Read the wish-level `**depends-on:**` value from each selected WISH.md's `## Dependencies` section (`none` means no edge).
2. Topologically sort into `merge_order` layers `1..N` — layer 1 has no selected dependencies; same-layer wishes are parallel.
3. Per-wish entry: `slug`, `branch: feat/<slug>`, `wish-path: .genie/wishes/<slug>/WISH.md`, `depends-on`, `merge-order`. Keep the canonical hyphenated keys so the plan can be checked directly against each wish.
4. Write `.genie/DREAM.md` in the shared worktree; present for human confirmation before executing.

## Phase 1: Execute

For each `merge_order` layer, in order:
- Spawn one worker subagent per wish via the **native delegation surface** — all of the layer's spawns in ONE message so they run in parallel (background; each notifies you with its final message).
- Every brief carries the Worker Contract below plus curated wish context (goal, groups, acceptance criteria, validation commands — see `work` § Context Curation).
- Follow-ups to a running worker go through **native follow-up messaging**; completion is push (the final-message notification), never a sleep-poll.
- Inspect state on demand: `genie board --wish <slug>` / `genie task list --wish <slug>`. If a wish has no task rows, drive it off WISH.md directly — task tracking is an enhancement, never a blocker.
- The layer is done when every worker has reported; then dispatch the next layer.

### Worker Contract

Each worker, independently:
1. Work in a dedicated branch and worktree for `feat/<slug>`; never let parallel writers share one checkout. Use Codex-managed or ordinary Git worktrees according to the active environment.
2. Execute the wish per `work` (its dispatch, review-gate, and task-state rules govern): dispatched engineers claim via `genie task checkout`; the worker leaves task state `in_progress` and reports evidence. Only the dream PM/orchestrator runs `genie task done` after clean review and passing validation.
3. Run `review` per group against acceptance criteria.
4. Run CI; on failure fix and retry (max 3 attempts; poll CI status, never sleep-loop). After 3 failures → blocked.
5. Only after CI green and authorized PR creation: create a PR targeting `dev`, preferring the GitHub connector.
6. Final message is the completion signal, every claim audited against tool output:
   - `done — PR <url>, CI green, groups N/N`
   - `blocked — <reason>, groups N/N`

## Phase 2: Review + PR

**Trigger:** all workers in the layer reported done or blocked.

1. Dispatch one reviewer subagent per PR via the native delegation surface (reviewer ≠ worker) to run `review` against the wish's acceptance criteria.
2. Read bot comments critically — never blindly accept automated findings.
3. On FIX-FIRST: diagnose first; return an overdesigned plan to wish/design review, otherwise dispatch `fix` for valid gaps (max 3 loops per PR). On another architectural issue: escalate in the report, no fix attempt.
4. CI must be green before proceeding — poll status, do not sleep.
5. On SHIP: mark the PR review-complete.

## Phase 3: Merge + QA

**Trigger:** all PRs marked SHIP.

1. After explicit merge authorization, merge PRs to `dev` in `merge_order`; never merge to `main` or `master`.
2. Dispatch a qa subagent on dev to test against each wish's QA criteria.
3. Each failure: `report` → `trace` → `fix` → retest. Every fix is a new PR through review and merge.
4. Continue until all criteria are proven or blocked.

## Phase 4: Report

Write `.genie/DREAM-REPORT.md` — always, even if every wish blocked:

```markdown
# Dream Report — <date>

## Per-Wish Status
| merge_order | slug | PR | CI | Review | Merged | QA |
|-------------|------|----|----|--------|--------|----|

## Blocked Wishes
- `<slug>`: <blocking reason>

## QA Findings
- `<slug>`: <criterion failed — root cause, fix PR>

## Follow-ups
- <items requiring human intervention>
```

## Grounded Progress

The report is an audit, not a recollection. Every cell traces to tool output from the run: PR URLs, CI results, review verdicts, `genie task list --wish <slug>` state, worker final messages. State per wish exactly what is verified, what failed, and what was skipped. Never report a wish shipped until its merge and QA evidence is in hand — dispatched is not done.

## Rules
- Never early-stop: a blocked wish is recorded and the remaining wishes continue.
- Never skip Phase 2 or Phase 3 — every PR is reviewed, every merge is QA-tested against wish criteria.
- The orchestrator never executes wish work — always dispatch worker subagents.
- No scope beyond what each WISH.md defines.
- Poll CI status — never `sleep` in retry loops.
