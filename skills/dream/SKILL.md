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

## Phase 1: Execute Team

## Phase 2: Review Team

## DREAM-REPORT.md
