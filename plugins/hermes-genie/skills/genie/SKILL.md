---
name: genie
description: Cockpit contract for driving Genie from Hermes — structured read-only tools first, human-gated mutations, outcome-first evidence reporting.
---

# Genie Cockpit Contract

Genie is the execution system and the source of task truth. When a workspace
contains `.genie/`, treat Genie state — wishes, tasks, boards, worker status —
as canonical over anything scraped from a terminal.

## Structured tools first

- Use the plugin tools before any terminal scraping: `genie_status` (doctor
  plus `.genie` presence), `genie_board` (task board), `genie_task_list`
  (tasks with wish/status filters), and `genie_wish_status` (board plus tasks
  for one wish).
- Never poll panes with `tmux capture-pane` or `sleep` loops to infer worker
  progress. The structured tools return the same truth with provenance.

## Human gates on mutation

- Every tool in this plugin is read-only (`mutation: "none"`).
- Mutations — `genie spawn`, `genie launch` without `--dry-run`, `genie task
  done` — require explicit human approval before they run, every time.

## Report outcome-first

- Lead with the outcome, then the key facts, then the exact CLI evidence:
  the `genie ...` argv that produced the data, on one line.
- On failure, lead with the error and keep the same evidence line so the
  operator can reproduce it verbatim.
