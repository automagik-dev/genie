---
name: dream
description: "Overnight autonomous execution — pick SHIP-ready wishes, execute while you sleep, wake up to green PRs."
---

Replaces /sleepyhead

## Picker

1. **Read source jar**
   - Read `.genie/brainstorm.md`.
   - Locate the `✅ Poured` section.
   - Parse each SHIP-ready entry in listed order, extracting:
     - `slug`
     - one-line description from the same jar entry

2. **Build picker display**
   - If no valid entries are found under `✅ Poured`, print exactly:
     - `No SHIP-ready wishes found in .genie/brainstorm.md`
   - Then exit immediately.
   - Otherwise, print a numbered list (preserve original order):
     - `<index>. <slug> — <one-line description>`

3. **Capture human selection**
   - Prompt the human to choose by number(s) (`1 3 5`) or `all`.
   - Accept whitespace-separated numbers.
   - `all` selects all displayed wishes in current order.
   - For numeric input, map each number to the corresponding displayed item.
   - Keep selected wishes in the same order they appear in the displayed list.

4. **Output for next step (DREAM.md generation input)**
   - Emit the ordered selected set in this explicit structure:
     - `- <slug>: .genie/wishes/<slug>/WISH.md`
   - Example:
     - `- dream-skill: .genie/wishes/dream-skill/WISH.md`
     - `- review-skill: .genie/wishes/review-skill/WISH.md`

## DREAM.md Generation

1. **Input (from Picker output)**
   - Receive the ordered selected wish list produced by Picker as:
     - `- <slug>: .genie/wishes/<slug>/WISH.md`
   - This gives both the ordered slug list and each `WISH.md` path.

2. **Build merge order (topological dependency layering)**
   - For each selected wish, read its `depends_on` field from the referenced `WISH.md`.
   - Compute a **topological** sort/layering across selected wishes.
   - Assign `merge_order` as integer layers `1..N`:
     - `merge_order: 1` for wishes with no selected dependencies.
     - Increment layer when dependencies require later merge.
     - Wishes in the same dependency level are parallel and share the same `merge_order` number.

3. **Generate per-wish DREAM entry fields**
   - `slug` — wish identifier.
   - `branch` — `feat/<slug>`.
   - `worktree_path` — e.g. `/tmp/dream-worktrees/<slug>`.
   - `wish_path` — path to `WISH.md` from Picker output.
   - `worker_prompt` — self-contained worker instructions including:
     - `wish_path`
     - `branch`
     - `worktree_path`
     - CI command to run
     - reporting format to return
   - `depends_on` — list of upstream slugs from `WISH.md`.
   - `merge_order` — integer produced by the topological layering step.

4. **Write orchestrator file**
   - Output path is `.genie/DREAM.md`.
   - Write this file in the target agent repository (not in the skills repository).

5. **Human review before run**
   - Present `.genie/DREAM.md` for confirmation.
   - Human may edit DREAM.md before triggering execution.

## Phase 1: Execute Team

1. **Create lead team context**
   - Attempt: `TeamCreate("dream-<date>")`.
   - Team name should include the run date (for traceability), e.g. `dream-2026-02-17`.

2. **Fallback if team creation fails**
   - If `TeamCreate` fails, fall back to `sessions_spawn`.
   - In fallback mode, execute wishes sequentially (one-by-one), still using each wish's `worker_prompt`.

3. **Lead execution loop (never early-stop)**
   - Read `.genie/DREAM.md` in listed order.
   - For each wish entry:
     - Create isolated workspace: `git worktree add <worktree_path> <branch>`.
     - Spawn exactly one worker for that wish using `Task`, passing the wish `worker_prompt` from DREAM.md.
   - Collect worker outcomes via `SendMessage`.
   - Anti-stop rule: if any wish returns `BLOCKED`, record the reason and continue with remaining wishes. Never stop before all wishes are attempted.

4. **Worker contract (self-contained, per wish)**
   - Read `WISH.md` from `wish_path`.
   - Prepare branch in worktree:
     - `cd <worktree_path> && git checkout -b <branch>`.
   - Implement all execution groups required by that `WISH.md`.
   - Run CI fix loop with max 3 retries:
     - Run CI command.
     - If CI fails, fix issues, `sleep 5`, retry.
     - Retry limit is exactly 3 retries; if still failing after limit, mark wish BLOCKED.
   - Only after CI is green, open PR:
     - `gh pr create --base <base_branch>`.
   - Report result back to lead in exact format:
     - Success: `DONE: PR at <url>. CI: green. Groups: N/N.`
     - Failure: `BLOCKED: <reason>. Groups: N/N.`

5. **Lead result handling**
   - Aggregate all worker messages (`DONE:` / `BLOCKED:`) into run status.
   - Preserve per-wish result, including BLOCKED reasons, for Phase 2 review handoff.

## Worker Self-Refinement

Before executing any task, workers self-refine their task prompt using `/refine`:

1. Call `/refine <task-prompt>` (text mode) — pass the task description as input
2. Also pass WISH.md path as context anchor: include it in the refine call to prevent scope invention
3. Read the output from `/tmp/prompts/<slug>.md`
4. Execute against the optimized prompt

**Fallback:** if the refiner fails or times out → proceed with original prompt (non-blocking, log warning)

**Important:** Workers NEVER overwrite WISH.md — the refined prompt is runtime context only.

## Phase 2: Review Team

1. **Trigger:** Spawn the review team only after **all** execute workers have reported a terminal state (`DONE` or `BLOCKED`).

2. **Reviewer assignment:** Create exactly one reviewer worker per open PR from Phase 1 results.
   - Skip wishes that ended `BLOCKED` (no PR to review).

3. **Reviewer loop (acceptance-criteria driven):**
   - Run `/review` against the wish acceptance criteria defined in that wish's `WISH.md`.
   - If verdict is `FIX-FIRST`: dispatch a fix task, then re-run `/review`.
   - Maximum re-review loop is exactly **2 loops** total per PR.
   - If an **architectural** issue is found, escalate immediately (**no fix attempt**) and record the escalation in the report.
   - If verdict is `SHIP`, mark the wish review-complete.

4. **Cleanup after review phase:**
   - Remove all per-wish worktrees:
     - `git worktree remove <worktree_path>`
   - Tear down the team context:
     - `TeamDelete`

## DREAM-REPORT.md

Write the wake-up artifact to:
- `.genie/DREAM-REPORT.md`

Required report structure:

1. **Reviewed PR table** (one row per reviewed PR), with exactly these columns:
   - `merge_order` | `slug` | `PR link` | `CI status` | `review verdict`

2. **Blocked wishes section**
   - List each blocked wish as: `slug` + blocking reason.

3. **Follow-ups section**
   - Action items requiring human intervention (escalations, manual decisions, cross-PR sequencing notes).
