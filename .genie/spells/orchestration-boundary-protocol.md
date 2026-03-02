# 📘 Orchestration Boundary Protocol Playbook

**Priority:** 🔴 CRITICAL
**Category:** Core Discipline
**Created:** 2025-10-21

---

## 🎯 Strategies and Hard Rules

### The Core Principle

**Once Forge task attempt starts → Base Genie STOPS touching implementation**

This is the fundamental boundary between orchestration (planning, coordinating) and execution (implementing, fixing).

### When Genie CAN Touch Files

**✅ Permitted:**
- [orchestration-001] helpful=0 harmful=0: ✅ No Forge task exists for this work (permitted to edit)
- [orchestration-002] helpful=0 harmful=0: ✅ Pure orchestration files like SESSION-STATE.md, MASTER-PLAN.md (permitted)
- [orchestration-003] helpful=0 harmful=0: ✅ Emergency hotfix when Forge unavailable (permitted with caution)
- [orchestration-004] helpful=0 harmful=0: ✅ Meta-learning: creating/updating .genie/spells/ (permitted direct execution)

**❌ Forbidden:**
- [orchestration-005] helpful=0 harmful=0: ❌ Forge task attempt is active for this work (forbidden to edit)
- [orchestration-006] helpful=0 harmful=0: ❌ Implementation work: bug fixes, features, refactoring (forbidden, delegate to Forge)
- [orchestration-007] helpful=0 harmful=0: ❌ Files owned by specialized agents like Git agent (forbidden, delegate properly)

### Post-Delegation Responsibilities

**After delegating to Forge, Genie:**
- [orchestration-008] helpful=0 harmful=0: ✅ Monitors progress (check Forge status via MCP)
- [orchestration-009] helpful=0 harmful=0: ✅ Answers questions if Forge executor asks
- [orchestration-010] helpful=0 harmful=0: ✅ Coordinates with other agents (multi-agent orchestration)
- [orchestration-011] helpful=0 harmful=0: ✅ Plans next steps (strategic planning post-execution)
- [orchestration-012] helpful=0 harmful=0: ✅ Reviews when complete (quality assurance role)
- [orchestration-013] helpful=0 harmful=0: ❌ Edits code files (forbidden after delegation)
- [orchestration-014] helpful=0 harmful=0: ❌ Implements fixes (forbidden, that's Forge's job)
- [orchestration-015] helpful=0 harmful=0: ❌ Duplicates Forge's work (critical boundary violation)

---

## 🔄 Common Patterns

### Pattern 1: Correct Delegation Flow

**User Request:** "Fix bug #168 (graceful shutdown)"

**Genie's Workflow:**
1. ✅ Create Forge task (if none exists)
2. ✅ Start task attempt (isolated worktree created)
3. ✅ **STOP** - Forge executor takes over
4. ✅ Monitor progress (check Forge status)
5. ✅ Review when complete
6. ✅ Coordinate PR/merge if needed

**What Genie Does NOT Do:**
- [orchestration-016] helpful=0 harmful=0: ❌ Start implementing after creating task (boundary violation)
- [orchestration-017] helpful=0 harmful=0: ❌ Edit files in main workspace while Forge works (creates conflicts)
- [orchestration-018] helpful=0 harmful=0: ❌ Duplicate Forge's work (critical anti-pattern)
- [orchestration-019] helpful=0 harmful=0: ❌ Assume agent failed when can't view progress (check worktree first!)

### Pattern 2: Meta-Learning vs Forge Decision

**Meta-Learning (Direct):**
- Document patterns
- Create spells
- Update framework
- Learning documentation

**Forge (Delegation):**
- Implement features
- Fix bugs
- Build systems
- Code refactoring

---

## 💻 Code Snippets and Templates

### Worktree Verification Commands

```bash
# List all active worktrees
ls /var/tmp/automagik-forge/worktrees/

# Navigate to specific worktree (use task ID prefix)
cd /var/tmp/automagik-forge/worktrees/<task-id-prefix>*

# Check if agent has been committing
git log --oneline -5

# Check working directory status
git status

# Check recent file activity
ls -lt | head -10
```

### Pre-Edit Safety Check Script

```bash
# Before editing ANY implementation file, run:

# 1. Check for active Forge sessions
mcp__genie__list_sessions

# 2. Check worktree status
ls /var/tmp/automagik-forge/worktrees/

# 3. If worktree exists for this work → STOP
# Let Forge executor handle it
```

---

## 🔧 Troubleshooting and Pitfalls

### Pitfall 1: The Violation Pattern

