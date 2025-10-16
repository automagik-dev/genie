# Parent Wish Review – Core/Template Agent Separation
**Date:** 2025-10-07T04:40Z | **Wish Status:** DRAFT (IN PROGRESS)
**Overall Completion Estimate:** ~25/100 (25%)

## Executive Summary

The "Core/Template Agent Separation" wish aims to restructure Genie's framework architecture by separating built-in core agents from user-customizable templates. **Progress is partial** with 2 of 4 phases showing meaningful completion, but **critical deliverables remain blocked**.

### Current State
- ✅ **Phase 1 COMPLETE** (Meta-learning unification)
- ✅ **Phase 0 PARTIAL** (Mode consolidation subset complete at 92/100)
- ❌ **Phase 0 REMAINING** (Core delivery delegation incomplete)
- ❌ **Phase 2 BLOCKED** (Delivery catalog rationalization not started)
- ❌ **Phase 3 BLOCKED** (Documentation pending earlier phases)
- ❌ **templates/ directory EMPTY** (critical blocker for entire wish)

---

## Phase-by-Phase Assessment

### Phase 0 – Genie Mode Consolidation

**Status:** 50% COMPLETE

**Completed Work:**
- ✅ Mode consolidation (socratic/debate/challenge merged)
- ✅ Renamed thinkdeep → explore
- ✅ Removed bloat variants (plan-advanced, debug-advanced, etc.)
- ✅ Orchestrator.md updated with mode selection guide
- ✅ AGENTS.md routing matrix updated
- ✅ .claude/README.md corrected
- **Score:** 92/100 (excellent execution)
- **Evidence:** `qa/review-mode-consolidation-202510070437.md`, commit 544bd0d

**Remaining Work:**
- [ ] Verify all 18 modes have matching `.genie/custom/<mode>.md` stubs
- [ ] Create missing custom stubs for modes without them
- [ ] MCP invocation smoke tests for new mode architecture
- [ ] Full delegation pattern verification

**Blockers:** None

**Estimated Completion Time:** 2-4 hours

---

### Phase 1 – Meta-Learning Unification

**Status:** ✅ COMPLETE

**Completed Work:**
- ✅ Unified learn agent created
- ✅ Legacy self-learn prompt retired
- ✅ Command wrappers updated
- ✅ Done Report convention established
- **Evidence:** `reports/done-learn-core-template-separation-20251007T1745Z.md`

**Remaining Work:** None

**Blockers:** None

---

### Phase 2 – Core Delivery Catalog Rationalization

**Status:** ❌ NOT STARTED

**Scope:**
- Collapse delivery prompts into `core/` with custom includes
- Retire redundant/obsolete agents
- Update `.claude/` aliases
- Verify agent resolution

**Blockers:**
- Phase 0 completion prerequisite
- Unclear which delivery agents are "redundant"
- No inventory of what needs rationalization

**Estimated Completion Time:** 6-8 hours

---

### Phase 3 – Documentation & Validation

**Status:** ❌ NOT STARTED (PARTIALLY BLOCKED)

**Scope:**
- Document core vs template split
- Create migration guide
- Capture validation evidence
- Update AGENTS.md, README.md

**Completed Documentation:**
- ✅ AGENTS.md partially updated (mode consolidation)
- ✅ .claude/README.md partially updated

**Remaining Work:**
- [ ] Migration guide (`.genie/guides/migration-core-template.md`)
- [ ] User migration guide for mode consolidation breaking changes
- [ ] Full architecture documentation
- [ ] Validation command outputs

**Blockers:**
- Requires Phase 0 & Phase 2 completion
- Templates directory prerequisite

**Estimated Completion Time:** 4-6 hours (after prerequisites)

---

## Critical Blocker Analysis

### 🔴 BLOCKER #1: templates/ Directory Empty

**Location:** Repo root `templates/`
**Status:** **EMPTY/MISSING**
**Impact:** **BLOCKS ENTIRE WISH**

**Why This Blocks Everything:**
The core premise of this wish is to separate:
1. **Core agents** → npm package (automatically loaded)
2. **Template files** → `templates/` directory (copied to user projects)

