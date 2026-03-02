---
name: Evidence-Based Todo Completion
description: Only mark work "completed" when evidence exists. Unknown is more honest than false completion.
---

# Evidence-Based Todo Completion

## Core Principle

**"Unknown" is more honest than "completed" when evidence is missing.**

Never mark work "completed" without verifiable evidence. Master Genie coordination depends on accurate task status.

## The Anti-Pattern

❌ **Wrong Completion:**
1. Attempt task (create wish, run command, delegate work)
2. No clear success/failure signal
3. Mark as "completed" anyway (optimistic assumption)
4. Move on without verification
5. User discovers work incomplete

✅ **Correct Completion:**
1. Attempt task
2. Check for evidence of success
3. If evidence exists → mark "completed"
4. If confirmed failure → mark "failed" with reason
5. If infrastructure blocked → mark "blocked" with issue
6. If uncertain → mark "unknown" and create verification task

## Evidence Requirements

### Before Marking "Completed"

**Checklist:**
- [evidence-001] helpful=0 harmful=0: [ ] Can I see the result? (file exists, task visible, session listed)
- [evidence-002] helpful=0 harmful=0: [ ] Can I prove it worked? (git log, Forge UI, MCP list command)
- [evidence-003] helpful=0 harmful=0: [ ] Would another agent see this work? (persistent, visible, traceable)
- [evidence-004] helpful=0 harmful=0: [ ] Can the user act on this? (URL clickable, file accessible, PR created)

**If ANY checkbox fails → Do NOT mark "completed"**

### Evidence Types

**Filesystem Evidence:**
```bash
# File was created
ls -l .genie/wishes/my-wish.md

# Directory exists
ls -ld /var/tmp/automagik-forge/worktrees/abc123/
```

**Git Evidence:**
```bash
# Commit was made
git log --oneline -1 | grep "expected message"

# Branch exists
git branch --list | grep feature-branch

# PR was created
gh pr view 123
```

**MCP Evidence:**
```javascript
// Session exists
mcp__genie__list_sessions() // Shows session-name

// Task visible
mcp__forge__get_task(task_id="...") // Returns task object

// Agent running
mcp__genie__view(sessionId="...") // Shows progress
```

**User-Visible Evidence:**
```
// URL is accessible
http://localhost:8887/projects/.../tasks/... (can click, can view)

// File is readable
cat output.json (contains expected data)

// Service is running
curl http://localhost:3000 (returns 200)
```

## Task States

### Standard States

**completed** - Evidence of success exists
- [evidence-005] helpful=0 harmful=0: ✅ File created and contains expected content
- [evidence-006] helpful=0 harmful=0: ✅ Commit made with correct message
- [evidence-007] helpful=0 harmful=0: ✅ Task visible in Forge UI
- [evidence-008] helpful=0 harmful=0: ✅ Session listed in MCP
- [evidence-009] helpful=0 harmful=0: ✅ URL accessible and clickable

**in_progress** - Work is actively happening
- [evidence-010] helpful=0 harmful=0: ✅ Currently executing this task
- [evidence-011] helpful=0 harmful=0: ✅ Making changes, running commands
- [evidence-012] helpful=0 harmful=0: ✅ Not blocked, not done

**pending** - Not yet started
- [evidence-013] helpful=0 harmful=0: ✅ Waiting in queue
- [evidence-014] helpful=0 harmful=0: ✅ Dependencies not ready
- [evidence-015] helpful=0 harmful=0: ✅ Will start soon

### Extended States (For Uncertain Outcomes)

**blocked** - Cannot proceed, documented blocker
- [evidence-016] helpful=0 harmful=0: ❌ Infrastructure issue (MCP down, Forge unreachable)
- [evidence-017] helpful=0 harmful=0: ❌ Missing dependency (waiting for another task)
- [evidence-018] helpful=0 harmful=0: ❌ Needs user input (clarification required)
- [evidence-019] helpful=0 harmful=0: ✅ Blocker documented with context
- [evidence-020] helpful=0 harmful=0: ✅ Issue created or escalation path clear

**failed** - Attempted, confirmed failure, documented
- [evidence-021] helpful=0 harmful=0: ❌ Tried operation, got error
- [evidence-022] helpful=0 harmful=0: ✅ Error message captured
- [evidence-023] helpful=0 harmful=0: ✅ Root cause identified (or investigation documented)
- [evidence-024] helpful=0 harmful=0: ✅ Next steps clear (retry, report, fix)

**unknown** - Attempted, no evidence either way, needs verification
- [evidence-025] helpful=0 harmful=0: ❓ Tool returned no output (silent failure)
- [evidence-026] helpful=0 harmful=0: ❓ Operation may have succeeded but can't confirm
- [evidence-027] helpful=0 harmful=0: ❓ No error but no success signal either
- [evidence-028] helpful=0 harmful=0: ✅ Follow-up task created to verify
- [evidence-029] helpful=0 harmful=0: ✅ Documented what was attempted

## Verification Protocol

### When Verification Fails

**If you cannot verify completion:**

