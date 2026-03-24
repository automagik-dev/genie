---
name: council
description: "Convene 10 specialist perspectives (architecture, security, performance, DX, ops, observability, deployment, complexity, assumptions, debugging) to critique a decision from diverse viewpoints. Use when you need a design review, want to evaluate tradeoffs, weigh pros and cons, gather feedback on an approach, or get different perspectives before committing to a plan."
---

# /council — Multi-Perspective Review

Convene a panel of 10 specialist perspectives to brainstorm, critique, and vote on a decision.

## When to Use

- Architecture decisions needing diverse viewpoints
- During `/wish` to generate approaches with tradeoffs
- During `/review` to surface risks and blind spots
- Deadlocked discussions needing fresh angles

### Auto-Invocation Triggers

- **During `/review`**: when an architecture decision has significant tradeoffs, `/review` may invoke `/council` for specialist input before rendering a verdict.
- **During `/brainstorm`**: when the Decisions dimension stays unfilled (░) after 2+ exchanges, `/brainstorm` suggests `/council` to break the deadlock.

## Mode Detection

Before running the council flow, detect which mode to use:

1. Run `genie team ls $GENIE_TEAM` and check if council members (names starting with `council-`) are present.
2. **Council members present** → **Full Spawn Mode**
3. **No council members** → **Lightweight Mode** (default)

## Lightweight Mode (Default)

One agent simulates all perspectives in a single session — faster, lower cost, good for most decisions.

### Flow

1. Identify the topic from user context (architecture, performance, security, API design, operations, or general)
2. Route to relevant council members (see [COUNCIL_MEMBERS.md](COUNCIL_MEMBERS.md) for routing table). Default: core trio
3. Generate each member's perspective — distinct, opinionated, non-overlapping
4. Collect votes: APPROVE, REJECT, or MODIFY from each member
5. Synthesize a collective recommendation with the vote tally
6. Present the advisory and ask the user to decide

## Full Spawn Mode

Real agents deliberate via `genie chat` and reach consensus. Higher-quality since each member runs in its own context.

### Setup

Hire council members into the team before invoking:

```bash
genie team hire council
```

This adds specialist agents (e.g., `council-questioner`, `council-architect`) to the current team.

### Flow

1. Identify the topic and select relevant members ([routing table](COUNCIL_MEMBERS.md#smart-routing))
2. Post the topic to team chat:
   ```bash
   genie chat post --team <team> "COUNCIL TOPIC: <topic>\n\nContext: <relevant context>\n\nPlease review and vote: APPROVE, REJECT, or MODIFY with rationale."
   ```
3. Notify each relevant council member via `genie send`:
   ```bash
   genie send 'New council topic posted to team chat. Read it, apply your lens, and post your perspective + vote.' --to council-<member>
   ```
4. Poll team chat for responses:
   ```bash
   genie chat read --team <team> --since <topic-post-timestamp>
   ```
5. **Timeout:** 2 minutes per member. Proceed with "no response" if exceeded.
6. Once all consulted members have responded (or timeout reached), synthesize:
   - Collect all perspectives from team chat
   - Tally votes
   - Produce the synthesized recommendation
7. Present the advisory to the user using the output format below

### Notes on Full Spawn Mode

- Council members respond independently with their own lens prompt
- The leader (session running `/council`) acts as moderator and synthesizer
- Unresponsive members are noted as "no response" in the tally

## Council Members and Routing

See [COUNCIL_MEMBERS.md](COUNCIL_MEMBERS.md) for the full member table (focus areas, lenses) and topic-based smart routing.

**Default:** Core trio — questioner, benchmarker, simplifier.

## Output Format

```markdown
## Council Advisory

### Topic: [Detected Topic]
### Mode: [Lightweight / Full Spawn]
### Members Consulted: [List]

### Perspectives

**questioner:**
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**simplifier:**
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

[... other members ...]

### Vote Summary
- Approve: X
- Reject: X
- Modify: X

### Synthesized Recommendation
[Council's collective advisory]

### User Decision Required
The council advises [recommendation]. Proceed?
```

## Rules

- Advisory only — never block progress based on council vote
- Never invoke all 10 for simple decisions; route to the relevant subset
- Each perspective must be distinct — no rubber-stamping or echoing other members
- Always synthesize votes into a recommendation; never present raw votes without interpretation
- The council advises, the user decides
