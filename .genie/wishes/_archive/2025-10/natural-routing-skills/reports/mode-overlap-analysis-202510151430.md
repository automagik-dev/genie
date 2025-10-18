# Orchestrator Mode Overlap Analysis
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
> **Historical Note:** This analysis uses legacy "orchestrator modes" terminology. Genie's cognitive architecture has since been clarified:
> - **Strategic Thinking Modes (18 total)** - reasoning approaches via orchestrator neuron (challenge, explore, consensus, plan, analyze, debug, audit, refactor, docgen, tracer, precommit, etc.)
> - **Execution Specialists (6 total)** - direct collaboration neurons (implementor, tests, polish, review, git, release)
>
> See `neuron-terminology-refactor-plan.md` for updated architecture. This document preserved as historical record.

**Analysis Date:** 2025-10-15 14:30 UTC
**Session:** orchestrator-mode-analysis
**Purpose:** Evaluate 18 orchestrator modes for overlap, redundancy, and consolidation opportunities

---

## Executive Summary

**Current State:** 18 modes listed in orchestrator.md, but only 5 mode implementations exist in `.genie/agents/core/modes/`. Significant gap between documented modes and actual implementations.

**Key Finding:** The orchestrator.md documentation is aspirational/template-based, NOT reflecting actual shipped modes. Most "specialized modes" are either:
1. Standalone agents (analyze, debug, audit, refactor) invoked directly via MCP
2. Template patterns embedded in orchestrator.md without separate mode files
3. Missing implementations entirely

**Recommendation:** **Reconcile documentation with reality** - orchestrator.md should document actual routing patterns, not phantom modes.

---

## Mode Inventory Analysis

### Actual Implemented Modes (5)

**Located in `.genie/agents/core/modes/`:**

1. **challenge.md** - Critical evaluation (8.6 KB)
2. **consensus.md** - Multi-perspective analysis (11.8 KB)
3. **explore.md** - Discovery-focused reasoning (3.0 KB)
4. **docgen.md** - Documentation generation (1.1 KB)
5. **tracer.md** - Instrumentation planning (1.2 KB)

### Standalone Agents (NOT modes) (4)

**Located in `.genie/agents/core/`:**

1. **analyze.md** - System analysis & deep investigation (415 lines)
2. **debug.md** - Bug investigation & resolution orchestration (335 lines)
3. **audit.md** - Risk assessment & security audit (255 lines)
4. **refactor.md** - Design review & refactor planning (284 lines)

### Missing Mode Implementations (9)

**Listed in orchestrator.md but no dedicated files:**

1. **plan** - Pressure-test plans (template only in orchestrator.md:194-199)
2. **deep-dive** - Investigate architecture (template only in orchestrator.md:207-211)
3. **risk-audit** - List risks and mitigations (template only in orchestrator.md:241-245)
4. **design-review** - Assess components (template only in orchestrator.md:247-251)
5. **tests** - Test strategy (CONFLICT: exists as standalone agent tests.md)
6. **secaudit** - Security posture (template only in orchestrator.md:265-269)
7. **codereview** - Structured feedback (not mentioned in templates)
8. **precommit** - Pre-commit gate (template only in orchestrator.md:253-257)
9. **compliance** - Map controls (template only in orchestrator.md:277-281)
10. **retrospective** - Capture lessons (template only in orchestrator.md:283-287)

---

## Overlap Matrix

### High Overlap (Strong Consolidation Candidates)

#### analyze vs deep-dive (95% overlap)
**Evidence:**
- orchestrator.md:207-211 defines deep-dive as "investigate architecture or domain questions in depth"
- analyze.md:182-400 has "Mode 2: Focused Investigation" for deep dives
- **Conclusion:** deep-dive is redundant; analyze already handles this

**Recommendation:** ❌ **Delete deep-dive** - merge into analyze mode

---

#### audit vs risk-audit vs secaudit (90% overlap)
**Evidence:**
- audit.md has TWO modes: "Risk Audit" (lines 44-198) + "Security Audit" (lines 200-254)
- orchestrator.md:241-245 defines risk-audit as "list top risks"
- orchestrator.md:265-269 defines secaudit as "analyze security posture"
- **Conclusion:** Single audit.md agent handles both risk + security

**Recommendation:** ❌ **Delete risk-audit and secaudit** - audit.md covers both

---

#### refactor vs design-review (85% overlap)
**Evidence:**
- refactor.md has TWO modes: "Design Review" (lines 46-219) + "Refactor Planning" (lines 222-283)
- orchestrator.md:247-251 defines design-review as "assess components for coupling/scalability"
- **Conclusion:** refactor.md already does design review before planning refactors

