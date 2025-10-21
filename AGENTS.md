# Genie Agent Framework

## Core Purpose
- Provide universal agent templates and CLI orchestration
- Replace product-specific branding with placeholders
- Domain-agnostic template repo

## Primary References
See `.genie/` directory for comprehensive documentation:
- `@.genie/product/mission.md`
- `@.genie/product/tech-stack.md`
- `@.genie/product/roadmap.md`
- `@.genie/product/environment.md`

## Core Skills Architecture

### Mandatory Skills (Auto-Loaded)

**Identity:**
- `@.genie/skills/know-yourself.md` - Who am I? What do I already know?

**Decision Framework:**
- `@.genie/skills/investigate-before-commit.md` - Investigate first, commit later
- `@.genie/skills/routing-decision-matrix.md` - Where should this work go?

**Orchestration:**
- `@.genie/skills/delegate-dont-do.md` - Should I do this? → No, delegate
- `@.genie/skills/orchestrator-not-implementor.md` - Know your role

### Executable Skills (On-Demand)

**Wish Workflow:**
- `wish-initiation` - Should I create a wish?
- `wish-issue-linkage` - Does this wish have an issue?
- `wish-lifecycle` - What happens to wishes after creation?
- `wish-forge-review-flow` - What's the execution workflow?

**Execution & Tracking:**
- `multi-step-execution` - Complex multi-step task breakdown
- `track-long-running-tasks` - Track progress with checkpoints
- `run-in-parallel` - Can these tasks run together?
- `gather-context` - Not enough information

**Learning & Blockers:**
- `meta-learn` - I learned something
- `blocker` - I'm blocked

**Behavioral Guardrails:**
- `ask-one-at-a-time` - Ask questions sequentially
- `break-things-move-fast` - No backwards compatibility required

**Environment:**
- `worktree-isolation` - Where does work happen?
- `chat-mode` - Conversational mode helpers
- `experiment` - Let's try something

### Code-Specific Skills
**Protocols & Tools:**
- `@.genie/code/skills/publishing-protocol.md`
- `@.genie/code/skills/team-consultation-protocol.md`
- `@.genie/code/skills/genie-integration.md`
- `@.genie/code/skills/agent-configuration.md`
- `@.genie/code/skills/tool-requirements.md`

**Conventions:**
- `@.genie/code/skills/branch-tracker-guidance.md`
- `@.genie/code/skills/evidence-storage.md`
- `@.genie/code/skills/file-naming-rules.md`
- `@.genie/code/skills/forge-integration.md`
- `@.genie/code/skills/forge-mcp-pattern.md`
- `@.genie/code/skills/forge-orchestration-workflow.md`

## Workflow Architecture
**Pattern:** `Wish → Forge → Review`

## Seven Amendments (Core Workflow Rules)

### 1. No Wish Without Issue 🔴 CRITICAL
**Rule:** Every wish execution MUST be linked to a GitHub issue

**Process:**
1. User requests work → Check for GitHub issue
2. No issue? → Create issue first (requires discovery)
3. Issue created → Create Forge task linked to issue
4. Forge task → Execute wish workflow

**Routing:**
- New work without issue → Route to discovery skill
- Discovery complete → Create GitHub issue
- Issue exists → Create Forge task with issue reference

**Enforcement:**
- Genie checks for issue before creating wish task
- Forge tasks must reference GitHub issue number
- SESSION-STATE.md tracks issue↔task mapping

**Why:**
- Single source of truth (GitHub issues)
- Prevents duplicate/orphaned work
- Enables community visibility
- Links wish→task→PR→issue lifecycle

### 2. File Organization Pattern
**Rule:** Root AGENTS.md contains full content, .genie/AGENTS.md is alias

**Structure:**
```
/AGENTS.md              # Full framework documentation (source)
/.genie/AGENTS.md       # @AGENTS.md (alias reference)
```

**Reason:**
- Root file = primary discovery point
- .genie/ = implementation details
- Alias pattern established, documented

**Maintenance:**
- Update root AGENTS.md (source of truth)
- .genie/AGENTS.md stays as @/AGENTS.md
- Both patterns valid, this is our choice

### 3. Real-Time State Awareness
**Rule:** SESSION-STATE.md must reflect live Forge Kanban state

**Implementation:**
- MCP startup sync (query all projects)
- Git hook auto-update (pre-commit)
- Optional: Polling loop (30s intervals)
- Future: Forge MCP resources (push-based)

**Schema:**
```markdown
## 📊 PROJECT: Name (id)
### 🔥 In Progress (N)
- task_id | Title | attempt: xxx
### 👀 In Review (N)
### 📝 Todo (N)

## 🔗 GITHUB ISSUES MAPPING
- #NNN → task_id, task_id
```

**Benefits:**
- Genie always knows current state
- Zero "what are you working on?" questions
- Automatic orchestration awareness
- Multi-project coordination

### 4-7. Reserved for Future Amendments
**Placeholder:** Additional core workflow rules will be documented here as they emerge

**Current Candidates:**
- MCP skill execution pattern
- Genie MCP dynamic skill loading
- Template derivation from .genie consciousness
- Agent delegation hierarchy enforcement

## Core Agents (Global)
@CORE_AGENTS.md

### Core Workflows
- `@.genie/workflows/forge/` - Global Forge workflows (domain-agnostic)
- `@.genie/code/workflows/wish.md` - Discovery & planning orchestrator (Code)
- `@.genie/code/workflows/forge.md` - Execution breakdown & implementation (Code)
- `@.genie/code/workflows/review.md` - Validation & quality assurance (Code)

