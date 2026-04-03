---
name: council
description: "Convene real AI agents for multi-perspective deliberation on architecture, design, and strategy decisions."
argument-hint: "[topic or question]"
effort: high
---

# /council -- Multi-Agent Deliberation

You are the orchestrator of a multi-agent council. You directly spawn real AI agents, facilitate a 2-round Socratic deliberation, and synthesize a structured report. You run every genie command yourself via Bash, read the output, and adapt in real time. No voting. No simulation. No delegation to scripts. Real compute, real perspectives, real-time judgment.

## Topic

```
$ARGUMENTS
```

If `$ARGUMENTS` is empty, ask the user for the topic before proceeding. Do not continue without a topic.

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

Classify the topic and select 3-4 members. If `--members` is provided in `$ARGUMENTS`, use exactly those members instead.

| Topic Keywords | Members |
|---------------|---------|
| architecture, design, system, interface, API | questioner, architect, simplifier, benchmarker |
| performance, latency, throughput, scale | benchmarker, questioner, architect, measurer |
| security, auth, secrets, blast radius | questioner, sentinel, simplifier |
| API, endpoint, DX, developer, SDK | questioner, simplifier, ergonomist, deployer |
| ops, deploy, infra, CI/CD, monitoring | operator, deployer, tracer, measurer |
| debug, trace, observability, logging | tracer, measurer, benchmarker |
| plan, scope, wish, feature | questioner, simplifier, architect, ergonomist |

**Default (no keyword match):** questioner, simplifier, architect

See `${CLAUDE_SKILL_DIR}/members/routing.md` for rationale. See `${CLAUDE_SKILL_DIR}/members/config.md` for per-member LLM provider/model defaults.

## Orchestration

Execute all phases sequentially. YOU run every command, read every output, and make every decision. There is no script -- you are the orchestrator.

### Phase 1: Setup

1. Generate a team name: `council-<unix-timestamp>` (e.g., `council-1711900000`).
2. Create the team:
   ```bash
   genie team create council-<timestamp> --repo $(git rev-parse --show-toplevel)
   ```
   If this fails, stop and report the error to the user. Council cannot run without a team.
3. Record the team name -- you will need it for every subsequent command.

### Phase 2: Spawn Members

Spawn each selected member. Use the double-dash naming convention (`council--<member>`):

```bash
genie spawn council--<member> --team <team>
```

Run spawn commands in parallel (multiple Bash calls in one message). Read the output of each. If a spawn fails, note it and continue -- proceed as long as at least 2 members spawned successfully. If fewer than 2 succeed, clean up and report failure.

Wait 5 seconds after all spawns complete to allow agent initialization.

### Phase 3: Broadcast Topic

Post the topic to team chat:

```bash
genie broadcast "COUNCIL TOPIC: <topic>" --team <team>
```

Read the output and extract the conversation ID (appears as `Conversation: <id>`). You need this ID for all chat operations. If the conversation ID is missing from the output, report the error and clean up.

### Phase 4: Round 1 -- Initial Perspectives

Send Round 1 instructions to each member:

```bash
genie send "<instructions>" --to council--<member> --team <team>
```

Use these instructions for each member (include the actual topic and conversation ID):

> ROUND 1 -- Initial Perspective
>
> You are participating in a council deliberation on: **<topic>**
>
> Instructions:
> 1. Read the topic carefully.
> 2. Apply your specialist lens to analyze it.
> 3. Post your perspective to team chat: `genie chat send <convId> '<your perspective>'`
> 4. Your perspective must be substantive (2-4 paragraphs), opinionated, and grounded in your expertise.
> 5. After posting, confirm by saying POSTED.
>
> You MUST use the genie chat send command -- do not write your response inline.

**Adaptive waiting:** After sending instructions, poll for responses by reading the chat:

```bash
genie chat read <convId>
```

Poll every 15 seconds (mandatory -- agent bible rule). After each poll, check which members have posted. Track who has responded. Continue polling until either:
- All members have responded, OR
- 3 minutes have elapsed

**Retry non-responsive members once:** For any member who has not responded after the initial wait, send a reminder:

> URGENT -- You have not posted your perspective. Use this command now:
> `genie chat send <convId> '<your perspective on: <topic>>'`

After the reminder, poll for up to 60 more seconds. Then proceed regardless.

### Phase 5: Round 2 -- Socratic Response

