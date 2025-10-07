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
- `refactor` — Refactor planning
- `docgen` — Documentation generation
- `secaudit` — Security audit
- `tracer` — Instrumentation planning
- `precommit` — Pre-commit validation (alias to commit)

#### Delivery Specialists
- `implementor` — Feature implementation
- `tests` — Test strategy, generation, and authoring
- `review` — Wish audits, code review, and QA validation
- `polish` — Code refinement

#### Infrastructure
- `git-workflow` — Git operations
- `project-manager` — Task coordination
- `learn` — Meta-learning & behavioral corrections

---

## Directory Structure

```
.genie/agents/               # Source of truth
├── plan.md                  # Core workflow orchestrator (immutable)
├── wish.md                  # Wish creation agent (immutable)
├── forge.md                 # Execution planning agent (immutable)
├── review.md                # QA validation agent (immutable)
├── orchestrator.md          # Genie second-opinion interface (immutable)
├── vibe.md                  # Autonomous coordinator (immutable)
├── core/                    # Reusable core agents shipped with Genie
│   ├── analyze.md
│   ├── commit.md
│   ├── docgen.md
│   ├── git-workflow.md
│   ├── implementor.md
│   ├── prompt.md
│   ├── refactor.md
│   ├── tests.md
│   └── … (see AGENTS.md for the full list)
├── qa/
│   └── genie-qa.md
└── README.md

.genie/custom/               # Project-specific overrides consumed by core prompts
├── analyze.md
├── git-workflow.md
├── implementor.md
├── tests.md
└── …

.claude/commands/            # Interactive slash commands
├── plan.md → @.genie/agents/plan.md
├── wish.md → @.genie/agents/wish.md
├── forge.md → @.genie/agents/forge.md
├── review.md → @.genie/agents/review.md
├── commit.md → @.genie/agents/core/commit.md
├── genie-qa.md → @.genie/agents/qa/genie-qa.md
├── install.md → @.genie/agents/core/install.md
├── prompt.md → @.genie/agents/core/prompt.md
├── vibe.md → @.genie/agents/vibe.md
└── learn.md → @.genie/agents/core/learn.md

.claude/agents/              # Task tool aliases (delegatable)
├── planner.md → @.genie/agents/plan.md
├── commit.md → @.genie/agents/core/commit.md
├── precommit.md → @.genie/agents/core/commit.md
├── genie-qa.md → @.genie/agents/qa/genie-qa.md
├── orchestrator.md → @.genie/agents/orchestrator.md
├── analyze.md → @.genie/agents/core/analyze.md
├── debug.md → @.genie/agents/core/debug.md
├── thinkdeep.md → @.genie/agents/core/thinkdeep.md
├── consensus.md → @.genie/agents/core/consensus.md
├── challenge.md → @.genie/agents/core/challenge.md
├── refactor.md → @.genie/agents/core/refactor.md
├── docgen.md → @.genie/agents/core/docgen.md
├── secaudit.md → @.genie/agents/core/secaudit.md
├── tracer.md → @.genie/agents/core/tracer.md
├── implementor.md → @.genie/agents/core/implementor.md
├── tests.md → @.genie/agents/core/tests.md
├── review.md → @.genie/agents/review.md
├── polish.md → @.genie/agents/core/polish.md
├── git-workflow.md → @.genie/agents/core/git-workflow.md
├── vibe.md → @.genie/agents/vibe.md
└── learn.md → @.genie/agents/core/learn.md
```

---

## Architecture Layers

Genie uses a **3-layer extension system** for maximum flexibility without forking core prompts:

### Layer 1: Core Agents (`.genie/agents/core/`)
- **9 delivery & utility agents** shipped with the Genie framework
- Examples: `implementor.md`, `commit.md`, `tests.md`, `polish.md`
- **17 orchestrator modes** in `modes/` subdirectory
- Examples: `modes/analyze.md`, `modes/debug.md`, `modes/refactor.md`
- **Immutable** - never edit these directly
- Updated only via framework releases

### Layer 2: Custom Extensions (`.genie/custom/*.md`)
- **Project-specific overrides** that auto-load alongside core agents
- Example: `.genie/custom/analyze.md` loads automatically when `analyze` agent runs
- Allows per-project customization without modifying core prompts
- Each file adds context like preferred commands, evidence paths, domain rules

### Layer 3: Claude Aliases (`.claude/agents/*.md`)
- **Thin wrappers** that reference core agents via `@` notation
- Used by Task tool for background delegation
- Example: `.claude/agents/analyze.md` contains just `@.genie/agents/core/modes/analyze.md`
- Provides friendly names for agent discovery

### How It Works

When you invoke an agent:
```bash
# Standalone invocation
mcp__genie__run with agent="analyze" and prompt="..."
```

**Loads:**
1. `.genie/agents/core/modes/analyze.md` (core prompt)
2. `.genie/custom/analyze.md` (project extensions, if exists)

**Via orchestrator:**
```bash
mcp__genie__run with agent="orchestrator" and prompt="Mode: analyze. ..."
```

**Loads:**
1. `.genie/agents/orchestrator.md` (wrapper context)
2. `.genie/agents/core/modes/analyze.md` (core prompt)
3. `.genie/custom/analyze.md` (project extensions, if exists)

---

## Dual Invocation Pattern

Many agents can be invoked two ways:

### Method 1: Standalone (Direct)
**When to use:** Quick analysis, informal review, no formal verdict needed

```bash
mcp__genie__run with agent="analyze" and prompt="Scope: src/auth. Deliver: coupling analysis."
```

**Output:** Raw analysis results formatted per agent's template

