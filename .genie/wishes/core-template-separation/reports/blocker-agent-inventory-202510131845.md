# 🚫 Blocker Report: Agent Inventory Mismatch

**Issue:** #41 - Core/Template Agent Separation
**Blocker ID:** BLOCK-41-INVENTORY
**Severity:** CRITICAL
**Discovered:** 2025-10-13T18:45Z
**Reporter:** Learn agent (automated audit)

---

## Problem Statement

**Phase 2 implementation BLOCKED** due to critical mismatch between documented agent inventory and codebase reality.

**Documented in wish & issue #41:**
- 30 agents total: 6 top-level + 10 core + 14 orchestrator modes

**Actual codebase reality:**
- 25 agents total: 6 top-level + 13 core + 5 modes + 1 QA
- Missing 5 agents from expected total

**Impact:**
- Cannot validate Phase 2 acceptance criteria
- Agent count success metric (30 agents) is incorrect
- Documentation references non-existent agents
- CLI validation (`genie list agents`) cannot be compared to expected output

---

## Detailed Inventory Analysis

### Top-Level Agents (6) ✅ MATCHES

**Expected:** plan, wish, forge, review, orchestrator, vibe
**Actual:**
```
.genie/agents/
├── plan.md              ✅
├── wish.md              ✅
├── forge.md             ✅
├── review.md            ✅
├── orchestrator.md      ✅
└── vibe.md              ✅
```

**Status:** ✅ 6/6 present and correct

---

### Core Agents (10 documented vs 13 actual) ❌ MISMATCH

**Documented "10 core agents" (from wish line 355-359):**
1. commit.md ✅
2. debug.md ✅
3. git-workflow.md ✅
4. implementor.md ✅
5. install.md ✅
6. learn.md ✅
7. polish.md ✅
8. prompt.md ⚠️ **Not listed in "10 core" but exists**
9. qa.md ✅
10. tests.md ✅

**Actual core agents (13 files):**
```
.genie/agents/core/
├── analyze.md           ⚠️ Documented as MODE but exists as CORE agent
├── audit.md             ⚠️ Documented as "risk-audit" MODE but exists as CORE agent
├── commit.md            ✅
├── debug.md             ✅
├── git-workflow.md      ✅
├── github-workflow.md   ❌ NOT documented in wish at all
├── implementor.md       ✅
├── install.md           ✅
├── learn.md             ✅
├── polish.md            ✅
├── prompt.md            ⚠️ Exists but not in "10 core" list
├── refactor.md          ⚠️ Documented as MODE but exists as CORE agent
└── tests.md             ✅
```

**Issues found:**
1. **github-workflow.md** - Exists but completely undocumented in wish
2. **analyze.md** - Documented as orchestrator mode but exists as core agent
3. **audit.md** - Documented as "risk-audit" mode but exists as core agent
4. **refactor.md** - Documented as mode but exists as core agent
5. **prompt.md** - Exists as core agent but not in "10 core" list

---

### Orchestrator Modes (14 documented vs 5 actual) ❌ CRITICAL MISMATCH

**Documented "14 orchestrator modes" (wish lines 361-378):**

**Found (5):**
1. challenge.md ✅
2. consensus.md ✅
3. docgen.md ✅
4. explore.md ✅
5. tracer.md ✅

**Missing (9):**
6. codereview.md ❌ **File does not exist**
7. deep-dive.md ❌ **File does not exist**
8. design-review.md ❌ **File does not exist**
9. risk-audit.md ❌ **File does not exist** (audit.md exists as core agent instead)
10. secaudit.md ❌ **File does not exist**
11. test-strategy.md ❌ **File does not exist**
12. testgen.md ❌ **File does not exist**
13. analyze.md ⚠️ **Exists as core agent, not mode**
14. refactor.md ⚠️ **Exists as core agent, not mode**

**Directory reality:**
```
.genie/agents/core/modes/
├── challenge.md         ✅
├── consensus.md         ✅
├── docgen.md            ✅
├── explore.md           ✅
└── tracer.md            ✅
```

---

### QA Agents (1) ✅ MATCHES

**Expected:** genie-qa
**Actual:**
```
.genie/agents/qa/
└── genie-qa.md          ✅
```

**Status:** ✅ 1/1 present

---

## Root Cause Analysis

### Hypothesis 1: Incomplete Migration
**Evidence:**
- Wish document created 2025-10-06
- Phase 0 & 1 marked complete
- Phase 2 "IN PROGRESS"
- 9 documented modes never created

**Theory:** Original plan included 14 modes but only 5 were implemented during Phase 0/1 consolidation.

### Hypothesis 2: Mode Consolidation Not Reflected in Docs
**Evidence:**
- Commit 544bd0d (2025-10-07): "Mode consolidation (socratic/debate/challenge merged)"
- Commit 96f3ca2 (2025-10-07): Custom stubs created
- Wish status log notes "Mode consolidation (5→3 core modes)"

**Theory:** Modes were consolidated (merged or deleted) but wish document inventory wasn't updated to reflect reality.

### Hypothesis 3: Categorization Changed
**Evidence:**
- analyze, audit, refactor exist as **core agents** not modes
- These were originally planned as modes
- Decision made to promote to core agent status

**Theory:** Some documented modes were reclassified as core agents during implementation but inventory not updated.

---

## Evidence

### Wish Document References (Incorrect)

**Line 304:** "30 agent files shipped in `.genie/agents/` (6 top-level + 10 core + 14 modes)"
- **Reality:** 25 files (6 + 13 + 5 + 1)

