---
name: Error Investigation Protocol
trigger: "Agent shows error but unclear if real failure"
answer: "Investigate with monitoring tools before panicking"
description: Proper response pattern when agent feedback seems broken or unclear
---

# Error Investigation Protocol


**When to use:** Agent tool (Genie MCP, Forge MCP) shows error messages but system state is unclear

**Trigger:** Seeing "unreachable" / "failed" / "error" messages in agent output

**Action:** INVESTIGATE → VERIFY → DECIDE (never panic and bypass)

---

## The Anti-Pattern (NEVER DO THIS)

```
See error message
  ↓
Assume system is broken
  ↓
Try to do work directly
  ↓
Create redundant sessions
  ↓
Bypass delegation
  ↓
Create chaos and lose work
```

**Evidence:** RC 37 release failure (2025-10-21)
- [error-001] helpful=0 harmful=0: Saw "Forge backend unreachable" in `genie view`
- [error-002] helpful=0 harmful=0: Panicked and tried to execute release manually
- [error-003] helpful=0 harmful=0: Created 3 redundant release agent sessions
- [error-004] helpful=0 harmful=0: Meanwhile, agents ACTUALLY COMPLETED SUCCESSFULLY
- [error-005] helpful=0 harmful=0: RC 37 published WITHOUT uncommitted changes
- [error-006] helpful=0 harmful=0: Lost work due to panic response

---

## The Correct Pattern (ALWAYS DO THIS)

```
See error message
  ↓
INVESTIGATE with monitoring tools
  ↓
Check actual system state
  ↓
Verify agent/process is running
  ↓
Trust delegation if state is healthy
  ↓
Wait with patience (use sleep intervals)
  ↓
Check results when complete
```

---

## Investigation Toolkit

### When `genie view` Shows Errors

**1. Check Genie MCP connectivity:**
```
mcp__genie__list_sessions
```
If this works, backend is fine (ignore "unreachable" message from genie view)

**2. Check session status:**
```
mcp__genie__list_sessions
```
Look for your session in "running" or "completed" state

**3. Check process list:**
```bash
ps aux | grep <executor-name>
# Examples: opencode, claude, cursor, gemini
```
Verify executor is running

**4. Check Forge process:**
```bash
ps aux | grep forge
netstat -tlnp | grep 8887  # Forge default port
```
Verify Forge backend is running and listening

**5. Wait with monitoring intervals:**
```bash
sleep 30  # Don't poll every second - be patient
# Then check status again
```

**6. View session details:**
```
mcp__genie__view(sessionId="...", full=true)
```
(Get full transcript and status details)

---

## Decision Tree

```
Error message appears
    ↓
Check Genie MCP (list_sessions)
    ↓
├─ Works → Backend is fine, trust delegation
│   ↓
│   Check session status
│   ↓
│   ├─ running → Wait patiently with sleep intervals
│   ├─ completed → Work complete, check results
│   ├─ success → Success, verify output
│   └─ failed → Investigate failure (read logs, check diffs)
│
└─ Fails → Backend is actually broken
    ↓
    Check backend process
    ↓
    ├─ Running → WebSocket/config issue
    │   ↓
    │   Check MCP server health
    │
    └─ Not running → Report blocker, restart Genie MCP
```

---

## Trust But Verify Protocol

### Trust
- [error-007] helpful=0 harmful=0: Agent sessions continue running even when view is broken
- [error-008] helpful=0 harmful=0: Genie backend executes tasks even when CLI shows errors
- [error-009] helpful=0 harmful=0: Executors (OpenCode/Claude/etc.) complete work autonomously
- [error-010] helpful=0 harmful=0: System is more robust than display suggests

### Verify
- [error-011] helpful=0 harmful=0: Use monitoring tools to check actual state
- [error-012] helpful=0 harmful=0: Check process list to confirm execution
- [error-013] helpful=0 harmful=0: Use Genie MCP to get real session status
- [error-014] helpful=0 harmful=0: Wait for completion before assuming failure

### Never
- [error-015] helpful=0 harmful=0: Bypass delegation due to display bugs
- [error-016] helpful=0 harmful=0: Create redundant sessions without investigating
- [error-017] helpful=0 harmful=0: Attempt direct execution when agents are working
- [error-018] helpful=0 harmful=0: Panic and lose uncommitted work

---

## Common Display Bugs vs Real Failures

### Display Bug: "Forge backend unreachable"

**Symptoms:**
- [error-019] helpful=0 harmful=0: `genie view` shows "backend unreachable"
- [error-020] helpful=0 harmful=0: But `mcp__genie__list_sessions` WORKS
- [error-021] helpful=0 harmful=0: Process list shows executors running
- [error-022] helpful=0 harmful=0: Session status shows "running"

**Diagnosis:** Genie CLI display bug, not real failure

**Action:** Ignore "unreachable" message, trust delegation

**Root cause:** WebSocket connection issue or HTTP health check instead of MCP connectivity check

### Display Bug: "No logs available"

