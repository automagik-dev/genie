---
name: Troubleshoot Infrastructure (When Delegation Monitoring Fails)
description: Protocol for diagnosing infrastructure issues vs actual agent failures. Check infrastructure first, never assume failure.
---

# Troubleshoot Infrastructure - When Delegation Monitoring Fails

## Core Principle

**Backend unreachable ≠ Agent stalled. Infrastructure issue ≠ Agent failure.**

When delegation monitoring fails (can't view session, Forge unreachable, worktree inaccessible), diagnose infrastructure FIRST before assuming agent failed.

## The Anti-Pattern

❌ **Wrong Response:**
1. Forge MCP returns "backend unreachable"
2. Assume agent stalled or failed
3. Start implementing work yourself
4. Violate "Once Delegated, Never Duplicated"

✅ **Correct Response:**
1. Forge MCP returns error
2. Diagnose infrastructure systematically
3. Check if agent actually working (worktree check)
4. Report bug if infrastructure issue
5. Resume/restart if needed, NEVER duplicate

## Diagnostic Protocol

### Step 1: Check Forge Health

**Test if Forge backend is responsive:**
```javascript
mcp__forge__list_projects()
```

**If this fails:**
- Forge backend may be down
- MCP connection issue
- Network/Docker problem

**Action:** Report infrastructure issue, don't assume agent failed

### Step 2: Check Task Status Directly

**Even if view fails, try direct task query:**
```javascript
mcp__forge__get_task(task_id="...")
mcp__forge__get_task_attempt(attempt_id="...")
```

**If this succeeds:**
- Backend is working
- View endpoint may have specific issue
- Agent may be progressing fine

**Action:** Use task status, not view, for monitoring

### Step 3: Check Worktree for Activity

**Agent works in isolated worktree - check it directly:**
```bash
# List all worktrees
ls /var/tmp/automagik-forge/worktrees/

# Navigate to specific worktree
cd /var/tmp/automagik-forge/worktrees/<task-id-prefix>*

# Check if agent has been committing
git log --oneline -5

# Check working directory status
git status

# Check recent activity
ls -lt | head -10
```

**If commits exist:**
- Agent is working successfully!
- Monitoring failed, but agent didn't
- Infrastructure issue, not agent issue

**Action:** Trust the worktree, report monitoring bug

### Step 4: Report Infrastructure Bugs

**Don't silently work around infrastructure issues:**
```bash
# Create GitHub issue for infrastructure problem
gh issue create --title "Forge MCP view endpoint unreachable" \
  --body "Attempted to monitor task <id>, got error <msg>. Task status shows agent working, but can't view progress." \
  --label "bug,infrastructure"
```

**Why:** Infrastructure bugs must be tracked and fixed, not silently tolerated

### Step 5: Resume or Restart (Never Duplicate)

**If agent actually stalled (no worktree commits, task stuck):**
```javascript
// Try resuming with follow-up
mcp__genie__resume(sessionId="...", prompt="Status check - are you still working?")

// Or restart task if truly stuck
// But NEVER implement yourself in main workspace
```

## Real-World Example

**Scenario:** Monitoring task b51db539 (update process fix)

**What Happened:**
1. Master Genie delegates to fix agent via Forge
2. `mcp__genie__view(sessionId)` returns "backend unreachable"
3. Master Genie gets anxious about progress visibility
4. **VIOLATION:** Master Genie starts editing genie-cli.ts, init.ts
5. Meanwhile: fix agent already completed work in worktree
6. Result: Duplicate work, wasted 40 minutes, Amendment #4 violated

**What Should Have Happened:**
1. Master Genie delegates to fix agent
2. `mcp__genie__view()` fails with "backend unreachable"
3. **Step 1:** Try `mcp__forge__list_projects()` → Works! Backend is fine
4. **Step 2:** Try `mcp__forge__get_task()` → Shows task in progress
5. **Step 3:** Check worktree:
   ```bash
   cd /var/tmp/automagik-forge/worktrees/b51d*
   git log --oneline -3
   # Shows: b8913b23 fix: Use workspace package version for update detection
   ```
6. **Discovery:** Agent completed work successfully! Monitoring failed, agent didn't.
7. **Step 4:** Report bug: "Genie MCP view endpoint unreachable while task running"
8. **Step 5:** No restart needed, agent succeeded. Merge worktree to main.

**Time Saved:** 40 minutes of duplicate work avoided

## Checklist Before Assuming Agent Failed

When delegation monitoring fails, check:

- [ ] Did I try `list_projects()` to test Forge health?
- [ ] Did I try `get_task()` instead of `view()`?
- [ ] Did I check the worktree for commits?
- [ ] Did I verify agent actually stalled vs monitoring failed?
- [ ] Did I report infrastructure bug?
- [ ] Am I about to violate "Once Delegated, Never Duplicated"?

## Why This Matters

**Master Genie anxiety about progress visibility MUST NOT trigger implementation work.**

Master Genie's role:
- ✅ Monitor progress (when monitoring works)
- ✅ Diagnose infrastructure issues
- ✅ Report bugs
- ✅ Coordinate next steps
- ❌ Implement when anxious about visibility
- ❌ Assume agent failed when infrastructure failed
- ❌ Duplicate agent's work

**Separation:** Infrastructure issues ≠ Agent failures. Diagnose correctly.

## Evidence

**Learning #7 Origin:** `learn.md` lines 152-164
**Learning #9 Origin:** `learn.md` lines 180-196
**Real violation:** Bug #168, task b51db539, 2025-10-21
**Analysis:** `/tmp/session-ultrathink-analysis.md` lines 108-126, 177-198, 294-312

## Related

- `@.genie/spells/orchestration-boundary-protocol.md` - Once delegated, never duplicated
- `@.genie/spells/orchestrator-not-implementor.md` - Role boundaries
- `AGENTS.md` Amendment #4 - Orchestration boundary protocol
