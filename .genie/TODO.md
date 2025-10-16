# 🎯 Genie Development TODO
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Prioritized work queue for Genie framework

---

## 🔥 CRITICAL Priority (Do First)

### 1. UPDATE.md Optimization ✅ COMPLETE
**File:** `.genie/UPDATE.md`
**Problems:**
1. Loaded 19 backup files with hardcoded @ (massive context bloat)
2. Used wrong backup path (`.genie.backup/` instead of `{{BACKUP_PATH}}`)

**Actions:**
1. Removed all @ prefixes (agents use Read during execution)
2. Replaced 48 hardcoded `.genie.backup/` with `{{BACKUP_PATH}}` placeholder

**Impact:**
- -19 @ refs → clean context, on-demand loading
- Correct path placeholder → CLI substitutes real backup path

**Evidence:** Knowledge graph audit 2025-10-16
**Status:** ✅ COMPLETE (2025-10-16)
**Completed:** 29 surgical edits total

**Before:**
- 19 @ references → loads 3,000-5,000 lines
- Hardcoded `.genie.backup/` → wrong path

**After:**
- 0 @ references → loads UPDATE.md only (668 lines)
- `{{BACKUP_PATH}}` placeholder → CLI substitutes `.genie/backups/<timestamp>/genie/`

### 2. Core-Template-Separation Wish Status ✅ COMPLETE (95/100)
**File:** `.genie/wishes/core-template-separation/`
**Status:** ✅ COMPLETE at 95/100 (2025-10-16 20:45Z)

**Completed:**
- ✅ Phase 0: Mode consolidation (92/100)
- ✅ Phase 1: Meta-learning unification
- ✅ Phase 2: Template structure created (templates/code/ + templates/create/)
- ✅ Phase 3: Multi-template validation + INSTALL.md creation
- ✅ Architecture validated: workflows in npm, accessed via @ or MCP (not copied by design)
- ✅ Root cause analysis: agents/ blacklist is CORRECT (preserves user customizations)
- ✅ INSTALL.md created for create template (ac7b810)
- ✅ Validation evidence documented (cb665e1)
- ✅ Wish updated to 95/100 (787ba64)

**Key Learning:**
- agents/ directory intentionally blacklisted (correct architecture)
- Workflows ship in npm package for both templates
- User projects access via @ or mcp__genie__run (never copy locally)
- NO BUG - working as designed!

**Remaining (5pts - minor docs):**
1. Update AGENTS.md §Universal Workflow Architecture section (15 min)
2. Archive wish with completion evidence
3. Update GitHub issue #41

**Evidence:**
- qa/template-validation-202510161630.md
- reports/multi-template-evolution-202510161800.md
- Commits: ac7b810, cb665e1, 787ba64

---

## ⚠️ HIGH Priority (Do After Critical)

### 3. Agent Deduplication Rollout ✅ PROOF-OF-CONCEPT COMPLETE
**Files:** 18 remaining agents (21 total, 3 done: implementor, tests, polish)
**Solution Proven:** Extract framework to AGENTS.md §Prompting Standards, agents reference it
**Completed:**
- ✅ Added §Prompting Standards Framework to AGENTS.md (~115 lines)
- ✅ Simplified 3 agents: implementor, tests, polish (-150 lines)
- ✅ Pattern validated: agents reference base, customize for role

**Action:** Apply pattern to remaining 18 agents
**Impact:** Projected -3,700 lines total when complete
**Status:** READY TO ROLLOUT (delegate to implementor)
**Effort:** 2-3 hours (delegate to implementor with clear spec)

### 4. wish.md Template Duplication
**File:** `.genie/agents/workflows/wish.md`
**Problem:** Template embedded in wish.md, copied to EVERY wish instance
**Root Cause:** Wish creation duplicates entire template
**Action:** Fix at source (wish.md workflow), prevent future duplication
**Status:** ARCHITECTURAL REVIEW NEEDED
**Effort:** 2 hours

---

## 🔍 INVESTIGATION Queue

