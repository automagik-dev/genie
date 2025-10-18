# 🧞 Genie Session State - RC28 Active (Forge Integration)

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Version:** v2.4.0-rc.27 → RC28 (in progress)
**Branch:** rc28 (multi-purpose integration branch)
**Status:** 🚧 ACTIVE - Forge Integration Foundation

---

## 🎯 RC28 MISSION: Forge Integration Foundation

**Strategic Focus:** 100% Forge executor replacement - eliminates 6+ critical bugs at once

**Core Philosophy:**
- Forge is PRIMARY entry point for all work
- Session name architecture enables Forge integration
- Many existing bugs become obsolete with Forge backend

---

## 📊 RC28 EXECUTION PLAN

### **Phase 1: Foundation (Session Names) ✅ IN PROGRESS**

**Issue #146 - Session Name Architecture**
- Status: ✅ Implementation complete, in final review
- Branch: 115-session-name-architecture → rc28 (renamed)
- Critical fix needed: run.ts:104 (storage key bug)
- **Why first:** Names align with Forge task names (foundation)

**Forge Tasks:**
- ✅ 93672720 - Complete session name implementation (DONE)
- ✅ 31a28932 - Review session name architecture (DONE)
- 🔴 b91ba10d - Fix critical bug in run.ts:104 (IN-REVIEW)

---

### **Phase 2: Core Replacement (Wish #120-A) 🚧 READY**

**Issue #143 - Forge Drop-In Replacement (Quick Win)**
- Status: Discoveries complete, ready for implementation
- Scope: 9 core endpoints, ZERO user-facing changes
- Impact: Eliminates 5-7 critical bugs simultaneously

**Discoveries Complete:**
- ✅ e46f87c2 - Filesystem restrictions audit (3 CRITICAL violations fixed)
- ✅ c8b8a793 - Migration script design (hybrid strategy)

**Forge Task:**
- 🟡 5fcd097d - Implement Wish #120-A (IN-REVIEW, ready to start)

**Implementation Groups:**
- Group A: Core integration (8 tasks) - Replace background-launcher.ts
- Group B: Migration & safety (5 tasks) - sessions.json → Forge
- Group C: Testing (3 tasks) - Stress tests, performance validation
- Group D: Documentation (4 tasks) - Evidence, rollback plan

---

### **Phase 3: Issue Cleanup 📋 AFTER PHASE 2**

**6 Issues Become OBSOLETE with Forge:**
- #115 - MCP Run Creates Multiple Sessions (Forge atomic creation)
- #92 - Sessions stuck in 'running' (Forge lifecycle management)
- #91 - Sessions missing from sessions.json (Postgres ACID)
- #93 - MCP agent start failures (no polling timeouts)
- #104 - Background launch timeout (atomic API, no 30s race)
- #122 - UUID reuse (Forge worktree isolation)

**Action After Merge:**
1. Validate each issue scenario with Forge backend
2. Close with note: "Fixed by Forge executor replacement (#143)"
3. Clean slate for RC29

---

## 🔥 ACTIVE FORGE TASKS

### **In Progress (2):**
1. **112fbf0b** - Create Advanced Forge MCP Server (FastMCP integration)
2. **336a4dfe** - [WISH] #120-executor-replacement (parent investigation)

### **In Review (3):**
1. **b91ba10d** - Fix critical bug in run.ts:104 (PR #146 blocker) 🔴 CRITICAL
2. **5fcd097d** - Implement Wish #120-A (ready to start)
3. **f09d6d78** - Report pre-push hook worktree issue

### **Done (7):**
- ✅ Session name architecture complete
- ✅ Filesystem audit complete (violations fixed)
- ✅ Migration strategy complete
- ✅ Protocol violations learned
- ✅ RC27 release tasks

---

## 📈 RC28 SUCCESS CRITERIA

**Functional:**
- ✅ Session name architecture merged (#146)
- ⏳ Forge executor drop-in replacement complete (#143)
- ⏳ 6 critical bugs eliminated
- ⏳ All tests passing

**Performance:**
- ⏳ Session creation < 5s (vs. 5-20s current)
- ⏳ 10+ parallel sessions safe
- ⏳ 0% timeout failures

**Code Quality:**
- ⏳ 40% code reduction (~270 lines deleted)
- ⏳ Zero worktree violations
- ⏳ Migration script validated

---

## 🚀 NEXT ACTIONS

**Immediate:**
1. ✅ Rename branch: 115-session-name-architecture → rc28
2. 🔴 Fix run.ts:104 critical bug (storage key)
3. Merge PR #146 (session names) to rc28
4. Start Forge task 5fcd097d (Wish #120-A implementation)
5. Monitor Forge MCP server task (112fbf0b)

**After Wish #120-A Complete:**
1. Validate 6 obsolete issues are truly fixed
2. Close obsolete issues with evidence
3. Version bump to v2.4.0-rc.28
4. Release RC28 to GitHub
5. Plan RC29 (Wish #120-B: Enhanced features)

---

**Command:** RC28 active - Forge integration foundation in progress
