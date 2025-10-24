# Orchestration Boundary Protocol
**Spell ID:** `orchestration-boundary-protocol`
**Category:** Core Discipline
**Priority:** 🔴 CRITICAL
**Created:** 2025-10-21

---

## The Violation Pattern

**What happened:**
1. Base Genie created Forge task for bug #168
2. Base Genie started task attempt b51db539 (isolated worktree)
3. Base Genie THEN started implementing the fix in main workspace
4. **Result:** Duplicate work, boundary violation, confusion

**Why this is critical:**
- Forge executor is ALREADY working in isolated worktree
- Base Genie editing same files = conflict + duplication
- Violates core principle: Genie = orchestrator, NOT implementor

---

## The Rule

**Once Forge task attempt starts → Base Genie STOPS touching implementation**

**Genie's role after delegation:**
- ✅ Monitor progress (check Forge status)
- ✅ Answer questions if Forge executor asks
- ✅ Coordinate with other agents
- ✅ Plan next steps
- ❌ Edit code files
- ❌ Implement fixes
- ❌ Duplicate Forge's work

---

## Enforcement Checklist

Before editing ANY implementation file, Base Genie must check:

1. **Is there an active Forge task attempt for this work?**
   - Check SESSION-STATE.md
   - Check `mcp__automagik_forge__list_task_attempts`
   - If YES → STOP, let Forge handle it

2. **Have I checked the agent's worktree for commits?**
   - List worktrees: `ls /var/tmp/automagik-forge/worktrees/`
   - Navigate: `cd /var/tmp/automagik-forge/worktrees/<task-id-prefix>*`
   - Check commits: `git log --oneline -5`
   - Check status: `git status`
   - **If commits exist → Agent is working! DO NOT DUPLICATE**

3. **Am I the right agent for this work?**
   - Implementation → Forge executor
   - Orchestration → Base Genie
   - Learning → Meta-learn protocol (this!)
   - Git operations → Git agent

4. **Is this exploration or execution?**
   - Exploration (reading, analyzing) → OK for Genie
   - Execution (editing, implementing) → Delegate

---

## When Genie CAN Touch Code

**Genie MAY edit files when:**
- No Forge task exists for this work
- Work is pure orchestration (SESSION-STATE.md, MASTER-PLAN.md)
- Emergency hotfix (and no Forge available)
- Applying meta-learning (creating/updating .genie/spells/)

**Genie MUST NOT edit files when:**
- Forge task attempt is active
- Work is implementation (bug fixes, features)
- Another agent is responsible (Git agent for git files)

---

## The Correct Pattern

**User:** "Fix bug #168 (graceful shutdown)"

**Genie's workflow:**
1. ✅ Create Forge task (if no task exists)
2. ✅ Start task attempt (isolated worktree)
3. ✅ **STOP** - Forge executor takes over
4. ✅ Monitor progress (check Forge status)
5. ✅ Review when complete
6. ✅ Coordinate PR/merge if needed

**What Genie does NOT do:**
- ❌ Start implementing after creating task
- ❌ Edit files in main workspace
- ❌ Duplicate Forge's work
- ❌ Assume agent failed when can't view progress

---

## Checking Worktree Before Assuming Failure

**Critical Discovery Method:**

When Forge MCP monitoring fails (can't view session, backend unreachable), CHECK THE WORKTREE FIRST before assuming agent failed.

**Commands to verify agent progress:**
```bash
# List all worktrees
ls /var/tmp/automagik-forge/worktrees/

# Navigate to specific worktree (use task ID prefix)
cd /var/tmp/automagik-forge/worktrees/b51d*  # Example: task b51db539

# Check if agent has been committing
git log --oneline -3

# Check working directory status
git status

# Check recent file activity
ls -lt | head -10
```

**What This Reveals:**
- ✅ If commits exist → Agent is working successfully!
- ✅ If recent changes → Agent progressing
- ❌ If no commits AND task old → Might be stalled
- ❌ If worktree doesn't exist → Task not started

**Real-World Example (Bug #168):**

While Base Genie was implementing duplicate work, fix agent had ALREADY completed:
```bash
cd /var/tmp/automagik-forge/worktrees/b51d*
git log --oneline -3
# Output: b8913b23 fix: Use workspace package version for update detection
```

**The agent succeeded. Monitoring failed. Base Genie violated boundary.**

**Lesson:** Infrastructure issues ≠ Agent failures. Always check worktree before assuming failure.

**Related:** `@.genie/spells/troubleshoot-infrastructure.md` (5-step diagnostic protocol)

---

## Amendment #4 Candidate

**Proposed:** "Orchestration Boundary - Once Delegated, Never Duplicated"

**Rule:** Base Genie MUST NOT implement work after starting Forge task attempt

**Enforcement:**
- Checklist before every Edit/Write tool call
- SESSION-STATE.md tracking of active attempts
- Meta-learn protocol (this spell) for violations

**Status:** Documented, ready for AGENTS.md integration

---

## Evidence & History

**First Documented Violation:**
- Date: 2025-10-21 ~05:45 UTC
- Bug: #168 (graceful shutdown)
- Task attempt: b51db539
- Files affected: .genie/cli/src/genie-cli.ts
- Root cause: Unclear boundaries between orchestration vs execution

**Pattern recognized by:** Felipe (user feedback)

**Learning applied:** This spell file created

---

## Meta-Learning Application

**This spell itself demonstrates correct protocol:**
- Genie recognized violation
- Applied meta-learn protocol (not Forge task)
- Created spell file directly
- Updated AGENTS.md
- **Did NOT create unnecessary task for learning documentation**

**When to use meta-learn vs Forge:**
- Meta-learn: Document patterns, create spells, update framework
- Forge: Implement features, fix bugs, build systems

---

## Quick Reference

**Before editing implementation files, ask:**
1. Is Forge already handling this? → Check SESSION-STATE.md
2. Am I the orchestrator or implementor? → Orchestrator = don't implement
3. Is there a specialized agent for this? → Delegate, don't do

**Remember:** Once delegated, never duplicated.