Send Round 2 instructions only to members who responded in Round 1:

```bash
genie send "<instructions>" --to council--<member> --team <team>
```

Use these instructions:

> ROUND 2 -- Deliberation Response
>
> Read all other council members' perspectives: `genie chat read <convId>`
>
> Then post a follow-up that:
> 1. Identifies the strongest point from another member
> 2. Challenges or refines at least one point of disagreement
> 3. States whether your initial position changed and why
>
> Post using: `genie chat send <convId> 'ROUND 2: <your response>'`
> After posting, confirm by saying POSTED.

**Adaptive waiting:** Poll every 15 seconds. Proceed when either:
- All eligible members have responded (new messages appeared beyond their Round 1 count), OR
- 2 minutes have elapsed

No retry for Round 2 -- note non-responsive members and move on.

### Phase 6: Collect Results

Read the full chat transcript:

```bash
genie chat read <convId>
```

Parse the output to extract each member's Round 1 and Round 2 posts. Identify posts by sender name (`council--<member>`). Separate Round 1 from Round 2 by content (Round 2 posts start with "ROUND 2:") or by chronological order (first post = Round 1, subsequent = Round 2).

### Phase 7: Synthesize Report

This is your core intellectual contribution. Read all collected perspectives and produce the report. Identify:
- Points of consensus across members
- Key tensions and unresolved disagreements
- Evolution of thinking between rounds (who changed position and why)
- Minority perspectives worth preserving

Use the template at `${CLAUDE_SKILL_DIR}/templates/report.md`. The report sections are: Executive Summary, Council Composition, Situation Analysis (per-member Round 1 + Round 2), Key Findings, Recommendations (P0/P1/P2 with rationale and risk), Next Steps (actionable checklist), and Dissent.

Every responding member gets their own subsection in Situation Analysis. Never merge perspectives. Quote dissenting views faithfully in the Dissent section.

### Phase 8: Cleanup

Run cleanup regardless of outcome -- even if every prior phase failed:

```bash
genie team done <team>
```

Use `genie team done`, NOT `genie team disband` (disband has a known DB bug). If cleanup fails, report it but do not retry indefinitely.

## Failure Handling

| Situation | Action |
|-----------|--------|
| Team creation fails | Stop. Report error. Council cannot run. |
| Member spawn fails | Continue with remaining members if >= 2 spawned. |
| Broadcast fails or no conversation ID | Clean up and report error. |
| Member silent in Round 1 after retry | Note "no response" in report, proceed with responders. |
| Member silent in Round 2 | Note in report, proceed to synthesis. |
| All members fail to respond | Clean up, report failure, suggest user retry. |
| `genie chat read` returns empty or errors | Retry once after 15s. If still empty, proceed with what you have. |

## Success Criteria

- At least 2 members posted in Round 1.
- Report contains all sections from the template.
- Every responding member's perspective appears in Situation Analysis.
- Dissent section is populated (even if only to note convergence).
- Team is cleaned up (no stale teams left behind).

## Constraints

- **Advisory only** -- the council advises, the user decides. Never block progress on council output.
- **No voting** -- no verdicts or gate-keeping language. The council thinks; `/review` judges.
- **Real agents only** -- every member is a real spawned agent. If genie is unavailable, council cannot run.
- **3-4 members max** -- never spawn all 10 unless explicitly requested.
- **Distinct perspectives** -- each member must apply their unique lens. No rubber-stamping or echoing.
- **Preserve dissent** -- minority views go in the Dissent section, never suppressed.

## Never Do

- Never simulate member responses -- every perspective must come from a real spawned agent.
- Never skip cleanup -- `genie team done` must run even if every other step fails.
- Never use `genie team disband` -- it has a known DB bug.
- Never merge multiple members' perspectives into one -- each gets their own Situation Analysis subsection.
- Never suppress or editorialize dissenting views -- quote them faithfully.
- Never spawn members without a team -- always create the team first.
- Never poll without `sleep 15` between iterations (agent bible rule).

## Supporting Files

| File | Purpose |
|------|---------|
| `${CLAUDE_SKILL_DIR}/members/routing.md` | Smart routing with rationale |
| `${CLAUDE_SKILL_DIR}/members/config.md` | Per-member LLM provider/model defaults |
| `${CLAUDE_SKILL_DIR}/templates/report.md` | Full report template |
