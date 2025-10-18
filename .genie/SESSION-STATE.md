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

### **Phase 1: Foundation (Session Names) ✅ COMPLETE**

**Issue #146 - Session Name Architecture**
- Status: ✅ Implementation complete, ready to merge
- Branch: rc28 (consolidated)
- **Why first:** Names align with Forge task names (foundation)

**Forge Tasks:**
- ✅ 93672720 - Complete session name implementation (DONE)
- ✅ 31a28932 - Review session name architecture (DONE)
- ✅ b91ba10d - Fix critical bug in run.ts:104 (DONE - verified at line 106)
- ✅ eaed664f - Pre-push hook worktree fix (DONE - 2025-10-18 21:47 UTC)

---

### **Phase 2: Core Replacement (Wish #120-A) 🟢 READY**

**Issue #143 - Forge Drop-In Replacement**
- Status: 🟢 UNBLOCKED - POC exists, ready for handler integration
- Discovery: forge-executor.ts POC EXISTS (308 lines, complete implementation)
- Scope: 9 core endpoints, ZERO user-facing changes
- Impact: Eliminates 6+ critical bugs simultaneously

**Discoveries Complete:**
- ✅ e46f87c2 - Filesystem restrictions audit (3 violations fixed in view.ts + resume.ts)
- ✅ c8b8a793 - Migration script design (hybrid strategy)
- ✅ **POC exists (2025-10-18 21:50 UTC):** `.genie/cli/src/lib/forge-executor.ts` (308 lines)

**Forge Task:**
- 🟡 5fcd097d - Wish #120-A (READY - POC verified, proceed with handler integration)

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

### **In Progress (1):**
1. **ec628d52** - Integrate forge-executor.ts handlers (Wish #120-A Group A)
   - Attempt: 465cb0df (started 2025-10-18)
   - Status: 🟢 EXECUTING handler integration
   - Branch: Will create from main
   - Tasks: 8 handler updates + file deletion (~270 lines)

### **Done (13):**
- ✅ **5fcd097d** - Wish #120-A POC + discoveries (COMPLETE)
- ✅ **b9884d4f** - Protocol violations learned (context-based routing)
- ✅ forge-executor.ts POC verification (exists at 308 lines)
- ✅ b91ba10d - Critical run.ts:104 bug fix (verified)
- ✅ eaed664f - Pre-push hook worktree fix (implemented)
- ✅ 93672720 - Session name implementation
- ✅ 31a28932 - Session name review
- ✅ e46f87c2 - Filesystem audit (violations fixed)
- ✅ c8b8a793 - Migration strategy design
- ✅ RC27 release tasks

### **Status Unknown (404 error):**
- ❓ **112fbf0b** - Create Advanced Forge MCP Server (may be deleted/moved)
- ❓ **336a4dfe** - [WISH] #120-executor-replacement (parent investigation)

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

**Currently Executing (Forge Task ec628d52):**
- ✅ Task created: Integrate forge-executor.ts handlers
- ✅ Attempt started: 465cb0df (2025-10-18)
- 🔄 **IN PROGRESS:** Claude Code executor performing handler integration
- 📍 Monitor: `mcp__automagik_forge__get_task(task_id="ec628d52-b587-4b50-bc52-e9a8e13ad8f8")`

**What's Being Integrated:**
1. Update handlers/run.ts → use forge-executor.ts
2. Update handlers/resume.ts → use forge-executor.ts
3. Update handlers/stop.ts → use forge-executor.ts
4. Update handlers/list.ts → use forge-executor.ts
5. Update handlers/view.ts → use forge-executor.ts
6. Delete background-launcher.ts (~120 lines)
7. Delete background-manager.ts (~150 lines)
8. Update imports across codebase

**After Integration Complete:**
1. Review PR created by Forge executor
2. Merge to rc28 branch
3. Validate 6 obsolete issues are truly fixed
4. Close obsolete issues with evidence
5. Version bump to v2.4.0-rc.28
6. Release RC28 to GitHub
7. Plan RC29 (Wish #120-B: Enhanced features)

---

**Command:** RC28 active - Forge integration foundation in progress
