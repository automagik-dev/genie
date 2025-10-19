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

### Universal Skills (Auto-loaded)
**Tier 1 (Identity):**
- `@.genie/skills/know-yourself.md`

**Tier 2 (Decision Framework):**
- `@.genie/skills/evidence-based-thinking.md`
- `@.genie/skills/routing-decision-matrix.md`

**Tier 3 (System Coordination):**
- `@.genie/skills/execution-integrity-protocol.md`
- `@.genie/skills/persistent-tracking-protocol.md`
- `@.genie/skills/meta-learn-protocol.md`

**Tier 4 (Discovery & Tools):**
- `@.genie/skills/delegation-discipline.md`
- `@.genie/skills/blocker-protocol.md`
- `@.genie/skills/chat-mode-helpers.md`
- `@.genie/skills/experimentation-protocol.md`
- `@.genie/skills/orchestration-protocols.md`
- `@.genie/skills/parallel-execution.md`

**Tier 5 (Guardrails):**
- `@.genie/skills/sequential-questioning.md`
- `@.genie/skills/no-backwards-compatibility.md`

### Code-Specific Skills
**Protocols & Tools:**
- `@.genie/code/skills/publishing-protocol.md`
- `@.genie/code/skills/role-clarity-protocol.md`
- `@.genie/code/skills/triad-maintenance-protocol.md`
- `@.genie/code/skills/team-consultation-protocol.md`
- `@.genie/code/skills/genie-integration.md`
- `@.genie/code/skills/agent-configuration.md`
- `@.genie/code/skills/tool-requirements.md`
- `@.genie/code/skills/wish-initiation-rule.md`

**Conventions:**
- `@.genie/code/skills/branch-tracker-guidance.md`
- `@.genie/code/skills/evidence-storage.md`
- `@.genie/code/skills/prompting-standards.md`
- `@.genie/code/skills/workspace-system.md`
- `@.genie/code/skills/file-naming-rules.md`
- `@.genie/code/skills/execution-patterns.md`
- `@.genie/code/skills/wish-document-management.md`
- `@.genie/code/skills/forge-integration.md`
- `@.genie/code/skills/forge-mcp-pattern.md`
- `@.genie/code/skills/missing-context-protocol.md`

## Workflow Architecture
**Pattern:** `Wish → Forge → Review`

### Core Workflows
- `@.genie/code/workflows/wish.md` - Discovery & planning orchestrator
- `@.genie/code/workflows/forge.md` - Execution breakdown & implementation
- `@.genie/code/workflows/review.md` - Validation & quality assurance

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

**Consultation protocol:** `@.genie/agents/code/skills/team-consultation-protocol.md`

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
See `@.genie/docs/mcp-interface.md` for complete documentation.

## Knowledge Graph (Auto-Generated)
<!-- AUTO-GENERATED-START: Do not edit manually -->
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Note:** Paths updated for new architecture (Genie → Collectives → Entities)

**Hierarchy:**

- **AGENTS.md** (framework entry point)
  - **.genie/product/mission.md** - Product vision & goals
  - **.genie/product/tech-stack.md** - Technology decisions
  - **.genie/product/roadmap.md** - Feature roadmap
  - **.genie/product/environment.md** - Development environment

**Universal Skills:**
  - **.genie/skills/know-yourself.md** - Identity & capabilities
  - **.genie/skills/evidence-based-thinking.md** - Decision framework
  - **.genie/skills/routing-decision-matrix.md** - Agent routing logic
  - **.genie/skills/execution-integrity-protocol.md** - Execution standards
  - **.genie/skills/persistent-tracking-protocol.md** - State tracking
  - **.genie/skills/meta-learn-protocol.md** - Learning system
  - **.genie/skills/delegation-discipline.md** - Invocation patterns
  - **.genie/skills/blocker-protocol.md** - Blocker handling
  - **.genie/skills/chat-mode-helpers.md** - Interaction patterns
  - **.genie/skills/experimentation-protocol.md** - Experimentation rules
  - **.genie/skills/orchestration-protocols.md** - Orchestration patterns
  - **.genie/skills/parallel-execution.md** - Parallel execution
  - **.genie/skills/sequential-questioning.md** - User interaction
  - **.genie/skills/no-backwards-compatibility.md** - Evolution policy

**Code Collective:**
  - **Skills:**
    - **.genie/code/skills/publishing-protocol.md**
    - **.genie/code/skills/role-clarity-protocol.md**
    - **.genie/code/skills/triad-maintenance-protocol.md**
    - **.genie/code/skills/team-consultation-protocol.md**
    - **.genie/code/skills/genie-integration.md**
    - **.genie/code/skills/agent-configuration.md**
    - **.genie/code/skills/tool-requirements.md**
    - **.genie/code/skills/wish-initiation-rule.md**
    - **.genie/code/skills/forge-integration.md**
    - **.genie/code/skills/forge-mcp-pattern.md**
  - **Workflows:**
    - **.genie/code/workflows/wish.md** - Discovery & planning
    - **.genie/code/workflows/forge.md** - Execution breakdown
    - **.genie/code/workflows/review.md** - Quality validation
  - **Teams:**
    - **.genie/code/teams/tech-council/council.md** - Orchestrator
    - **.genie/code/teams/tech-council/nayr.md** - Foundational thinking
    - **.genie/code/teams/tech-council/oettam.md** - Performance focus
    - **.genie/code/teams/tech-council/jt.md** - Simplicity advocate

**Documentation:**
  - **.genie/docs/mcp-interface.md** - MCP integration guide

<!-- AUTO-GENERATED-END -->
