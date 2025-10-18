# 🧞 Genie Forge Task Orchestration - 2025-10-18

**Last Updated:** 2025-10-18 08:45 UTC
**Purpose:** Orchestrate 10 parallel Forge tasks → PRs → merge to main
**Model:** Each Forge task = one worktree + one genie + one PR

---

## 🚀 ACTIVE FORGE TASKS (10 total)

All base branch: **main** (switched from feat/self-updating-ecosystem after PR #106 merged)

### ✅ PHASE 1 COMPLETE: All Assessments Done

All 10 genies completed assessment/implementation phases on their worktrees.

---

## 📊 TASK ORCHESTRATION BOARD

### GROUP 1: Main Feature Development (3 tasks)

| Task | Genie | Branch | Status | Next |
|------|-------|--------|--------|------|
| **#1: agents-optimization** | Genie #1 | feat/agents-optimization | ✅ Assessment | Push + Create PR |
| **#2: rc21-session-lifecycle-fix** | Genie #2 | feat/rc21-session-lifecycle-fix | ✅ Assessment | Implement fixes |
| **#3: multi-template-architecture** | Genie #3 | feat/multi-template-architecture | ✅ Assessment | Implement Groups B-E |

### GROUP 2: Skills & Architecture (2 tasks)

| Task | Genie | Branch | Status | Next |
|------|-------|--------|--------|------|
| **#4: skills-prioritization** | Genie #4 | feat/skills-prioritization | ✅ Implemented | Validate + PR |
| **#5: genie-arch-rebrand** | Genie #5 | feat/genie-arch-rebrand | ✅ Group A done | Continue Groups B-E |

### GROUP 3: Infrastructure (2 tasks)

| Task | Genie | Branch | Status | Next |
|------|-------|--------|--------|------|
| **#6: backup-update-system** | Genie #6 | feat/backup-update-system | ✅ Assessment | Investigation + Design |
| **#7: bug-104 (timeout fix)** | Genie #7 | (ready for PR) | ✅ Tests + Docs | Final validation + PR |

### GROUP 4: Bug Investigations (2 tasks - RESOLVED)

| Task | Genie | Status | Issue | Next |
|------|-------|--------|-------|------|
| **#8: bug-66 (session resume)** | Genie #8 | ✅ RESOLVED | #66 closed | Convert to PR |
| **#9: bug-102 (session collision)** | Genie #9 | ✅ RESOLVED | #102 closed | Convert to PR |

### GROUP 5: Organization (1 task - COMPLETE)

| Task | Genie | Status | Result |
|------|-------|--------|--------|
| **#10: triage-incomplete-wishes** | Genie #10 | ✅ COMPLETE | 6 wishes archived, 2 kept |

---

## 🎯 CURRENT PHASE: PULL REQUEST CREATION

**Mission:** Each worktree → PR → ready for Felipe's review/merge

### Immediate Next Steps (Next 30 mins)

**Push to origin + create PRs:**
- ✅ Task #1 (agents-optimization): Commit changes, push branch, `gh pr create`
- ✅ Task #4 (skills-prioritization): Validate, push, `gh pr create`
- ✅ Task #7 (bug-104): Validate, push, `gh pr create`

**Continue implementation:**
- Task #2 (rc21-session-lifecycle-fix): Investigate + fix background-launcher.ts
- Task #3 (multi-template-architecture): Design → implement Groups B-E
- Task #5 (genie-arch-rebrand): Continue with Groups B-E
- Task #6 (backup-update-system): Investigate + design system

**Bug investigation PRs:**
- Task #8 (bug-66): Convert investigation doc to PR
- Task #9 (bug-102): Convert investigation doc to PR

---

## 🏗️ WORKTREE DIRECTORY STRUCTURE

```
/var/tmp/automagik-forge/worktrees/
├── ce4e-wish-agents-opti                 # Task #1
├── edf9-wish-rc21-sessio                 # Task #2
├── a5d7-wish-multi-templ                 # Task #3
├── 38c6-wish-skills-prio                 # Task #4
├── 5b96-wish-genie-arch                  # Task #5
├── c4cd-wish-backup-upda                 # Task #6
├── 3dc1-bug-104-mcp-back                 # Task #7
├── 5f1f-bug-66-mcp-sessi                 # Task #8
├── 8e5b-bug-102-mcp-sess                 # Task #9
└── 334a-triage-incomplet                 # Task #10
```

Each worktree = isolated workspace + feature branch + genie session

---

## 📌 GITHUB ISSUES CREATED

| Issue | Task | Status |
|-------|------|--------|
| #107  | Task #4 | OPEN (skills-prioritization) |
| #108  | Task #5 | OPEN (genie-arch-rebrand) |
| #109  | Task #2 | OPEN (rc21-session-lifecycle-fix) |
| #110  | Task #3 | OPEN (multi-template-architecture) |
| #111  | Task #1 | OPEN (agents-optimization) |
| #112  | Task #10 | OPEN (template-extraction) |
| #114  | Task #6 | OPEN (backup-update-system) |
| #66   | Task #8 | ✅ CLOSED (bug-66 resolved) |
| #102  | Task #9 | ✅ CLOSED (bug-102 resolved) |

---

## 💾 ORCHESTRATION STATE

**Parallel Execution:** 10 genies working in parallel on independent worktrees

**Synchronization Points:**
1. ✅ All assessments complete (2025-10-18 05:20-05:34 UTC)
2. 🔄 PR creation phase (2025-10-18 08:45-09:30 UTC target)
3. ⏳ Human review phase (Felipe reviews PRs)
4. ⏳ Merge to main (one by one as approved)

**No blocking dependencies** - all tasks work independently on their own branches

---

## 🎓 ORCHESTRATION RULES

1. **One Forge task = One worktree = One branch = One PR**
   - Each genie works in isolation
   - No conflicts between parallel genies
   - Each PR reviewed independently

2. **Base branch flow:** feat/self-updating-ecosystem → main (done) → new base for all tasks
   - PR #106 merged ✅
   - All 10 tasks use main as base now
   - Each creates own feature branch

3. **PR creation workflow:**
   - Genie commits changes to worktree branch
   - Push to origin: `git push origin feat/XXX`
   - Create PR: `gh pr create --base main`
   - Title: [TASK] Brief description
   - Body: Links to GitHub issue + wish document

4. **Success criteria per task:**
   - PR created and visible on GitHub
   - All commits traced (wish: or fixes #)
   - Tests passing (pre-push hooks)
   - Description clear for human review

---

## 🔄 NEXT INSTRUCTIONS FOR EACH GENIE

### Task #1: agents-optimization
```
PHASE 2: Create PR
- Commit: git add AGENTS.md && git commit -m "..."
- Push: git push origin feat/agents-optimization
- PR: gh pr create --base main --title "Optimize AGENTS.md (86% reduction)"
```

### Task #2: rc21-session-lifecycle-fix
```
PHASE 2: Implement session lifecycle fix
- Investigate: background-launcher.ts session creation logic
- Fix: V1→V2 format transition, session persistence
- Tests: Verify session creation doesn't fail after resume
- Commit: git commit -m "fix: session lifecycle bugs" ...
- PR: When complete
```

### Task #3: multi-template-architecture
```
PHASE 2: Implement template architecture
- GROUP B: Architecture design (draft design doc)
- GROUP C: Implementation (template generation logic)
- GROUP D: Testing (template rendering tests)
- GROUP E: Documentation (architecture guide)
- PR: When all groups complete
```

### Tasks #4-7: Similar pattern
- Validate → Commit → Push → PR create

---

## 📝 GENIE COORDINATION NOTES

- **All 10 tasks are independent** - work can proceed in parallel
- **No merge conflicts expected** - each on own feature branch
- **Human approval needed** - Felipe reviews each PR before merge
- **Token/context is local per worktree** - each genie has clean slate
- **Traceability** - each commit references wish or GitHub issue

---

**Status:** ✅ Ready for Phase 2 (PR creation) - Begin issuing next-phase instructions to each genie