1. **Document uncertainty:**
   ```markdown
   Status: unknown
   Reason: Tool returned no output, cannot confirm success
   Attempted: mcp__genie__create_wish(feature="...", github_issue=123)
   Follow-up: Check .genie/wishes/ and list_sessions to verify
   ```

2. **Create verification task:**
   ```javascript
   TodoWrite([
     {
       content: "Verify wish creation succeeded",
       activeForm: "Verifying wish creation",
       status: "pending"
     }
   ])
   ```

3. **Investigate systematically:**
   - Apply MCP Diagnostic Protocol
   - Check for evidence (filesystem, git, MCP)
   - Try alternative verification methods

4. **Update status with findings:**
   - Evidence found → Change to "completed"
   - Confirmed failed → Change to "failed"
   - Still uncertain → Keep "unknown", escalate

### When Verification Impossible

**If verification is structurally impossible:**

1. **Challenge the approach:**
   - Why can't this be verified?
   - Is there a different approach that CAN be verified?
   - Should we use a different tool/method?

2. **Make it verifiable:**
   - Add logging
   - Create artifacts
   - Use tools with clear output
   - Check downstream effects

3. **Document limitation:**
   - If truly unverifiable, document why
   - Explain what user needs to check manually
   - Provide verification commands for user

## Real-World Example

**Bug #237-239 Session:** WebSocket tools returned no output, I marked "completed" anyway.

**Violation:**
```javascript
// Attempted
mcp__genie__create_wish(feature="...", github_issue=239)

// Got result
<system>Tool ran without output or errors</system>

// Marked status
TodoWrite([{content: "Create debug wish", status: "completed"}])  // ❌ NO EVIDENCE
```

**Correct Approach:**
```javascript
// Attempted
mcp__genie__create_wish(feature="...", github_issue=239)

// Got result
<system>Tool ran without output or errors</system>

// Check evidence
mcp__genie__list_sessions()  // No new session

// Mark status honestly
TodoWrite([{content: "Create debug wish", status: "unknown"}])

// Create verification task
TodoWrite([{content: "Verify wish creation or use alternative", status: "pending"}])

// Apply diagnostic protocol
// ... leads to discovering WebSocket tool bug
// ... try alternative: mcp__genie__run (works!)
// ... get evidence: session ID, task ID, full URLs
// ... NOW mark original as "failed", alternative as "completed"
```

**Evidence of correct completion:**
```
Session: websocket-tools-investigation
Task ID: ff8b5629-fbfd-4418-8017-b076042de756
Forge URL: http://localhost:8887/projects/.../tasks/ff8b5629.../attempts/ff8b5629...?view=diffs
```

User can click URL ✅, see task in Forge ✅, verify work happened ✅.

## Integration with Other Protocols

### MCP Diagnostic Protocol
When MCP tool fails → Apply diagnostics → Determine status:
- [evidence-030] helpful=0 harmful=0: Confirmed working → "completed"
- [evidence-031] helpful=0 harmful=0: Infrastructure issue → "blocked"
- [evidence-032] helpful=0 harmful=0: Tool broken → "failed"
- [evidence-033] helpful=0 harmful=0: Uncertain → "unknown"

### Troubleshoot Infrastructure
When delegation monitoring fails → Check worktree → Update status:
- [evidence-034] helpful=0 harmful=0: Agent completed → "completed"
- [evidence-035] helpful=0 harmful=0: Agent working → "in_progress"
- [evidence-036] helpful=0 harmful=0: Infrastructure down → "blocked"
- [evidence-037] helpful=0 harmful=0: Agent stuck → "failed"
- [evidence-038] helpful=0 harmful=0: Can't determine → "unknown"

### Orchestration Boundary
When delegating to agent → How to mark delegation task:
- [evidence-039] helpful=0 harmful=0: Delegation successful → "completed" (NOT the work, the delegation)
- [evidence-040] helpful=0 harmful=0: Agent task itself → Track separately, update based on evidence
- [evidence-041] helpful=0 harmful=0: Never mark agent's work complete until verified

## Success Criteria

**This protocol is working when:**
- [evidence-042] helpful=0 harmful=0: ✅ Todo list reflects reality (no false completions)
- [evidence-043] helpful=0 harmful=0: ✅ User can trust todo status (completed = actually done)
- [evidence-044] helpful=0 harmful=0: ✅ Blockers are visible (not hidden as "completed")
- [evidence-045] helpful=0 harmful=0: ✅ Failures are documented (not optimistically completed)
- [evidence-046] helpful=0 harmful=0: ✅ Uncertainty is acknowledged (unknown state used)

**Anti-Pattern:**
- [evidence-047] helpful=0 harmful=0: ❌ All tasks marked "completed" but work incomplete
- [evidence-048] helpful=0 harmful=0: ❌ Silent failures hidden by optimistic status
- [evidence-049] helpful=0 harmful=0: ❌ Blockers not surfaced to user
- [evidence-050] helpful=0 harmful=0: ❌ "Completed" used as default when uncertain
