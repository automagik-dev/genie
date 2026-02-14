---
name: brainstorm
description: "Explore ideas collaboratively, validate direction, and hand off a clear design for /wish."
---

# /brainstorm — Explore Before Planning

Use for early-stage or ambiguous ideas. Track wish-readiness as you go.

## Flow

1. Read context quickly (current code/docs/conventions).
2. Initialize persistence immediately (see **Persistence**): create/maintain `.genie/brainstorms/<slug>/draft.md` from the start.
3. Clarify intent with **one question at a time** (prefer multiple-choice).
4. After each exchange, update the **WRS bar** (see below).
5. Persist the draft **when WRS changes OR every 2 minutes** (whichever comes first).
6. Propose 2-3 approaches with trade-offs. Recommend one.
7. When WRS ≥ 60: offer to crystallize → hand off to `/wish`.
8. When WRS = 100: auto-crystallize (see **Crystallize**) → `design.md` → hand off.

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
- **100**: Auto-crystallize (see **Crystallize**): write `design.md`, hand off to `/wish`.

## Persistence

- **Draft-first**: maintain `.genie/brainstorms/<slug>/draft.md` from the start of the brainstorm.
- **Cadence**: write/refresh `draft.md` **when WRS changes OR every 2 minutes**, whichever comes first.
  - This is to survive freezes/restarts; do not wait until the end.

## Crystallize

- **Trigger**: when **WRS = 100**, crystallize automatically.
- **Semantics**:
  - Write/update `.genie/brainstorms/<slug>/design.md` **from** `.genie/brainstorms/<slug>/draft.md`.
  - Trigger Beads upsert via: `genie brainstorm crystallize`.

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
