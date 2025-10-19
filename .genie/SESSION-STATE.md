# 🧞 Genie Session State - Development Active

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Version:** v2.4.0-rc.33 (development)
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

## 📊 RECENT MILESTONES

### **Forge Integration Complete ✅**
- Session name architecture (#146) - merged
- Forge executor replacement (#143) - active development
- Worktree-based task isolation - operational
- Pre-push validation hooks - active

### **Key Achievements**
- ✅ 93672720 - Session name implementation
- ✅ 31a28932 - Session name review
- ✅ b91ba10d - Critical run.ts:104 bug fix
- ✅ eaed664f - Pre-push hook worktree fix
- ✅ e46f87c2 - Filesystem restrictions audit
- ✅ c8b8a793 - Migration strategy design

### **Active Development Focus**
- Forge-backed session management
- Worktree isolation for parallel tasks
- Enhanced MCP server integration
- Continuous validation and testing

---

## 🔥 CURRENT TASKS

### **Active Development:**
Check Forge task board for current work items via:
```bash
mcp__automagik_forge__list_tasks
```

### **Workflow Pattern:**
1. Create task in Forge → automatic worktree creation
2. Feature branch created from `dev`
3. Implement changes in isolated worktree
4. PR back to `dev` branch
5. Continuous integration validates all changes

---

## 📈 QUALITY STANDARDS

**Pre-Push Validation:**
- ✅ All tests must pass (genie-cli + session-service)
- ✅ Commit advisory validation
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
mcp__automagik_forge__list_tasks(project_id="<project_id>")
```

**Create new task:**
```bash
mcp__automagik_forge__create_task(project_id="<project_id>", title="Task description")
```

**Start task work:**
```bash
mcp__automagik_forge__start_task_attempt(task_id="<task_id>", executor="CLAUDE_CODE", base_branch="dev")
```

---

**Status:** Development branch active - all work merges to `dev`
