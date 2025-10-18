# Bug #66 Investigation Report: MCP Session Disappears After Resume
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Bug ID:** #66
**Status:** ✅ RESOLVED
**Fixed in:** v2.4.0-rc.9
**Validated in:** v2.4.0-rc.21
**Investigation Date:** 2025-10-18
**Investigator:** Bug #66 Investigation Genie (Claude Haiku 4.5)
**Issue URL:** https://github.com/namastexlabs/automagik-genie/issues/66

---

## Executive Summary

Bug #66 was a **critical** MCP session persistence issue where sessions would become inaccessible after resume operations, returning "No run found" errors. The bug was caused by a fundamental flaw in session storage architecture where sessions were keyed by agent name rather than unique session IDs, leading to session collisions and data loss.

**Root Cause:** Session storage used agent names as keys, causing new sessions to overwrite previous ones
**Fix:** Migrated to V2 storage format using unique sessionId as storage key
**Related:** Bug #102 (session collision) - same root cause
**Impact:** CRITICAL - Blocked multi-neuron workflows and session coordination

---

## Bug Description

### Symptoms

1. **Session Appears Active But Unreachable**
   - `mcp__genie__list_sessions` shows session with status "running"
   - `mcp__genie__view` returns "No run found for session {id}"
   - `mcp__genie__resume` returns "No run found for session {id}"

2. **Context Loss After Timeout**
   - Sessions became inaccessible after ~45 minutes of runtime
   - Complete session state lost
   - No ability to recover work or continue execution

3. **State Desynchronization**
   - List operation showed different data than view/resume operations
   - Backend storage inconsistency

### Reproduction Steps

1. Start long-running agent session: `mcp__genie__run with agent="orchestrator"`
2. Note session ID (e.g., `4d4c76a7-e58a-487a-b66f-7ff408dafb37`)
3. Wait ~45 minutes (session runs in background)
4. Attempt resume: `mcp__genie__resume with sessionId="4d4c76a7-e58a-487a-b66f-7ff408dafb37"`
5. Observe error: "No run found for session 4d4c76a7-e58a-487a-b66f-7ff408dafb37"

### Example Case

- **Session ID:** `4d4c76a7-e58a-487a-b66f-7ff408dafb37`
- **Agent:** prompt (refactoring)
- **Started:** 2025-10-17 17:20 UTC
- **Runtime:** ~45 minutes before becoming inaccessible
- **Error:** "No run found" on view/resume attempts

---

## Root Cause Analysis

### Technical Investigation

The issue was rooted in the session storage architecture in `.genie/cli/src/session-store.ts`:

#### V1 Format (BROKEN)
```typescript
// Version 1 - Sessions keyed by AGENT NAME
{
  "version": 1,
  "agents": {
    "implementor": {           // ❌ Agent name as key
      "sessionId": "abc-123",
      "agent": "implementor",
      "created": "..."
    }
  }
}
```

**Problem:** When a new session of the same agent type started, it would overwrite the previous entry:

```typescript
// First session
agents["implementor"] = { sessionId: "abc-123", ... }

// Second session - OVERWRITES first!
agents["implementor"] = { sessionId: "def-456", ... }

// First session (abc-123) is now LOST
```

#### V2 Format (FIXED)
```typescript
// Version 2 - Sessions keyed by SESSION ID
{
  "version": 2,
  "sessions": {
    "abc-123": {              // ✅ SessionId as key
      "sessionId": "abc-123",
      "agent": "implementor",
      "created": "..."
    },
    "def-456": {              // ✅ Unique key
      "sessionId": "def-456",
      "agent": "implementor",
      "created": "..."
    }
  }
}
```

**Fix:** Each session has a unique key (its sessionId), preventing collisions and overwrites.

### Key Code Changes

File: `.genie/cli/src/session-store.ts:26`

```typescript
export interface SessionStore {
  version: number;
  sessions: Record<string, SessionEntry>; // ✅ keyed by sessionId, not agent name
  // Legacy format compatibility (will be migrated on load)
  agents?: Record<string, SessionEntry>;
}
```

Migration logic automatically converts V1 to V2 format:

```typescript
// File: session-store.ts:118-144
// Version 1 format (agents keyed by agent name) - MIGRATE
if (incoming.agents) {
  callbacks.onWarning?.('Migrating sessions.json from v1 to v2');

  const sessions: Record<string, SessionEntry> = {};
  Object.entries(incoming.agents).forEach(([agentName, entry]) => {
    // Generate sessionId if missing
    const sessionId = entry.sessionId || `legacy-${agentName}-${Date.now()}`;
    sessions[sessionId] = {
      ...entry,
      agent: entry.agent || agentName,
      sessionId
    };
  });

  return { version: 2, sessions };
}
```

---

## Fix Implementation

### Commit Details

**Commit:** `e78c8d1de75e26ae42393756429fd67fc9b990aa`
**Author:** Felipe Rosa
**Date:** 2025-10-17 20:47:50 UTC
**Message:** `fix(mcp): session collision + friendly names (Bug #102, #90)`

### Changes Summary

1. **Session Storage Migration (V1 → V2)**
   - Changed storage key from agent name to sessionId
   - Automatic migration for existing V1 sessions
   - Backward compatibility maintained

2. **Session Lookup Enhancement**
   - Priority: Direct sessionId (UUID) → Friendly name → Log file scan
   - Support for both UUID and name-based lookups

