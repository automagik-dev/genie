---
name: MCP Diagnostic Protocol
description: Always verify MCP health before using specialized tools. Investigate systematically when tools fail silently.
---

# MCP Diagnostic Protocol

## Core Principle

**Check MCP health BEFORE using specialized tools. Silent failure requires investigation, not assumption.**

When MCP tools fail (especially WebSocket-native tools), diagnose systematically before giving up or suggesting manual workarounds.

## The Anti-Pattern

❌ **Wrong Response:**
1. Use specialized MCP tool (`create_wish`, `run_forge`)
2. Tool returns no output
3. Assume success or failure without evidence
4. Mark work "complete" or suggest manual workaround
5. Move on without investigation

✅ **Correct Response:**
1. Use specialized MCP tool
2. Tool returns no output
3. **Check MCP health systematically**
4. Try alternatives (simpler tools, non-WebSocket)
5. Look for evidence of success/failure
6. Report infrastructure issue if found
7. ONLY THEN suggest manual approach (with full context)

## Diagnostic Protocol

### Step 1: Verify MCP Server Responsive

**Before using any specialized tool, confirm MCP is working:**
```javascript
// Simple read operation - should always work
mcp__genie__list_agents()
```

**If this fails:**
- MCP server may be down
- Connection issue
- Configuration problem

**Action:** Fix MCP connection before attempting specialized operations

### Step 2: Check If Work Already Exists

**Prevent duplicate work - check if operation already succeeded:**
```javascript
// See active sessions
mcp__genie__list_sessions()

// Check Forge tasks
mcp__forge__list_tasks(project_id="...")
```

**If work exists:**
- Silent tool call may have actually succeeded
- Previous attempt may have completed
- Duplicate operation unnecessary

**Action:** Resume existing work, don't create new

### Step 3: Start with Simple Operations

**Test MCP progressively:**
```
Read operations → Write operations
Non-WebSocket → WebSocket
Diagnostic → Action
```

**Example progression:**
```javascript
// 1. Simple read (no WebSocket)
mcp__genie__list_agents()

// 2. Session operation (may use WebSocket)
mcp__genie__list_sessions()

// 3. Complex operation (WebSocket-native)
mcp__genie__create_wish(...)
```

**If simple operations work but complex fail:**
- Isolates issue to specific tool
- Provides diagnostic context
- Enables targeted bug report

### Step 4: Try Alternative Tools

**When specialized tool fails, try equivalent non-WebSocket version:**

**WebSocket Tools:**
- `mcp__genie__create_wish` → `mcp__genie__run` with agent="wish"
- `mcp__genie__run_forge` → `mcp__genie__run` with agent="forge"

**Direct Tools:**
- Genie MCP → Forge MCP directly
- MCP → Native Bash/Read as last resort

**Example:**
```javascript
// This failed (WebSocket):
mcp__genie__create_wish(feature="...", github_issue=123)

// Try non-WebSocket alternative:
mcp__genie__run(
  agent="wish",
  prompt="Create wish for feature X linked to issue #123"
)
```

### Step 5: Check for Evidence of Success

**Silent failure might be silent success - verify:**

**Filesystem:**
```bash
# Check if files created
ls .genie/wishes/
ls /var/tmp/automagik-forge/worktrees/
```

**Git:**
```bash
# Check for commits
git log --oneline -5
```

**MCP:**
```javascript
// Check if sessions exist
mcp__genie__list_sessions()
```

**If evidence exists:**
- Operation succeeded despite no output
- Report output issue, but don't duplicate work

### Step 6: Report or Escalate

**If systematic investigation shows infrastructure issue:**

1. **Document findings:**
   - What tool was used
   - What output was expected vs received
   - What diagnostics were performed
   - What evidence exists (or doesn't)

2. **Create issue:**
   ```bash
   gh issue create \
     --title "MCP tool silent failure: create_wish returns no output" \
     --body "$(cat investigation-notes.md)" \
     --label "bug,infrastructure"
   ```

3. **Use workaround:**
   - Document why workaround needed
   - Use alternative tool with full context
   - Track issue for proper fix

**Only after exhausting all diagnostic steps should manual workaround be suggested.**

## Common Violations

### Violation 1: Silent Failure → Immediate Exit

**Wrong:**
```
Tool fails → "This isn't working, try manually" → Exit
```

**Right:**
```
Tool fails → Check MCP health → Try alternatives → Look for evidence → Report issue → Then suggest workaround with context
```

### Violation 2: No Output → Assume Success

**Wrong:**
```
create_wish returns nothing → Mark task "completed" → Move on
```

**Right:**
```
create_wish returns nothing → Check list_sessions → Check filesystem → Check git → Verify evidence → Then mark status
```

### Violation 3: First Failure → Give Up

**Wrong:**
```
create_wish fails → "Let's do this manually instead"
```

**Right:**
```
create_wish fails → Try list_agents → Try mcp__genie__run → Check worktrees → Report infrastructure bug → Create wish with working tool
```

## Integration with Evidence Protocol

This protocol works with Evidence-Based Todo Completion:

```
MCP tool used → No output received → Diagnostic protocol executed → Evidence checked → Status determined:
- completed (evidence of success found)
- failed (confirmed failure, documented)
- blocked (infrastructure issue, reported)
- unknown (no evidence either way, needs verification)
```

**Never mark "completed" without evidence. Unknown is more honest than falsely complete.**

## Real-World Example

**Bug #239:** WebSocket MCP tools (`create_wish`, `run_forge`) returned no output during task creation attempt.

**Violation:** Marked task "completed" without evidence, suggested manual workaround.

**Correct Response:**
1. ✅ Check MCP health: `list_agents` (worked)
2. ✅ Check sessions: `list_sessions` (no new sessions)
3. ✅ Try alternative: `mcp__genie__run` (worked!)
4. ✅ Get evidence: Session ID, task ID, full URLs returned
5. ✅ Report issue: Created #239 for WebSocket tool investigation
6. ✅ Use working tool: Successfully created both wishes with verification

**Evidence:** Session `websocket-tools-investigation` created, task ff8b5629... visible in Forge UI.

## Success Criteria

**This protocol is working when:**
- ✅ No more premature exits after first tool failure
- ✅ Infrastructure issues reported, not worked around silently
- ✅ Alternative tools tried before suggesting manual approach
- ✅ Evidence checked before declaring success/failure
- ✅ Todo status reflects reality (blocked/failed/unknown vs false "completed")

**Integration:** Works with MCP-first hierarchy, Evidence-based completion, Troubleshoot Infrastructure protocols.
