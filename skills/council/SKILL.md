---
name: council
description: "Brainstorm and critique with 10 specialist viewpoints. Use for architecture, plan reviews, or tradeoffs."
---

# /council — Multi-Perspective Review

Convene a panel of 10 specialist perspectives to brainstorm, critique, and vote on a decision.

## When to Use

- Architecture decisions needing diverse viewpoints
- During `/wish` to generate approaches with tradeoffs
- During `/review` to surface risks and blind spots
- Deadlocked discussions needing fresh angles

## Mode Detection

Before running the council flow, detect which mode to use:

1. Run `genie team ls $GENIE_TEAM` (or the current team) and check if council members (names starting with `council-`) are present in the team.
2. **If council members are present** → use **Full Spawn Mode**
3. **If no council members** → use **Lightweight Mode** (default)

## Lightweight Mode (Default)

When no council members are hired in the team, simulate all perspectives in a single session.

### Flow

1. Identify the topic from user context (architecture, performance, security, API design, operations, or general)
2. Route to the relevant council members (see Smart Routing below). Default: core trio
3. Generate each member's perspective — distinct, opinionated, non-overlapping
4. Collect votes: APPROVE, REJECT, or MODIFY from each member
5. Synthesize a collective recommendation with the vote tally
6. Present the advisory and ask the user to decide

## Full Spawn Mode

When council members are hired in the team, use the team chat channel for real multi-agent deliberation.

### Flow

1. Identify the topic and select relevant members (Smart Routing)
2. Post the topic to team chat:
   ```bash
   genie chat post --team <team> "COUNCIL TOPIC: <topic>\n\nContext: <relevant context>\n\nPlease review and vote: APPROVE, REJECT, or MODIFY with rationale."
   ```
3. Notify each relevant council member via `genie send`:
   ```bash
   genie send 'New council topic posted to team chat. Read it, apply your lens, and post your perspective + vote.' --to council-<member>
   ```
4. Wait for responses. Poll team chat for council member messages:
   ```bash
   genie chat read --team <team> --since <topic-post-timestamp>
   ```
5. Once all consulted members have responded (or after a reasonable wait), the leader synthesizes:
   - Collect all perspectives from team chat
   - Tally votes
   - Produce the synthesized recommendation
6. Present the advisory to the user using the same output format

### Notes on Full Spawn Mode

- Council members respond independently — each applies their own lens prompt
- The leader (session running `/council`) acts as moderator and synthesizer
- If a council member hasn't responded, note them as "no response" in the tally
- Full spawn mode produces higher-quality reviews since each member runs in its own context

## Council Members

| Member | Focus | Lens |
|--------|-------|------|
| **questioner** | Challenge assumptions | "Why? Is there a simpler way?" |
| **benchmarker** | Performance evidence | "Show me the benchmarks." |
| **simplifier** | Complexity reduction | "Delete code. Ship features." |
| **sentinel** | Security oversight | "Where are the secrets? What's the blast radius?" |
| **ergonomist** | Developer experience | "If you need to read the docs, the API failed." |
| **architect** | Systems thinking | "Talk is cheap. Show me the code." |
| **operator** | Operations reality | "No one wants to run your code." |
| **deployer** | Zero-config deployment | "Zero-config with infinite scale." |
| **measurer** | Observability | "Measure, don't guess." |
| **tracer** | Production debugging | "You will debug this in production." |

## Smart Routing

| Topic | Members |
|-------|---------|
| Architecture | questioner, benchmarker, simplifier, architect |
| Performance | benchmarker, questioner, architect, measurer |
| Security | questioner, simplifier, sentinel |
| API Design | questioner, simplifier, ergonomist, deployer |
| Operations | operator, tracer, measurer |
| Observability | tracer, measurer, benchmarker |
| Full Review | all 10 |

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
