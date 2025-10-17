# Wish: AGENTS.md Context Optimization

**Created:** 2025-10-17
**Status:** active
**Priority:** CRITICAL

---

## Context Ledger

**Problem:**
- AGENTS.md currently 2272 lines (bloated)
- Target: ≤500 lines
- Must extract knowledge WITHOUT LOSS to neurons/skills
- .genie/custom/ needs absorption into neurons
- Recent folder restructure affects agent paths

**Scope:**
- Extract sections → appropriate neurons/skills
- Replace with @ references (lightweight pointers)
- Absorb .genie/custom/ content into neurons
- Validate final result: ≤500 lines, complete knowledge preservation

**Context dependencies:**
- New folder structure: .genie/agents/genie/neurons/, .genie/agents/genie/skills/
- @ semantics: path reference only (NOT full content load)
- Loading architecture: CLAUDE.md → AGENTS.md → agent.md
- Each neuron = AGENTS.md (base) + specialty (extension)

**Success criteria:**
- ✅ AGENTS.md ≤500 lines
- ✅ Zero knowledge loss (all patterns preserved)
- ✅ @ references replace duplicated content
- ✅ .genie/custom/ absorbed into neurons
- ✅ All validation commands pass

---

## Execution Groups

### Group A: Extract GitHub Workflow Patterns
**Target:** `.genie/agents/genie/neurons/git/git.md`
**Lines to extract:** 41-179 (Developer Welcome Flow, GitHub integration)
**Replace with:** `@.genie/agents/code/neurons/git/git.md` (GitHub workflow reference)

**Sections:**
- Developer Welcome Flow (41-72)
- Quick Capture Workflow (74-94)
- Git & GitHub Workflow Integration (96-179)

### Group B: Extract Prompting Standards
**Target:** `.genie/agents/genie/neurons/prompt/prompt.md`
**Lines to extract:** 1001-1115, 1769-1882 (@ / ! / patterns, Task Breakdown Structure)
**Replace with:** `@.genie/agents/neurons/prompt.md` (prompting framework reference)

**Sections:**
- @ / ! / Feature Reference (1008-1115)
- Task Breakdown Structure (1775-1801)
- Context Gathering Protocol (1803-1828)
- Blocker Report Protocol (1831-1846)
- Done Report Template (1848-1882)

### Group C: Extract Forge Patterns
**Target:** `.genie/agents/genie/neurons/forge/forge.md`
**Lines to extract:** 1209-1258 (Forge MCP Task Pattern)
**Replace with:** `@.genie/agents/neurons/forge.md` (forge patterns reference)

**Sections:**
- Forge MCP Task Pattern (1209-1258)

### Group D: Extract Learn Patterns
**Target:** `.genie/agents/genie/neurons/learn/learn.md`
**Lines to extract:** 1260-1279 (Meta-Learn & Behavioral Corrections)
**Replace with:** `@.genie/agents/neurons/learn.md` (meta-learning reference)

**Sections:**
- Meta-Learn & Behavioral Corrections (1260-1279)

### Group E: Extract Release Protocol
**Target:** `.genie/agents/genie/neurons/release/release.md`
**Lines to extract:** 1361-1402 (Publishing Protocol)
**Replace with:** `@.genie/agents/code/neurons/release.md` (release protocol reference)

**Sections:**
- Publishing Protocol (1361-1402)

### Group F: Extract Supporting Docs
**Targets:** `.genie/docs/` (create supporting documentation)
**Lines to extract:** 479-569, 571-698, 1633-1767, 1884-1930
**Replace with:** `<file>.md` references

**Files to create:**
- `delegation-enforcement.md` (479-569) - Application-Level Enforcement
- `session-state-protocol.md` (571-698) - Persistent Tracking Protocol
- `triad-protocol.md` (1633-1767) - Triad Maintenance Protocol
- `mcp-interface.md` (1884-1930) - CLI Command Interface