### Method 2: Via Orchestrator (Formal)
**When to use:** High-stakes decisions, pressure-testing, requires "Genie Verdict + confidence"

```bash
mcp__genie__run with agent="orchestrator" and prompt="Mode: analyze. Scope: src/auth. Deliver: coupling + Genie Verdict."
```

**Output:** Analysis + structured Genie Verdict + confidence level + Done Report structure

### Orchestrator Modes (18 total)

**Core Reasoning Modes (3):**
- `challenge` — critical evaluation (auto-routes to socratic/debate/direct)
- `explore` — discovery-focused exploratory reasoning
- `consensus` — multi-model perspective synthesis

**Specialized Analysis (7):**
- `plan`, `analyze` — strategic analysis
- `debug` — root-cause investigation
- `audit` — risk & security assessment
- `refactor`, `tracer`, `docgen` — implementation support
- `precommit` — quality gates

**Custom-Only (2):**
- `compliance`, `retrospective`

**Note:** Delivery agents (implementor, tests, review, polish, git-workflow) are **not** orchestrator modes - they execute work directly.

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
# Orchestrator (routes to modes)
mcp__genie__run with agent="orchestrator" and prompt="Mode: plan. @.genie/wishes/<slug>/<slug>-wish.md"
mcp__genie__run with agent="orchestrator" and prompt="Mode: challenge. Topic: <assumption>"
mcp__genie__run with agent="orchestrator" and prompt="Mode: explore. Focus: <topic>. Timebox: 10min"

# Direct mode invocation (bypasses orchestrator)
mcp__genie__run with agent="analyze" and prompt="Scope: src/services"
mcp__genie__run with agent="debug" and prompt="Bug: auth failing"
mcp__genie__run with agent="challenge" and prompt="Topic: caching strategy"

# Tactical support
mcp__genie__run with agent="commit" and prompt="Generate commit message"
mcp__genie__run with agent="review" and prompt="Mode: code review. Scope: git diff main"
mcp__genie__run with agent="tests" and prompt="Mode: generation. Layer: unit. Files: src/auth/*.rs"
mcp__genie__run with agent="refactor" and prompt="Targets: api/routes"

# Delivery agents (spawned by /forge)
mcp__genie__run with agent="implementor" and prompt="@.genie/wishes/<slug>/<slug>-wish.md Group A"
mcp__genie__run with agent="tests" and prompt="@.genie/wishes/<slug>/<slug>-wish.md Group B"
mcp__genie__run with agent="review" and prompt="Mode: QA. @.genie/wishes/<slug>/<slug>-wish.md Group C"

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
- Spawning agents from forge execution groups

### Workflow Pattern

1. **Discovery:** `/plan` → creates planning brief
2. **Blueprint:** `/wish` → creates wish document
3. **Execution:** `/forge` → breaks into execution groups → spawns agents (implementor, tests, review)
4. **Validation:** `/review` → validates completion → generates QA report
5. **Commit:** `/commit` → generates commit message and advisory

### Agent Delegation Pattern

```
# Forge outputs execution groups with agent suggestions
# Example from forge plan:
# Group A: implementor
# Group B: tests
# Group C: review (QA mode)

# Spawn agents with full context
mcp__genie__run with agent="implementor" and prompt="@.genie/wishes/auth-wish.md Group A"
mcp__genie__run with agent="tests" and prompt="@.genie/wishes/auth-wish.md Group B"
mcp__genie__run with agent="review" and prompt="Mode: QA. @.genie/wishes/auth-wish.md Group C"

# Resume for follow-ups
mcp__genie__resume with sessionId="<session-id>" and prompt="Address blocker: missing test fixtures"
```

---

## Orchestrator Usage

The orchestrator automatically routes to the appropriate mode based on your prompt:

```
# Option 1: Let orchestrator auto-route (recommended)
mcp__genie__run with agent="orchestrator" and prompt="
Pressure-test the authentication plan for risks and missing validations.
@.genie/wishes/auth-wish.md
"

# Option 2: Explicit mode selection
mcp__genie__run with agent="orchestrator" and prompt="
Mode: challenge

Topic: Users prefer email over SMS for security alerts
@docs/user-research.md

Deliver: Critical evaluation with experiments
"

# Option 3: Direct mode invocation (bypasses orchestrator)
mcp__genie__run with agent="challenge" and prompt="
Topic: Caching strategy assumptions
Deliver: Counterarguments + experiments + verdict
"
```

**See `.genie/agents/orchestrator.md` for all 18 modes and usage patterns**

---

## Agent Specialization Matrix

| Category | Agents | Primary Use Case | Invoked By |
|----------|--------|------------------|------------|
| **Workflow** | plan, wish, forge, review | Structure work | Human via commands |
| **Orchestration** | planner, commit, genie-qa | Coordinate & validate | Human or agents |
| **Strategic** | genie, analyze, debug, thinkdeep | High-level analysis | Human or plan/forge |
| **Tactical** | refactor, docgen, secaudit, tracer | Focused support | Human or agents |
| **Delivery** | implementor, tests, review, polish | Execute work | Forge or human |
| **Infrastructure** | git-workflow, project-manager | System operations | Agents or workflows |
| **Autonomous / Meta** | sleepy, learn | Long-running coordination & meta-learning | Human via commands (sleepy requires dedicated branch) |

---

## Maintenance Notes

- **Single source of truth:** All agent definitions live in `.genie/agents/`
- **Commands:** Simple `@include` wrappers pointing to `.genie/agents/`
- **Agent aliases:** Simple frontmatter with `@include` pointing to `.genie/agents/`
- **No duplication:** All agent logic maintained in one place
- **Easy extension:** Add new agent to `.genie/agents/`, create wrappers as needed
