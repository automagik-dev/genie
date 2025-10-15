# Genie Natural Language Routing

**You just talk. Genie handles everything.**

## Architecture

```
Felipe ↔ Genie (persistent conversational mentor)
          ↓
       Neuron Sessions (persistent conversations)
       ├─ orchestrator-[context]
       ├─ implementor-[task]
       ├─ tests-[module]
       ├─ challenge-[topic]
       └─ etc.
```

**Single interface:** Natural conversation
**Single routing mechanism:** Genie decides based on context (routing.md)
**Single execution layer:** MCP direct to specialist neurons
**Persistence:** Neuron sessions for long-running work

## Specialist Neurons (Access via MCP Only)

#### Strategic Deep-Dive
- `genie` — Pressure-testing, second opinions, consensus building
- `analyze` — System architecture audit
- `explore` — Discovery-focused exploratory reasoning
- `debug` — Root cause investigation
- `consensus` — Decision facilitation (also callable via genie)
- `challenge` — Assumption breaking (also callable via genie)

#### Tactical Utilities
- `refactor` — Refactor planning
- `docgen` — Documentation generation
- `audit` — Risk assessment and security audit
- `tracer` — Instrumentation planning
- `precommit` — Pre-commit validation (alias to commit)

#### Delivery Specialists
- `implementor` — Feature implementation
- `tests` — Test strategy, generation, and authoring
- `review` — Wish audits, code review, and QA validation
- `polish` — Code refinement

#### Infrastructure
- `git` — ALL git and GitHub operations (branch, commit, PR, issues)
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
│   ├── git.md
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
├── git.md
├── implementor.md
├── tests.md
└── …

.genie/custom/routing.md     # Routing triggers & neuron architecture (Genie only)
```

**Note:** `.claude/commands/` and `.claude/agents/` removed in natural language routing.
Genie routes directly via MCP based on conversation context.

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

### Layer 3: Routing Logic (`.genie/custom/routing.md`)
- **Routing triggers** that guide Genie's delegation decisions
- Loaded ONLY by Genie (not by specialist agents)
- Contains: neuron architecture, routing triggers, natural conversation patterns
- Prevents routing paradox (specialists never see routing rules)

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

**Note:** Delivery agents (implementor, tests, review, polish, git) are **not** orchestrator modes - they execute work directly.

---

## Natural Language Routing (How Genie Works)

**You talk naturally. Genie routes invisibly.**

### Example Conversation

```
You: "I want to build an auth system"
Genie: *consults plan neuron, gathers context*
Genie: "Cool! Here's what I'm thinking... [plan]. Sound good?"

You: "Yes"
Genie: *creates wish document*
Genie: "Awesome! I've captured this. Ready to break it down?"

You: "Yes"
Genie: *creates forge plan or executes directly*
Genie: "Let's start with Group A..."

[Work happens naturally with neuron sessions]

Genie: "Done! Want me to review it?"
```

**You never see:** Commands, MCP calls, agent names
**You only see:** Natural conversation

### Neuron Sessions (Persistent Conversations)

**Neurons are persistent conversation partners, not one-shot tools.**

```
# Start neuron session
mcp__genie__run with agent="orchestrator" and prompt="[Initial context]"
# Creates session: orchestrator-abc123

# Resume throughout work (builds context over time)
mcp__genie__resume with sessionId="orchestrator-abc123" and prompt="[Follow-up]"

# Neuron remembers everything, context grows organically
```

**Session naming:** `[neuron-type]-[context-slug]`
- `orchestrator-auth-design`
- `implementor-routing-triggers`
- `tests-api-validation`
- `challenge-architecture`

**Benefits:**
- ✅ Context preserved across iterations
- ✅ Longer collaboration without resets
- ✅ Socratic dialogues that actually work
- ✅ Complete conversation = evidence trail
- ✅ No context explosion (scoped per neuron)

**When Genie uses neurons:**
- Strategic work → orchestrator neuron (persistent thinking partner)
- Complex implementation → implementor neuron (iterative refinement)
- Test development → tests neuron (evolving strategy)
- Long-running tasks → appropriate neuron with session

**Inspect sessions:**
```
mcp__genie__list_sessions
mcp__genie__view with sessionId="<session-id>" and full=true
mcp__genie__resume with sessionId="<session-id>" and prompt="Follow-up..."
mcp__genie__stop with sessionId="<session-id>"
```

---

## Natural Flow (Plan → Wish → Forge → Review)

**Genie obsesses over this flow. You just talk, Genie guides you through it.**

### 1. Discovery (Plan Phase - Invisible)
- You express intent naturally
- Genie detects complexity (≥3 files, strategic, multi-domain)
- Genie consults plan neuron, gathers context
- Genie presents plan naturally: "Here's what I'm thinking..."
- You approve or refine

### 2. Blueprint (Wish Phase - Invisible)
- Genie creates `.genie/wishes/<slug>/<slug>-wish.md`
- Mentions casually: "I've captured this as a wish"
- You don't need to know mechanics

### 3. Breakdown (Forge Phase)
- Complex work: Genie creates forge plan document
- Simple work: Genie executes directly
- You see: "Here's the breakdown..." or "Let me handle this..."

### 4. Execution (Natural)
- Simple tasks: Genie handles directly
- Complex tasks: Genie summons specialist neurons
- Neuron sessions for iterative work
- Progress updates: "Working on Group A..." → "Done!"

### 5. Validation (Review Phase)
- Genie suggests: "Want me to review this?"
- Runs review neuron, validates completion
- Reports: "All validated! Here's the evidence..."

### 6. Checkpoint (Commit)
- Genie detects checkpoint (≥3 files, logical completion)
- Suggests: "Looks like a good checkpoint - want to commit?"
- Handles commit naturally

### 7. Completion
- Suggests PR when appropriate
- Handles git workflow invisibly
- Returns: "PR created: [link]"

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
| **Workflow** | plan, wish, forge, review | Structure work | Genie (invisible to user) |
| **Orchestration** | orchestrator, commit | Coordinate & validate | Genie as neurons |
| **Strategic** | analyze, explore, debug, challenge, consensus | High-level analysis | Genie via orchestrator neuron |
| **Tactical** | refactor, docgen, audit, tracer | Focused support | Genie when needed |
| **Delivery** | implementor, tests, review, polish | Execute work | Genie for complex tasks |
| **Infrastructure** | git, learn | System operations | Genie when needed |
| **Autonomous** | vibe | Autonomous wish coordination | Genie (requires dedicated branch) |

---

## Maintenance Notes

- **Single source of truth:** All agent definitions live in `.genie/agents/`
- **Routing logic:** `.genie/custom/routing.md` guides Genie's delegation decisions
- **No wrappers needed:** Genie routes directly via MCP based on conversation context
- **No duplication:** All agent logic maintained in one place
- **Easy extension:** Add new agent to `.genie/agents/`, update routing.md triggers if needed
- **Natural interface:** User just talks, no commands to maintain
