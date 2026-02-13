---
name: brainstorm
description: "Explore ideas collaboratively, validate direction, and hand off a clear design for /wish."
---

# /brainstorm — Explore Before Planning

Use for early-stage or ambiguous ideas.

## Flow

1. Read context quickly (current code/docs/conventions).
2. Clarify intent with one question at a time (prefer multiple-choice).
3. Propose 2-3 approaches with trade-offs.
4. Recommend one approach and explain why.
5. Align scope boundaries (IN, OUT, assumptions, constraints).
6. Present design in short sections and validate each with the user.
7. Finalize handoff for `/wish`.

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

`Design validated. Run /wish to turn this into an executable plan.`

Note any cross-repo or cross-agent dependencies discovered during brainstorm — these become `depends-on`/`blocks` fields in the wish.
