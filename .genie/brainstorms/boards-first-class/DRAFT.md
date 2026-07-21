# Brainstorm: Boards first-class (create + custom columns)

**WRS: ████░░░░░░ 40/100** — Problem ✅ | Scope ░ | Decisions ░ | Risks ░ | Criteria ✅

## Problem

`genie board` hardcodes its columns to the four execution statuses, so a board can only ever show
execution state — you cannot model a roadmap (Idea → Brainstormed → Wish → Executing → Shipped) or
any other problem-shaped kanban. Boards also cannot be created from the CLI at all
(`createBoard()` in `src/lib/v5/task-state.ts:208` has no command surface).

## Context (verified 2026-07-21)

- Columns: `COLUMNS` const in `src/term-commands/v5-board.ts:32-37` — status enum, left to right.
- Design doctrine being challenged: "kanban derived purely by query, NO stored view state".
- The status machine (blocked/ready/in_progress/done) is load-bearing: ready-set computation,
  `task checkout` claims, dependency recompute. It must remain the execution authority.
- First consumer: the `roadmap` board seeded 2026-07-21 (13 macro cards, all stuck in "Ready").

## Decision (RATIFIED by Felipe, 2026-07-21)

Columns are **the genie lifecycle contract, not arbitrary labels**: the canonical stages are
`Brainstorm → Wish → Work → Review` (the framework's own verbs), and new stages like `Idea` can be
added and are moved **manually**. The current `blocked/ready/in_progress/done` labels are
execution-machine internals leaking into the UI — the macro board renames the experience to the
actual framework contract. Mechanically this is the assigned-stage model: boards carry a column
list, cards carry a stage, `genie task move` changes it; the execution status machine underneath
stays untouched (it still owns ready-set/checkout for execution boards).

Capture flow that motivated it: *"got an idea, let me add to the jar"* — dropping a thought into
an `Idea` column should be one frictionless verb.

## Risks

- Two sources of truth (status vs stage) drifting — must define which surfaces show which.
- MCP server + `task export` schema additions must stay backward-compatible.

## Criteria (seed)

- `genie board create roadmap --columns "Idea,Brainstormed,Wish,Executing,Shipped"` works.
- `genie task move <id> --stage Wish` reflects on next `genie board --board roadmap` render.
- Existing status-column boards render byte-identical when no custom columns are defined.
