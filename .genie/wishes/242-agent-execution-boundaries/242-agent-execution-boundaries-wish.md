# 🧞 Agent Execution Boundaries Clarification WISH
**Status:** DRAFT
**GitHub Issue:** #242
**Roadmap Item:** ARCH-001 – @.genie/product/roadmap.md §Architecture
**Mission Link:** @.genie/product/mission.md §Core Principles
**Completion Score:** 0/100 (updated by `/review`)

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [x] All relevant files/docs referenced with @ notation (4 pts)
  - [ ] Background persona outputs captured in context ledger (3 pts)
  - [x] Assumptions (ASM-#), decisions (DEC-#), risks documented (3 pts)
- **Scope Clarity (10 pts)**
  - [x] Clear current state and target state defined (3 pts)
  - [ ] Spec contract complete with success metrics (4 pts)
  - [x] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Validation commands specified with exact syntax (4 pts)
  - [ ] Artifact storage paths defined (3 pts)
  - [ ] Approval checkpoints documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Follows project standards (@.genie/standards/*) (5 pts)
  - [ ] Minimal surface area changes, focused scope (5 pts)
  - [ ] Clean abstractions and patterns (5 pts)
- **Test Coverage (10 pts)**
  - [ ] Unit tests for new behavior (4 pts)
  - [ ] Integration tests for workflows (4 pts)
  - [ ] Evidence of test execution captured (2 pts)
- **Documentation (5 pts)**
  - [ ] Inline comments where complexity exists (2 pts)
  - [ ] Updated relevant external docs (2 pts)
  - [ ] Context preserved for maintainers (1 pt)
- **Execution Alignment (10 pts)**
  - [ ] Stayed within spec contract scope (4 pts)
  - [ ] No unapproved scope creep (3 pts)
  - [ ] Dependencies and sequencing honored (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] All validation commands executed successfully (6 pts)
  - [ ] Artifacts captured at specified paths (5 pts)
  - [ ] Edge cases and error paths tested (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Command outputs (failures → fixes) logged (4 pts)
  - [ ] Screenshots/metrics captured where applicable (3 pts)
  - [ ] Before/after comparisons provided (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval obtained at checkpoints (2 pts)
  - [ ] All blockers resolved or documented (2 pts)
  - [ ] Status log updated with completion timestamp (1 pt)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| User teaching session | conversation | Dual execution path confusion identified | wish discovery |
| @AGENTS.md | repo | Amendment #1: "Forge is PRIMARY entry point" | spec contract |
| @.genie/spells/forge-integration.md | repo | Part 1: Forge as main entry point principle | spec contract |
| @.genie/code/spells/genie-integration.md | repo | Current Genie MCP agent patterns | analysis |
| GitHub Issue #242 | tracker | Architectural questions to answer | wish goals |

## Discovery Summary
- **Primary analyst:** Base Genie (learning session with Felipe)
- **Key observations:**
  - Two parallel execution paths exist: `mcp__genie__run` (direct agents) vs Forge tasks
  - AGENTS.md Amendment #1 states "Forge is PRIMARY entry point for ALL work"
  - forge-integration.md reinforces this principle
  - Yet 6 active Genie MCP sessions currently running (no Forge integration)
  - User pointed out conceptual confusion: "starting an agent in genie (that uses forge)" vs "creating a task that uses an agent"
- **Assumptions (ASM-#):**
  - ASM-1: Direct Genie MCP sessions were intended for advisory/analysis work
  - ASM-2: Forge tasks were intended for implementation work requiring git workflow
  - ASM-3: These systems should coexist with clear boundaries (not unified)
- **Open questions (Q-#):**
  - Q-1: Should all agent work flow through Forge, or are there legitimate direct invocation cases?
  - Q-2: How should `.genie/.session` track both systems (if both should exist)?
  - Q-3: What's the routing decision matrix: when Genie MCP vs when Forge task?
  - Q-4: Are current 6 active Genie MCP sessions violating architecture?
- **Risks:**
  - Confusion leads to inconsistent orchestration patterns
  - State tracking fragmented across two systems
  - "Live project state" unclear when mixing both approaches

## Executive Summary
Define clear architectural boundaries between Genie MCP sessions (direct agent invocation) and Forge task execution (worktree + git workflow). Document routing decision matrix, update framework amendments, and align all orchestration patterns with single source of truth.

## Current State
- **What exists today:**
  - `@AGENTS.md` - Base Genie orchestration framework with Amendment #1 (Forge is primary)
  - `@.genie/spells/forge-integration.md` - Forge as main entry point documentation
  - `@.genie/code/spells/genie-integration.md` - Genie MCP agent usage patterns
  - `mcp__genie__run` - Direct agent invocation (creates sessions in background)
  - `mcp__automagik_forge__create_task` + `start_task_attempt` - Forge task creation (worktree + branch)
  - 6 active Genie MCP sessions running currently
  - No `.genie/.session` file (per Amendment #5: ephemeral state, gitignored)
- **Gaps/Pain points:**
  - No clear routing rules: when to use Genie MCP vs Forge tasks
  - Dual state tracking: `.genie/sessions/` vs `/var/tmp/automagik-forge/worktrees/`
  - Amendment #1 says "Forge is PRIMARY" but Genie MCP sessions bypass Forge entirely
  - "Live project state" concept unclear when both systems coexist

## Target State & Guardrails
- **Desired behaviour:**
  - Crystal clear routing decision: when Base Genie uses `mcp__genie__run` vs `mcp__automagik_forge__create_task`
  - Updated Amendment (or new Amendment #8) documenting execution path boundaries
  - Routing decision matrix in `@.genie/spells/routing-decision-matrix.md` updated
  - Live state tracking strategy that accounts for both systems (if both exist) or explains deprecation
  - All 41 agents categorized: which must use Forge, which can use direct invocation
- **Non-negotiables:**
  - Must align with Amendment #1 principle (Forge is primary for implementation work)
  - Must not break existing 6 active Genie MCP sessions
  - Must preserve token efficiency (Amendment #6, #7)
  - Must maintain orchestration boundary (Amendment #4)

## Execution Groups
### Group A – Architecture Analysis
- **Goal:** Analyze all 41 agents and categorize execution requirements
- **Surfaces:** `@.genie/code/spells/genie-integration.md`, `@.genie/spells/routing-decision-matrix.md`
- **Deliverables:**
  - Agent categorization matrix (Forge-required vs MCP-allowed)
  - Routing decision rules (implementation work vs advisory work)
  - State tracking strategy (unified or parallel)
- **Evidence:** Store in wish `qa/group-a/agent-categorization.md`
- **Suggested personas:** `reasoning/analyze`, `challenge`
- **External tracker:** GitHub #242

### Group B – Framework Documentation
- **Goal:** Document architectural decision and update framework
- **Surfaces:** `@AGENTS.md`, `@.genie/spells/routing-decision-matrix.md`, `@.genie/spells/forge-integration.md`
- **Deliverables:**
  - New Amendment #8 (or update Amendment #1) with execution boundaries
  - Updated routing-decision-matrix.md with MCP vs Forge rules
  - Updated genie-integration.md with clear guidance
- **Evidence:** Store in wish `qa/group-b/framework-updates.md`
- **Suggested personas:** `implementor`, `polish`
- **External tracker:** GitHub #242

### Group C – Validation
- **Goal:** Verify all orchestration patterns align with new boundaries
- **Surfaces:** All `.genie/code/agents/*.md`, all `.genie/spells/*.md`
- **Deliverables:**
  - Audit of existing agent invocations in framework
  - Compliance report: which patterns need updating
  - Updated examples in documentation
- **Evidence:** Store in wish `qa/group-c/validation-report.md`
- **Suggested personas:** `qa`, `review`
- **External tracker:** GitHub #242

## Verification Plan
- **Validation steps:**
  1. Run `mcp__genie__list_agents` and categorize all 41 agents
  2. Check all framework files for agent invocation examples
  3. Verify routing-decision-matrix.md has clear MCP vs Forge rules
  4. Test both execution paths with sample agents
  5. Confirm 6 active sessions align with new boundaries (or document exceptions)
- **Evidence storage:** Use wish `qa/` subfolders for each group
- **Branch strategy:** Dedicated feature branch via Forge task

### Evidence Checklist
- **Validation commands (exact):**
  - `mcp__genie__list_agents` - Get all 41 agents
  - `mcp__genie__list_sessions` - Check current sessions
  - `grep -r "mcp__genie__run" .genie/` - Find all direct invocations in framework
  - `grep -r "mcp__automagik_forge__create_task" .genie/` - Find all Forge invocations
- **Artefact paths (where evidence lives):**
  - `.genie/wishes/242-agent-execution-boundaries/qa/group-a/`
  - `.genie/wishes/242-agent-execution-boundaries/qa/group-b/`
  - `.genie/wishes/242-agent-execution-boundaries/qa/group-c/`
  - `.genie/wishes/242-agent-execution-boundaries/reports/`
- **Approval checkpoints (human sign-off required):**
  - After Group A analysis: Human reviews routing decision rules
  - After Group B documentation: Human reviews Amendment #8 wording
  - After Group C validation: Human approves final framework state

## <spec_contract>
- **Scope:**
  - Analyze 41 agents and categorize execution requirements (Forge-required vs MCP-allowed)
  - Define routing decision matrix: when to use Genie MCP vs Forge tasks
  - Document execution boundaries in new Amendment #8 (or update Amendment #1)
  - Update routing-decision-matrix.md with clear rules
  - Update genie-integration.md with execution guidance
  - Validate all framework agent invocations align with new boundaries
- **Out of scope:**
  - Changing Forge MCP implementation
  - Changing Genie MCP implementation
  - Migrating existing 6 sessions (validate they align, don't break them)
  - Modifying agent frontmatter execution configuration
- **Success metrics:**
  - ✅ All 41 agents categorized with execution requirements
  - ✅ Routing decision matrix has explicit MCP vs Forge rules
  - ✅ New Amendment #8 (or updated Amendment #1) committed
  - ✅ Zero framework files contain ambiguous agent invocation examples
  - ✅ 6 active sessions validated as compliant (or documented as exceptions)
- **External tasks:** GitHub Issue #242
- **Dependencies:**
  - Genie MCP must remain functional (don't break existing sessions)
  - Forge MCP must remain functional (don't break task creation)
  - All framework amendments must maintain consistency
</spec_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-242-<timestamp>.md` inside the wish folder describing findings.
2. Notify owner (Felipe) and wait for updated instructions.
3. Resume only after the wish status/log is updated.

## Status Log
- [2025-10-23 23:50Z] Wish created by Base Genie during learning session
- [2025-10-23 23:48Z] GitHub Issue #242 created
- [2025-10-23 23:45Z] User pointed out dual execution path confusion
