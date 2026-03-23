---
name: brainstorm
description: "Explore ambiguous or early-stage ideas interactively — tracks wish-readiness and crystallizes into a design for /wish."
---

# /brainstorm — Explore Before Planning

Collaborate on fuzzy ideas until they are concrete enough for `/wish`.

## When to Use
- User has an idea but unclear scope or approach
- Requirements are ambiguous and need interactive refinement
- User explicitly invokes `/brainstorm`

## Context Injection

This skill is multi-agent aware and operates on the shared worktree:
- All brainstorm artifacts live in `.genie/` within the shared worktree (not the repo root)
- When invoked via dispatch, acknowledges injected context (file path + extracted section) and uses it as seed
- Multiple agents can read brainstorm state concurrently; writes are coordinated by the orchestrator

## Flow
1. **Read context:** scan current code, docs, conventions. Check `.genie/brainstorm.md` in the shared worktree for an existing entry matching this slug/topic — use as seed if found. If context was injected from dispatch, use it directly.
2. **Init persistence:** create `.genie/brainstorms/<slug>/DRAFT.md` immediately in the shared worktree. Create `.genie/brainstorm.md` if missing (see Jar).
3. **Clarify intent:** one question at a time, prefer multiple-choice.
4. **Show WRS bar** after every exchange (see WRS).
5. **Persist draft** when WRS changes OR every 2 minutes — whichever comes first.
6. **Propose approaches:** 2-3 options with trade-offs. Recommend one.
7. **Crystallize** when WRS = 100: write `DESIGN.md`, update jar, hand off.

## WRS — Wish Readiness Score

Five dimensions, 20 points each. Show the bar after every exchange.

| Dimension | Filled when… |
|-----------|-------------|
| **Problem** | One-sentence problem statement is clear |
| **Scope** | IN and OUT boundaries defined |
| **Decisions** | Key technical/design choices made with rationale |
| **Risks** | Assumptions, constraints, failure modes identified |
| **Criteria** | At least one testable acceptance criterion exists |

### Display Format

```
WRS: ██████░░░░ 60/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ░ | Criteria ░
```

- ✅ = filled (20 pts) — enough info to write that section of a wish
- ░ = unfilled (0 pts) — still needs discussion
- **< 100:** keep refining
- **= 100:** auto-crystallize

## Jar

Brainstorm index at `.genie/brainstorm.md`. Tracks all topics across sessions.

**On start:** create if missing. Prefer `templates/brainstorm.md`; otherwise auto-create with sections:

```markdown
# Brainstorm Jar
## Raw
## Simmering
## Ready
## Poured
```

| Event | Action |
|-------|--------|
| Start | Look up slug/topic (fuzzy match) — use as seed context |
| WRS change | Update entry to reflect current section (Raw/Simmering/Ready) |
| Crystallize | Move entry to Poured, link resulting wish |

## Crystallize

Triggered automatically when WRS = 100.

1. Write `.genie/brainstorms/<slug>/DESIGN.md` from `DRAFT.md` using the Design Template below.
2. Update `.genie/brainstorm.md` — move item to Poured with wish link.
3. Auto-invoke `/review` (plan review) on the `DESIGN.md`.

## Output Options

| Complexity | Output |
|-----------|--------|
| Standard | Write `DESIGN.md`, auto-invoke `/review` (plan review) |
| Small but non-trivial | Write design, ask whether to implement directly |
| Trivial | Add one-liner to jar (Raw section), no file needed |

## Handoff

After `/review` returns SHIP on the design:

```
Design reviewed and validated (WRS {score}/100). Proceeding to /wish.
```

Note any cross-repo or cross-agent dependencies — these become `depends-on`/`blocks` fields in the wish.

## Stuck Decisions

If the **Decisions** dimension stays ░ (unfilled) after 2+ exchanges, suggest:

```
Decisions seem stuck. Consider running /council to get specialist perspectives on the tradeoffs.
```

## Design Template

Use this structure when writing `DESIGN.md` at crystallize:

```markdown
# Design: <Title>

| Field | Value |
|-------|-------|
| **Slug** | `<slug>` |
| **Date** | YYYY-MM-DD |
| **WRS** | 100/100 |

## Problem
One-sentence problem statement.

## Scope
### IN
- Concrete deliverable 1
- Concrete deliverable 2

### OUT
- Explicit exclusion 1

## Approach
Chosen approach with rationale. Reference alternatives considered.

## Decisions
| Decision | Rationale |
|----------|-----------|
| Choice 1 | Why this over alternatives |

## Risks & Assumptions
| Risk | Severity | Mitigation |
|------|----------|------------|
| Risk 1 | Low/Medium/High | How to handle |

## Success Criteria
- [ ] Testable criterion 1
- [ ] Testable criterion 2
```

## Task Lifecycle Integration (v4)

On crystallize, create a draft task in PG so the brainstorm is tracked in `genie task list`:

### On crystallize (WRS = 100)
```bash
# Create draft task (starts at draft stage by default)
genie task create "<brainstorm title>" --type software

# Link to the design draft
genie task comment #<seq> "Draft: .genie/brainstorms/<slug>/DRAFT.md"
```

| Event | Command |
|-------|---------|
| Crystallize | `genie task create "<brainstorm title>" --type software` |
| Link draft | `genie task comment #<seq> "Draft: .genie/brainstorms/<slug>/DRAFT.md"` |

**Graceful degradation:** If PG is unavailable or `genie task` commands fail, warn but do not block the crystallize flow. The DESIGN.md and brainstorm jar are the source of truth — PG tasks are an optional tracking enhancement.

## Rules
- One question per message. Never batch questions.
- YAGNI and simplicity first.
- Always propose alternatives before recommending.
- Never assume requirements without confirmation.
- No implementation during brainstorm.
- Persist early and often — do not wait until the end.