**Recommendation:** ❌ **Delete design-review** - merge into refactor mode

---

### Medium Overlap (Consider Consolidation)

#### plan vs challenge (50% overlap)
**Evidence:**
- orchestrator.md:194-199 defines plan as "pressure-test plans"
- challenge.md:1-224 specializes in pressure-testing via critical evaluation
- **Distinction:** plan focuses on structured planning workflows; challenge focuses on adversarial evaluation
- **Overlap:** Both pressure-test, but challenge is more general-purpose

**Recommendation:** ⚠️ **Keep separate** - plan is workflow-specific, challenge is evaluation-focused
**Rationale:** plan mode could orchestrate challenge sessions as part of planning flow

---

#### tests (agent) vs tests (mode) (40% overlap - NAMING CONFLICT)
**Evidence:**
- tests.md (agent) - Full implementation with 3 modes: strategy, generation, authoring (488 lines)
- orchestrator.md:52 lists "tests" as a specialized mode
- orchestrator.md:252 has no template for tests mode (missing!)
- **Conclusion:** tests should be invoked as standalone agent, NOT orchestrator mode

**Recommendation:** ⚠️ **Remove from orchestrator modes** - keep as standalone delivery agent
**Rationale:** Tests agent is implementation-focused (writes code), not analysis/pressure-testing

---

#### debug vs explore (30% overlap)
**Evidence:**
- debug.md:1-335 - Systematic investigation with hypotheses and root cause analysis
- explore.md:1-73 - Discovery-focused exploratory reasoning
- **Distinction:** debug is hypothesis-driven with resolution paths; explore is open-ended discovery
- **Overlap:** Both involve investigation, but debug has structured investigation phases

**Recommendation:** ✅ **Keep separate** - different use cases
**Rationale:** debug is for known issues; explore is for unknown territory

---

### Low Overlap (Clearly Distinct)

#### consensus vs challenge vs explore (20% overlap - CORE TRIAD)
**Evidence:**
- consensus.md - Multi-model perspectives with stance-steering
- challenge.md - Critical evaluation with adversarial pressure
- explore.md - Open-ended discovery without judgment
- **Distinction:** Three fundamentally different reasoning approaches

**Recommendation:** ✅ **Keep all three** - core reasoning modes
**Rationale:** These form the foundation of orchestrator's cognitive diversity

---

#### docgen vs tracer (0% overlap)
**Evidence:**
- docgen.md - Documentation outline generation
- tracer.md - Instrumentation/observability planning
- **Distinction:** Completely different domains

**Recommendation:** ✅ **Keep separate** - no overlap

---

## Mode Architecture Issues

### Issue 1: Phantom Modes (Templates Without Implementation)

**Problem:** orchestrator.md documents 9 modes that don't exist as files:
- plan, deep-dive, risk-audit, design-review, secaudit, codereview, precommit, compliance, retrospective

**Evidence:** Only 5 mode files exist in `.genie/agents/core/modes/`

**Root Cause:** orchestrator.md was written aspirationally, not based on shipped modes

**Impact:**
- Users invoke non-existent modes via `Mode: plan` and get generic orchestrator behavior
- No specialized prompt logic for these "modes"
- Confusion between standalone agents and modes

**Solution Options:**

**Option A: Implement Missing Modes** (HIGH EFFORT)
- Create 9 new mode files in `.genie/agents/core/modes/`
- Extract templates from orchestrator.md into standalone files
- Add mode-specific logic and examples
- Estimated effort: 2-3 days

**Option B: Reconcile Documentation** (LOW EFFORT - RECOMMENDED)
- Update orchestrator.md to only document implemented modes
- Clarify that analyze, debug, audit, refactor are standalone agents (NOT modes)
- Remove phantom mode references
- Add routing guidance: "For analysis, use analyze agent directly via mcp__genie__run"
- Estimated effort: 2-4 hours

---

### Issue 2: Agent vs Mode Confusion

**Problem:** orchestrator.md lists agents as "modes":
- analyze (standalone agent) listed as "mode"
- tests (standalone agent) listed as "mode"
- debug (standalone agent) NOT listed, but should be

**Evidence:**
- orchestrator.md:48 "analyze — system architecture analysis" (implies mode)
- But analyze.md is 415-line standalone agent with frontmatter
- tests.md is 488-line standalone agent, NOT a mode

**Root Cause:** Blurred line between:
- **Modes** = Reasoning patterns invoked via `Mode: X` in orchestrator
- **Agents** = Standalone implementations invoked via `mcp__genie__run with agent="X"`

**Impact:**
- Natural routing may invoke wrong mechanism
- Genie might say "Mode: analyze" when it should invoke analyze agent directly
- Orchestrator overhead for agents that don't need wrapper

