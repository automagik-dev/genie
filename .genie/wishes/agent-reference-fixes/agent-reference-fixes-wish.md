# 🧞 Agent Reference Fixes WISH
**Status:** APPROVED
**Roadmap Item:** Phase 1 – @.genie/product/roadmap.md §Instrumentation & Telemetry
**Mission Link:** @.genie/product/mission.md
**Standards:** @.genie/standards/best-practices.md
**Completion Score:** 0/100

## Evaluation Matrix (100 Points Total)

### Discovery Phase (30 pts)
- **Context Completeness (10 pts)**
  - [ ] All broken references identified with evidence (4 pts)
  - [ ] Current vs target state documented (3 pts)
  - [ ] Decisions captured (secaudit, thinkdeep, explore) (3 pts)
- **Scope Clarity (10 pts)**
  - [ ] Clear current state (5 broken refs) (3 pts)
  - [ ] Target state defined (all refs resolve) (4 pts)
  - [ ] Out-of-scope explicitly stated (3 pts)
- **Evidence Planning (10 pts)**
  - [ ] Validation commands specified (4 pts)
  - [ ] Test plan for all 5 fixes (3 pts)
  - [ ] Rollback strategy documented (3 pts)

### Implementation Phase (40 pts)
- **Code Quality (15 pts)**
  - [ ] Minimal changes (wrapper fixes only) (5 pts)
  - [ ] Follows naming conventions (5 pts)
  - [ ] No logic changes (5 pts)
- **Test Coverage (10 pts)**
  - [ ] All 5 refs resolve after fix (5 pts)
  - [ ] Smoke test passes (5 pts)
- **Documentation (5 pts)**
  - [ ] .claude/README.md updated (3 pts)
  - [ ] AGENTS.md updated (2 pts)
- **Execution Alignment (10 pts)**
  - [ ] Stayed in current branch (4 pts)
  - [ ] No scope creep (3 pts)
  - [ ] Evidence captured (3 pts)

### Verification Phase (30 pts)
- **Validation Completeness (15 pts)**
  - [ ] All wrapper files load without errors (6 pts)
  - [ ] MCP agent list shows all agents (5 pts)
  - [ ] No broken @ references (4 pts)
- **Evidence Quality (10 pts)**
  - [ ] Before/after file tree captured (4 pts)
  - [ ] Test output logged (3 pts)
  - [ ] Git diff reviewed (3 pts)
- **Review Thoroughness (5 pts)**
  - [ ] Human approval obtained (2 pts)
  - [ ] Status log updated (2 pts)
  - [ ] Done report filed (1 pt)

## Context Ledger
| Source | Type | Summary | Routed To |
| --- | --- | --- | --- |
| Analysis output | investigation | 5 broken refs found | entire wish |
| @.genie/agents/core/ | repo | Current agent structure | implementation |
| @.claude/agents/ | repo | Wrapper files | implementation |
| @.genie/product/roadmap.md | roadmap | Phase 1 alignment | discovery |

## Discovery Summary
- **Primary analyst:** Claude (Sonnet 4.5)
- **Key observations:**
  - 4 broken wrapper references: analyze, refactor, secaudit, thinkdeep
  - 1 missing wrapper: explore
  - analyze.md and refactor.md exist in core/ but wrappers point to modes/
  - secaudit and thinkdeep don't exist anywhere
  - explore.md exists in modes/ but has no wrapper

