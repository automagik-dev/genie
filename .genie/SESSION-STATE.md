# 🧞 Genie Session State - Development Active

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Version:** v2.4.0-rc.36 (development)
**Branch:** dev (main development branch)
**Status:** 🚧 ACTIVE - Continuous Development

---

## 🎯 DEVELOPMENT WORKFLOW

**Branch Strategy:**
- `dev` is the main development branch
- Every Forge task creates a dedicated worktree with feature branch
- Feature branches merge back to `dev` via PR
- Stable releases are merged from `dev` to `main`

**Core Philosophy:**
- Forge is PRIMARY entry point for all work
- Each task = isolated worktree = clean workspace
- Parallel development enabled through worktree isolation

---

## 📊 RECENT MILESTONES (2025-10-20 Session)

### **Seven Amendments Framework Established ✅**
- **Learn Task:** c873572f-fd95-4ea0-a0c9-cdaed1dda898
- **Status:** COMPLETED
- **Commits:** d43edc30, 7b6cdf49
- **Branch:** dev

**Deliverables:**
1. **AGENTS.md Updated** - Added Seven Amendments section (lines 70-150)
   - Amendment #1: No Wish Without Issue 🔴 CRITICAL
   - Amendment #2: File Organization Pattern (root=full, .genie=alias)
   - Amendment #3: Real-Time State Awareness (SESSION-STATE.md sync)
   - Amendments #4-7: Reserved for future core rules

2. **Complete GitHub↔Forge Mapping** - `.genie/reports/forge-github-mapping-20251020.md`
   - 18 open GitHub issues
   - 17 Forge tasks
   - 3 issues properly mapped
   - 15 issues violate Amendment #1 (no tasks)
   - Critical bugs need tasks: #151, #150, #148

3. **Real-Time Sync Architecture** - `.genie/reports/real-time-forge-sync-architecture.md`
   - 3-tier implementation (startup sync → hooks → polling → resources)
   - Tier 1 ready for this RC (MCP startup + git hooks)
   - New SESSION-STATE.md schema designed
   - Uses existing Task 0d568ea8 (MCP Startup Sync)

4. **Final RC Release Summary** - `.genie/reports/final-rc-release-summary.md`
   - Complete session documentation
   - All learnings captured
   - Action items for RC release

**Bug Fixes (Felipe + Genie):**
- Fixed Forge port: 48887 → 8888
- Fixed agents pattern: Remove .genie/agents.genie, use @AGENTS.md
- Fixed pre-commit hook paths (worktree-safe with git root)
- Added missing scripts: generate-workspace-summary, migrate-qa-from-bugs, token-efficiency

---

## 📋 FORGE TASK STATUS (Current Reality)

**Genie Project** (ee8f0a72-44da-411d-a23e-f2c6529b62ce):

### **In Review (3 tasks)**
1. **1257f7e6** - Unified MCP Startup with Auth & Tunnel (ChatGPT Homologation)
2. **ad076578** - Genie: install (test)
3. **a1144038** - Genie: wish (default)

