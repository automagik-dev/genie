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
1. **Gate check:** if the request is fuzzy (no prior design, unclear scope, vague requirements), auto-trigger `/brainstorm` first. If a brainstorm/design exists, proceed. Otherwise ask: "This needs more clarity. Running `/brainstorm` to refine the idea first."
2. **Align intent:** ask one question at a time until success criteria are clear.
3. **Define scope:** explicit IN and OUT lists. OUT scope cannot be empty.
4. **Decompose into groups:** split into small, loosely coupled execution groups.
5. **Write wish:** create `.genie/wishes/<slug>/WISH.md` using the Wish Template below.
6. **Add verification:** every group gets acceptance criteria + a validation command.
7. **Declare dependencies:** declare `depends-on` between execution groups and cross-wish dependencies.
8. **Handoff:** auto-invoke `/review` (plan review) on the WISH.md. Do not suggest `/work` directly — the review gate must pass first.

## Wish Document Sections

| Section | Required | Notes |
|---------|----------|-------|
| Status / Slug / Date | Yes | Status: DRAFT on creation |
| Summary | Yes | 2-3 sentences: what and why |
| Scope IN / OUT | Yes | OUT cannot be empty |
| Decisions | Yes | Key choices with rationale |
| Success Criteria | Yes | Checkboxes, each testable |
| Execution Strategy | Yes | Wave-based parallel/sequential execution plan |
| Execution Groups | Yes | Goal, deliverables, acceptance criteria, validation command |
| Dependencies | No | `depends-on` / `blocks` using slug or `repo/slug` |
| QA Criteria | No | What must be verified on dev after merge |
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

## Execution Strategy

### Wave 1 (parallel)
| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | <task description> |
| 2 | engineer | <task description> |

### Wave 2 (after Wave 1)
| Group | Agent | Description |
|-------|-------|-------------|
| 3 | engineer | <task description> |
| review | reviewer | Review Groups 1+2 |

## Execution Groups

### Group 1: <Name>
**Goal:** One sentence.
**Deliverables:**
1. Deliverable with acceptance criteria
2. Deliverable with acceptance criteria

**Acceptance Criteria:**
- [ ] Testable criterion

**Validation:**
```bash
# Command that exits 0 on success
```

**depends-on:** none | Group N

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] <functional criterion — user-facing behavior works>
- [ ] <integration criterion — system works end-to-end>
- [ ] <regression criterion — existing behavior not broken>

---

## Assumptions / Risks
| Risk | Severity | Mitigation |
|------|----------|------------|
| Risk 1 | Low/Medium/High | How to handle |

---

## Review Results

_Populated by `/review` after execution completes._

---

## Files to Create/Modify

```
<list of files this wish will touch>
```
```

## Rules
- No implementation during `/wish` — planning only.
- No vague tasks ("improve everything"). Every task must be testable.
- Keep tasks bite-sized and independently shippable.
- Declare cross-wish dependencies early with `depends-on` / `blocks`.
- OUT scope must contain at least one concrete exclusion.
- Execution Strategy is mandatory — every wish must define waves, even if sequential (single wave). This forces the planner to think about ordering, parallelism, and dependencies upfront.
