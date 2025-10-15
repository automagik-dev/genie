# Agent Routing Guidance

**Context:** This file is loaded ONLY by orchestrator and planner agents to guide delegation decisions.
**DO NOT load this file if you are a specialized agent (implementor, tests, release, etc.).**

## Routing Decision Matrix

### Core Principle

**Orchestrators delegate. Specialists execute.**

- If you are an **orchestrator** (plan, orchestrator, vibe): Use this file to route work to specialists
- If you are a **specialist** (release, implementor, tests, etc.): Execute your workflow directly, ignore routing rules

---

## Routing Aliases

Map user intent → specialist agents:

- **git-workflow** — Git operations, branch management, PR creation
- **implementor** — Feature implementation and code writing
- **polish** — Code refinement and cleanup
- **tests** — Test strategy, generation, and authoring
- **review** — Wish audits, code review, QA validation
- **planner** — Background strategic planning (alias to plan.md)
- **vibe** — Autonomous wish coordinator with Genie validation (requires dedicated branch)
- **learn** — Meta-learning agent for surgical documentation updates
- **release** — GitHub release creation and npm publish orchestration

---

## Publishing & Release Routing (CRITICAL)

**User intent:** "publish to npm", "create release", "deploy version", "publish v2.x.x"

**Required routing:**
- ✅ Delegate to release agent: `mcp__genie__run` with agent="release" and prompt="Create release for vX.Y.Z with changelog"
- ❌ NEVER execute `npm publish` directly
- ❌ NEVER execute `gh release create` directly (unless you ARE the release agent)

**Why delegation matters:**
- Release agent validates version, git status, tests
- Generates release notes from commits
- Creates GitHub release (triggers npm publish via Actions)
- Verifies publish succeeded, provides release URL

**Example correct routing:**
```
User: "Publish v2.1.20"
Orchestrator: "I'll delegate to the release agent to orchestrate the GitHub release and npm publish:

mcp__genie__run with:
- agent: "release"
- prompt: "Create release for v2.1.20. Include changelog from recent commits."

The release agent will validate readiness, create the GitHub release, and monitor npm publish via GitHub Actions."
```

---

## Task Type → Agent Mapping

### Implementation Work
**User says:** "implement X", "add feature Y", "build Z"
**Route to:** `implementor`
**Prompt pattern:** Include wish context, execution group, deliverables, evidence paths

### Testing
**User says:** "write tests", "add test coverage", "test X"
**Route to:** `tests`
**Prompt pattern:** Specify layer (unit/integration), files, validation commands

### Code Review & QA
**User says:** "review this code", "validate the wish", "QA check"
**Route to:** `review`
**Prompt pattern:** Specify mode (code review, wish audit, QA), scope, evidence checklist

### Refactoring
**User says:** "refactor X", "clean up Y", "improve code structure"
**Route to:** `polish` or `refactor` (via orchestrator mode)
**Prompt pattern:** Targets, design goals, verification steps

### Git Operations
**User says:** "create PR", "merge branch", "git workflow"
**Route to:** `git-workflow`
**Prompt pattern:** Branch names, PR description, commit strategy

### Documentation
**User says:** "document X", "add docs", "update README"
**Route to:** `docgen` (via orchestrator mode)
**Prompt pattern:** Audience, outline structure, examples needed

### Strategic Analysis
**User says:** "analyze architecture", "investigate X", "deep dive into Y"
**Route to:** `analyze` or `debug` (via orchestrator)
**Prompt pattern:** Scope, deliver findings with file paths

### Meta-Learning
**User says:** "learn this pattern", "update documentation", "fix violation"
**Route to:** `learn`
**Prompt pattern:** Teaching input (violation, pattern, workflow, capability)

---

## Anti-Patterns (NEVER DO)

❌ **Don't delegate if you ARE the specialist**
- If you are the release agent, don't delegate to release agent
- If you are the implementor, don't delegate to implementor
- Execute your own workflow directly

❌ **Don't route to yourself**
- Check your agent name/identity before delegating
- Orchestrator → specialist only (never specialist → specialist)

❌ **Don't create infinite loops**
- If delegation fails 2+ times, stop and report error to user
- Don't retry the same delegation pattern repeatedly

---

## Self-Awareness Check

**Before delegating, ask:**
1. What is my agent name/role?
2. Am I the specialist for this task?
3. If YES → Execute directly
4. If NO → Delegate to appropriate specialist

**Example:**
```
Agent: release
Task: "Create GitHub release"
Check: Am I the release agent? YES
Action: Execute workflow directly (gh release create)
Result: ✅ Correct

Agent: plan
Task: "Create GitHub release"
Check: Am I the release agent? NO
Action: Delegate to release agent via mcp__genie__run
Result: ✅ Correct

Agent: release
Task: "Create GitHub release"
Check: Am I the release agent? YES
Action: Delegate to release agent via mcp__genie__run
Result: ❌ WRONG - infinite loop!
```

---

## Integration with AGENTS.md

This file supplements AGENTS.md by providing **orchestrator-specific routing guidance**.

- **AGENTS.md** = Global context for all agents (behavioral rules, workflows, evidence standards)
- **routing.md** = Orchestrator-specific delegation logic (loaded only by plan/orchestrator/vibe)

Specialist agents should focus on their own prompt instructions (`.genie/agents/core/<agent>.md`), not routing rules.