### Group G: Absorb .genie/custom/ Content
**Action:** Merge custom overrides into neurons
**Targets:** All neurons with corresponding .genie/custom/ files
**Method:** Read custom/*.md → append to neuron/*.md → delete custom/*.md

**Custom files:**
- routing.md → stays (orchestrator-only)
- Other overrides → merge into respective neurons

### Group H: Final Validation
**Action:** Verify optimization results
**Validations:**
- Line count: `wc -l AGENTS.md` → must be ≤500
- Knowledge preservation: grep key patterns, all present
- @ references: all valid paths
- Agents load correctly: test with MCP
- Build/tests pass: `pnpm run check`

---

## Spec Contract

**AGENTS.md final structure (≤500 lines):**
```markdown
# Genie Template Overview
## Repository Self-Awareness
## No Backwards Compatibility
## Experimentation Protocol
## Unified Agent Stack
## Directory Map
## Architectural Foundations
  ### Genie Loading Architecture (stays - critical)
  ### Neuron Delegation Hierarchy (stays - critical)
## Natural Flow Protocol (condensed)
## Universal Workflow Architecture (condensed)

# Core references (@ pointers):
@.genie/agents/code/neurons/git/git.md (GitHub patterns)
@.genie/agents/neurons/prompt.md (prompting standards)
@.genie/agents/neurons/forge.md (forge patterns)
@.genie/agents/neurons/learn.md (meta-learning)
@.genie/agents/code/neurons/release.md (release protocol)
# Critical behavioral overrides (stays):
- Delegation Discipline
- Role Clarity Protocol
- Execution Integrity Protocol
- Evidence-Based Thinking

# Agent Playbook (condensed, references neurons)
```

**Knowledge preservation guarantee:**
- All patterns documented in target files
- @ references establish loading relationship
- Grep validation confirms no pattern loss
- Test suite validates agent functionality

---

## Evidence Checklist

**Pre-extraction:**
- [x] AGENTS.md baseline: 2272 lines
- [x] Extraction plan approved
- [ ] Backup created: `cp AGENTS.md AGENTS.md.backup`

**Group A (git patterns):**
- [ ] Sections extracted to git.md
- [ ] @ reference added to AGENTS.md
- [ ] Validation: grep "Developer Welcome" finds git.md
- [ ] Validation: grep "Quick Capture" finds git.md

**Group B (prompt patterns):**
- [ ] Sections extracted to prompt.md
- [ ] @ reference added to AGENTS.md
- [ ] Validation: grep "Task Breakdown Structure" finds prompt.md
- [ ] Validation: grep "@ / ! /" finds prompt.md

**Group C (forge patterns):**
- [ ] Sections extracted to forge.md
- [ ] @ reference added to AGENTS.md
- [ ] Validation: grep "Forge MCP Task Pattern" finds forge.md

**Group D (learn patterns):**
- [ ] Sections extracted to learn.md
- [ ] @ reference added to AGENTS.md
- [ ] Validation: grep "Meta-Learn" finds learn.md

**Group E (release protocol):**
- [ ] Sections extracted to release.md
- [ ] @ reference added to AGENTS.md
- [ ] Validation: grep "Publishing Protocol" finds release.md

**Group F (supporting docs):**
- [ ] delegation-enforcement.md created
- [ ] session-state-protocol.md created
- [ ] triad-protocol.md created
- [ ] mcp-interface.md created
- [ ] @ references added to AGENTS.md

**Group G (custom absorption):**
- [ ] Custom files merged into neurons
- [ ] Custom files removed (except routing.md)
- [ ] Validation: neurons contain custom patterns

**Group H (final validation):**
- [ ] Line count: `wc -l AGENTS.md` ≤500 ✓
- [ ] Pattern check: all key patterns grep successfully
- [ ] @ references: all paths valid
- [ ] MCP test: agents load correctly
- [ ] Build: `pnpm run check` passes
- [ ] Done Report created

---

## Risks & Mitigations

**Risk:** Breaking agent functionality during extraction
**Mitigation:** Test after each group, rollback if failures

**Risk:** Losing behavioral patterns in extraction
**Mitigation:** Comprehensive grep validation after each group

**Risk:** @ reference errors (wrong paths)
**Mitigation:** Validate all paths exist before replacing content

**Risk:** Custom overrides lost during absorption
**Mitigation:** Read custom files completely before deletion

---

## Branch Strategy

**Branch:** `feat/agents-optimization`
**Commits:** One commit per execution group
**PR:** After Group H validation passes

---

## Tracking

**Wish created:** 2025-10-17
**Forge plan:** Next step
**Implementation:** 8 implementor sessions (one per group)
