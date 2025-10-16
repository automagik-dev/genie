# 🎯 Genie Development TODO
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Prioritized work queue for Genie framework

---

## 🔥 CRITICAL Priority (Do First)

### 1. UPDATE.md Excessive @ Usage ✅ ACCEPTED
**File:** `.genie/agents/neurons/update.md`
**Problem:** Loads 17 backup files with hardcoded @
**Impact:** -17 @ refs, -40% file size, poor maintainability
**Action:** Replace `.genie.backup/@...` with dynamic discovery (Glob + Read)
**Evidence:** Knowledge graph audit 2025-10-16
**Status:** READY TO IMPLEMENT
**Effort:** 30 minutes

```markdown
# Before (17 hardcoded @):
@.genie.backup/@.genie/agents/workflows/plan.md
@.genie.backup/@.genie/agents/workflows/wish.md
... (15 more)

# After (dynamic discovery):
**Backup contents:**
!`find .genie/backups/latest -name "*.md" | sort`

# Then use Glob + Read to load selectively based on what changed
```

### 2. Core-Template-Separation Wish Status ✅ ACCEPTED
**File:** `.genie/wishes/core-template-separation/`
**Problem:** Wish at 25/100 since Oct 7, potentially complete but not updated
**Action:**
1. Check if work is done → archive if complete
2. If not done → convert 10 excessive @ refs to selective Read
3. Update status to 100/100 or document remaining work

**Status:** INVESTIGATION REQUIRED
**Effort:** 1 hour investigation + action

---

## ⚠️ HIGH Priority (Do After Critical)

### 3. Agent Redundancy Investigation
**Files:** implementor.md, install.md, modes/audit.md, modes/challenge.md
**Problem:** Duplicate Discovery/Implementation/Verification blocks
**Question:** WHY are these duplicated? What's the root cause?
**Action:**
1. Analyze pattern origins
2. Determine if extraction is appropriate
3. Propose @ reference strategy OR document intentional duplication

**Status:** DEEP DIVE NEEDED
**Effort:** 2 hours

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
- ✅ Knowledge graph audit (6.5/10 health score)
- ✅ Identified systematic fixes

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