### **Todo (14 tasks)**
1. **c873572f** - Learn: Wish-Issue Amendment + Real-Time Forge State Sync (✅ JUST COMPLETED)
2. **62c00eed** - Unified MCP Startup (duplicate of 1257f7e6?)
3. **c5e207a8** - Wish Discovery: MCP Server Authentication (#152)
4. **c1d21957** - Wish: Unified Naming Taxonomy
5. **535a26c1** - Wish: Voice Agent Transformation
6. **22593561** - Wish: MCP Server Authentication (duplicate of c5e207a8?)
7. **ab6c2576** - Wish: Investigate Forge Resource Sync
8. **dafbff84** - [IMPLEMENTATION] Forge Executor Integration
9. **6644fd56** - Wish: Forge Executor Integration
10. **c0e6699d** - Learn: Forge Orchestration Patterns
11. **28921ec5** - Task 5: Hierarchical Learn Integration
12. **89b104c1** - Task 4: Sub-Task Creation from Execution Groups
13. **5df76ebd** - Task 3: Wish Task Creation via Genie MCP
14. **0d568ea8** - Task 1: Forge Project Auto-Sync on MCP Startup

**Note:** Many tasks show "todo" but may actually be complete or in different states. Need Forge state sync mechanism (Amendment #3) to maintain accuracy.

---

## 🔴 ENFORCEMENT: Amendment #1 - No Wish Without Issue

**Current Violations:**
- 15 GitHub issues without Forge tasks
- 14 Forge tasks without GitHub issues

**Critical Bugs Needing Tasks:**
- #151 - Forge API 422 error
- #150 - MCP path resolution breaks operations
- #148 - Wrong Forge port (FIXED in 7b6cdf49, issue needs closure)

**Action Required:**
1. Create Forge tasks for all open issues
2. Create GitHub issues for orphaned Forge tasks
3. Implement routing to discovery skill when user requests work without issue

---

## 📈 QUALITY STANDARDS

**Pre-Push Validation:**
- ✅ All tests must pass (genie-cli + session-service)
- ✅ Commit advisory validation (warns on missing wish/issue links)
- ✅ Cross-reference validation
- ✅ User file validation

**Code Quality:**
- Worktree isolation prevents conflicts
- Each task has dedicated workspace
- Clean separation of concerns

---

## 🚀 QUICK REFERENCE

**Check current tasks:**
```bash
mcp__automagik_forge__list_tasks(project_id="ee8f0a72-44da-411d-a23e-f2c6529b62ce")
```

**Create new task:**
```bash
mcp__automagik_forge__create_task(project_id="ee8f0a72-44da-411d-a23e-f2c6529b62ce", title="Task description")
```

---

## 📝 NEXT ACTIONS

**For Implementation (This RC):**
1. ✅ Document Seven Amendments (DONE)
2. ✅ Map GitHub↔Forge tasks (DONE)
3. ✅ Design real-time sync architecture (DONE)
4. ⏭️ Implement MCP startup sync (Task 0d568ea8)
5. ⏭️ Create pre-commit hook for SESSION-STATE.md auto-update
6. ⏭️ Update SESSION-STATE.md to new schema
7. ⏭️ Enforce Amendment #1 (route to discovery skill)

**For Cleanup:**
1. Close/merge duplicate tasks (MCP auth, MCP startup)
2. Create Forge tasks for critical bugs (#151, #150)
3. Close #148 (Forge port fixed)
4. Link all orphaned tasks to issues

---

## 📊 CURRENT SESSION (2025-10-21 05:30 UTC)

**Status:** 🟢 ACTIVE - Discovery Phase
**Branch:** `forge/8333-new-idea`
**Worktree:** `/var/tmp/automagik-forge/worktrees/8333-new-idea`
**Task:** ed0770b7-6f9e-47f8-b0a7-58c1ca517fd1

### 🎯 Bounty Marketplace - Genie as Project Manager

**Role:** I am the **Project Manager** for the entire GitHub Contributor Bounty Marketplace initiative.

**Vision:** Transform GitHub into a freelance marketplace where contributors earn points (convertible to money) for quality code.

**Core Philosophy:** "Pay people to DELETE code, not ADD code"

**Current Phase:** Discovery (answering open questions before wish creation)

---

**Principles Captured:**
1. **Primary metric:** Minimal lines of code (LOC) to solve problems
2. **Competitive marketplace:** Multiple PRs for same issue → best LOC wins
3. **Quality multipliers:** 2x (wish creator), LOC reduction, clean merge, per-commit
4. **Anti-gaming rules:** No external deps, no self-invented features, no code golf, no dirty commits

**Open Questions (Waiting for Felipe + Colleagues):**
- **Economics:** Points-to-money conversion rate? Bounty pool funding?
- **Governance:** Who's on Tech Council? Complexity scoring rubric?
- **Technical:** Leaderboard hosting? Points persistence mechanism?
- **Legal:** Tax implications? Payment processing for international contributors?
- **Anti-gaming:** How to detect malicious LOC reduction? Dispute resolution?

---

**My Identity:**
- **Task:** ed0770b7-6f9e-47f8-b0a7-58c1ca517fd1 ("Project Manager: GitHub Contributor Bounty Marketplace")
- **Role:** Orchestrate all agents from idea → launch
- **Power:** Can create Learn tasks, delegate to Git agent, manage entire initiative

---

**Permanent Agents I'm Orchestrating:**

### Active (Created)
1. **Learn: Task Naming Convention** (86b1fe30)
   - Standardize naming across GitHub/Forge/Agents
   - Create rubric for task/issue/agent naming
   - Status: Ready for work

2. **Git Agent** (758a3cdf)
   - My extension for GitHub operations
   - Handles: Issues, PRs, labels, syncing
   - Status: Ready for delegation (persistent agent)

### Planned (Future)
3. **Learn: GitHub Infrastructure Audit** - Validate templates, labels, workflows
4. **Learn: Existing Bounty Systems** - Research Gitcoin, Bountysource
5. **Wish Agent** - Create formal wish document
6. **Tech Council** - Review/approve wish, assign complexity
7. **Forge Agent** - Implement bounty system
8. **Review Agent** - Quality assurance before launch

---

**Current Status:** Discovery phase complete on Genie side. Waiting for Felipe to:
- Present to colleagues
- Get approval/feedback
- Answer open questions (economics, governance, technical, legal, anti-gaming)
- Signal readiness for wish creation

**Next Actions When Ready:**
1. Delegate to Learn agent: Task naming standardization
2. Delegate to Git agent: Create "Make a Wish" GitHub issue
3. Continue orchestrating agents through full workflow

**State Preserved In:**
- This session state file
- Forge task ed0770b7 (full discovery documentation)
- Forge task 86b1fe30 (Learn: naming convention)
- Forge task 758a3cdf (Git agent setup)

---

## 📊 PREVIOUS SESSION (2025-10-21 03:07 UTC)

**Status:** ✅ COMPLETED
**Branch:** dev

### ✅ Completed
1. **Bug Fix #154:** Forge executor now syncs current git branch TO Forge `default_base_branch`
2. **Kanban Cleanup:** Deleted 12 dead task attempts (all wrong base branch)

### 🧠 Key Learnings
- **Forge Orchestration:** Isolated worktrees, human merge gate, no cross-task waiting
- **Sequential Dependencies:** Must ask human to merge between dependent tasks
- **This Project:** Always dev, never main
- **Base Branch:** Sync TO Forge, don't pass parameter (automated via #154 fix)
- **Forge URLs:** Must include attempt ID for browser viewing