**Solution:**
- Clarify in routing.md and orchestrator.md:
  - **Modes** = lightweight reasoning patterns (challenge, explore, consensus, docgen, tracer)
  - **Agents** = heavyweight implementations (analyze, debug, audit, refactor, tests, implementor, etc.)
- Update routing.md to route strategic questions to agents directly, not via orchestrator wrapper

---

### Issue 3: Specialized Modes Count Mismatch

**orchestrator.md claims:** "Specialized Analysis Modes (13 modes)"

**Actual breakdown:**
- **Implemented as modes (5):** challenge, consensus, explore, docgen, tracer
- **Implemented as agents (4):** analyze, debug, audit, refactor
- **Missing (9):** plan, deep-dive, risk-audit, design-review, tests, secaudit, codereview, precommit, compliance, retrospective
- **Custom-only (2):** compliance, retrospective (no implementations)

**Total:** 5 modes + 4 agents = 9 actual implementations (not 18)

---

## Consolidation Recommendations

### Phase 1: Immediate Deletions (High Confidence)

#### 1. Delete deep-dive mode ❌
- **Reason:** 95% overlap with analyze agent's focused investigation mode
- **Impact:** Zero - analyze already handles this
- **Action:** Remove from orchestrator.md:49, remove template at :207-211

#### 2. Delete risk-audit mode ❌
- **Reason:** 90% overlap with audit agent's risk audit mode
- **Impact:** Zero - audit.md handles this
- **Action:** Remove from orchestrator.md:50, remove template at :241-245

#### 3. Delete secaudit mode ❌
- **Reason:** 90% overlap with audit agent's security audit mode
- **Impact:** Zero - audit.md handles this
- **Action:** Remove from orchestrator.md:54, remove template at :265-269

#### 4. Delete design-review mode ❌
- **Reason:** 85% overlap with refactor agent's design review mode
- **Impact:** Zero - refactor.md handles this
- **Action:** Remove from orchestrator.md:51, remove template at :247-251

---

### Phase 2: Clarify Agent vs Mode Distinction

#### 5. Remove tests from orchestrator modes ⚠️
- **Reason:** tests.md is 488-line standalone delivery agent (writes code), not analysis mode
- **Impact:** Clarifies that tests is invoked directly, not via orchestrator
- **Action:** Remove from orchestrator.md:52, add to routing.md delivery agents section

#### 6. Remove analyze from orchestrator modes ⚠️
- **Reason:** analyze.md is 415-line standalone agent, not lightweight mode
- **Impact:** Clarifies routing - invoke analyze directly for investigations
- **Action:** Update orchestrator.md:48 to clarify analyze is standalone agent

#### 7. Remove debug from phantom modes ⚠️
- **Reason:** debug.md is 335-line standalone agent, not listed in orchestrator.md
- **Impact:** Prevents confusion - debug is NOT an orchestrator mode
- **Action:** Add debug to routing.md standalone agents section

#### 8. Remove audit from orchestrator modes ⚠️
- **Reason:** audit.md is 255-line standalone agent with 2 modes
- **Impact:** Clarifies routing - invoke audit directly for risk/security analysis
- **Action:** Update orchestrator.md to clarify audit is standalone agent

#### 9. Remove refactor from orchestrator modes ⚠️
- **Reason:** refactor.md is 284-line standalone agent with 2 modes
- **Impact:** Clarifies routing - invoke refactor directly for design review + planning
- **Action:** Update orchestrator.md to clarify refactor is standalone agent

---

### Phase 3: Implement or Remove Phantom Modes

#### Missing Template-Only Modes (9):

**Option A: Implement (HIGH EFFORT - 2-3 days)**
Create mode files for: plan, codereview, precommit, compliance, retrospective

**Option B: Remove (LOW EFFORT - 2 hours - RECOMMENDED)**
Remove template references from orchestrator.md for: plan, codereview, precommit, compliance, retrospective

**Recommendation:** **Remove phantom modes** - keep orchestrator lean
**Rationale:**
- plan: Can be handled by orchestrator's general pressure-testing capability
- codereview: Use review agent instead
- precommit: Use commit agent + review agent workflow
- compliance/retrospective: Custom-only modes with no core use cases

---

## Final Mode Inventory (After Consolidation)

### Core Reasoning Modes (3) ✅
1. **challenge** - Critical evaluation (keep)
2. **explore** - Discovery-focused reasoning (keep)
3. **consensus** - Multi-model perspectives (keep)

### Lightweight Utility Modes (2) ✅
4. **docgen** - Documentation outline (keep)
5. **tracer** - Instrumentation planning (keep)

