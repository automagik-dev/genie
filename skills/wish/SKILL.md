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

## Shared Worktree

This skill is collaborative and operates on the shared worktree:
- All wish artifacts live in `.genie/wishes/` within the shared worktree
- State group definitions are written to the shared worktree so other agents and skills can read them
- When invoked via dispatch, acknowledges injected context (brainstorm design, file path + extracted section)

## Flow
1. **Gate check:** if no prior brainstorm/design context, ask: "Run /brainstorm first, or draft the wish directly?"
2. **Align intent:** ask one question at a time until success criteria are clear.
3. **Define scope:** explicit IN and OUT lists. OUT scope cannot be empty.
4. **Decompose into groups:** split into small, loosely coupled execution groups.
5. **Write wish:** create `.genie/wishes/<slug>/WISH.md` using the Wish Template below.
6. **Add verification:** every group gets acceptance criteria + a validation command.
7. **Link tasks:** create linked tasks and declare dependencies.
8. **Handoff:** reply `Wish documented. Run /work to execute.`

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

## Wish Template

Use this structure when writing `WISH.md`:

```markdown
# Wish: <Title>

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `<slug>` |
| **Date** | YYYY-MM-DD |
| **Design** | [DESIGN.md](../../brainstorms/<slug>/DESIGN.md) |

## Summary
2-3 sentences: what this wish delivers and why it matters.

## Scope
### IN
- Concrete deliverable 1
- Concrete deliverable 2

### OUT
- Explicit exclusion 1 (OUT cannot be empty)

## Decisions
| Decision | Rationale |
|----------|-----------|
| Choice 1 | Why this over alternatives |

## Success Criteria
- [ ] Testable criterion 1
- [ ] Testable criterion 2

## Execution Groups

### Group 1: <Name>
**Goal:** One sentence.
**Deliverables:**
1. Deliverable with acceptance criteria
2. Deliverable with acceptance criteria

**Acceptance criteria:**
- Criterion with validation command

**Validation:**
\```bash
# Command that exits 0 on success
\```

**depends-on:** none | Group N

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Risk 1 | Low/Medium/High | How to handle |
```

## Rules
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