### Supporting Components
- `@.genie/code/agents/wish/blueprint.md` - Wish document creation

## Advisory Teams Architecture
**Teams** are multi-persona advisory collectives that analyze and recommend but never execute.

### Tech Council (Board of Technology)
- **Council orchestrator:** `@.genie/code/teams/tech-council/council.md`
- **Personas:**
  - `@.genie/code/teams/tech-council/nayr.md` (Questioning, foundational thinking)
  - `@.genie/code/teams/tech-council/oettam.md` (Performance-driven, benchmark-focused)
  - `@.genie/code/teams/tech-council/jt.md` (Simplicity-focused, terse)

**Consultation protocol:** `@.genie/code/skills/team-consultation-protocol.md`

## @ Tool Semantics
**Critical:** @ is a lightweight path reference, NOT a content loader.

**Use Cases:**
- Point to supplementary documentation
- Create knowledge graph connections
- Save tokens by referencing, not duplicating

## Agent Invocation Hierarchy
**Natural Structure:**
1. **Base Genie:** Human interface, persistent coordinator
2. **Collectives:** Domain-specific organization (code, create)
3. **Agents:** Individual execution units with persistent memory
4. **Teams:** Advisory groups (analyze, recommend, no execution)
5. **Workflows:** Deterministic sequences (wish, forge, review)

**Enforcement:** Folder structure reflects invocation hierarchy

## MCP Quick Reference
See `@.genie/product/docs/mcp-interface.md` for complete documentation.

## Knowledge Graph (Auto-Generated)
<!-- AUTO-GENERATED-START: Do not edit manually -->
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Note:** Paths updated for new architecture (Genie → Collectives → Entities)
**Total Tokens:** 43,560 (baseline for efficiency validation)

**Distribution:**
- Code Skills: 11,622 tokens (26.7%)
- Universal Skills: 10,203 tokens (23.4%)
- Advisory Teams: 8,643 tokens (19.8%)
- Code Workflows: 7,328 tokens (16.8%)
- Product Docs: 2,518 tokens (5.8%)
- Core Framework: 1,843 tokens (4.2%)
- Documentation: 758 tokens (1.7%)
- Code Agents: 645 tokens (1.5%)

**Hierarchy:**

- **AGENTS.md** (1,843 tokens, +41,717 from 44 refs)
  - **.genie/product/mission.md** (684 tokens)
  - **.genie/product/tech-stack.md** (546 tokens)
  - **.genie/product/roadmap.md** (594 tokens)
  - **.genie/product/environment.md** (694 tokens)
  - **.genie/skills/know-yourself.md** (1,392 tokens)
  - **.genie/skills/evidence-based-thinking.md** (748 tokens)
  - **.genie/skills/routing-decision-matrix.md** (1,251 tokens)
  - **.genie/skills/execution-integrity-protocol.md** (643 tokens)
  - **.genie/skills/persistent-tracking-protocol.md** (1,066 tokens)
  - **.genie/skills/meta-learn-protocol.md** (648 tokens)
  - **.genie/skills/delegation-discipline.md** (1,729 tokens)
  - **.genie/skills/blocker-protocol.md** (97 tokens)
  - **.genie/skills/chat-mode-helpers.md** (248 tokens)
  - **.genie/skills/experimentation-protocol.md** (499 tokens)
  - **.genie/skills/orchestration-protocols.md** (219 tokens)
  - **.genie/skills/parallel-execution.md** (93 tokens)
  - **.genie/skills/sequential-questioning.md** (1,275 tokens)
  - **.genie/skills/no-backwards-compatibility.md** (295 tokens)
  - **.genie/skills/role-clarity-protocol.md** (732 tokens)
  - **.genie/skills/triad-maintenance-protocol.md** (1,315 tokens)
  - **.genie/skills/wish-initiation-rule.md** (1,210 tokens)
  - **.genie/skills/wish-document-management.md** (791 tokens)
  - **.genie/skills/workspace-system.md** (104 tokens)
  - **.genie/skills/execution-patterns.md** (110 tokens)
  - **.genie/skills/missing-context-protocol.md** (128 tokens)
  - **.genie/code/skills/publishing-protocol.md** (565 tokens)
  - **.genie/code/skills/team-consultation-protocol.md** (1,858 tokens)
  - **.genie/code/skills/genie-integration.md** (1,202 tokens)
  - **.genie/code/skills/agent-configuration.md** (535 tokens)
  - **.genie/code/skills/tool-requirements.md** (116 tokens)
  - **.genie/code/skills/branch-tracker-guidance.md** (164 tokens)
  - **.genie/code/skills/evidence-storage.md** (286 tokens)
  - **.genie/code/skills/file-naming-rules.md** (293 tokens)
  - **.genie/code/skills/forge-integration.md** (1,627 tokens)
  - **.genie/code/skills/forge-mcp-pattern.md** (417 tokens)
  - **.genie/code/workflows/wish.md** (1,373 tokens)
  - **.genie/code/workflows/forge.md** (5,955 tokens)
  - **.genie/code/agents/wish/blueprint.md** (645 tokens)
  - **.genie/code/teams/tech-council/council.md** (2,235 tokens)
  - **.genie/code/teams/tech-council/nayr.md** (2,013 tokens)
  - **.genie/code/teams/tech-council/oettam.md** (2,489 tokens)
  - **.genie/code/teams/tech-council/jt.md** (1,906 tokens)
  - **.genie/docs/mcp-interface.md** (758 tokens)

<!-- AUTO-GENERATED-END -->