**Symptoms:**
- [error-023] helpful=0 harmful=0: `genie view` shows "(No logs available)"
- [error-024] helpful=0 harmful=0: But task status shows "in-progress"
- [error-025] helpful=0 harmful=0: Executor process is running

**Diagnosis:** Log streaming issue, not execution failure

**Action:** Monitor via Forge MCP task status instead

### Real Failure: Task Status "failed"

**Symptoms:**
- [error-026] helpful=0 harmful=0: Task status shows "failed"
- [error-027] helpful=0 harmful=0: Executor process not running
- [error-028] helpful=0 harmful=0: No recent activity in worktree

**Diagnosis:** Actual execution failure

**Action:** Investigate failure (read logs, check diffs, review error messages)

---

## Monitoring Best Practices

### Patience Over Polling

**❌ Wrong:**
```bash
while true; do
  check_status
  sleep 1  # Polling every second
done
```

**✅ Correct:**
```bash
# Check once, then wait
check_status

# If in-progress, wait longer
sleep 30  # or 60 seconds

# Check again
check_status
```

### Progressive Intervals

**Pattern:**
```
First check: Immediate
Second check: 30 seconds later
Third check: 60 seconds later
Ongoing: 60-120 second intervals
```

**Why:** Reduce system load, avoid spam, respect execution time

### State-Based Decisions

**Don't decide based on:**
- [error-029] helpful=0 harmful=0: Error messages in view output
- [error-030] helpful=0 harmful=0: Missing logs
- [error-031] helpful=0 harmful=0: Display timeouts

**Do decide based on:**
- [error-032] helpful=0 harmful=0: Task status from Forge MCP
- [error-033] helpful=0 harmful=0: Process existence in `ps aux`
- [error-034] helpful=0 harmful=0: Actual file changes in worktree
- [error-035] helpful=0 harmful=0: Commit history in git log

---

## Evidence

### Session Demonstrating Correct Pattern (2025-10-21)

**Scenario:** While analyzing RC 37 failure, encountered same "unreachable" error

**Investigation:**
```bash
# Checked Genie MCP connectivity
mcp__genie__list_sessions
# Result: SUCCESS - full session list returned

# Checked session status
Session 1d824e13-936b-4182-a49f-9198eb2fd087: "running"

# Checked processes
ps aux | grep opencode
# Result: OpenCode executor running (PID 1002766)

# Checked Forge
ps aux | grep forge
netstat -tlnp | grep 8887
# Result: Forge running on port 8887

# Conclusion: Display bug, not real failure
# Action: Trusted delegation, waited patiently
```

**Outcome:** Work continued successfully despite error messages

---

## Integration with Other Spells

### Combine with:
- [error-054] helpful=0 harmful=0: `@.genie/spells/delegate-dont-do.md` - Don't bypass delegation due to errors
- [error-055] helpful=0 harmful=0: `@.genie/code/spells/genie-integration.md` - Monitoring patterns for Genie MCP
- [error-056] helpful=0 harmful=0: `@.genie/spells/forge-integration.md` - Forge task status checking

### When to escalate:
- [error-036] helpful=0 harmful=0: Forge MCP actually fails (not just display error)
- [error-037] helpful=0 harmful=0: Process definitely not running
- [error-038] helpful=0 harmful=0: Task status stuck for >10 minutes with no activity
- [error-039] helpful=0 harmful=0: Repeated failures with clear error patterns

---

## Future Improvements

**Genie CLI fixes needed:**
1. [error-040] helpful=0 harmful=0: Fix "Forge backend unreachable" false positives
2. [error-041] helpful=0 harmful=0: Add real-time status polling to `genie view`
3. [error-042] helpful=0 harmful=0: Create `genie status` command for health checks
4. [error-043] helpful=0 harmful=0: Implement session→task→attempt mapping
5. [error-044] helpful=0 harmful=0: Use Forge advanced APIs for monitoring

**See:** `.genie/reports/rc37-failure-analysis-20251021.md` for detailed recommendations

---

## Validation

**Before panicking about errors, validate:**
- [error-045] helpful=0 harmful=0: [ ] Checked Genie MCP connectivity (list_sessions)
- [error-046] helpful=0 harmful=0: [ ] Checked session status (running vs failed)
- [error-047] helpful=0 harmful=0: [ ] Checked process existence (ps aux)
- [error-048] helpful=0 harmful=0: [ ] Waited appropriate interval (30-60 seconds)
- [error-049] helpful=0 harmful=0: [ ] Verified this is NOT just a display bug

**Only bypass delegation if:**
- [error-050] helpful=0 harmful=0: [ ] Genie MCP actually fails (not display bug)
- [error-051] helpful=0 harmful=0: [ ] Process confirmed not running
- [error-052] helpful=0 harmful=0: [ ] Session status confirmed failed
- [error-053] helpful=0 harmful=0: [ ] Blocker documented and reported

---

**Remember:** Display bugs ≠ System failures. Investigate before acting. Trust but verify. 🧞🔍✅
