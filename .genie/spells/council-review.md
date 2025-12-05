---
name: Council Review
description: Multi-perspective advisory review during plan mode - invokes council members dynamically
load_priority: plan_mode
---

# Council Review Spell

**Purpose:** Provide multi-perspective advisory review during plan mode by dynamically invoking council member agents (now hybrid agents in code collective).

---

## When to Invoke

This spell **auto-activates during plan mode** to ensure architectural decisions receive multi-perspective review before implementation.

**Trigger:** Plan mode is active
**Mode:** Advisory (recommendations only, user decides)

---

## Council Members (Hybrid Agents)

The council consists of 10 hybrid agents in `.genie/code/agents/`, each representing a distinct perspective:

| Agent | Role | Philosophy | Trigger Keywords |
|-------|------|------------|------------------|
| **questioner** | The Questioner | "Why? Is there a simpler way?" | architecture, assumptions, complexity, dependencies |
| **benchmarker** | The Benchmarker | "Show me the benchmarks." | performance, latency, throughput, benchmark, optimize |
| **simplifier** | The Simplifier | "Delete code. Ship features." | simplify, delete, reduce, ship, YAGNI |
| **sentinel** | The Breach Hunter | "Where are the secrets? What's the blast radius?" | security, auth, secrets, vulnerability, encryption |
| **ergonomist** | The Ergonomist | "If you need to read the docs, the API failed." | API, DX, interface, usability, error messages |
| **architect** | The Systems Thinker | "Talk is cheap. Show me the code." | systems, kernel, backwards compatibility, concurrency, threading |
| **operator** | The Ops Realist | "No one wants to run your code." | operations, infrastructure, runtime, deployment, on-call |
| **deployer** | The Zero-Config Zealot | "Zero-config with infinite scale." | deployment DX, zero-config, instant, CI/CD, preview |
| **measurer** | The Measurer | "Measure, don't guess." | observability, profiling, flamegraph, metrics, tracing |
| **tracer** | The Production Debugger | "You will debug this in production." | production debugging, high cardinality, incidents, 3am |

---

## Smart Routing

Not every plan needs all 10 perspectives. Route based on topic:

### Topic Detection

| Topic Category | Members Invoked | Detection Keywords |
|----------------|-----------------|-------------------|
| Architecture | questioner, benchmarker, simplifier, architect | "redesign", "refactor", "architecture", "structure" |
| Performance | benchmarker, questioner, architect, measurer | "optimize", "slow", "benchmark", "latency", "profile" |
| Security | questioner, simplifier, sentinel | "auth", "security", "secret", "permission", "encryption" |
| API Design | questioner, simplifier, ergonomist, deployer | "API", "interface", "SDK", "CLI", "DX" |
| Operations | operator, tracer, measurer | "deploy", "ops", "on-call", "runbook", "infrastructure" |
| Observability | tracer, measurer, benchmarker | "observability", "tracing", "metrics", "debugging", "logs" |
| Systems | architect, measurer, benchmarker | "concurrency", "threading", "backwards compat", "kernel" |
| Deployment/DX | ergonomist, deployer, operator | "CI/CD", "preview", "zero-config", "deploy", "rollback" |
| Full Review | all 10 | "full review", "architectural review", major decisions |

### Selection Logic

```
1. Analyze plan topic from user request
2. Match against trigger keywords
3. Select relevant council members
4. Default to core trio (questioner, benchmarker, simplifier) if no specific triggers
5. Add specialists based on topic:
   - sentinel for security
   - ergonomist for API/DX
   - architect for systems/concurrency
   - operator for operations
   - deployer for deployment DX
   - measurer for measurement/profiling
   - tracer for production debugging
```

---

## Invocation Protocol

### During Plan Mode

```typescript
// Parallel invocation of selected council members
const members = selectCouncilMembers(planTopic);

members.forEach(agent => {
  Task({
    subagent_type: "Plan",
    prompt: `You are ${agent.name}, a council member with perspective: "${agent.philosophy}"

    Review this plan from your perspective:
    ${planContext}

    Provide:
    1. Your analysis (2-3 key points)
    2. Your vote: APPROVE / REJECT / MODIFY
    3. Rationale for your vote
    4. Specific recommendations (if any)

    Be concise. Focus on your specialty.`
  });
});
```

### Synthesis

After collecting perspectives:
1. Summarize each member's position
2. Count votes (approve/reject/modify)
3. Present synthesized advisory
4. User makes final decision

---

