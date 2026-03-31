---
name: council
description: "Convene real AI agents for multi-perspective deliberation on architecture, design, and strategy decisions."
argument-hint: "[topic or question]"
effort: high
---

# /council -- Multi-Agent Deliberation

Spawn real AI agents, each with a distinct specialist lens, to deliberate on a topic via Socratic debate. The orchestrator selects members, facilitates two rounds of discussion, and synthesizes a consulting-firm-grade report. No voting. No simulation. Real compute, real perspectives.

## When to Use

- Architecture decisions needing diverse viewpoints
- Performance/security/API tradeoffs where a single perspective is insufficient
- Strategic planning where blind spots are costly
- Any decision worth 5-10 minutes of multi-agent deliberation

## Topic

```
$ARGUMENTS
```

If `$ARGUMENTS` is empty, ask the user for the topic before proceeding.

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

Classify the topic and select 3-4 members. Never spawn all 10 unless explicitly requested.

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

**`--members` override:** If the user passes `--members questioner,architect`, use exactly those members instead of auto-routing. This is a power-user escape hatch.

See `${CLAUDE_SKILL_DIR}/members/routing.md` for the full routing configuration with rationale.

## Mixed-LLM Support

Council members can run on different providers and models. Pass `--provider` and `--model` flags on spawn to override defaults.

```bash
genie spawn council--questioner --team <team> --session <team> --provider codex --model o3
```

See `${CLAUDE_SKILL_DIR}/members/config.md` for per-member default configurations.

## Orchestration Protocol

The orchestrator (you) manages the full lifecycle: create team, spawn members, facilitate deliberation, synthesize report, clean up. Use the helper script for parallel operations:

```bash
${CLAUDE_SKILL_DIR}/scripts/council-dispatch.sh
```

### Step 1: Create Council Team

```bash
TEAM="council-$(date +%s)"
REPO=$(git rev-parse --show-toplevel)
genie team create "$TEAM" --repo "$REPO"
```

### Step 2: Spawn Selected Members

Spawn each member selected by smart routing (or `--members` override). Use top-level `genie spawn` with double-dash member names.

```bash
genie spawn council--questioner --team "$TEAM" --session "$TEAM"
genie spawn council--architect --team "$TEAM" --session "$TEAM"
genie spawn council--simplifier --team "$TEAM" --session "$TEAM"
```

For mixed-LLM, add provider/model flags:

```bash
genie spawn council--questioner --team "$TEAM" --session "$TEAM" --provider codex --model o3
```

### Step 3: Post Topic

Broadcast the topic to the team. This creates a team conversation and returns a conversation ID.

```bash
CONV_ID=$(genie broadcast "COUNCIL TOPIC: $ARGUMENTS" --team "$TEAM")
```

Capture the conversation ID from the output -- it is needed for all subsequent chat operations.

### Step 4: Round 1 -- Initial Perspectives

Send Round 1 instructions to each member. Each member applies their specialist lens and posts their initial perspective to team chat.

```bash
genie send "Round 1: Read the council topic in team chat via 'genie chat read $CONV_ID'. Apply your specialist lens. Post your initial perspective via 'genie chat send $CONV_ID <your perspective>'. Focus on your unique angle. You have 3 minutes." --to council--questioner --team "$TEAM"
genie send "Round 1: Read the council topic in team chat via 'genie chat read $CONV_ID'. Apply your specialist lens. Post your initial perspective via 'genie chat send $CONV_ID <your perspective>'. Focus on your unique angle. You have 3 minutes." --to council--architect --team "$TEAM"
genie send "Round 1: Read the council topic in team chat via 'genie chat read $CONV_ID'. Apply your specialist lens. Post your initial perspective via 'genie chat send $CONV_ID <your perspective>'. Focus on your unique angle. You have 3 minutes." --to council--simplifier --team "$TEAM"
```

**Timeout:** 3 minutes per member. Poll for responses:

```bash
genie chat read "$CONV_ID" --json
```

Count messages per sender. If a member has not posted after 3 minutes, note them as "no response" and proceed.

### Step 5: Round 2 -- Socratic Response

After Round 1 completes (or times out), send Round 2 instructions. Each member reads all Round 1 posts and responds: agree, challenge, or refine.

```bash
genie send "Round 2: Read all Round 1 perspectives via 'genie chat read $CONV_ID'. Respond to the other members -- agree, challenge, or refine their points. Post your follow-up via 'genie chat send $CONV_ID <your response>'. You have 2 minutes." --to council--questioner --team "$TEAM"
genie send "Round 2: Read all Round 1 perspectives via 'genie chat read $CONV_ID'. Respond to the other members -- agree, challenge, or refine their points. Post your follow-up via 'genie chat send $CONV_ID <your response>'. You have 2 minutes." --to council--architect --team "$TEAM"
genie send "Round 2: Read all Round 1 perspectives via 'genie chat read $CONV_ID'. Respond to the other members -- agree, challenge, or refine their points. Post your follow-up via 'genie chat send $CONV_ID <your response>'. You have 2 minutes." --to council--simplifier --team "$TEAM"
```