Without the templates directory populated, we cannot:
- ❌ Test the core/template separation
- ❌ Validate `genie init` behavior
- ❌ Prove zero-breaking-change claim
- ❌ Complete Phase 2 (delivery catalog must know where to live)
- ❌ Complete Phase 3 (documentation needs to reference template structure)

**Resolution Required:**
1. Create `templates/` directory structure:
   ```
   templates/
   ├── .genie/
   │   ├── custom/           # Project override stubs
   │   ├── standards/        # Best practices templates
   │   ├── product/          # Mission/roadmap templates
   │   ├── guides/           # Getting started docs
   │   └── state/            # Empty session storage
   ├── .claude/
   │   ├── commands/         # Slash command wrappers
   │   └── agents/           # Task tool aliases
   └── README.md             # Template usage guide
   ```

2. Populate with starter files (customization stubs, placeholder docs)
3. Update `genie init` to copy from `templates/` to target project
4. Test in clean environment

**Estimated Time to Resolve:** 8-12 hours

---

### 🟡 BLOCKER #2: Phase 0 Incomplete

**Status:** 50% complete (mode consolidation done, delegation pattern incomplete)

**Impact:** Blocks Phase 2 progression

**Resolution:**
- Complete custom stub creation for all 18 modes
- Verify delegation pattern works end-to-end
- Run MCP smoke tests

**Estimated Time:** 2-4 hours

---

### 🟡 BLOCKER #3: Migration Guide Missing

**Status:** Not created

**Impact:** Breaking changes (mode consolidation) have no user guidance

**Resolution:**
- Create `.genie/guides/migration-mode-consolidation.md`
- Document `Mode: socratic` → `Mode: challenge. Method: socratic` pattern
- Explain auto-routing fallback behavior

**Estimated Time:** 1-2 hours

---

## Evaluation Matrix Scoring (Partial)

Since the wish is incomplete, I'll score only what's been **delivered and validated**:

### Discovery Phase: 20/30 pts (67%)

- **Context Completeness (7/10 pts)**
  - [x] Files/docs referenced (4/4) – Mode consolidation well-documented
  - [x] Agent inventory (3/3) – Catalog complete
  - [ ] Template content audit (0/3) – **Gap:** templates/ empty

- **Scope Clarity (10/10 pts)**
  - [x] Core vs template distinction (3/3)
  - [x] Spec contract (4/4)
  - [x] Out-of-scope (3/3)

- **Evidence Planning (3/10 pts)**
  - [x] Validation commands (3/4) – Mode checks defined
  - [ ] Migration path (0/3) – **Gap:** No templates/ structure
  - [ ] Approval checkpoints (0/3) – **Gap:** Phase-gate approvals not documented

### Implementation Phase: 15/40 pts (38%)

- **Code Quality (10/15 pts)**
  - [x] Directory structure (5/5) – Mode consolidation clean
  - [ ] Minimal breaking changes (0/5) – **Gap:** Breaking changes without migration guide
  - [x] Clear @include paths (5/5) – Orchestrator.md patterns documented

- **Test Coverage (0/10 pts)**
  - [ ] Init script tested (0/4) – **Gap:** templates/ prerequisite
  - [ ] Template copy verification (0/4) – **Gap:** templates/ prerequisite
  - [ ] MCP resolution tests (0/2) – **Gap:** Runtime verification missing

- **Documentation (3/5 pts)**
  - [x] AGENTS.md updated (2/2)
  - [ ] Migration guide (0/2) – **Gap:** Breaking change guide missing
  - [x] README updated (1/1)

- **Execution Alignment (2/10 pts)**
  - [ ] Stayed in scope (0/4) – **Partial:** Mode consolidation yes, full wish no
  - [x] No scope creep (2/2) – Clean execution within defined boundaries
  - [ ] Dependencies honored (0/4) – **Gap:** templates/ dependency unresolved

### Verification Phase: 8/30 pts (27%)

- **Validation Completeness (4/15 pts)**
  - [ ] Init creates structure (0/6) – **Gap:** templates/ prerequisite
  - [x] Core agents accessible (4/4) – Mode consolidation verified
  - [ ] Workflows unbroken (0/5) – **Gap:** No end-to-end test

- **Evidence Quality (4/10 pts)**
  - [x] Before/after comparison (4/4) – Mode consolidation documented
  - [ ] Init output (0/3) – **Gap:** No init test
  - [ ] Agent resolution proof (0/3) – **Gap:** MCP smoke test missing

