---
name: council
description: "Multi-perspective brainstorming and critique with 10 specialized council members. Use during architecture decisions, wish planning, or reviews to get diverse viewpoints."
---

# /council - Multi-Perspective Review

Use the council (a crew of specialist subagents) to brainstorm, critique, or vote.

## When to Use

- During `/wish`: Generate 2-3 approaches with tradeoffs
- During `/review`: Find risks and gaps
- During architecture decisions: Get independent perspectives
- When stuck: Fresh viewpoints break deadlocks

## Council Members

| Member | Focus | Philosophy |
|--------|-------|------------|
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

Not every decision needs all 10 perspectives:

| Topic | Members |
|-------|---------|
| Architecture | questioner, benchmarker, simplifier, architect |
| Performance | benchmarker, questioner, architect, measurer |
| Security | questioner, simplifier, sentinel |
| API Design | questioner, simplifier, ergonomist, deployer |
| Operations | operator, tracer, measurer |
| Full Review | all 10 |

**Default:** Core trio (questioner, benchmarker, simplifier)

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

...

### Vote Summary
- Approve: X
- Reject: X
- Modify: X

### Synthesized Recommendation
[Council's collective advisory]
```

## Philosophy

**The council advises, the user decides.**

Value is in diverse perspective, not gatekeeping. Each member surfaces blind spots and challenges assumptions.
