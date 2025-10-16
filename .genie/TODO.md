# 🎯 Genie Development TODO
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Context:** Prioritized work queue for Genie framework

---

## 🔥 CRITICAL Priority (Do First)

*All critical tasks complete!*

---

## ⚠️ HIGH Priority (Do After Critical)

*All high priority tasks complete!*

### 4. wish.md Template Duplication
**File:** `.genie/agents/workflows/wish.md`
**Problem:** Template embedded in wish.md, copied to EVERY wish instance
**Root Cause:** Wish creation duplicates entire template
**Action:** Fix at source (wish.md workflow), prevent future duplication
**Status:** IN PROGRESS - Implementor session active
**Session:** e38398a3-42fe-4e1c-acec-c6025d0b1112
**Started:** 2025-10-17 00:45 UTC
**Effort:** 2 hours (delegated)

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
- CRITICAL: 0 hours (complete)
- HIGH: 2 hours
- MEDIUM: TBD (deferred)
- INVESTIGATION: 3-4 hours

**Current capacity:** Full focus available

**Next action:** See STATE.md for current session focus
