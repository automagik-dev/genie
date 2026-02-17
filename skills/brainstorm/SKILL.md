---
name: brainstorm
description: "Explore ideas collaboratively, validate direction, and hand off a clear design for /wish."
---

# /brainstorm — Explore Before Planning

Use for early-stage or ambiguous ideas. Track wish-readiness as you go.

## Flow

1. Read context quickly (current code/docs/conventions). Check `.genie/brainstorm.md` for an existing entry matching this slug/topic — if found, use it as seed context.
2. Initialize persistence immediately (see **Persistence**): create/maintain `.genie/brainstorms/<slug>/DRAFT.md` from the start. Also create `.genie/brainstorm.md` if missing (see **Jar**).
3. Clarify intent with **one question at a time** (prefer multiple-choice).
4. After each exchange, update the **WRS bar** (see below).
5. Persist the draft **when WRS changes OR every 2 minutes** (whichever comes first).
6. Propose 2-3 approaches with trade-offs. Recommend one.
7. When WRS = 100: auto-crystallize (see **Crystallize**) → `DESIGN.md` → hand off.

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

- **< 100**: Keep refining.
- **100**: Auto-crystallize (see **Crystallize**): write `DESIGN.md`, hand off to `/wish`.

## Persistence

- **Draft-first**: maintain `.genie/brainstorms/<slug>/DRAFT.md` from the start of the brainstorm.
- **Cadence**: write/refresh `DRAFT.md` **when WRS changes OR every 2 minutes**, whichever comes first.
  - This is to survive freezes/restarts; do not wait until the end.

## Jar

The agent-level brainstorm jar lives at `.genie/brainstorm.md`. It tracks all brainstorm topics across sessions.

- **On start**: create `.genie/brainstorm.md` if it doesn't exist (use the template in `templates/brainstorm.md` if available).
- **On check**: look up the current slug/topic in the jar — if found, use it as seed context (load current WRS + notes).
- **On WRS change**: update the entry in the jar to reflect the current section (Raw/Simmering/Ready/Poured).

## Crystallize

- **Trigger**: when **WRS = 100**, crystallize automatically.
- **Semantics**:
  - Write/update `.genie/brainstorms/<slug>/DESIGN.md` **from** `.genie/brainstorms/<slug>/DRAFT.md`.
  - Update `.genie/brainstorm.md` — move the item from its current section to `✅ Poured` with a link to the wish.
  - Trigger Beads upsert via: `genie brainstorm crystallize`.

## Output Options

- **Standard**: write `.genie/brainstorms/<slug>/DESIGN.md` and hand off to `/wish`.
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