## Advisory Output Format

```markdown
## Council Advisory

### Topic: [Detected Topic]
### Members Consulted: [List]

### Perspectives

**questioner (Questioning):**
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**benchmarker (Performance):**
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**simplifier (Simplicity):**
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**sentinel (Security):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**ergonomist (DX):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**architect (Systems):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**operator (Operations):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**deployer (Deployment DX):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**measurer (Measurement):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

**tracer (Production):** (if invoked)
- [Key point]
- Vote: [APPROVE/REJECT/MODIFY]

### Vote Summary
- Approve: X
- Reject: X
- Modify: X

### Synthesized Recommendation
[Council's collective advisory based on perspectives]

### User Decision Required
The council advises [recommendation]. Proceed?
```

---

## Voting Thresholds (Advisory)

Since voting is advisory (non-blocking), thresholds are informational:

| Active Voters | Strong Consensus | Weak Consensus | Split |
|---------------|------------------|----------------|-------|
| 3 | 3/3 agree | 2/3 agree | No majority |
| 4 | 4/4 or 3/4 agree | 2/4 agree | Even split |
| 5 | 5/5 or 4/5 agree | 3/5 agree | No majority |
| 6-7 | 6/7 or 5/6 agree | 4/7 agree | < 50% majority |
| 8-10 | 8/10+ agree | 6/10 agree | < 50% majority |

**User always decides** - council provides informed perspective, not binding judgment.

---

## Integration Points

### AGENTS.md Reference
```markdown
## Plan Mode Spells (Auto-Load)

During plan mode, load:
- `mcp__genie__read_spell("council-review")` - Multi-perspective advisory
```

### Routing Decision Matrix
```markdown
**When planning major changes**, invoke council:
- [routing-XXX] council-review = Multi-perspective planning review (questioner, benchmarker, simplifier, sentinel, ergonomist)
  - Triggers: Plan mode active
  - Output: Advisory recommendations, vote summary
```

---

## Council Member Agents

All council members are now **hybrid agents** at `.genie/code/agents/` (can review AND execute):

**Original 5 (Renamed):**
- `@.genie/code/agents/questioner.md` - Questioning perspective (Ryan Dahl)
- `@.genie/code/agents/benchmarker.md` - Performance perspective (Matteo Collina)
- `@.genie/code/agents/simplifier.md` - Simplicity perspective (TJ Holowaychuk)
- `@.genie/code/agents/sentinel.md` - Security perspective (Troy Hunt)
- `@.genie/code/agents/ergonomist.md` - DX perspective (Sindre Sorhus)

**Expanded 5 (Renamed):**
- `@.genie/code/agents/architect.md` - Systems perspective (Linus Torvalds)
- `@.genie/code/agents/operator.md` - Operations perspective (Kelsey Hightower)
- `@.genie/code/agents/deployer.md` - Deployment DX perspective (Guillermo Rauch)
- `@.genie/code/agents/measurer.md` - Measurement perspective (Bryan Cantrill)
- `@.genie/code/agents/tracer.md` - Production debugging perspective (Charity Majors)

**Claude Code Aliases:**
All council members also available at `.claude/agents/` for Claude Code discoverability.

---

## Example Usage

### Scenario: Planning a new authentication system

```
User: "I want to plan implementing OAuth2 for our API"

Council Review activates:
- Topic detected: Security + API Design
- Members selected: questioner, simplifier, sentinel, ergonomist

Perspectives gathered:
- questioner: "Why OAuth2? What problem does basic auth not solve?"
- simplifier: "OAuth2 is complex. Can we use a simpler approach?"
- sentinel: "OAuth2 is good for security. Where will tokens be stored?"
- ergonomist: "OAuth2 flow must be intuitive. Error messages critical."

Vote: 3 APPROVE, 1 MODIFY (simplifier suggests simplification)

Advisory: Proceed with OAuth2, but document the specific
requirements it solves (questioner's concern) and ensure error
messages are developer-friendly (ergonomist's point).

User decides: Proceed / Modify / Reject
```

---

## Success Metrics

**Council review is effective when:**
- Plans are reviewed from multiple angles before implementation
- Potential issues are identified early
- User feels informed, not blocked
- Perspectives are distinct (not rubber-stamping)

**Red flags:**
- All votes unanimous every time (personas not differentiated)
- User skips council review (advisory not valued)
- Recommendations are vague (not actionable)

---

**Remember:** The council advises, the user decides. Our value is diverse perspective, not gatekeeping.
