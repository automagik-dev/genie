---
name: brainstorm
description: "Explore ideas collaboratively, validate direction, and hand off a clear design for /wish."
---

# /brainstorm — Explore Before Planning

Use for early-stage or ambiguous ideas. Track wish-readiness as you go.

## Flow

1. Read context quickly (current code/docs/conventions).
2. Clarify intent with **one question at a time** (prefer multiple-choice).
3. After each exchange, update the **WRS bar** (see below).
4. Propose 2-3 approaches with trade-offs. Recommend one.
5. When WRS ≥ 60: offer to crystallize → hand off to `/wish`.
6. When WRS = 100: auto-crystallize → `design.md` → hand off.

## WRS — Wish Readiness Score

Track these dimensions. Each is worth 20 points. Show the bar after every exchange.

| Dimension | What it means |
|-----------|--------------|
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
- Show after EVERY exchange, even if unchanged

### Thresholds

- **< 40**: Keep exploring. Don't rush.
- **40-59**: Getting close. Focus questions on unfilled dimensions.
- **≥ 60**: Offer: `"WRS hit 60. Ready to pour into /wish, or keep refining?"`
- **100**: Auto-crystallize: write `design.md`, hand off to `/wish`.

## Output Options

- **Standard**: write `.genie/brainstorms/<slug>/design.md` and hand off to `/wish`.
- **Small but non-trivial**: write the design, then ask whether to implement directly.
- **Trivial**: verbal validation only; no file required.

## Principles

- One question per message
- YAGNI and simplicity first
- Never skip alternatives
- Never assume requirements without confirmation
- No implementation during brainstorm

## Handoff Message

`Design validated (WRS {score}/100). Run /wish to turn this into an executable plan.`

Note any cross-repo or cross-agent dependencies discovered — these become `depends-on`/`blocks` fields in the wish.
