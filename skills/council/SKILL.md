---
name: council
description: "Convene real AI agents for multi-perspective deliberation on architecture, design, and strategy decisions."
argument-hint: "[topic or question]"
effort: high
---

# /council — Multi-Agent Deliberation

Convene 3-4 real subagents, run a 2-round Socratic deliberation, and synthesize a structured report. No voting, no simulation — every perspective comes from a real spawned agent, and you, the orchestrator, make every judgment call in real time.

## Topic

```
$ARGUMENTS
```

If empty, ask the user for the topic before proceeding. If `--members a,b,c` appears in the arguments, use exactly those members instead of routing.

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

Classify the topic and select 3-4 members:

| Topic Keywords | Members |
|---------------|---------|
| architecture, design, system, interface, API | questioner, architect, simplifier, benchmarker |
| performance, latency, throughput, scale | benchmarker, questioner, architect, measurer |
| security, auth, secrets, blast radius | questioner, sentinel, simplifier |
| API, endpoint, DX, developer, SDK | questioner, simplifier, ergonomist, deployer |
| ops, deploy, infra, CI/CD, monitoring | operator, deployer, tracer, measurer |
| debug, trace, observability, logging | tracer, measurer, benchmarker |
| plan, scope, wish, feature | questioner, simplifier, architect, ergonomist |

**Default (no keyword match):** questioner, simplifier, architect.

Rationale: `members/routing.md`. Per-member model defaults: `members/config.md`.

## Deliberation

### Round 1 — Initial Perspectives

Spawn each selected member as a subagent via the **Agent tool** — all spawns in ONE message so they deliberate in parallel (background; each notifies you with its final message). Per-member brief:

> You are the council's **<member>** — <lens>. Council topic: **<topic>**.
>
> Apply your specialist lens. Return your perspective as your final message: substantive (2-4 paragraphs), opinionated, grounded in your expertise. Take positions; cite evidence or name the assumption you are making.

A member that fails to spawn or returns nothing usable: note it and continue, as long as at least 2 members delivered. Fewer than 2 → report failure to the user and stop.

### Round 2 — Socratic Response

For each member that responded, send the other members' Round 1 perspectives via **SendMessage** (this continues the member's session with its context intact):

> ROUND 2 — the other members' perspectives are below. Reply with:
> 1. The strongest point another member made.
> 2. At least one point you challenge or refine.
> 3. Whether your initial position changed, and why.
>
> <compiled Round 1 perspectives, attributed by member>

A member that does not answer Round 2: record "no Round 2 response" and synthesize from what exists.

### Synthesis

Your core intellectual contribution. From the collected responses identify: points of consensus, key tensions and unresolved disagreements, evolution of thinking between rounds, and minority perspectives worth preserving.

Write the report per `templates/report.md`: Executive Summary, Council Composition, Situation Analysis (one subsection per responding member — Round 1 and Round 2, never merged), Key Findings, Recommendations (P0/P1/P2 with rationale and risk), Next Steps, Dissent (quoted faithfully; if none, note the convergence).

## Failure Handling

| Situation | Action |
|-----------|--------|
| Fewer than 2 members deliver Round 1 | Stop; report failure, suggest retry |
| Member silent or errored | Note "no response" in the report, proceed with responders |
| Round 2 SendMessage fails | Retry once; then synthesize from Round 1 alone for that member |

## Constraints

- **Advisory only** — the council advises, the user decides. Never block progress on council output.
- **No voting** — no verdicts or gate-keeping language. The council thinks; `/review` judges.
- **3-4 members max** — never spawn all 10 unless explicitly requested.
- **Distinct perspectives** — each member applies their unique lens; no echoing, no rubber-stamping.
- **Preserve dissent** — minority views go in the Dissent section, never suppressed or editorialized.
- **Real agents only** — never simulate or write a member's response yourself.

## Supporting Files

| File | Purpose |
|------|---------|
| `${CLAUDE_SKILL_DIR}/members/routing.md` | Smart routing with rationale |
| `${CLAUDE_SKILL_DIR}/members/config.md` | Per-member model defaults and overrides |
| `${CLAUDE_SKILL_DIR}/templates/report.md` | Full report template |