### 5. MCP Session Creation Bugs
**Evidence:**
- Prompt agent session `c69a45b1` - failed to start (no run found)
- Orchestrator agent session `337b5125` - failed to start (no run found)

**Question:** Why did `mcp__genie__run` return session IDs that don't exist?
**Action:** Debug MCP session creation flow
**Status:** NEEDS INVESTIGATION
**Effort:** 1-2 hours

---

## 📋 MEDIUM Priority (Backlog)

### 6. Close Wish #40 as Complete
**Status:** 95% COMPLETE (per analysis)
**Action:**
1. Update wish to 100/100
2. Document what exists
3. Close issue #40
4. Archive wish

**Status:** READY (analysis complete)
**Effort:** 15 minutes

### 7. Multi-Template Architecture Analysis
**Wish:** #37
**Status:** 50% complete (partial migration done Oct 12)
**Action:** Continue analysis, prepare for execution
**Status:** DEFER until higher priority work complete
**Effort:** See wish analysis

### 8. Create Wish #49 (Telemetry)
**Issue:** #49 - Telemetry system
**Action:** Create wish document from issue
**Status:** DEFER until higher priority work complete
**Effort:** 1 hour

### 9. Create Wish #53 (ChatGPT Integration)
**Issue:** #53 - Bring Genie to ChatGPT
**Action:** Create wish document from issue
**Status:** DEFER - needs triage first
**Effort:** TBD

---

## ⏸️ PAUSED / BLOCKED

### core-template-separation (#41)
**Status:** 25/100 since Oct 7 - STALLED
**Blocker:** Conflicts with multi-template (#37)
**Decision:** Wait for #37 to complete, then re-evaluate if still needed
**Resume:** After #37 complete

### backup-update-system (#38)
**Status:** 0/100 - NOT STARTED
**Priority:** LOW (current system works)
**Decision:** Defer indefinitely
**Resume:** Only if user requests

---

## 🎉 COMPLETED (This Session)

- ✅ Backlog audit complete
- ✅ Closed 3 duplicate/obsolete issues
- ✅ Updated 2 wishes to 100/100
- ✅ Archived 2 completed wishes
- ✅ Investigation wish #44 complete (NOT a bug - version issue)
- ✅ Issue #44 closed
- ✅ Wish analysis: #40, #37, #41, #38
- ✅ **Knowledge graph audit complete** (132 files, 6.5/10 health)
  - Report: `.genie/qa/evidence/knowledge-graph-audit-20251016123107.md`
  - Visual graph: `.genie/qa/evidence/knowledge-graph-visual.mermaid`
- ✅ **Agent deduplication proof-of-concept** (3 agents done)
  - Added §Prompting Standards Framework to AGENTS.md
  - Simplified implementor, tests, polish agents
  - Projected -3,700 lines when rolled out to all 21 agents
- ✅ **Learn agent fixes** (./genie → mcp__genie__ pattern documented)
- ✅ **UPDATE.md optimization** (CRITICAL #1)
  - Removed 19 excessive @ references (0 @ refs now)
  - Fixed 48 hardcoded `.genie.backup/` → `{{BACKUP_PATH}}` placeholder
  - Impact: Clean context, correct path substitution, on-demand loading

---

## 🔄 Priority Rules

**1. CRITICAL > HIGH > MEDIUM > INVESTIGATION**

**2. System health > New features**
- Fix excessive @ usage before adding new wishes
- Investigate redundancy before creating new agents
- Clean up templates before creating new templates

**3. Complete before starting**
- Finish CRITICAL #1 before CRITICAL #2
- One task deeply, not many shallowly
- Document completion evidence

**4. Evidence-based decisions**
- Always analyze before implementing
- Read existing code before editing
- Check for partial implementations

---

## 📊 Effort Tracking

**Total estimated work:**
- CRITICAL: 1.5 hours
- HIGH: 4 hours
- MEDIUM: TBD (deferred)
- INVESTIGATION: 3-4 hours

**Current capacity:** Full focus available

**Next action:** Start CRITICAL #1 (UPDATE.md)
