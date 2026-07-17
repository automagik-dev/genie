---
name: dream
description: "Batch-execute SHIP-ready wishes overnight — pick wishes, orchestrate workers, review delivery candidates, wake up to results."
---

# dream — Overnight Batch Execution

**Runtime syntax:** in Codex, invoke the plugin copy with the owner-qualified `$genie:<skill>` selector; use bare `$<skill>` only when intentionally selecting a user-tier copy (a separately installed personal copy; Genie no longer seeds this tier). Claude Code and Hermes use `/<skill>`. Cross-skill prose below uses bare names as portable semantic routes; the orchestrator resolves the selector for the active tier.

Pick SHIP-ready wishes, build a dependency-ordered plan, dispatch one worker subagent per wish, review delivery candidates, integrate them through the repository's PM mainline mode, run the QA loop, and write a wake-up report. The dream orchestrator dispatches — it never executes wish work directly.

This is a high-impact, explicit-only workflow. The user must approve the selected wishes and generated plan. In GitHub-backed mode, PR creation and remote merge retain their external-write authority gates; third-party review/checks remain mandatory. In zero-remote mode, validated candidate integration into local `main` plus wish archival is autonomous after plan approval. Never deploy, send external messages, expand scope, or infer policy for a non-GitHub remote without separate authority.

## When to Use
- Human wants to queue multiple wishes for autonomous overnight execution
- Multiple WISH.md files have persisted status `APPROVED`

## Flow
1. **Pick wishes** (Picker below); human confirms the selection.
2. **Generate `.genie/DREAM.md`** — dependency-ordered plan; human may edit before the run.
3. **Phase 1 — Execute:** dispatch workers layer by layer, collect outcomes.
4. **Phase 2 — Review + delivery gate:** review every PR or local delivery candidate; fix valid gaps.
5. **Phase 3 — Mainline + QA:** integrate in order using PM repository mode; QA until criteria are proven.
6. **Phase 4 — Report:** write `.genie/DREAM-REPORT.md`, the wake-up artifact.

## Picker
1. Read `.genie/wishes/*/WISH.md` and select only wishes whose Status field is exactly `APPROVED`. The brainstorm jar is historical/discovery context, never readiness authority. A Poured entry without an existing approved WISH.md is skipped and reported as drift. No matches → print `No APPROVED wishes found under .genie/wishes/` and stop.
2. List matches numbered by slug: `1. <slug> — <one-line description>`.
3. Human picks by number (`1 3 5`) or `all`.

## DREAM.md
1. Read the wish-level `**depends-on:**` value from each selected WISH.md's `## Dependencies` section (`none` means no edge).
2. Topologically sort into `merge_order` layers `1..N` — layer 1 has no selected dependencies; same-layer wishes are parallel.
3. Per-wish entry: `slug`, `branch: feat/<slug>`, `wish-path: .genie/wishes/<slug>/WISH.md`, `depends-on`, `merge-order`. Keep the canonical hyphenated keys so the plan can be checked directly against each wish.
4. Write `.genie/DREAM.md` in the dream PM's integration worktree; present for human confirmation before executing.

## Phase 1: Execute

For each `merge_order` layer, in order:
- Spawn one worker subagent per wish via the **native delegation surface** — all of the layer's spawns in ONE message so they run in parallel (background; each notifies you with its final message).
- Every brief carries the Worker Contract below plus curated wish context (goal, groups, acceptance criteria, validation commands — see `work` § Context Curation).
- Follow-ups to a running worker go through **native follow-up messaging**; completion is push (the final-message notification), never a sleep-poll.
- Inspect state on demand: `genie board --wish <slug>` / `genie task list --wish <slug>`. If a wish has no task rows, drive it off WISH.md directly — task tracking is an enhancement, never a blocker.
- The layer is done when every worker has reported; then dispatch the next layer.

### Worker Contract

