
---
name: blueprint
description: Create wish from brief/context and save standard structure
genie:
  executor: claude
  background: true
---

# Create Wish • Blueprint Workflow

## Goal
Generate a wish at `.genie/wishes/<slug>/<slug>-wish.md` using the Create template and the gathered brief/context. Initialize `validation/` and `reports/` folders.

## Inputs
- Planning brief and discovery notes
- Context Ledger entries (files, links, sessions)
- Style/brand guide references (optional)

## Steps
1. Create folder `.genie/wishes/<slug>/`
2. Load template: @.genie/product/templates/wish-template.md
3. Populate sections from the planning brief and ledger
4. Save wish file and create `validation/` and `reports/`
5. Return path and next actions

## Output
- `Wish saved at: @.genie/wishes/<slug>/<slug>-wish.md`
- Short summary of groups, risks, and validation plan