- **Review Thoroughness (0/5 pts)**
  - [ ] Human approval (0/2) – **Gap:** No phase-gate approvals
  - [ ] Blockers resolved (0/2) – **Gap:** templates/ blocker active
  - [ ] Status log updated (0/1) – **Fixed:** Just updated

---

## Overall Scoring

**Delivered Work:** 43/100 (43%)

**Adjusted for Scope:** 25/100 (25%)
- Reason: Templates directory blocker prevents 50%+ of wish deliverables

**Verdict:** ⚠️ **NEEDS WORK** – Critical blocker prevents progress

---

## Recommendations

### Immediate Actions (Next 24 Hours)

1. **Resolve templates/ blocker** (Priority 1)
   - Create directory structure
   - Populate with minimal starter files
   - Test `genie init` in clean environment
   - **Blocks:** Everything

2. **Complete Phase 0** (Priority 2)
   - Create missing `.genie/custom/<mode>.md` stubs
   - Run MCP smoke tests
   - Verify delegation pattern
   - **Time:** 2-4 hours

3. **Create migration guide** (Priority 3)
   - Document breaking changes from mode consolidation
   - Provide migration examples
   - Explain auto-routing
   - **Time:** 1-2 hours

### Short-Term Actions (Next Week)

4. **Phase 2 execution** (after templates/ resolved)
   - Rationalize delivery catalog
   - Update agent resolver
   - **Time:** 6-8 hours

5. **Phase 3 completion**
   - Full architecture documentation
   - Validation evidence collection
   - **Time:** 4-6 hours

### Long-Term Follow-Ups

6. **MCP smoke test suite**
   - End-to-end mode invocation tests
   - Agent resolution verification
   - **Time:** 3-4 hours

7. **User migration support**
   - Monitor for mode-related issues
   - Provide guidance in docs/issues
   - **Time:** Ongoing

---

## Risk Assessment

**HIGH RISK:**
- 🔴 templates/ blocker prevents wish completion
- 🔴 Breaking changes shipped without migration guide
- 🔴 No end-to-end validation (MCP tests missing)

**MEDIUM RISK:**
- 🟡 Phase 2/3 timeline uncertain (depends on templates/)
- 🟡 User confusion from mode consolidation breaking changes

**LOW RISK:**
- 🟢 Mode consolidation work is solid (92/100 score)
- 🟢 Phase 1 complete with good evidence

---

## Next Steps

1. **Human Decision Required:**
   - Prioritize templates/ directory creation?
   - Or continue with incremental Phase 0 completion?
   - Recommended: **Fix templates/ blocker first** (unblocks everything)

2. **If templates/ resolved:**
   - Complete Phase 0 (2-4 hours)
   - Execute Phase 2 (6-8 hours)
   - Execute Phase 3 (4-6 hours)
   - **Total remaining:** ~15-20 hours

3. **If templates/ deferred:**
   - Complete Phase 0 remaining work
   - Create migration guides
   - Wait for templates/ before Phase 2/3

---

## Evidence Files

**Existing:**
- ✅ `qa/review-mode-consolidation-202510070437.md` (this subset, 92/100)
- ✅ `reports/commit-advice-mode-consolidation-202510070431.md`
- ✅ `reports/done-learn-core-template-separation-20251007T1745Z.md`
- ✅ `qa/group-b/meta-learn-merge.md`

**Missing:**
- ❌ `qa/group-a/genie-consolidation.md` (full Phase 0 evidence)
- ❌ `qa/group-c/delivery-catalog.md` (Phase 2)
- ❌ `qa/group-d/docs-and-validation.md` (Phase 3)
- ❌ `.genie/guides/migration-core-template.md`
- ❌ `.genie/guides/migration-mode-consolidation.md`

---

## Conclusion

**Current Status:** 25% complete, **critical blocker active**

**Path Forward:**
1. Resolve templates/ directory (unblocks 50%+ of wish)
2. Complete Phase 0 (4 hours)
3. Execute Phase 2 (8 hours)
4. Execute Phase 3 (6 hours)
5. **Total remaining:** ~20-25 hours to full completion

**Recommended Action:** Prioritize templates/ creation before continuing other phases.
