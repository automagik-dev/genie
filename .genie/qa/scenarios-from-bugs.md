# QA Scenarios from GitHub Issues
**Auto-Generated:** 2025-10-18 05:31:38 UTC
**Source:** GitHub Issues with label `type:bug`
**Script:** `.genie/scripts/sync-qa-from-issues.py`

---

## Summary

**Total Bugs:** 53
- 🔴 Open: 7
- ✅ Fixed: 46

---

## Open Bugs

## Bug #66: [Bug] MCP session disappears after resume - "No run found"
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:critical
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/66

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., `4d4c76a7-e58a-487a-b66f-7ff408dafb37`)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- `mcp__genie__view` shows session state
- `mcp__genie__resume` continues session with full context preserved
- Session remains queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in `mcp__genie__list_sessions` with status: running
- `mcp__genie__view` returns "No run found"
- `mcp__genie__resume` returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #89: [Bug] CLI session output references non-existent ./genie command
**Status:** 🔴 Open
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/89

### Reproduction Steps
1. Start any Genie agent session via `mcp__genie__run`
2. Check session output for resume/view/list instructions
3. Try executing `./genie resume <session-id>`
4. Result: "command not found" error

### Expected Behavior
Session output should reference correct MCP tools:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`
- Or `npx automagik-genie` for CLI operations

### Actual Behavior
Output shows legacy commands:
- `./genie resume <session-id>`
- `./genie view <session-id>`
- `./genie list`
- `./genie stop <session-id>`

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #91: [Bug] Sessions referenced in documentation missing from sessions.json and MCP list
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/91

### Reproduction Steps
1. Review `.genie/SESSION-STATE.md` for active/completed sessions
2. Query `.genie/state/agents/sessions.json`
3. Call `mcp__genie__list_sessions`
4. Observe: Many sessions from STATE.md missing from both files

### Expected Behavior
All sessions tracked in STATE.md should be queryable via:
- `mcp__genie__list_sessions`
- `.genie/state/agents/sessions.json`
- Log files in `.genie/state/agents/logs/`

### Actual Behavior
Sessions disappear after completion, preventing later inspection or resumption.

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #92: [Bug] Sessions stuck in 'running' status despite completion or abandonment
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:medium
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/92

### Reproduction Steps
1. Call `mcp__genie__list_sessions`
2. Find sessions with status="running" and old timestamps
3. Check if session actually completed or abandoned
4. Observe: Status never updated to completed/abandoned

### Expected Behavior
Sessions should transition from "running" to "completed" or "abandoned" when work finishes.

### Actual Behavior
Sessions remain stuck in "running" status indefinitely, even after completion.

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #93: [Bug] MCP agent start failures with 'Command failed' error
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/93

### Reproduction Steps
1. Invoke mcp__genie__run with agent="learn" (or agent="git")
2. Provide comprehensive prompt with Discovery → Implementation → Verification structure (~500-700 lines)
3. Observe "Command failed" error instead of session start

### Expected Behavior
Agent session starts successfully, returns session ID for tracking.

### Actual Behavior
Command fails immediately with error output showing debug flags and command construction.

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #102: [Bug] MCP session ID collision - same session ID used by multiple agents
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/102

### Reproduction Steps
1. Run: `mcp__genie__list_sessions`
2. Search output for session ID `4946bad6`
3. Observe same ID appearing multiple times with different agent types and timestamps

### Expected Behavior
- Each agent session should have a unique session ID
- No duplicate session IDs in list_sessions output
- Session ID should be immutable and map to exactly one agent

### Actual Behavior
- Same session ID reused by multiple agents
- Different creation timestamps for identical IDs
- `mcp__genie__view` behavior ambiguous (which agent's session is returned?)
- Creates confusion in session tracking and management

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #104: [Bug] MCP Background Launch Timeout + Long Prompt ARG_MAX Failure (RC9+)
**Status:** 🔴 Open
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/104

### Validation
- [ ] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

---

## Fixed Bugs

## Bug #101: [Bug] MCP agent start failures with "Command failed" error
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/101

### Reproduction Steps
1. Invoke: `mcp__genie__run with agent="learn" and prompt="[large prompt ~700 lines]"`
2. Observe: Command fails immediately
3. Result: No session ID created, error message returned

### Expected Behavior
Agent session created successfully with session ID returned to caller

### Actual Behavior
Command execution fails before session initialization. Error includes permission flags in debug output (`execConfig.permissionMode`, `--dangerously-skip-permissions`)

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #100: [Bug] MCP session ID collision - same ID used by multiple agents
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/100

### Reproduction Steps
1. Run: `mcp__genie__list_sessions`
2. Search output for duplicate session IDs
3. Verify same ID appears with different agent types and metadata

### Expected Behavior
Each session should have a unique UUID. Session IDs must be globally unique across all agents.

### Actual Behavior
Session ID collision creates ambiguity about:
- Which agent owns the session
- Which agent output to retrieve
- Session status and lifecycle

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #99: [Bug] MCP agent start failures with "Command failed" error
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/99

### Reproduction Steps
1. Invoke `mcp__genie__run` with agent="learn" (or other agent) and large prompt (~700 lines)
2. Observe command failure with "Command failed" error
3. Check SESSION-STATE.md - no session ID created

### Expected Behavior
- Agent session created successfully
- Session ID returned
- Agent ready to accept follow-up work

### Actual Behavior
- Command fails with error message
- No session ID created
- Debug output shows permission flags: `execConfig.permissionMode = bypassPermissions, --dangerously-skip-permissions`
- Agent never initializes

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #98: [Bug] Session ID collision in list_sessions output
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/98

### Reproduction Steps
1. Run: `mcp__genie__list_sessions`
2. Observe output for duplicate session IDs
3. Note different agent types with same ID

### Expected Behavior
Each session has a unique ID

### Actual Behavior
Session ID appears twice with different agent types and statuses, causing confusion about which agent's output to inspect

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #97: [Bug] Session ID collision in list_sessions output
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/97

### Reproduction Steps
1. Start a learn agent session
2. Call `mcp__genie__list_sessions`
3. Observe the same session ID in two separate entries with different agent types and statuses

### Expected Behavior
Each unique agent session should have a unique session ID. Session IDs should never collide across different agents or statuses.

### Actual Behavior
Session ID `4946bad6-98f4-4822-b90b-6abc09d21fc7` appears twice:
- Entry #1: agents/git (status: running)
- Entry #2: agents/learn (status: completed)

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #96: [Bug] MCP agent start failures with "Command failed" error
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/96

### Reproduction Steps
1. Invoke `mcp__genie__run` with agent=\"learn\" (or other agents)
2. Provide a comprehensive prompt with teaching/instruction content (~700+ lines)
3. Observe \"Command failed\" error instead of session creation
4. No session ID is returned, agent never starts

### Expected Behavior
Agent session should start successfully and return a session ID for tracking.

### Actual Behavior
MCP CLI returns a command error with debug output showing permission flags:
```
[DEBUG] execConfig.permissionMode = bypassPermissions
[DEBUG] Added --dangerously-skip-permissions (for bypassPermissions mode)
Command failed: /home/namastex/.nvm/versions/node/v22.16.0/bin/node /home/namastex/workspace/automagik-genie/.genie/cli/dist/genie-cli.js run [agent] [prompt]
```

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #95: [Bug] MCP agent start failures with 'Command failed' error
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/95

### Reproduction Steps
1. Invoke `mcp__genie__run` with `agent="learn"` (or other agents)
2. Provide a full prompt with comprehensive teaching/instruction content (~700+ lines)
3. Observe 'Command failed' error instead of successful session start

### Expected Behavior
Agent session starts successfully and returns a session ID for further operations.

### Actual Behavior
Command fails with error message:
```
Command failed: /home/namastex/.nvm/versions/node/v22.16.0/bin/node /home/namastex/workspace/automagik-genie/.genie/cli/dist/genie-cli.js run learn ...
```

Debug output shows:
```
[DEBUG] execConfig.permissionMode = bypassPermissions
[DEBUG] Added --dangerously-skip-permissions (for bypassPermissions mode)
```

No session is created, and no session ID is returned.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #94: [Bug] MCP session ID collision - same ID for multiple agents
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:critical
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/94

### Reproduction Steps
1. Start multiple agent sessions over time
2. Call mcp__genie__list_sessions
3. Observe duplicate session IDs with different agent types

### Expected Behavior
Each session should have a unique ID, even across different agent types.

### Actual Behavior
Same session ID (`4946bad6-98f4-4822-b90b-6abc09d21fc7`) appears for:
- Entry #1: agents/git (status: running)
- Entry #2: agents/learn (status: completed)

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #90: [Bug] mcp__genie__view with full=true returns truncated snippets instead of full transcript
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/90

### Reproduction Steps
1. Start a long-running session (50+ interactions)
2. Call: `mcp__genie__view with sessionId="<session-id>" and full=true`
3. Compare MCP output vs raw log file
4. Observe: Snippets returned instead of complete transcript

### Expected Behavior
`mcp__genie__view` with `full=true` should return complete transcript, not abbreviated snippets.

### Actual Behavior
MCP returns truncated "Key Checkpoints" summary regardless of `full=true` parameter.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #88: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/88

### Reproduction Steps
1. Start any Genie agent session via MCP
2. Check the session output for resume/view instructions
3. Attempt to execute `./genie resume <session-id>`
4. Result: `command not found` error

### Expected Behavior
Output should reference the correct MCP syntax or CLI commands:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or for CLI operations: `npx automagik-genie [command]`

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #87: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/87

### Reproduction Steps
1. Start any Genie agent session
2. Observe MCP output for session resume instructions
3. Try to execute `./genie` command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #86: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/86

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute ./genie command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #85: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/85

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute ./genie command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #84: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/84

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute `./genie` command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #83: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/83

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute ./genie command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #82: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/82

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute ./genie command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #81: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/81

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions  
3. Try to execute ./genie command → fails with "command not found"

### Expected Behavior
Output should reference correct MCP syntax:
- `mcp__genie__resume with sessionId="<session-id>"`
- `mcp__genie__view with sessionId="<session-id>"`
- `mcp__genie__list_sessions`

Or suggest `npx automagik-genie` for CLI operations.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #80: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/80

### Reproduction Steps
1. Start any Genie agent session
2. Observe CLI output for session resume instructions
3. Try to execute `./genie` command
4. Get "command not found" error

### Expected Behavior
CLI output should reference correct MCP syntax or npx commands instead of non-existent ./genie commands.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #79: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/79

### Reproduction Steps
1. Run a CLI session (any agent)
2. Observe output instructions for resuming
3. User sees `./genie resume ...` reference
4. User tries command → error (command not found)

### Expected Behavior
CLI session output should suggest correct commands:
- For CLI: `npx automagik-genie resume <session-id> "<prompt>"`
- For MCP: `mcp__genie__resume with sessionId="<session-id>" and prompt="<prompt>"`

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #78: [Bug] CLI session output references non-existent ./genie command
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:high, area:cli
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/78

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #77: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:critical, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/77

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #76: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:critical, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/76

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #75: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:critical, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/75

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #74: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, area:workflows
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/74

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- `mcp__genie__view` should show session state
- `mcp__genie__resume` should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in `mcp__genie__list_sessions` with status: running
- `mcp__genie__view` returns "No run found"
- `mcp__genie__resume` returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #72: [Bug] MPC session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, area:mcp, priority:critical
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/72

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #71: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:medium, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/71

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., 4d4c76a7-e58a-487a-b66f-7ff408dafb37)
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- mcp__genie__view should show session state
- mcp__genie__resume should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in mcp__genie__list_sessions with status: running
- mcp__genie__view returns "No run found"
- mcp__genie__resume returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #70: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:medium, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/70

### Description
No description provided

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #69: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/69

### Reproduction Steps
1. Start a agent session with `mcp__genie__run` (e.g., prompt agent)
2. Work for 30-45 minutes
3. Attempt to resume session with `mcp__genie__resume sessionId="<id>"`
4. Observe error: "No run found" or empty response
5. Check `mcp__genie__list_sessions` - session still listed but inaccessible

### Expected Behavior
- Session should remain accessible for full duration
- `mcp__genie__resume` should restore session context
- Ability to continue work without losing state

### Actual Behavior
- Session becomes inaccessible after ~45 minutes
- `mcp__genie__resume` returns "No run found"
- Session entry persists in list but is effectively orphaned
- Forced to create new session, losing conversation context

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #68: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/68

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Session ID returned: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Wait ~45 minutes
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
Session should remain queryable and resumable indefinitely. mcp__genie__view shows state, mcp__genie__resume continues session with context preserved.

### Actual Behavior
Session appears in mcp__genie__list_sessions but mcp__genie__view returns "No run found". Session context lost entirely.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #67: [Bug] MCP session disappears after resume - No run found
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/67

### Reproduction Steps
1. Start a agent session with `mcp__genie__run` (e.g., prompt agent)
2. Work for 30-45 minutes
3. Attempt to resume session with `mcp__genie__resume sessionId="<id>"`
4. Observe error: "No run found" or empty response
5. Check `mcp__genie__list_sessions` - session still listed but inaccessible

### Expected Behavior
- Session should remain accessible for full duration
- `mcp__genie__resume` should restore session context
- Ability to continue work without losing state

### Actual Behavior
- Session becomes inaccessible after ~45 minutes
- `mcp__genie__resume` returns "No run found"
- Session entry persists in list but is effectively orphaned
- Forced to create new session, losing conversation context

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #65: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/65

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Session ID returned: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Wait ~45 minutes
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
Session should remain queryable and resumable indefinitely. `mcp__genie__view` shows state, `mcp__genie__resume` continues session with context preserved.

### Actual Behavior
Session appears in `mcp__genie__list_sessions` but `mcp__genie__view` returns "No run found". Session context lost entirely.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #64: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:medium, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/64

### Reproduction Steps
1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID: 4d4c76a7-e58a-487a-b66f-7ff408dafb37
3. Wait ~45 minutes (session runs in background)
4. Resume same session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Expected Behavior
- `mcp__genie__view` should show session state
- `mcp__genie__resume` should continue the session with full context preserved
- Session should remain queryable and resumable indefinitely
- Session lifecycle: start → (optional pause) → resume → complete

### Actual Behavior
- Session appears in `mcp__genie__list_sessions` with status: running
- `mcp__genie__view` returns "No run found"
- `mcp__genie__resume` returns "No run found"
- Session context lost entirely after timeout
- State sync broken between list/view/resume operations

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #63: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/63

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Session status: "completed" (shown in view)
4. Resume session: `mcp__genie__resume with sessionId="4d4c76a7..."`
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #62: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/62

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Session status: "completed" (shown in view)
4. Resume session: `mcp__genie__resume with sessionId="4d4c76a7..."`
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via `mcp__genie__view` and `mcp__genie__resume` commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #61: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/61

### Reproduction Steps
1. Start session: mcp__genie__run with agent="prompt"
2. Receive session ID: 4d4c76a7-e58a-487a-b66f-7ff408dafb37
3. Session status: "completed" (shown in view)
4. Resume session: mcp__genie__resume with sessionId="4d4c76a7..."
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #60: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/60

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Session status: "completed" (shown in view)
4. Resume session: `mcp__genie__resume with sessionId="4d4c76a7..."`
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #59: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/59

### Reproduction Steps
1. Start session: mcp__genie__run with agent="prompt"
2. Receive session ID: 4d4c76a7-e58a-487a-b66f-7ff408dafb37
3. Session status: "completed" (shown in view)
4. Resume session: mcp__genie__resume with sessionId="4d4c76a7..."
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #58: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/58

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Session status: "completed" (shown in view)
4. Resume session: `mcp__genie__resume with sessionId="4d4c76a7..."`
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #57: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/57

### Reproduction Steps
1. Start session: `mcp__genie__run` with agent="prompt"
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Session status: "completed" (shown in view)
4. Resume session: `mcp__genie__resume` with sessionId="4d4c76a7..."
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via `mcp__genie__view` and `mcp__genie__resume` commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #56: [Bug] MCP session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/56

### Reproduction Steps
1. Start session: mcp__genie__run with agent="prompt"
2. Receive session ID: 4d4c76a7-e58a-487a-b66f-7ff408dafb37
3. Session status: "completed" (shown in view)
4. Resume session: mcp__genie__resume with sessionId="4d4c76a7..."
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via mcp__genie__view and mcp__genie__resume commands. Session state should be preserved in the session store.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #55: [Bug] MCP session disappears after resume - 'No run found'
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/55

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Receive session ID: `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
3. Check session status: `mcp__genie__view with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
4. Session shows: "completed"
5. Resume session: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37" and prompt="[continuation]"`
6. Resume succeeds, returns session ID
7. View session again: `mcp__genie__view with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
8. Error: "No run found"

### Expected Behavior
After resume, session should remain accessible via `mcp__genie__view` and `mcp__genie__resume` commands. Session state should be preserved in the session store. Resuming a session should not cause it to disappear.

### Actual Behavior
Session disappears from session store after resume operation. Subsequent view/resume attempts return "No run found" error, effectively losing access to the session and all its context.

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #54: [Bug] Session disappears after resume - "No run found"
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-17
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/54

### Reproduction Steps
1. Start session: `mcp__genie__run with agent="prompt"`
2. Session ID received: 4d4c76a7-e58a-487a-b66f-7ff408dafb37
3. View session: Status "completed"
4. Resume session: `mcp__genie__resume with sessionId="4d4c76a7..."`
5. Resume succeeds, returns session ID
6. View session again: "Error: No run found"

### Expected Behavior
After resume, session should remain accessible via view/resume

### Actual Behavior
Session disappears from session store after resume

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #52: [Bug] Templates not published to npm - genie init create fails
**Status:** ✅ Fixed
**Labels:** type:bug, priority:critical
**Created:** 2025-10-15
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/52

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #51: [Bug] Specialist agents load routing.md causing self-delegation loops
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high
**Created:** 2025-10-15
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/51

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #45: [Bug] Background MCP agents with permissionMode:default still prompt on Edit operations
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high
**Created:** 2025-10-15
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/45

### Expected Behavior
With `permissionMode: default`, ALL file operations (Write, Edit, Read) should proceed without user permission prompts.

### Actual Behavior
- `Write` to new files: ✅ No prompts
- `Edit` to existing files: ❌ Permission prompts appear

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

## Bug #44: [Bug] Background MCP agents with permissionMode:default still prompt on Edit operations
**Status:** ✅ Fixed
**Labels:** type:bug, priority:high, status:needs-triage
**Created:** 2025-10-15
**GitHub:** https://github.com/namastexlabs/automagik-genie/issues/44

### Reproduction Steps
1. Create MCP agent with `permissionMode: default` and `background: true`
2. Invoke via `mcp__genie__run`
3. Agent uses `Write` to create new file → succeeds without prompts
4. Agent uses `Read` then `Edit` on existing file → permission prompt appears

### Expected Behavior
With `permissionMode: default`, ALL file operations (Write, Edit, Read) should proceed without user permission prompts in background mode.

### Actual Behavior
- ✅ Write to new files: No prompts
- ❌ Edit to existing files: Permission prompts appear blocking autonomous execution

### Validation
- [x] Bug verified fixed
- [ ] Test scenario executed
- [ ] Regression test added
- [ ] Documentation updated

---

---

## Usage

This file is auto-generated from GitHub issues. To update:

```bash
python .genie/scripts/sync-qa-from-issues.py
```

To run manually with dry-run:

```bash
python .genie/scripts/sync-qa-from-issues.py --dry-run
```

To automate via GitHub Actions (future):
- Add workflow trigger: daily or on issue close
- Run script and commit changes
- Track regression coverage
