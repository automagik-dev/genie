---
name: wish
description: "Use when starting non-trivial work that needs structured planning - converts ideas into wish documents with scope, acceptance criteria, and execution tasks."
---

# /wish

Convert a validated idea into an executable wish plan.

## Gate
If no prior brainstorm/design context exists, ask first:
**"Want to run /brainstorm first, or should I draft the wish directly?"**

## Flow
1. **Align intent:** one question at a time; confirm success criteria.
2. **Define boundaries:** explicit IN and OUT scope (OUT cannot be empty).
3. **Design into tasks:** split into small execution groups with minimal coupling.
4. **Write wish:** create `.genie/wishes/<slug>/wish.md` from `references/wish-template.md`.
5. **Add verification:** each group must include acceptance criteria + validation command.
6. **Create task tracking:** create linked tasks and dependencies as needed.
7. **Handoff:** reply: `Wish documented. Run /work to execute.`

## Required Wish Sections
- Status, slug, date
- Problem/summary
- Scope IN / OUT
- Key decisions + rationale
- Success criteria (checkboxes)
- Execution groups with deliverables, acceptance criteria, validation commands

## Rules
- No implementation during /wish.
- No vague tasks ("do everything").
- Every task must be testable.
- Keep tasks bite-sized and shippable.
