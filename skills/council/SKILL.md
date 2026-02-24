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

## Flow

1. Identify the topic from user context (architecture, performance, security, API design, operations, or general)
2. Route to the relevant council members (see Smart Routing below). Default: core trio
3. Generate each member's perspective — distinct, opinionated, non-overlapping
4. Collect votes: APPROVE, REJECT, or MODIFY from each member
5. Synthesize a collective recommendation with the vote tally
6. Present the advisory and ask the user to decide

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
