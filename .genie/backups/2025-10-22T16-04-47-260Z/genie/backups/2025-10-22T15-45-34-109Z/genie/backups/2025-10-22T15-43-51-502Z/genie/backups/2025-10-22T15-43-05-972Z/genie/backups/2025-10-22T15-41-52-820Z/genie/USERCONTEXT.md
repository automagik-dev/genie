# 🧞 Genie User Context: Felipe - Development Mode

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Current Repo:** automagik-genie
**Version:** v2.4.0-rc.33 (development)
**Branch:** dev (main development branch)
**Mode:** Continuous Development via Forge

---

## 📊 Quick Status

**Current Mode:** Continuous Development
- `dev` branch is the main development branch
- Every task creates isolated worktree from `dev`
- Feature branches merge back to `dev` via PR
- Stable releases merged from `dev` to `main`

**Development Pattern:**
**"Forge-first, worktree-isolated, PR-driven workflow"**

---

## 🎯 Working Relationship

Felipe + Genie = Collaborative orchestration via Forge
- **Forge:** PRIMARY entry point for all work (issue → task card → worktree → PR)
- **Genie:** Orchestrates Forge tasks, monitors progress, coordinates agents
- **Felipe:** Strategic decisions, approvals, merge operations

---

## 📌 Dev Branch Workflow

**Branch:** dev (main development branch)
**Purpose:** All development work merges here before release

**Workflow:**
1. Create task in Forge (manual or from GitHub issue)
2. Forge creates dedicated worktree + feature branch from `dev`
3. Implement changes in isolated worktree
4. PR merges feature branch back to `dev`
5. When stable → merge `dev` to `main` as release

**Benefits:**
- Complete workspace isolation (no conflicts)
- Parallel development enabled
- Clean feature integration
- Continuous validation via pre-push hooks

---

## 🧠 Felipe's Preferences & Patterns

**Communication Style:**
- Direct, concise updates
- Evidence-based decisions
- No unnecessary pleasantries
- Strategic pivots when needed

**Development Philosophy:**
- Focus on high-impact work
- Eliminate root causes, not symptoms
- Forge as primary entry point (not optional)
- Worktree isolation for all tasks

**Decision Patterns:**
- Quick strategic pivots when needed
- Trusts Genie to orchestrate details
- Wants visibility (Forge task cards)
- Prefers clean, isolated development

**Learned Patterns (2025-10-19):**
- **Delegation:** Genie orchestrates, doesn't execute (wish → forge → review)
- **Monitoring:** Active sleep loop, not passive waiting
- **Teams:** Tech Council for architectural decisions (nayr, oettam, jt)
- **Context:** Never lose context - full recovery from worktrees
- **Terminology:** "Hive" not "collective" (flat agent structure)
- **Architecture Corrections:** No "fixed tasks" - state="agent" created on-demand
- **Branch Strategy:** Genie=dev, Forge=main, Wishes=feat/<slug>, Sub-tasks=worktrees
- **Integration:** forge.md creates Forge sub-tasks via API (not just files)
- **Hierarchy:** Project Learn + wish Learn sub-tasks (two-tier)
- **🔴 Critical Blockers:** Forge backend changes required before Genie work continues
  - Felipe must execute + publish Forge Tasks 2, 6, 7 (new version release)
  - Genie integration CANNOT proceed without new Forge API features

**Learned Patterns (2025-10-21):**
- **Forge Orchestration:** Isolated worktrees = tasks can't see each other's changes until merged
- **Human Merge Gate:** Only humans merge tasks, agents never merge (quality control)
- **Sequential Dependencies:** If Task B needs Task A's changes → STOP and ask human to merge Task A first
- **No Cross-Task Waiting:** Tasks can't wait for each other (isolated environments)
- **Parallel Tasks:** Independent tasks CAN run in parallel
- **This Project = dev:** Always base on dev, never main for this project
- **Base Branch Automation:** Sync current git branch TO Forge `default_base_branch`, don't pass parameter
- **Forge URLs:** Must include attempt ID: `http://localhost:8887/projects/{proj}/tasks/{task}/attempts/{attempt}?view=diffs`
- **State Files:** Use USERCONTEXT.md + SESSION-STATE.md for session continuity, not ad-hoc files
- **File Creation:** Reports go in `.genie/reports/` and require permission first
- **Kanban Hygiene:** Delete dead task attempts immediately, don't leave mess

---

## 📋 Quick Reference

**Current Setup:**
- Branch: dev (main development)
- Base branch for all tasks: dev
- Worktree isolation: enabled
- Forge integration: active

**Starting New Work:**
1. Create Forge task (with project_id)
2. Start task attempt (executor="CLAUDE_CODE", base_branch="dev")
3. Work happens in isolated worktree
4. PR merges back to dev

**Check Active Tasks:**
```bash
mcp__automagik_forge__list_tasks(project_id="<project_id>")
```

---

**Status:** ✅ READY - Dev branch workflow established

**Workflow:** Task → Worktree → Feature Branch → PR → Dev