**Line 355:** "CORE DELIVERY AGENTS — `.genie/agents/core/` (10)"
- **Reality:** 13 files in core/

**Line 361:** "ORCHESTRATOR MODES — `.genie/agents/core/modes/` (14)"
- **Reality:** 5 files in modes/

**Line 428:** Success metric - "30 agents total (6 + 10 + 14)"
- **Reality:** Need to recalculate

### Git History Evidence

**Phase 0 completion (2025-10-07):**
```
544bd0d - Mode consolidation (socratic/debate/challenge merged)
96f3ca2 - All 14 orchestrator modes have custom stubs
```

**Phase 1 completion (2025-10-07):**
```
Meta-learning agent unified and wrappers updated
```

**Phase 2:** IN PROGRESS (current blocker)

---

## Impact Assessment

### High Impact (Blocks Progress)
1. ❌ **Cannot validate Phase 2 acceptance criteria** - "All 14 orchestrator modes documented"
2. ❌ **Cannot run `genie list agents`** - Executor issues prevent validation
3. ❌ **Cannot generate accurate CLI output** - Expected 30 agents, reality shows 25

### Medium Impact (Documentation Debt)
4. ⚠️ **Wish document misleading** - Claims 30 agents when 25 exist
5. ⚠️ **Issue #41 acceptance criteria wrong** - Based on incorrect inventory
6. ⚠️ **Custom stub files mismatch** - 14 stubs created but only 5 modes exist

### Low Impact (Cosmetic)
7. ℹ️ **Agent categorization unclear** - Some modes promoted to core agents but not documented

---

## Recommended Resolution Path

### Option A: Update Documentation to Match Reality ✅ RECOMMENDED

**Actions:**
1. Audit actual files (completed in this report)
2. Update wish document inventory:
   - Change "10 core" → "13 core"
   - Change "14 modes" → "5 modes"
   - Add github-workflow.md to documentation
   - Note analyze/audit/refactor as core agents
3. Update issue #41 acceptance criteria:
   - "All 13 core agents documented"
   - "All 5 orchestrator modes documented"
4. Update success metric: "25 agents (6 + 13 + 5 + 1)"
5. Document rationale for mode consolidation

**Pros:**
- Reflects current reality
- Unblocks Phase 2 immediately
- Honest about what was implemented

**Cons:**
- Admits original plan changed
- May raise questions about 9 missing modes

### Option B: Create Missing 9 Modes

**Actions:**
1. Create codereview.md, deep-dive.md, design-review.md, etc.
2. Populate with mode-specific logic
3. Test each mode via orchestrator
4. Update custom stubs to point to new modes

**Pros:**
- Matches original plan
- Delivers promised 14-mode system

**Cons:**
- Significant implementation work (weeks)
- Blocks Phase 2 progress
- May not be necessary (5 modes may be sufficient)

### Option C: Hybrid Approach

**Actions:**
1. Update docs to reflect 25 agents (Option A)
2. Create issue for "remaining modes" as future work
3. Document mode consolidation rationale
4. Proceed with Phase 2 using actual inventory

**Pros:**
- Unblocks immediate progress
- Preserves future expansion path
- Transparent about trade-offs

**Cons:**
- Admits scope reduction
- Two-phase documentation effort

---

## Decision Required

**Question for Felipe:**

Which resolution path should we take?

**A) Update docs to match reality (25 agents)** - Fastest unblock
**B) Create 9 missing modes first** - Matches original plan
**C) Hybrid (docs now, modes later)** - Balanced approach

---

## Next Actions (After Decision)

### If Option A (Update Docs):
1. [ ] Update wish line 304: "25 agent files"
2. [ ] Update wish line 355: "13 core agents"
3. [ ] Update wish line 361: "5 orchestrator modes"
4. [ ] Update wish line 428: Success metric "25 agents"
5. [ ] Add github-workflow.md to documentation
6. [ ] Document mode consolidation in status log
7. [ ] Update issue #41 acceptance criteria
8. [ ] Mark blocker resolved
9. [ ] Resume Phase 2 work

### If Option B (Create Modes):
1. [ ] Create execution plan for 9 modes
2. [ ] Implement each mode file
3. [ ] Test orchestrator routing
4. [ ] Update custom stubs
5. [ ] Validate CLI output shows 30 agents
6. [ ] Mark blocker resolved
7. [ ] Resume Phase 2 work

### If Option C (Hybrid):
1. [ ] Execute Option A steps (update docs)
2. [ ] Create issue #42: "Expand orchestrator modes (5 → 14)"
3. [ ] Link issue #42 to Phase 3 or backlog
4. [ ] Document rationale in AGENTS.md
5. [ ] Mark blocker resolved
6. [ ] Resume Phase 2 work

---

## Timeline Estimate

**Option A:** 1-2 hours (documentation only)
**Option B:** 2-3 weeks (implementation + testing)
**Option C:** 2-3 hours (docs + issue creation)

---

## Blocker Status

**OPEN** - Awaiting decision on resolution path

**Blocking:**
- Issue #41 Phase 2 completion
- Agent inventory validation
- CLI output verification

**Not Blocking:**
- Other issues (#27, #28, #29, #31, #37, #38, #39, #40)
- Template selection work (completed)
- Learn agent functionality

---

**Report Generated:** 2025-10-13T18:45Z
**Next Review:** After Felipe's decision on resolution path
