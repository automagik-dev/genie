# Genie Agent Architecture

## Access Patterns

### Commands Only (Interactive Workflows)
Conversational flows that guide humans through multi-step processes.
Access via: `/command`

- `/plan` — Product planning dialogue
- `/wish` — Wish creation dialogue
- `/forge` — Execution breakdown dialogue
- `/review` — QA validation dialogue
- `/install` — Framework installation
- `/prompt` — Prompt refinement helper
- `/sleepy` — Autonomous wish coordinator with Genie validation
- `/learn` — Meta-learning for framework improvements

### Both Command & Agent (Dual-Purpose)
Can be invoked interactively OR delegated to background/subagents.
Access via: `/command` OR `mcp__genie__run` OR Task tool

- `commit` / `/commit` — Commit advisory generation
- `genie-qa` / `/genie-qa` — Self-validation workflow
- `planner` — Background strategic planning (alias to plan.md, used by /plan workflow)

### Agents Only (Delegatable Workers)
Best invoked via `mcp__genie__run` or spawned by other agents.
Access via: `mcp__genie__run` OR Task tool

#### Strategic Deep-Dive
- `genie` — Pressure-testing, second opinions, consensus building
- `analyze` — System architecture audit
- `thinkdeep` — Extended reasoning
- `debug` — Root cause investigation
- `consensus` — Decision facilitation (also callable via genie)
- `challenge` — Assumption breaking (also callable via genie)

#### Tactical Utilities
- `codereview` — Diff/file review
- `refactor` — Refactor planning
- `testgen` — Test generation
- `docgen` — Documentation generation
- `secaudit` — Security audit
- `tracer` — Instrumentation planning
- `precommit` — Pre-commit validation (alias to commit)

#### Delivery Specialists
- `implementor` — Feature implementation
- `tests` — Test writing
- `polish` — Code refinement
- `qa` — Quality assurance
- `bug-reporter` — Bug triage & filing

#### Infrastructure
- `git-workflow` — Git operations
- `project-manager` — Task coordination
- `self-learn` — Behavioral learning

---

## Directory Structure

```
.genie/agents/               # Source of truth
├── plan.md                  # Core workflow orchestrator
├── wish.md                  # Wish creation agent
├── forge.md                 # Execution planning agent
├── review.md                # QA validation agent
├── specialists/             # Delivery & domain experts
│   ├── bug-reporter.md
│   ├── genie-qa.md
│   ├── git-workflow.md
│   ├── implementor.md
│   ├── learn.md
│   ├── polish.md
│   ├── project-manager.md
│   ├── qa.md
│   ├── self-learn.md
│   ├── sleepy.md
│   └── tests.md
└── utilities/               # Reusable helpers
    ├── analyze.md
    ├── challenge.md
    ├── codereview.md
    ├── commit.md
    ├── consensus.md
    ├── debug.md
    ├── docgen.md
    ├── identity-check.md
    ├── install.md
    ├── prompt.md
    ├── refactor.md
    ├── secaudit.md
    ├── testgen.md
    ├── thinkdeep.md
    ├── tracer.md
    └── genie.md

.claude/commands/            # Interactive slash commands
├── plan.md → @.genie/agents/plan.md
├── wish.md → @.genie/agents/wish.md
├── forge.md → @.genie/agents/forge.md
├── review.md → @.genie/agents/review.md
├── commit.md → @.genie/agents/core/commit.md
├── genie-qa.md → @.genie/agents/specialists/genie-qa.md
├── install.md → @.genie/agents/utilities/install.md
├── prompt.md → @.genie/agents/utilities/prompt.md
├── sleepy.md → @.genie/agents/specialists/sleepy.md
└── learn.md → @.genie/agents/specialists/learn.md

.claude/agents/              # Task tool aliases (delegatable)
├── planner.md → @.genie/agents/plan.md
├── commit.md → @.genie/agents/core/commit.md
├── precommit.md → @.genie/agents/core/commit.md
├── genie-qa.md → @.genie/agents/specialists/genie-qa.md
├── genie.md → @.genie/agents/core/orchestrator.md
├── analyze.md → @.genie/agents/utilities/analyze.md
├── debug.md → @.genie/agents/utilities/debug.md
├── thinkdeep.md → @.genie/agents/utilities/thinkdeep.md
├── consensus.md → @.genie/agents/utilities/consensus.md
├── challenge.md → @.genie/agents/utilities/challenge.md
├── codereview.md → @.genie/agents/core/codereview.md
├── refactor.md → @.genie/agents/core/refactor.md
├── testgen.md → @.genie/agents/core/testgen.md
├── docgen.md → @.genie/agents/core/docgen.md
├── secaudit.md → @.genie/agents/core/secaudit.md
├── tracer.md → @.genie/agents/core/tracer.md
├── implementor.md → @.genie/agents/specialists/implementor.md
├── tests.md → @.genie/agents/specialists/tests.md
├── polish.md → @.genie/agents/specialists/polish.md
├── qa.md → @.genie/agents/specialists/qa.md
├── bug-reporter.md → @.genie/agents/specialists/bug-reporter.md
├── git-workflow.md → @.genie/agents/specialists/git-workflow.md
├── project-manager.md → @.genie/agents/specialists/project-manager.md
├── self-learn.md → @.genie/agents/specialists/self-learn.md
├── sleepy.md → @.genie/agents/specialists/sleepy.md
└── learn.md → @.genie/agents/specialists/learn.md
```

---

## MCP Quick Reference

### Interactive Workflows (Commands)
Use slash commands for interactive workflows:

```
/plan           # Start product planning dialogue
/wish           # Create wish document
/forge          # Break wish into execution groups
/review         # Validate completed work

# Helpers
/install        # Set up Genie in new project
/prompt         # Refine prompt/instructions
/commit         # Interactive commit flow
/genie-qa       # Self-validate Genie framework
/sleepy         # Autonomous wish coordinator (requires dedicated branch)
/learn          # Teach Genie new patterns/behaviors
```

### Background Agents (Delegatable via MCP)
Use MCP tools for background agents:

```
# Strategic deep-dive
mcp__genie__run with agent="genie" and prompt="Mode: planning. Objective: ..."
mcp__genie__run with agent="planner" and prompt="Background: analyze roadmap gaps..."
mcp__genie__run with agent="analyze" and prompt="Scope: src/services. Deliver: dependency map..."
mcp__genie__run with agent="debug" and prompt="Bug: auth failing. Hypotheses: ..."
mcp__genie__run with agent="thinkdeep" and prompt="Focus: scaling strategy. Timebox: 10min..."

# Tactical utilities
mcp__genie__run with agent="commit" and prompt="Generate commit message for current staged changes"
mcp__genie__run with agent="codereview" and prompt="Scope: git diff main. Task: ..."
mcp__genie__run with agent="testgen" and prompt="Layer: unit. Files: src/auth/*.rs..."
mcp__genie__run with agent="refactor" and prompt="Targets: api/routes. Plan: ..."

# Delivery specialists (spawned by /forge)
mcp__genie__run with agent="implementor" and prompt="Task: FORGE-123"
mcp__genie__run with agent="tests" and prompt="Task: FORGE-124"
mcp__genie__run with agent="qa" and prompt="Task: FORGE-125"

# Inspect & resume
mcp__genie__list_sessions
mcp__genie__view with sessionId="<session-id>" and full=true
mcp__genie__resume with sessionId="<session-id>" and prompt="Follow-up: ..."
mcp__genie__stop with sessionId="<session-id>"
```

---

## Usage Guidelines

### When to Use Commands vs MCP Agents

**Use Commands (`/command`) when:**
- Starting a new workflow step (plan → wish → forge → review)
- Need interactive guidance through multi-step process
- Want conversation-style collaboration

**Use MCP Agents (`mcp__genie__run` or Task tool) when:**
- Delegating specific task to background worker
- Need parallel execution of multiple tasks
- Want to resume/inspect long-running work
- Spawning specialists from forge execution groups

### Workflow Pattern

1. **Discovery:** `/plan` → creates planning brief
2. **Blueprint:** `/wish` → creates wish document
3. **Execution:** `/forge` → breaks into execution groups → spawns agents (implementor, tests, qa)
4. **Validation:** `/review` → validates completion → generates QA report
5. **Commit:** `/commit` → generates commit message and advisory

### Agent Delegation Pattern

```
# Forge outputs execution groups with agent suggestions
# Example from forge plan:
# Group A: implementor
# Group B: tests
# Group C: qa

# Spawn agents with full context
mcp__genie__run with agent="implementor" and prompt="@.genie/wishes/auth-wish.md Group A"
mcp__genie__run with agent="tests" and prompt="@.genie/wishes/auth-wish.md Group B"
mcp__genie__run with agent="qa" and prompt="@.genie/wishes/auth-wish.md Group C"

# Resume for follow-ups
mcp__genie__resume with sessionId="<session-id>" and prompt="Address blocker: missing test fixtures"
```

---

## Genie Modes Reference

`genie` consolidates multiple analysis patterns into a single versatile agent:

```
# Planning & pressure-testing
mcp__genie__run with agent="genie" and prompt="Mode: planning. Objective: pressure-test @.genie/wishes/auth-wish.md"

# Consensus & decision-making
mcp__genie__run with agent="genie" and prompt="Mode: consensus. Decision: use PostgreSQL vs MongoDB"

# Challenge assumptions
mcp__genie__run with agent="genie" and prompt="Mode: challenge. Assumption: users prefer email over SMS"

# Deep investigation
mcp__genie__run with agent="genie" and prompt="Mode: deep-dive. Topic: authentication flow dependencies"

# Debug with hypotheses
mcp__genie__run with agent="genie" and prompt="Mode: debug. Bug: login fails intermittently"

# Risk assessment
mcp__genie__run with agent="genie" and prompt="Mode: risk-audit. Initiative: migrate to microservices"

# Design review
mcp__genie__run with agent="genie" and prompt="Mode: design-review. Component: payment service"

# Test strategy
mcp__genie__run with agent="genie" and prompt="Mode: test-strategy. Feature: password reset flow"

# See @.genie/agents/core/orchestrator.md for all modes
```

---

## Agent Specialization Matrix

| Category | Agents | Primary Use Case | Invoked By |
|----------|--------|------------------|------------|
| **Workflow** | plan, wish, forge, review | Structure work | Human via commands |
| **Orchestration** | planner, commit, genie-qa | Coordinate & validate | Human or agents |
| **Strategic** | genie, analyze, debug, thinkdeep | High-level analysis | Human or plan/forge |
| **Tactical** | codereview, refactor, testgen, docgen, secaudit, tracer | Specific utilities | Human or specialists |
| **Delivery** | implementor, tests, polish, qa, bug-reporter | Execute work | Forge or human |
| **Infrastructure** | git-workflow, project-manager, self-learn | System operations | Agents or workflows |
| **Autonomous** | sleepy, learn | Long-running coordination & meta-learning | Human via commands (sleepy requires dedicated branch) |

---

## Maintenance Notes

- **Single source of truth:** All agent definitions live in `.genie/agents/`
- **Commands:** Simple `@include` wrappers pointing to `.genie/agents/`
- **Agent aliases:** Simple frontmatter with `@include` pointing to `.genie/agents/`
- **No duplication:** All agent logic maintained in one place
- **Easy extension:** Add new agent to `.genie/agents/`, create wrappers as needed