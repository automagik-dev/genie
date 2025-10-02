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
- `/sleepy` — Autonomous wish coordinator with Twin Genie
- `/learn` — Meta-learning for framework improvements

### Both Command & Agent (Dual-Purpose)
Can be invoked interactively OR delegated to background/subagents.
Access via: `/command` OR `./genie run <agent>` OR Task tool

- `commit` / `/commit` — Commit advisory generation
- `genie-qa` / `/genie-qa` — Self-validation workflow
- `planner` — Background strategic planning (alias to plan.md, used by /plan workflow)

### Agents Only (Delegatable Workers)
Best invoked via `./genie run <agent>` or spawned by other agents.
Access via: `./genie run <agent>` OR Task tool

#### Strategic Deep-Dive
- `twin` — Pressure-testing, second opinions, consensus building
- `analyze` — System architecture audit
- `thinkdeep` — Extended reasoning
- `debug` — Root cause investigation
- `consensus` — Decision facilitation (also callable via twin)
- `challenge` — Assumption breaking (also callable via twin)

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
    └── twin.md

.claude/commands/            # Interactive slash commands
├── plan.md → @.genie/agents/plan.md
├── wish.md → @.genie/agents/wish.md
├── forge.md → @.genie/agents/forge.md
├── review.md → @.genie/agents/review.md
├── commit.md → @.genie/agents/utilities/commit.md
├── genie-qa.md → @.genie/agents/specialists/genie-qa.md
├── install.md → @.genie/agents/utilities/install.md
├── prompt.md → @.genie/agents/utilities/prompt.md
├── sleepy.md → @.genie/agents/specialists/sleepy.md
└── learn.md → @.genie/agents/specialists/learn.md

.claude/agents/              # Task tool aliases (delegatable)
├── planner.md → @.genie/agents/plan.md
├── commit.md → @.genie/agents/utilities/commit.md
├── precommit.md → @.genie/agents/utilities/commit.md
├── genie-qa.md → @.genie/agents/specialists/genie-qa.md
├── twin.md → @.genie/agents/utilities/twin.md
├── analyze.md → @.genie/agents/utilities/analyze.md
├── debug.md → @.genie/agents/utilities/debug.md
├── thinkdeep.md → @.genie/agents/utilities/thinkdeep.md
├── consensus.md → @.genie/agents/utilities/consensus.md
├── challenge.md → @.genie/agents/utilities/challenge.md
├── codereview.md → @.genie/agents/utilities/codereview.md
├── refactor.md → @.genie/agents/utilities/refactor.md
├── testgen.md → @.genie/agents/utilities/testgen.md
├── docgen.md → @.genie/agents/utilities/docgen.md
├── secaudit.md → @.genie/agents/utilities/secaudit.md
├── tracer.md → @.genie/agents/utilities/tracer.md
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

## CLI Quick Reference

### Interactive Workflows (Commands)
```bash
# Core Genie workflow (4-step process)
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

### Background Agents (Delegatable)
```bash
# Strategic deep-dive
./genie run twin "Mode: planning. Objective: ..."
./genie run planner "Background: analyze roadmap gaps..."
./genie run analyze "Scope: src/services. Deliver: dependency map..."
./genie run debug "Bug: auth failing. Hypotheses: ..."
./genie run thinkdeep "Focus: scaling strategy. Timebox: 10min..."

# Tactical utilities
./genie run commit "Generate commit message for current staged changes"
./genie run codereview "Scope: git diff main. Task: ..."
./genie run testgen "Layer: unit. Files: src/auth/*.rs..."
./genie run refactor "Targets: api/routes. Plan: ..."

# Delivery specialists (spawned by /forge)
./genie run implementor "Task: FORGE-123"
./genie run tests "Task: FORGE-124"
./genie run qa "Task: FORGE-125"

# Inspect & resume
./genie list sessions
./genie view <sessionId> --full
./genie resume <sessionId> "Follow-up: ..."
./genie stop <sessionId>
```

---

## Usage Guidelines

### When to Use Commands vs Agents

**Use Commands (`/command`) when:**
- Starting a new workflow step (plan → wish → forge → review)
- Need interactive guidance through multi-step process
- Want conversation-style collaboration

**Use Agents (`./genie run` or Task tool) when:**
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

```bash
# Forge outputs execution groups with agent suggestions
# Example from forge plan:
# Group A: implementor
# Group B: tests
# Group C: qa

# Spawn agents with full context
./genie run implementor "@.genie/wishes/auth-wish.md Group A"
./genie run tests "@.genie/wishes/auth-wish.md Group B"
./genie run qa "@.genie/wishes/auth-wish.md Group C"

# Resume for follow-ups
./genie resume <sessionId> "Address blocker: missing test fixtures"
```

---

## Twin Modes Reference

`twin` consolidates multiple analysis patterns into a single versatile agent:

```bash
# Planning & pressure-testing
./genie run twin "Mode: planning. Objective: pressure-test @.genie/wishes/auth-wish.md"

# Consensus & decision-making
./genie run twin "Mode: consensus. Decision: use PostgreSQL vs MongoDB"

# Challenge assumptions
./genie run twin "Mode: challenge. Assumption: users prefer email over SMS"

# Deep investigation
./genie run twin "Mode: deep-dive. Topic: authentication flow dependencies"

# Debug with hypotheses
./genie run twin "Mode: debug. Bug: login fails intermittently"

# Risk assessment
./genie run twin "Mode: risk-audit. Initiative: migrate to microservices"

# Design review
./genie run twin "Mode: design-review. Component: payment service"

# Test strategy
./genie run twin "Mode: test-strategy. Feature: password reset flow"

# See @.genie/agents/utilities/twin.md for all modes
```

---

## Agent Specialization Matrix

| Category | Agents | Primary Use Case | Invoked By |
|----------|--------|------------------|------------|
| **Workflow** | plan, wish, forge, review | Structure work | Human via commands |
| **Orchestration** | planner, commit, genie-qa | Coordinate & validate | Human or agents |
| **Strategic** | twin, analyze, debug, thinkdeep | High-level analysis | Human or plan/forge |
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