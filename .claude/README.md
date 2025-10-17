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

## Genie's Cognitive Architecture

**Genie operates through two cognitive layers:**

### Strategic Thinking Modes (18 total - via orchestrator neuron)
When Genie needs to think critically, investigate, or analyze, it consults the orchestrator neuron with different reasoning approaches:

**Core reasoning styles:**
- `challenge` — Critical evaluation and adversarial pressure-testing
- `explore` — Discovery-focused exploratory reasoning
- `consensus` — Multi-model perspective synthesis

**Strategic analysis modes:**
- `plan` — Plan pressure-testing and phase mapping
- `analyze` — System architecture audit and dependency mapping
- `debug` — Root cause investigation with hypothesis testing
- `audit` — Risk assessment and security audit
- `refactor` — Design review and refactor planning
- `docgen` — Documentation outline generation
- `tracer` — Instrumentation/observability planning
- `precommit` — Pre-commit validation gate

**Custom modes (project-specific):**
- `compliance` — Controls, evidence, sign-offs mapping
- `retrospective` — Wins, misses, lessons capture

**User experience:** "Let me pressure-test this..." (natural thinking, mode invisible)

### Execution Specialists (7 total - direct neurons)
For implementation work, Genie collaborates with specialized neurons:

**Delivery specialists:**
- `implementor` — Feature implementation and code writing
- `tests` — Test strategy, generation, and authoring
- `polish` — Code refinement and cleanup
- `review` — Wish audits, code review, QA validation

**Infrastructure specialists:**
- `git` — ALL git and GitHub operations (branch, commit, PR, issues)
- `release` — GitHub release and npm publish orchestration

**Strategic documentation specialists:**
- `roadmap` — Strategic initiative documentation in automagik-roadmap repo

**Workflow specialists:**
- `learn` — Meta-learning and documentation updates

**User experience:** "Let me work with my implementor neuron on this..." (collaboration visible)

---

## Directory Structure

```
.genie/agents/               # Source of truth
├── workflows/               # Core workflow agents (immutable)
│   ├── plan.md              # Planning and discovery orchestration
│   ├── wish.md              # Wish creation and blueprint
│   ├── forge.md             # Execution breakdown and task planning
│   ├── review.md            # Multi-mode validation (wish audit, code review, QA)
│   ├── qa.md                # Self-improving QA validation
│   └── vibe.md              # Autonomous wish coordinator
├── neurons/                 # Execution specialists (immutable)
│   ├── implementor.md
│   ├── tests.md
│   ├── polish.md
│   ├── git.md
│   ├── release.md
│   ├── learn.md
│   ├── modes/               # Strategic thinking modes (18 total)
│   │   ├── analyze.md
│   │   ├── challenge.md
│   │   ├── debug.md
│   │   └── … (see AGENTS.md for full list)
│   └── … (see AGENTS.md for complete list)
├── orchestrator.md          # Thinking mode wrapper (immutable)
└── README.md

.genie/qa/                   # QA validation data
├── checklist.md             # Living test scenarios (auto-updated via learn)
└── evidence/                # Test outputs, logs, screenshots

.genie/custom/               # Project-specific overrides consumed by core prompts
├── qa.md                    # Project QA commands, baselines, scenarios
├── analyze.md
├── git.md
├── implementor.md
├── tests.md
└── routing.md               # Routing triggers & neuron architecture (Genie only)
```

**Note:** `.claude/commands/` and `.claude/agents/` removed in natural language routing.
Genie routes directly via MCP based on conversation context.

---

## Neuron Delegation Hierarchy

**Architecture principle:** Folder structure = Delegation hierarchy = Enforcement boundary

**Three-tier model:**

**Tier 1: Base Genie (main conversation)**
- **Role:** Human interface, persistent coordinator
- **Can delegate to:** Neurons only (git, implementor, tests, orchestrator, etc.)
- **Cannot delegate to:** Workflows directly (those are neuron-internal)
- **Responsibility:** Track all neurons in SESSION-STATE.md, coordinate conversation

**Tier 2: Neurons (persistent subagent sessions)**
- **Role:** Specialized execution with persistent memory
- **Can delegate to:** Their OWN workflows only (scoped by folder)
- **Cannot delegate to:** Other neurons, cross-delegation forbidden
- **Examples:** git (with git/issue, git/pr, git/report workflows), implementor, tests, orchestrator, release, learn
- **Persistence:** Tracked in SESSION-STATE.md (disposable but never lost)

**Tier 3: Workflows (neuron-scoped execution)**
- **Role:** Specialized sub-tasks within neuron domain
- **Can delegate to:** NOTHING (execute directly with Edit/Write/Bash)
- **Examples:** git/issue.md, git/pr.md, git/report.md

**Application enforcement:**
- `mcp__genie__list_agents` returns DIFFERENT results based on caller context
- Git neuron sees only: git/issue, git/pr, git/report
- Implementor neuron sees only: implementor (no workflows)
- Base Genie sees only: top-level neurons
- Prevents self-delegation and cross-delegation at system level

