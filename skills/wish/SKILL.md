---
name: wish
description: "Convert an idea into a structured wish plan with scope, acceptance criteria, and execution groups for /work."
---

# /wish — Plan Before You Build

Convert a validated idea into an executable wish document at `.genie/wishes/<slug>/WISH.md`.

## When to Use
- User describes non-trivial work that needs planning before implementation.
- User wants to scope, decompose, or formalize a feature/change.
- Prior `/brainstorm` output exists and needs to become actionable.

## Flow
1. **Gate check:** if no prior brainstorm/design context, ask: "Run /brainstorm first, or draft the wish directly?"
2. **Align intent:** ask one question at a time until success criteria are clear.
2. **Define scope:** explicit IN and OUT lists. OUT scope cannot be empty.
3. **Decompose into groups:** split into small, loosely coupled execution groups.
4. **Write wish:** create `.genie/wishes/<slug>/WISH.md` from `references/wish-template.md`.
5. **Add verification:** every group gets acceptance criteria + a validation command.
6. **Link tasks:** create linked tasks and declare dependencies.
7. **Handoff:** reply `Wish documented. Run /work to execute.`

## Wish Document Sections

| Section | Required | Notes |
|---------|----------|-------|
| Status / Slug / Date | Yes | Status: DRAFT on creation |
| Summary | Yes | 2-3 sentences: what and why |
| Scope IN / OUT | Yes | OUT cannot be empty |
| Decisions | Yes | Key choices with rationale |
| Success Criteria | Yes | Checkboxes, each testable |
| Execution Groups | Yes | Goal, deliverables, acceptance criteria, validation command |
| Dependencies | No | `depends-on` / `blocks` using slug or `repo/slug` |
| Assumptions / Risks | No | Flag what could invalidate the plan |

## Rules
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
