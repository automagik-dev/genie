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

## Phase 2: Review Team

## DREAM-REPORT.md
