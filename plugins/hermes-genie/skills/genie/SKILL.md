---
name: genie
description: Thin cockpit pointer for driving Genie from Hermes — load the product wish/work/review skills via the first-class skill path, use the MCP board tools for task truth, keep mutations human-gated.
---

# Genie Cockpit Pointer

Genie is the execution system and the source of task truth. When a workspace
contains `.genie/`, treat Genie state — wishes, tasks, boards, worker status —
as canonical over anything scraped from a terminal.

## Load the product skills, don't duplicate them

- For planning, execution, and review posture, load the first-class product
  skills directly: `wish`, `work`, and `review`. This plugin no longer ships
  `genie-work`/`genie-review` duplicates — the product skills are canonical.

## Use MCP for board truth

- Read board and task state through the genie MCP tools (`genie_board`,
  `genie_wish_status`, `genie_task`) rather than terminal scraping. The native
  Hermes surface only adds the gap tools MCP does not cover: `genie_status`
  (doctor plus `.genie` presence), `genie_work_plan` (dry-run launch plan), and
  `genie_review_plan` (wish status plus acceptance criteria).
- Never poll panes with `tmux capture-pane` or `sleep` loops to infer worker
  progress. The structured tools return the same truth with provenance.

## Human gates on mutation

- Every tool in this plugin is read-only (`mutation: "none"`).
- Mutations — `genie spawn`, `genie launch` without `--dry-run`, `genie task
  done` — require explicit human approval before they run, every time.

## Report outcome-first

- Lead with the outcome, then the key facts, then the exact CLI evidence:
  the `genie ...` argv that produced the data, on one line.
