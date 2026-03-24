---
name: wish
description: "Convert an idea into a structured wish plan with scope, acceptance criteria, and execution groups for /work. Use when the user says 'plan a feature', 'break down task', 'project planning', 'requirements', 'create tasks', 'define scope', 'decompose work', 'scope this out', or needs to formalize a feature into actionable execution groups before implementation."
---

# /wish — Plan Before You Build

Convert a validated idea into an executable wish document at `.genie/wishes/<slug>/WISH.md`.

## When to Use
- User describes non-trivial work that needs planning before implementation.
- User wants to scope, decompose, or formalize a feature/change.
- Prior `/brainstorm` output exists and needs to become actionable.

## Shared Worktree

This skill is collaborative and operates on the shared worktree:
- All wish artifacts live in `.genie/wishes/` within the shared worktree
- State group definitions are written to the shared worktree so other agents and skills can read them
- When invoked via dispatch, acknowledges injected context (brainstorm design, file path + extracted section)

## Flow
1. **Gate check:** if the request is fuzzy (no prior design, unclear scope, vague requirements), auto-trigger `/brainstorm` first. If a brainstorm/design exists, proceed. Otherwise ask: "This needs more clarity. Running `/brainstorm` to refine the idea first."
2. **Align intent:** ask one question at a time until success criteria are clear.
3. **Define scope:** explicit IN and OUT lists. OUT scope cannot be empty.
4. **Decompose into groups:** split into small, loosely coupled execution groups.
5. **Write wish:** create `.genie/wishes/<slug>/WISH.md` using the Wish Template.
6. **Add verification:** every group gets acceptance criteria + a validation command.
7. **Declare dependencies:** declare `depends-on` between execution groups and cross-wish dependencies.
8. **Handoff:** auto-invoke `/review` (plan review) on the WISH.md. Do not suggest `/work` directly — the review gate must pass first.

## Wish Template

Use the structure defined in [WISH-TEMPLATE.md](./WISH-TEMPLATE.md) when writing `WISH.md` files.

## Rules
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
- Execution Strategy is mandatory — every wish must define waves, even if sequential (single wave). This forces the planner to think about ordering, parallelism, and dependencies upfront.
