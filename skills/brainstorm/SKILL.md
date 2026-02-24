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

## Flow
1. **Read context:** scan current code, docs, conventions. Check `.genie/brainstorm.md` for an existing entry matching this slug/topic — use as seed if found.
2. **Init persistence:** create `.genie/brainstorms/<slug>/DRAFT.md` immediately. Create `.genie/brainstorm.md` if missing (see Jar).
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

1. Write `.genie/brainstorms/<slug>/DESIGN.md` from `DRAFT.md` (use `references/design-template.md`).
2. Update `.genie/brainstorm.md` — move item to Poured with wish link.
3. Run `genie brainstorm crystallize`.

## Output Options

| Complexity | Output |
|-----------|--------|
| Standard | Write `DESIGN.md`, hand off to `/wish` |
| Small but non-trivial | Write design, ask whether to implement directly |
| Trivial | Verbal validation only — no file needed |

## Handoff

```
Design validated (WRS {score}/100). Run /wish to turn this into an executable plan.
```

Note any cross-repo or cross-agent dependencies — these become `depends-on`/`blocks` fields in the wish.

## Rules
- One question per message. Never batch questions.
- YAGNI and simplicity first.
- Always propose alternatives before recommending.
- Never assume requirements without confirmation.
- No implementation during brainstorm.
- Persist early and often — do not wait until the end.