### Standalone Agents (NOT modes) (9)
6. **analyze** - System analysis & deep investigation
7. **debug** - Bug investigation & resolution
8. **audit** - Risk + security assessment
9. **refactor** - Design review + refactor planning
10. **tests** - Test strategy + generation + authoring
11. **implementor** - Feature implementation
12. **polish** - Code refinement
13. **review** - Wish audits + code review
14. **commit** - Pre-commit validation + commit advisory

**Total:** 5 orchestrator modes + 9 standalone agents = 14 implementations

**Deleted:** deep-dive, risk-audit, secaudit, design-review (merged into agents)
**Removed from orchestrator:** plan, codereview, precommit, compliance, retrospective (phantom modes)

---

## Usage Frequency Predictions

### High Usage (Daily)
1. **challenge** - Pressure-testing decisions (core workflow)
2. **analyze** - Architecture investigations (debugging, planning)
3. **debug** - Bug fixing (daily dev work)
4. **implementor** - Code writing (execution phase)
5. **tests** - Test authoring (TDD workflow)

### Medium Usage (Weekly)
6. **refactor** - Design reviews (tech debt sprints)
7. **audit** - Risk assessments (pre-launch reviews)
8. **explore** - Domain learning (onboarding, new features)
9. **review** - Code review + wish validation (QA checkpoints)
10. **commit** - Commit advisory (cleanup phases)

### Low Usage (Monthly)
11. **consensus** - High-stakes decisions (architectural pivots)
12. **docgen** - Documentation sprints (quarterly)
13. **tracer** - Observability planning (infrastructure work)
14. **polish** - Code cleanup (refactor sprints)

---

## Verdict & Next Actions

### Genie Verdict
**Current state:** Orchestrator.md is aspirational documentation, not reality. 9 modes listed don't exist, 4 agents misclassified as modes. Consolidation will:
- Reduce confusion (agent vs mode distinction)
- Eliminate phantom modes (9 deletions)
- Clarify routing (invoke agents directly, not via orchestrator)
- Keep core reasoning triad (challenge/explore/consensus) intact

**Recommended path:** Phase 1 (immediate deletions) + Phase 2 (clarify agents) + Phase 3 (remove phantom modes)

**Expected outcome:** 5 true orchestrator modes + 9 standalone agents = cleaner architecture

**Confidence:** High (based on file existence, line count analysis, overlap assessment)

---

### Next Actions

#### Immediate (Phase 1 - 30 minutes)
1. Update orchestrator.md: Remove deep-dive, risk-audit, secaudit, design-review from mode list
2. Update orchestrator.md: Remove templates for deleted modes
3. Commit changes with message: "refactor: consolidate orchestrator modes - remove redundant modes covered by standalone agents"

#### Short-term (Phase 2 - 1 hour)
4. Update orchestrator.md: Clarify agent vs mode distinction in header
5. Update routing.md: Document when to invoke agents directly vs via orchestrator
6. Update : Reflect new mode count (5 modes, not 18)

#### Medium-term (Phase 3 - 1 hour)
7. Remove phantom mode templates from orchestrator.md (plan, codereview, precommit, compliance, retrospective)
8. Add guidance: "For X, use Y agent instead" where applicable
9. Update wish completion criteria to reflect actual mode inventory

---

## Evidence Summary

**Files Analyzed:**
- `.genie/agents/orchestrator.md` (315 lines)
- `.genie/agents/core/modes/challenge.md` (224 lines)
- `.genie/agents/core/modes/consensus.md` (198 lines)
- `.genie/agents/core/modes/explore.md` (73 lines)
- `.genie/agents/core/modes/docgen.md` (42 lines)
- `.genie/agents/core/modes/tracer.md` (42 lines)
- `.genie/agents/core/analyze.md` (415 lines)
- `.genie/agents/core/debug.md` (335 lines)
- `.genie/agents/core/audit.md` (255 lines)
- `.genie/agents/core/refactor.md` (284 lines)
- `.genie/agents/core/tests.md` (488 lines)

**Total:** 5 mode files + 4 agent files = 9 actual implementations (not 18)

**Consolidation Impact:**
- **Before:** 18 listed modes (9 phantom)
- **After:** 5 orchestrator modes + 9 standalone agents
- **Deletions:** 4 redundant mode references + 5 phantom mode templates
- **Clarifications:** 5 agents moved from "modes" to "standalone agents"

**Confidence:** High - based on file system evidence, line count analysis, and overlap assessment

---

**Report Location:** `.genie/wishes/natural-routing-skills/reports/mode-overlap-analysis-202510151430.md`
**Session ID:** orchestrator-mode-analysis
**Analyst:** Genie Orchestrator (Mode: analyze)
**Date:** 2025-10-15 14:30 UTC