**What Happened (Bug #168):**
1. Base Genie created Forge task
2. Base Genie started task attempt b51db539 (isolated worktree)
3. Base Genie THEN started implementing in main workspace ❌
4. **Result:** Duplicate work, boundary violation, confusion

**Why This Is Critical:**
- Forge executor is ALREADY working in isolated worktree
- Base Genie editing same files = conflict + duplication
- Violates core principle: Genie = orchestrator, NOT implementor

**How to Avoid:**
Follow the enforcement checklist (see Verification section)

### Pitfall 2: Assuming Failure When Monitoring Fails

**Problem:**
Forge MCP monitoring fails (can't view session, backend unreachable) → Genie assumes agent failed → Genie starts implementing ❌

**Solution:**
CHECK THE WORKTREE FIRST before assuming failure

**Commands:**
```bash
# Navigate to worktree
cd /var/tmp/automagik-forge/worktrees/b51d*  # Example: task b51db539

# Check if agent has been committing
git log --oneline -3

# Output example:
# b8913b23 fix: Use workspace package version for update detection
```

**Interpretation:**
- [orchestration-020] helpful=0 harmful=0: ✅ Commits exist in worktree → Agent is working successfully!
- [orchestration-021] helpful=0 harmful=0: ✅ Recent changes in worktree → Agent progressing normally
- [orchestration-022] helpful=0 harmful=0: ❌ No commits AND task old → Might be stalled (investigate)
- [orchestration-023] helpful=0 harmful=0: ❌ Worktree doesn't exist → Task not started (safe to work)

**Real-World Example (Bug #168):**
While Base Genie was implementing duplicate work, fix agent had ALREADY completed the fix in its worktree. Monitoring failed, but agent succeeded.

**Lesson:** Infrastructure issues ≠ Agent failures. Always check worktree before assuming failure.

**Related:** `@.genie/spells/troubleshoot-infrastructure.md` (5-step diagnostic protocol)

---

## 📚 Domain-Specific Knowledge

### Worktree Isolation Architecture

**How Forge Works:**
- Each task attempt = isolated git worktree
- Location: `/var/tmp/automagik-forge/worktrees/<task-id-prefix>*/`
- Independent workspace (doesn't affect main repo)
- Agent commits to worktree branch
- Success → merge to target branch
- Failure → discard worktree

**Why This Matters:**
- [orchestration-024] helpful=0 harmful=0: Genie's main workspace ≠ Forge executor's worktree (different locations)
- [orchestration-025] helpful=0 harmful=0: Editing main workspace while Forge works = boundary violation (creates conflicts)
- [orchestration-026] helpful=0 harmful=0: Always check worktree to see actual progress (monitoring infrastructure may fail)

### Agent Responsibility Matrix

- [orchestration-027] helpful=0 harmful=0: Implementation work → Forge executor (Base Genie: orchestrate, monitor only)
- [orchestration-028] helpful=0 harmful=0: Git operations → Git agent (Base Genie: delegate, don't execute)
- [orchestration-029] helpful=0 harmful=0: Meta-learning → Base Genie direct execution (update spells, patterns)
- [orchestration-030] helpful=0 harmful=0: Orchestration files → Base Genie direct execution (SESSION-STATE.md, plans)
- [orchestration-031] helpful=0 harmful=0: Emergency hotfix → Base Genie if no Forge available (execute with caution)

### Historical Context

**First Documented Violation:**
- **Date:** 2025-10-21 ~05:45 UTC
- **Bug:** #168 (graceful shutdown)
- **Task attempt:** b51db539
- **Files affected:** src/cli/genie-cli.ts (historical - old path structure)
- **Root cause:** Unclear boundaries between orchestration vs execution
- **Pattern recognized by:** Felipe (user feedback)
- **Learning applied:** This playbook created

**Amendment Status:**
This protocol became Amendment #4 in AGENTS.md: "Orchestration Boundary - Once Delegated, Never Duplicated"

---

## ✅ Verification Checklist

Before editing ANY implementation file, Base Genie must verify:

### 1. Active Task Check
- [orchestration-032] helpful=0 harmful=0: [ ] Check SESSION-STATE.md for active attempts before editing
- [orchestration-033] helpful=0 harmful=0: [ ] Run `mcp__genie__list_sessions` to see running tasks
- [orchestration-034] helpful=0 harmful=0: [ ] **If active task exists for this work → STOP** (let executor handle it)

### 2. Worktree Status Check
- [orchestration-035] helpful=0 harmful=0: [ ] List worktrees: `ls /var/tmp/automagik-forge/worktrees/`
- [orchestration-036] helpful=0 harmful=0: [ ] Navigate to relevant worktree (if exists)
- [orchestration-037] helpful=0 harmful=0: [ ] Check commits: `git log --oneline -5` (verify agent activity)
- [orchestration-038] helpful=0 harmful=0: [ ] Check status: `git status` (see working changes)
- [orchestration-039] helpful=0 harmful=0: [ ] **If commits exist → Agent is working! DO NOT DUPLICATE**

### 3. Agent Responsibility Check
- [orchestration-040] helpful=0 harmful=0: [ ] Is this implementation work? → Forge executor (delegate)
- [orchestration-041] helpful=0 harmful=0: [ ] Is this orchestration? → Base Genie OK (proceed)
- [orchestration-042] helpful=0 harmful=0: [ ] Is this learning? → Meta-learn protocol (use learn spell)
- [orchestration-043] helpful=0 harmful=0: [ ] Is this git operations? → Git agent (delegate properly)

### 4. Work Type Classification
- [orchestration-044] helpful=0 harmful=0: [ ] Is this exploration (reading, analyzing)? → OK for Genie (proceed)
- [orchestration-045] helpful=0 harmful=0: [ ] Is this execution (editing, implementing)? → Delegate (boundary rule)

### 5. Quick Decision Tree

```
Are you about to edit an implementation file?
│
├─ YES → Is there an active Forge task for this work?
│         │
│         ├─ YES → STOP ❌ (Let Forge handle it)
│         │
│         └─ NO → Are you the right agent for this?
│                  │
│                  ├─ Implementation → Delegate to Forge
│                  │
│                  └─ Orchestration/Learning → Proceed ✅
│
└─ NO → Proceed ✅
```

**Remember:** Once delegated, never duplicated.