**Timeout:** 2 minutes per member. Poll the same way as Round 1.

### Step 6: Collect All Perspectives

```bash
genie chat read "$CONV_ID" --json
```

Parse the JSON output. For each member, extract their Round 1 and Round 2 posts. Note any members who did not respond.

### Step 7: Synthesize Report

Read all collected perspectives and produce the structured report (see Report Template below). The report is the deliverable -- it must justify the compute cost.

### Step 8: Cleanup

Always clean up, even if deliberation fails or times out.

```bash
genie team done "$TEAM"
```

**Important:** Use `genie team done`, NOT `genie team disband` (disband has a known DB bug).

## Deliberation Protocol

The council uses a 2-round Socratic deliberation protocol:

### Round 1: Initial Perspectives (3 min timeout)

Each member independently:
1. Reads the topic from team chat
2. Applies their specialist lens
3. Posts their initial perspective to team chat via `genie chat send`
4. Focuses on their unique angle -- no need to address other members yet

### Round 2: Socratic Response (2 min timeout)

Each member:
1. Reads all Round 1 posts from team chat
2. Identifies points of agreement, disagreement, and nuance
3. Posts a follow-up that engages with other members' perspectives
4. May agree, challenge, refine, or extend others' positions

### Synthesis

The orchestrator (not a council member) reads all posts from both rounds and produces the final report. The orchestrator identifies:
- Points of consensus across members
- Key tensions and disagreements
- Evolution of thinking between rounds
- Minority perspectives worth preserving

## Report Template

Use the template at `${CLAUDE_SKILL_DIR}/templates/report.md` for the full structure. The report follows this format:

```markdown
# Council Report: <Topic>

## Executive Summary
<2-3 sentences: the question, the consensus, the key tension>

## Council Composition
| Member | Lens | Provider | Model |
|--------|------|----------|-------|
| questioner | Challenge assumptions | claude | opus |
| architect | Systems thinking | claude | sonnet |

## Situation Analysis
### questioner
**Initial perspective (Round 1):** <Round 1 post>
**After deliberation (Round 2):** <Round 2 post -- how their view evolved>

### architect
**Initial perspective (Round 1):** <Round 1 post>
**After deliberation (Round 2):** <Round 2 post>

## Key Findings
1. <Finding with evidence from member perspectives>
2. <Finding -- note where members agreed vs disagreed>

## Recommendations
| Priority | Recommendation | Rationale | Risk if Ignored |
|----------|---------------|-----------|-----------------|
| P0 | ... | ... | ... |
| P1 | ... | ... | ... |

## Next Steps
- [ ] <Concrete actionable item 1>
- [ ] <Concrete actionable item 2>

## Dissent
<Any minority perspectives that disagreed with consensus -- preserved, not suppressed>
```

## Timeout Handling

| Situation | Action |
|-----------|--------|
| Member does not post in Round 1 within 3 min | Note as "no response" in report, proceed to Round 2 |
| Member does not post in Round 2 within 2 min | Note in report, proceed to synthesis |
| All members fail to respond | Report the failure, clean up team, ask user to retry |
| Team creation fails | Cannot proceed -- report error to user |
| Member spawn fails | Proceed with remaining members if at least 2 are available |

## Supporting Files

| File | Purpose |
|------|---------|
| `${CLAUDE_SKILL_DIR}/members/routing.md` | Smart routing configuration with rationale |
| `${CLAUDE_SKILL_DIR}/members/config.md` | Per-member LLM provider/model defaults |
| `${CLAUDE_SKILL_DIR}/templates/report.md` | Full report template |
| `${CLAUDE_SKILL_DIR}/scripts/council-dispatch.sh` | Helper script for parallel spawn, deliberation, and collection |

## Rules

- **Advisory only** -- the council advises, the user decides. Never block progress on council output.
- **No voting** -- no verdicts or gate-keeping language anywhere. The council thinks; `/review` judges.
- **Real agents only** -- every council member is a real spawned agent. If genie infrastructure is unavailable, council cannot run.
- **Route smart** -- spawn 3-4 members per topic, not all 10. Use the smart routing table.
- **Distinct perspectives** -- each member must apply their unique lens. No rubber-stamping or echoing.
- **Preserve dissent** -- minority views are captured in the Dissent section, never suppressed.
- **Timeout gracefully** -- never block indefinitely. Note non-responsive members and proceed.
- **Clean up always** -- `genie team done` must run even if deliberation fails. No stale teams.