3. **Friendly Session Names** (Bonus Feature)
   - CLI: `--name` option for `run` command
   - MCP: `name` parameter in run tool
   - Auto-generation format: `{agent}-{YYMMDDHHmm}`
   - Example: `analyze-2310171530`

4. **Files Modified** (44 files)
   - Core: `session-store.ts`, `session-helpers.ts`
   - Handlers: `run.ts`, `resume.ts`, `stop.ts`, `view.ts`, `shared.ts`
   - MCP: `server.ts`
   - Documentation: `AGENTS.md`, skills documentation

---

## Validation & Testing

### Regression Test Suite

A comprehensive 10-step regression test was created:

**File:** `.genie/agents/neurons/qa/workflows/bug-66-session-persistence.md`

**Test Coverage:**
1. ✅ Sessions persist through single resume
2. ✅ Sessions persist through multiple resumes
3. ✅ No "No run found" error after resume
4. ✅ Session ID remains constant across resumes
5. ✅ Multiple sessions of same agent type don't overwrite each other
6. ✅ sessions.json maintains both sessions correctly
7. ✅ Session lookup works with both UUID and name
8. ✅ V1 → V2 migration preserves all data
9. ✅ Backward compatibility maintained
10. ✅ No session fragmentation or data loss

### Validation Status

- **RC9:** Initial fix deployed ✅
- **RC21:** Comprehensive regression suite passed ✅
- **Status:** Fully validated, no regressions detected

---

## Related Issues

### Bug #102: Session Collision
- **Status:** RESOLVED (same fix)
- **Root Cause:** Identical to Bug #66
- **Fix:** Session key migration (V1 → V2)

### Bug #90: History Fragmentation
- **Status:** RESOLVED (consequence of #102 fix)
- **Root Cause:** Re-keying logic caused log file fragmentation
- **Fix:** Removed re-keying, use sessionId from start

---

## Impact Analysis

### Before Fix
- ❌ Sessions lost after resume operations
- ❌ Only one session per agent type could exist
- ❌ Multi-neuron workflows blocked
- ❌ Work recovery impossible
- ❌ Session coordination unreliable

### After Fix
- ✅ Sessions persist indefinitely
- ✅ Unlimited sessions per agent type
- ✅ Multi-neuron workflows enabled
- ✅ Full work recovery capability
- ✅ Reliable session coordination
- ✅ Friendly session naming (bonus)

---

## Lessons Learned

### Architecture Insights

1. **Unique Keys Are Critical**
   - Never use non-unique identifiers (agent name) as storage keys
   - Always use unique IDs (sessionId) for entity storage

2. **State Synchronization**
   - Single source of truth prevents desynchronization
   - Storage format directly impacts data integrity

3. **Migration Strategy**
   - Automatic migration enables smooth upgrades
   - Backward compatibility reduces user friction

### Testing Insights

1. **Multi-Session Testing**
   - Test with multiple sessions of same agent type
   - Verify no collisions or overwrites

2. **Lifecycle Testing**
   - Test full session lifecycle: create → pause → resume → complete
   - Verify state persistence at each step

3. **Long-Running Testing**
   - Test sessions with extended runtime (~45+ minutes)
   - Ensure no timeout-related data loss

---

## Recommendations

### For Users
1. ✅ Update to v2.4.0-rc.9 or later
2. ✅ Sessions will automatically migrate to V2 format on first load
3. ✅ Use friendly names for easier session management: `genie run --name my-task`

### For Developers
1. ✅ Run regression test suite before each RC release
2. ✅ Monitor sessions.json format and integrity
3. ✅ Verify session persistence in multi-session scenarios
4. ✅ Test session operations with both UUID and name lookups

### For Future Development
1. Consider session cleanup policies (archive old sessions)
2. Add session metadata (tags, descriptions, dependencies)
3. Implement session groups/collections for complex workflows
4. Add session export/import for sharing workflows

---

## References

### Documentation
- **GitHub Issue:** https://github.com/namastexlabs/automagik-genie/issues/66
- **Regression Test:** `.genie/agents/neurons/qa/workflows/bug-66-session-persistence.md`
- **Fix Commit:** `e78c8d1de75e26ae42393756429fd67fc9b990aa`

### Related Files
- **Session Store:** `.genie/cli/src/session-store.ts`
- **Session Helpers:** `.genie/cli/src/lib/session-helpers.ts`
- **MCP Server:** `.genie/mcp/src/server.ts`
- **CLI Handlers:** `.genie/cli/src/cli-core/handlers/{run,resume,view,stop}.ts`

### Related Issues
- **Bug #102:** Session ID Collision (same root cause)
- **Bug #90:** Full Transcript Fragmentation (consequence fix)

---

## Conclusion

Bug #66 was a critical session persistence issue caused by using agent names as storage keys instead of unique session IDs. The fix involved migrating to a V2 storage format with sessionId-based keying, automatic migration logic, and enhanced session lookup capabilities.

**Key Achievements:**
- ✅ Complete resolution with backward compatibility
- ✅ Comprehensive regression testing
- ✅ Bonus feature: Friendly session names
- ✅ Related bugs fixed as consequence (#102, #90)
- ✅ No regressions in RC21 validation

**Status:** CLOSED - Fully resolved and validated

---

**Report Generated:** 2025-10-18 UTC
**Genie:** Bug #66 Investigation (Claude Haiku 4.5)
**Branch:** forge/0b8f-bug-66-mcp-sessi
