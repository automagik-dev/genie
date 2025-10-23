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
- Saw "Forge backend unreachable" in `genie view`
- Panicked and tried to execute release manually
- Created 3 redundant release agent sessions
- Meanwhile, agents ACTUALLY COMPLETED SUCCESSFULLY
- RC 37 published WITHOUT uncommitted changes
- Lost work due to panic response

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

**1. Check Forge MCP connectivity:**
```
mcp__automagik_forge__list_tasks(project_id="...")
```
If this works, Forge is fine (ignore "unreachable" message from genie view)

**2. Check task status:**
```
mcp__automagik_forge__list_tasks(project_id="...", limit=5)
```
Look for your task in "in-progress" state

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

**6. When advanced tools available:**
```
mcp__automagik_forge__adv_get_task_attempt(attempt_id="...")
mcp__automagik_forge__adv_get_process(process_id="...")
```
(Note: Requires --advanced flag, may not be enabled)

---

## Decision Tree

```
Error message appears
    ↓
Check Forge MCP (list_tasks)
    ↓
├─ Works → Forge is fine, trust delegation
│   ↓
│   Check task status
│   ↓
│   ├─ in-progress → Wait patiently with sleep intervals
│   ├─ in-review → Work complete, check results
│   ├─ completed → Success, verify output
│   └─ failed → Investigate failure (read logs, check diffs)
│
└─ Fails → Forge is actually broken
    ↓
    Check Forge process
    ↓
    ├─ Running → Port/config issue, check netstat
    │   ↓
    │   Check correct port (8887 vs 8888 confusion)
    │
    └─ Not running → Report blocker, restart Forge
```

---

## Trust But Verify Protocol

### Trust
- Agent sessions continue running even when view is broken
- Forge executes tasks even when CLI shows errors
- Executors (OpenCode/Claude/etc.) complete work autonomously
- System is more robust than display suggests

### Verify
- Use monitoring tools to check actual state
- Check process list to confirm execution
- Use Forge MCP to get real task status
- Wait for completion before assuming failure

### Never
- Bypass delegation due to display bugs
- Create redundant sessions without investigating
- Attempt direct execution when agents are working
- Panic and lose uncommitted work

---

## Common Display Bugs vs Real Failures

### Display Bug: "Forge backend unreachable"

**Symptoms:**
- `genie view` shows "Forge backend unreachable"
- But `mcp__automagik_forge__list_tasks` WORKS
- Process list shows Forge running
- Task status shows "in-progress"

**Diagnosis:** Genie CLI display bug, not real failure

**Action:** Ignore "unreachable" message, trust delegation

**Root cause:** Port confusion (8888 vs 8887) or HTTP health check instead of MCP connectivity check

### Display Bug: "No logs available"

**Symptoms:**
- `genie view` shows "(No logs available)"
- But task status shows "in-progress"
- Executor process is running

**Diagnosis:** Log streaming issue, not execution failure

**Action:** Monitor via Forge MCP task status instead

### Real Failure: Task Status "failed"

**Symptoms:**
- Task status shows "failed"
- Executor process not running
- No recent activity in worktree

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
- Error messages in view output
- Missing logs
- Display timeouts

**Do decide based on:**
- Task status from Forge MCP
- Process existence in `ps aux`
- Actual file changes in worktree
- Commit history in git log

---

## Evidence

### Session Demonstrating Correct Pattern (2025-10-21)

**Scenario:** While analyzing RC 37 failure, encountered same "unreachable" error

**Investigation:**
```bash
# Checked Forge MCP connectivity
mcp__automagik_forge__list_tasks(project_id="...")
# Result: SUCCESS - full task list returned

# Checked task status
Task 1d824e13-936b-4182-a49f-9198eb2fd087: "in-progress"

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
- `@.genie/spells/delegate-dont-do.md` - Don't bypass delegation due to errors
- `@.genie/code/spells/genie-integration.md` - Monitoring patterns for Genie MCP
- `@.genie/spells/forge-integration.md` - Forge task status checking

### When to escalate:
- Forge MCP actually fails (not just display error)
- Process definitely not running
- Task status stuck for >10 minutes with no activity
- Repeated failures with clear error patterns

---

## Future Improvements

**Genie CLI fixes needed:**
1. Fix "Forge backend unreachable" false positives
2. Add real-time status polling to `genie view`
3. Create `genie status` command for health checks
4. Implement session→task→attempt mapping
5. Use Forge advanced APIs for monitoring

**See:** `.genie/reports/rc37-failure-analysis-20251021.md` for detailed recommendations

---

## Validation

**Before panicking about errors, validate:**
- [ ] Checked Forge MCP connectivity (list_tasks)
- [ ] Checked task status (in-progress vs failed)
- [ ] Checked process existence (ps aux)
- [ ] Waited appropriate interval (30-60 seconds)
- [ ] Verified this is NOT just a display bug

**Only bypass delegation if:**
- [ ] Forge MCP actually fails (not display bug)
- [ ] Process confirmed not running
- [ ] Task status confirmed failed
- [ ] Blocker documented and reported

---

**Remember:** Display bugs ≠ System failures. Investigate before acting. Trust but verify. 🧞🔍✅