Each worker, independently:
1. Work in a dedicated wish integration branch and worktree for `feat/<slug>`. Within it, execute each concurrent group in its own branch and worktree per `work`; never let parallel writers share one checkout. Use runtime-managed or ordinary Git worktrees according to the active environment.
2. Execute the wish per `work` (its group-lane dispatch, review, integration, garbage-collection, and task-state rules govern): dispatched engineers claim via `genie task checkout`; the worker leaves task state `in_progress` and reports evidence. Only the dream PM/orchestrator runs `genie task done` after clean review, integration, passing validation, and cleanup of the completed group lane.
3. Run `review` per group against acceptance criteria.
4. Run the wish validation. In GitHub-backed mode, CI must also pass; on failure fix and retry (max 3 attempts; poll CI status, never sleep-loop). After 3 failures → blocked.
5. GitHub-backed: only after CI green and authorized PR creation, create a PR targeting authoritative `main`, preferring the GitHub connector. Zero remotes: report the reviewed `feat/<slug>` tip as the local delivery candidate; do not touch `main`.
6. Final message is the completion signal, every claim audited against tool output:
   - `done — PR <url>, CI green, groups N/N`
   - `done — local candidate <sha>, validation green, groups N/N`
   - `blocked — <reason>, groups N/N`

## Phase 2: Review + Delivery Gate

**Trigger:** all workers in the layer reported done or blocked.

1. Dispatch one reviewer subagent per PR or exact local candidate commit via the native delegation surface (reviewer ≠ worker) to run `review` against the wish's acceptance criteria.
2. Read bot comments critically — never blindly accept automated findings.
3. On FIX-FIRST: diagnose first; return an overdesigned plan to wish/design review, otherwise dispatch `fix` for valid gaps (max 3 loops per PR). On another architectural issue: escalate in the report, no fix attempt.
4. In GitHub-backed mode CI must be green before proceeding — poll status, do not sleep. In zero-remote mode rerun the declared validation against the exact candidate.
5. On SHIP: mark the PR or local candidate review-complete.

## Phase 3: Mainline + QA

**Trigger:** all delivery candidates marked SHIP.

For each wish in `merge_order`:

1. GitHub-backed: run required QA on the exact PR candidate. On success, persist `SHIPPED` and completion evidence in a final closure commit, rerun required checks/review, then wait for authorized or third-party PR merge. That merge makes remote `main` authoritative. Fetch it, require clean local `main`, attempt a fast-forward/equality proof, archive the exact reviewed closure commit, then remove the clean local wish lane. Never reset, force, or locally merge the feature branch into `main`; record a failed mirror as lifecycle debt.
2. Zero remotes: create a temporary candidate from current `main`, merge the reviewed wish branch there, resolve conflicts through a bounded fixer, and validate/QA the exact result. On success, persist staged `SHIPPED` and completion evidence in the candidate and rerun required checks/review. Archive that exact integrated closure commit, remove clean wish/candidate worktrees and refs with compare-and-swap, then prove `main` is unchanged and fast-forward it to the archived commit.
3. A pre-promotion failure retains or recreates the active lane and leaves the wish `IN_PROGRESS`. A hosted mirror, archive, or cleanup failure after remote merge is reported as lifecycle debt and retried without rewriting authoritative `SHIPPED` history.
4. Each failure before mainline promotion: `report` → `trace` → `fix` → retest. In GitHub-backed mode every fix remains in the reviewed PR; in zero-remote mode every fix repeats candidate review before main fast-forward.
5. Continue until all criteria are proven or blocked.

## Phase 4: Report

Write `.genie/DREAM-REPORT.md` — always, even if every wish blocked:

```markdown
# Dream Report — <date>

## Per-Wish Status
| merge_order | slug | Delivery | Validation/CI | Review | Mainline | Local mirror | Archive/cleanup | QA |
|-------------|------|----------|---------------|--------|----------|--------------|-----------------|----|

## Blocked Wishes
- `<slug>`: <blocking reason>

## QA Findings
- `<slug>`: <criterion failed — root cause, fix delivery>

## Follow-ups
- <items requiring human intervention>
```

## Grounded Progress

The report is an audit, not a recollection. Every cell traces to tool output from the run: PR URL or local candidate SHA, validation/CI results, review verdicts, mainline and archive refs, local-mirror and cleanup state, `genie task list --wish <slug>` state, and worker final messages. State per wish exactly what is verified, what failed, and what was skipped. Report a wish shipped only with authoritative mainline and QA evidence; list every mirror, archive, or cleanup debt, and never report the lifecycle fully closed while any remains.

## Rules
- Never early-stop: a blocked wish is recorded and the remaining wishes continue.
- Never skip Phase 2 or Phase 3 — every delivery candidate is reviewed and every mainline result is QA-tested against wish criteria.
- The orchestrator never executes wish work — always dispatch worker subagents.
- No scope beyond what each WISH.md defines.
- Poll CI status — never `sleep` in retry loops.
