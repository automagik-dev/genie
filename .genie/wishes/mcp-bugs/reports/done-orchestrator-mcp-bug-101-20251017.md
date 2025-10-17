# Done Report: MCP Agent Start Failure Bug #101

**Session ID:** `orchestrator-mcp-bug-101`
**Created:** 2025-10-17 23:30-23:35 UTC
**Status:** ✅ COMPLETED

---

## Scope

**Objective:** Create GitHub issue for MCP agent start failure bug

**Bug Details:**
- MCP agent invocations (mcp__genie__run) fail with "Command failed" error
- Prevents session creation entirely (no session ID returned)
- Distinct from existing issues #90 (view truncation), #91 (persistence), #92 (zombie sessions)
- Impact: HIGH - blocks all agent-based workflows with large prompts (~700 line threshold)

---

## Discovery

**Root Issue Identified:**
- Original failure: 2025-10-17 18:45 UTC - Learn agent invocation failed
- Error: "Command failed" with permission flag debug output
- Trigger condition: Large prompt (~700 lines teaching input)
- System error: `execConfig.permissionMode = bypassPermissions`, `--dangerously-skip-permissions`

**Recursive Bug Discovered:**
- Attempted to delegate issue creation to git neuron
- Git neuron start ALSO failed with same error
- Demonstrates the bug's severity: can't use agents to report the bug affecting agents

---

## Implementation

### Attempted Path: MCP Delegation
```bash
mcp__genie__run with agent="git" and prompt="[GitHub issue creation task]"
```
**Result:** ❌ FAILED - Command failed error (same bug being reported)

### Successful Path: Direct Bash + gh CLI
```bash
gh issue create \
  --title "[Bug] MCP agent start failures with \"Command failed\" error" \
  --body "[comprehensive description with reproduction steps, environment, evidence]" \
  --label "type:bug,area:mcp,priority:high"
```
**Result:** ✅ SUCCESS - Issue #101 created

---

## Issue Details

**GitHub Issue:** #101
**URL:** https://github.com/namastexlabs/automagik-genie/issues/101
**Title:** `[Bug] MCP agent start failures with "Command failed" error`
**Labels:** type:bug, area:mcp, priority:high
**State:** OPEN (reopened after being auto-closed)

**Note:** Issue was initially created and auto-closed by GitHub (likely due to template configuration). Reopened at 2025-10-17 23:35 UTC for investigation.

### Body Content
- Description: MCP agent invocations fail with "Command failed" error
- Steps to reproduce: Invoke mcp__genie__run with large prompt (~700 lines)
- Expected behavior: Agent session created successfully with session ID
- Actual behavior: Command fails before session initialization
- Environment: Linux WSL2, Node v22.16.0, Genie v2.4.0-rc.8
- Evidence: Error timestamp, agent attempted, debug output
- Related issues: Links to #90 (view), #91 (persistence), #92 (zombie)
- Impact statement: Blocks MCP agent invocations with larger prompts

---

## Verification

✅ **All Success Criteria Met:**

| Criterion | Status | Evidence |
|-----------|--------|----------|
| Issue created with [Bug] title | ✅ | Issue #101 title format correct |
| Comprehensive description | ✅ | Full context, reproduction steps included |
| All fields populated | ✅ | Description, environment, evidence all present |
| Labels applied correctly | ✅ | type:bug, area:mcp, priority:high |
| Cross-references to related issues | ✅ | Links to #90, #91, #92 in body |
| Issue number captured | ✅ | Issue #101 |
| Done Report created | ✅ | This report at correct path |

---

## Key Learnings & Follow-ups

### Pattern Discovered: Recursive Bugs
- Bug affects agent start mechanism
- Can't use agents to report the bug
- Emergency bypass to direct tools is appropriate recovery pattern

### Escalation Needed
- This issue (MCP agent start) may indicate deeper CLI/MCP execution issues
- Permission flag visibility suggests permission model confusion
- Related to existing #89 (CLI output references non-existent ./genie)

### Delegation vs Emergency Bypass
- Primary approach: Delegate to git neuron (proper orchestration)
- When delegation fails: Use direct bash + gh CLI (emergency bypass justified)
- This session demonstrates correct escalation path

### Risks & Future Work
1. **Root cause:** Why does large prompt size trigger command failure?
2. **Threshold:** What is exact prompt size threshold (~700 lines)?
3. **Permission model:** Why are permission flags appearing in stderr?
4. **Recursive impact:** How many MCP operations affected by this bug?

---

## Evidence Location

**GitHub Issue:** https://github.com/namastexlabs/automagik-genie/issues/101

**Session tracking:** @.genie/SESSION-STATE.md (orchestrator-mcp-bug-101)

**Related issues:** #90, #91, #92, #98, #99

---

## Resolution

**Action Taken:** GitHub issue #101 successfully created with comprehensive bug report

**Next Steps:**
1. Assign to engineer for investigation
2. Determine exact prompt size threshold
3. Investigate permission model in MCP execution
4. Consider impact on other agent starts

**Status:** ✅ ISSUE REPORTED - Ready for triage and investigation