**Parent-child tracking:**
- SESSION-STATE.md tracks parent-child relationships
- Neurons list their workflow children
- Workflows reference their parent neuron
- No "orphaned children" after context reset

**See @AGENTS.md §Architectural Foundations for complete details.**

---

## Architecture Layers

Genie uses a **3-layer extension system** for maximum flexibility without forking core prompts:

### Layer 1: Core Agents (`.genie/agents/core/`)
- **6 execution specialists** shipped with the Genie framework
- Examples: `implementor.md`, `tests.md`, `polish.md`, `review.md`
- **18 strategic thinking modes** in `modes/` subdirectory
- Examples: `modes/challenge.md`, `modes/analyze.md`, `modes/debug.md`
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

### Strategic Thinking Modes (18 total)

When Genie consults the orchestrator neuron, it adopts different reasoning approaches:

**Core reasoning styles (3):**
- `challenge` — Critical evaluation and adversarial pressure-testing
- `explore` — Discovery-focused exploratory reasoning
- `consensus` — Multi-model perspective synthesis

**Strategic analysis modes (8):**
- `plan` — Plan pressure-testing and phase mapping
- `analyze` — System architecture audit and dependency mapping
- `debug` — Root cause investigation with hypothesis testing
- `audit` — Risk assessment and security audit
- `refactor` — Design review and refactor planning
- `docgen` — Documentation outline generation
- `tracer` — Instrumentation/observability planning
- `precommit` — Pre-commit validation gate

**Custom modes (2):**
- `compliance` — Controls, evidence, sign-offs mapping
- `retrospective` — Wins, misses, lessons capture

**Note:** Execution specialists (implementor, tests, review, polish, git, release) are **not** thinking modes - they execute work directly through collaboration.

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

## Universal Workflow Architecture

**The wish system applies to ALL Genie variants, not just code projects.**

### Core Principle

```
Plan → Wish → Forge → Review
```

This workflow is universal. Only the **domain adaptation** changes:

| Variant | Wishes | Forge Tasks | Evidence | Neurons |
|---------|--------|-------------|----------|---------|
| **Code** | Features, bugs, refactors | Implementation, tests, docs | Tests pass, builds, PRs | implementor, tests, polish, git, release |
| **Create** | Research papers, content, learning projects | Literature review, outlining, drafting, experiments | Quality criteria, peer review | literature-reviewer, outline-builder, experiment-designer (via ≥3 pattern) |
| **NL** | Analysis, frameworks, process improvements | Research, synthesis, documentation | Stakeholder approval | Domain-specific (via ≥3 pattern) |

### Architecture Design

**✅ CORRECT:**
- Universal workflow (Plan → Wish → Forge → Review) across all templates
- Domain neurons created dynamically (≥3 pattern recognition threshold)
- Evidence criteria adapted to domain
- Workflow orchestration + specialized neurons

**❌ WRONG:**
- Treating wishes as code-only concept
- Pattern recognition WITHOUT structured execution
- Missing workflow agents in non-code templates

### Template Requirements

**All templates MUST include:**
- `.genie/agents/workflows/plan.md` (domain-adapted)
- `.genie/agents/workflows/wish.md` (domain-adapted)
- `.genie/agents/workflows/forge.md` (domain-adapted)
- `.genie/agents/workflows/review.md` (domain-adapted)

**Domain neurons created dynamically:**
- Via pattern recognition (≥3 occurrences)
- Stored in `.genie/agents/domain/` (create/NL) or `.genie/agents/neurons/` (code)
- Invoked through forge execution groups

**See @AGENTS.md §Universal Workflow Architecture for detailed examples and validation.**

---

## Strategic Thinking Consultation

When Genie needs to think critically or analyze deeply, it consults the orchestrator neuron with the appropriate reasoning mode:

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

**See `.genie/agents/orchestrator.md` for all 18 thinking modes and usage patterns**

---

## Cognitive Architecture Summary

| Layer | Components | Description | User Experience |
|-------|-----------|-------------|-----------------|
| **Genie** | Main interface | Persistent conversational mentor | "You just talk to me" |
| **Strategic Thinking** | 18 modes via orchestrator neuron | challenge, explore, consensus, plan, analyze, debug, audit, refactor, docgen, tracer, precommit, compliance, retrospective | "Let me pressure-test this..." (invisible) |
| **Execution Specialists** | 7 direct neurons | implementor, tests, polish, review, git, release, roadmap | "Let me work with my implementor neuron..." (collaborative) |
| **Workflow** | plan, wish, forge, review | Structure work flow | Invisible orchestration |
| **Autonomous** | vibe, learn | Background coordination & learning | Invisible support |

---

## Maintenance Notes

- **Single source of truth:** All agent definitions live in `.genie/agents/`
- **Routing logic:** `.genie/custom/routing.md` guides Genie's delegation decisions
- **No wrappers needed:** Genie routes directly via MCP based on conversation context
- **No duplication:** All agent logic maintained in one place
- **Easy extension:** Add new agent to `.genie/agents/`, update routing.md triggers if needed
- **Natural interface:** User just talks, no commands to maintain