**Decisions (DEC-#):**
- DEC-1: Move analyze and refactor TO modes/ (wrappers already expect them there)
- DEC-2: Create secaudit.md mode as thin wrapper to audit.md security mode
- DEC-3: Remove thinkdeep wrapper (unimplemented, not in roadmap)
- DEC-4: Create explore wrapper (mode exists, should be delegatable)

**Risks:**
- Breaking existing scripts that rely on agent names
- Confusion about which agents are available
- Users trying to invoke missing agents

## Executive Summary
Fix 5 broken agent wrapper references in `.claude/agents/` to restore full agent functionality. Minimal scope: update wrapper paths to match actual file locations, create missing wrappers for valid agents, document decisions for deprecated agents.

## Current State
- **Misplaced agents (2):**
  - `.genie/agents/core/analyze.md` (should be in `modes/`)
  - `.genie/agents/core/refactor.md` (should be in `modes/`)
  - Wrappers already point to correct paths, files are just in wrong location

- **Missing mode files (1):**
  - `.genie/agents/core/modes/secaudit.md` (wrapper exists, target missing)

- **Invalid wrapper (1):**
  - `.claude/agents/thinkdeep.md` (references non-existent agent, needs removal)

- **Missing wrapper (1):**
  - `.claude/agents/explore.md` (target exists, wrapper missing)

- **Pain points:**
  - Task tool can't delegate to broken agents
  - MCP genie tools may fail for these agents
  - Documentation lists agents that don't work

## Target State & Guardrails
- **Desired behaviour:**
  - All 23 wrappers in `.claude/agents/` resolve to valid files
  - No broken `@` references
  - Clear documentation of agent inventory

- **Non-negotiables:**
  - Stay in current branch (`wish/core-template-separation`)
  - No logic changes to agent prompts
  - Minimal file changes (wrappers only)
  - All changes reversible

## Execution Groups

### Group A – Move Agents to Modes
- **Goal:** Relocate analyze and refactor to modes/ directory
- **Surfaces:**
  - `@.genie/agents/core/analyze.md`
  - `@.genie/agents/core/refactor.md`
- **Deliverables:**
  - Move analyze.md: `core/analyze.md` → `core/modes/analyze.md`
  - Move refactor.md: `core/refactor.md` → `core/modes/refactor.md`
  - Verify wrappers now resolve correctly
- **Evidence:** Store before/after file tree + git mv output in `qa/group-a/`
- **Suggested personas:** implementor
- **External tracker:** N/A

### Group B – Create Missing Files
- **Goal:** Create secaudit mode and explore wrapper
- **Surfaces:**
  - `@.genie/agents/core/modes/secaudit.md`
  - `@.claude/agents/explore.md`
- **Deliverables:**
  - Create secaudit.md as thin wrapper pointing to audit.md with security focus
  - Create explore.md wrapper pointing to `@.genie/agents/core/modes/explore.md`
- **Evidence:** File creation logged in `qa/group-b/`
- **Suggested personas:** implementor
- **External tracker:** N/A

### Group C – Remove Invalid Wrapper
- **Goal:** Clean up thinkdeep wrapper (agent not implemented)
- **Surfaces:** `@.claude/agents/thinkdeep.md`
- **Deliverables:**
  - Remove `.claude/agents/thinkdeep.md`
  - Document removal in AGENTS.md (agent deprecated/not implemented)
- **Evidence:** Deletion logged in `qa/group-c/`
- **Suggested personas:** implementor
- **External tracker:** N/A

### Group D – Update Documentation
- **Goal:** Sync docs with structural changes
- **Surfaces:**
  - `@.claude/README.md`
  - `@AGENTS.md`
- **Deliverables:**
  - Update agent inventory (22 total, -1 thinkdeep)
  - Update mode list (now 7 modes: analyze, refactor, secaudit, challenge, consensus, explore, docgen, tracer)
  - Document modes vs full agents distinction
- **Evidence:** Doc diffs in `qa/group-d/`
- **Suggested personas:** docgen
- **External tracker:** N/A

## Verification Plan
- **Validation commands:**
  ```bash
  # Verify no broken references
  for f in .claude/agents/*.md; do
    ref=$(grep "^@.genie/agents/" "$f" 2>/dev/null)
    if [ -n "$ref" ]; then
      target=${ref#@}
      if [ ! -f "$target" ]; then
        echo "BROKEN: $(basename $f) -> $ref"
      fi
    fi
  done

  # Test MCP agent listing
  # (requires MCP server running)

  # Run smoke tests
  pnpm run test:genie
  ```

- **Evidence storage:**
  - `qa/` folder for each group
  - `reports/` for Done Reports
  - Before/after file listings

- **Branch strategy:** Stay in `wish/core-template-separation`

### Evidence Checklist
- **Validation commands (exact):**
  - Broken ref check script (shown above)
  - `pnpm run test:genie` for smoke tests
  - Manual test: attempt to invoke each fixed agent

- **Artefact paths:**
  - `qa/group-a/` - wrapper fixes diffs
  - `qa/group-b/` - explore wrapper creation
  - `qa/group-c/` - documentation updates
  - `reports/` - Done Reports from each agent

- **Approval checkpoints:**
  - Human review of decisions (secaudit, thinkdeep, explore)
  - Review git diff before committing
  - Confirm smoke tests pass

## <spec_contract>
- **Scope:**
  - Move analyze.md and refactor.md to modes/ directory
  - Create secaudit.md mode (wrapper to audit.md)
  - Create explore.md wrapper in .claude/agents/
  - Remove thinkdeep.md wrapper (unimplemented agent)
  - Update documentation to match new structure

- **Out of scope:**
  - Changes to agent prompt logic
  - Creating new agent functionality
  - Refactoring agent architecture
  - Moving other agents to modes/

- **Success metrics:**
  - 0 broken references in `.claude/agents/`
  - All 22 valid wrappers resolve to existing files
  - Mode count updated: 7 modes (was 5)
  - `pnpm run test:genie` passes
  - Documentation matches reality

- **External tasks:** None

- **Dependencies:** None (all decisions made)
</spec_contract>

## Blocker Protocol
1. Pause work and create `reports/blocker-agent-fixes-<timestamp>.md` describing findings.
2. Notify owner and wait for updated instructions.
3. Resume only after wish status/log is updated.

## Status Log
- [2025-10-07 14:30Z] Wish created
- [2025-10-07 14:45Z] Decisions approved: move to modes/, create secaudit mode, remove thinkdeep, add explore wrapper
- [2025-10-07 14:45Z] Status: APPROVED - ready for forge
