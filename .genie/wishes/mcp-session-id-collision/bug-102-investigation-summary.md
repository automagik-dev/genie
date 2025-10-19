# Bug #102 Investigation Summary
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Bug:** Session ID Collision - Same UUID Used by Multiple Agents
**Severity:** HIGH
**Status:** ✅ RESOLVED in v2.4.0-rc.16

---

## Quick Summary

**Problem:** Session ID `4946bad6-98f4-4822-b90b-6abc09d21fc7` appeared THREE times in session list with different agents and timestamps.

**Root Cause:** Temporary session keys were re-keyed to UUIDs, creating multiple entries and fragmenting log files.

**Fix:** Eliminated temp keys, persist with real sessionId from the start, removed re-keying logic.

**Bonus:** Added friendly session names for better developer experience.

---

## The Bug

### What We Observed
When running `mcp__genie__list_sessions`, the same session ID appeared multiple times:

1. **genie/agents/git** (created 2025-10-17T18:15:51.377Z)
2. **agents/learn** (created 2025-10-15T22:00:04.917Z)
3. **agents/git** (created 2025-10-15T22:02:32.691Z)

### Why This Was Bad
- **Session tracking unreliable:** Can't determine which session belongs to which agent
- **Ambiguous behavior:** `mcp__genie__view` doesn't know which session to return
- **Cross-contamination risk:** Different agents sharing same session ID
- **Violated core assumption:** Session ID should uniquely identify ONE session

---

## The Investigation

### Discovery Process

**Step 1:** Examined session creation flow in `run.ts`
```typescript
// ❌ Found this (WRONG)
const tempSessionId = `temp-${resolvedAgentName}-${startTime}`;
store.sessions[tempSessionId] = entry;  // Persist immediately
```

**Step 2:** Traced sessionId extraction in `shared.ts`
```typescript
// ❌ Found re-keying logic
if (oldSessionId !== trimmed) {
  delete store.sessions[oldSessionId];  // Delete temp key
  store.sessions[trimmed] = entry;      // Create new entry
}
```

**Step 3:** Connected to Bug #90 (history fragmentation)
- Re-keying creates multiple log files per session
- `view` command only reads current log file
- Earlier conversation history lost

### Root Cause Analysis

**Problem 1: Premature Persistence**
- Created session with temp key before knowing real sessionId
- Persisted immediately to sessions.json
- Temp key: `temp-analyze-1697557551377`

**Problem 2: Re-Keying Collision**
- After background process started, extracted real sessionId
- Re-keyed from temp to UUID
- Old entry deleted, new entry created
- **Consequence:** Multiple log files, session fragmentation

**Problem 3: Timing Race Condition**
- If multiple sessions created in same millisecond
- Temp keys could collide: `temp-analyze-1697557551377`
- Re-keying to different UUIDs would create confusion

---

## The Fix

### Three-Part Solution

**Part 1: Eliminate Temp Keys**

**File:** `.genie/cli/src/cli-core/handlers/run.ts`

```typescript
// ✅ CORRECT (After)
const entry: SessionEntry = {
  agent: resolvedAgentName,
  name: parsed.options.name || generateSessionName(resolvedAgentName),
  sessionId: null  // Will be filled by extraction - DON'T PERSIST YET
};
```

**Part 2: Persist with Real SessionId**

**File:** `.genie/cli/src/cli-core/handlers/shared.ts`

```typescript
// ✅ CORRECT (After)
if (sessionId) {
  entry.sessionId = sessionId;
  entry.lastUsed = new Date().toISOString();
  store.sessions[sessionId] = entry;  // First-time persistence
  void persistStore(ctx, store);
}
```

**Part 3: Remove Re-Keying**

**File:** `.genie/cli/src/lib/session-helpers.ts`

```typescript
// ✅ Removed re-keying logic entirely
// Now just looks up sessions, never modifies keys
```

### Result
- ✅ No temp keys created
- ✅ Sessions persisted with real sessionId from the start
- ✅ One session entry per run
- ✅ One log file per session
- ✅ Full conversation history preserved
- ✅ No session ID collision

---

## Bonus: Friendly Session Names

While fixing the bug, we added a developer experience enhancement:

### Schema Addition
```typescript
export interface SessionEntry {
  agent: string;
  name?: string;  // NEW: Friendly session name
  sessionId: string | null;
  // ...
}

// Auto-generates names like "analyze-2310171530"
export function generateSessionName(agentName: string): string {
  const timestamp = new Date().toISOString()
    .replace(/[-:T]/g, '')
    .slice(2, 12); // YYMMDDHHmm
  return `${agentName}-${timestamp}`;
}
```

### Usage
```bash
# User-provided name
mcp__genie__run with agent="analyze" and name="bug-investigation"

# Auto-generated name
mcp__genie__run with agent="analyze"
# Creates: "analyze-2310171545"

# Resume by name
mcp__genie__resume with sessionId="bug-investigation"  # Works!
```

### Before/After Comparison

**Before:**
```
Found 3 sessions:
1. 2d5884fd-a3c4-4e9b-8f5c-1234567890ab
2. 3e6995ge-b4d5-5f0c-9g6d-2345678901bc
3. 4f7aa6hf-c5e6-6g1d-0h7e-3456789012cd
```

**After:**
```
Found 3 sessions:
1. 2d5884fd-a3c4-4e9b-8f5c-1234567890ab
   Name: bug-investigation
   Agent: analyze

2. 3e6995ge-b4d5-5f0c-9g6d-2345678901bc
   Name: auth-feature
   Agent: implementor

3. 4f7aa6hf-c5e6-6g1d-0h7e-3456789012cd
   Name: analyze-2310171530
   Agent: analyze
```

---

## Testing & Validation

### Regression Test Created
**Location:** `.genie/agents/qa/workflows/bug-102-session-collision.md`

**Test Scenario:**
1. Create 3 sessions with same agent type (genie)
2. Create 3 sessions with different agent types
3. Verify all 6 sessions have unique session IDs
4. Verify sessions.json uses sessionId as keys (not agent names)
5. Verify each view command returns correct session

### QA Results
- ✅ RC16: Initial fix verified
- ✅ RC21: Enhanced session lifecycle verified
- ✅ RC22: No regressions, fix holds

---

## Impact Assessment

### Bugs Fixed
- **#102:** Session ID collision ✅ FIXED
- **#90:** History fragmentation ✅ AUTO-FIXED (side effect)
- **#66:** Session disappears after resume ✅ PARTIAL FIX (side effect)

### Developer Experience Improvements
- ✅ Friendly session names for easy identification
- ✅ Resume/view/stop by name (not just UUID)
- ✅ Auto-generated names when not specified
- ✅ Clear session ownership and tracking

### Code Quality Improvements
- ✅ Removed complex re-keying logic
- ✅ Simplified session lifecycle
- ✅ Consolidated findSessionEntry logic
- ✅ Eliminated timing race conditions

---

## Files Modified

**Core Session Management (7 files):**
1. `.genie/cli/src/session-store.ts` - Schema + generateSessionName
2. `.genie/cli/src/cli-core/handlers/run.ts` - Remove temp keys
3. `.genie/cli/src/cli-core/handlers/shared.ts` - Persist with sessionId
4. `.genie/cli/src/lib/session-helpers.ts` - Remove re-keying
5. `.genie/cli/src/cli-core/handlers/resume.ts` - Use shared lookup
6. `.genie/cli/src/cli-core/handlers/view.ts` - Use shared lookup
7. `.genie/cli/src/cli-core/handlers/stop.ts` - Use shared lookup

**CLI Parameter Support (3 files):**
8. `.genie/cli/src/cli-core/types.ts` - CLIOptions interface
9. `.genie/cli/src/lib/types.ts` - CLIOptions interface
10. `.genie/cli/src/lib/cli-parser.ts` - --name parameter

**MCP Integration (1 file):**
11. `.genie/mcp/src/server.ts` - Name support in MCP tools

---

## Lessons Learned

### What Went Wrong
1. **Premature optimization:** Persisted sessions before knowing real sessionId
2. **Complex state management:** Re-keying logic added fragility
3. **Timing assumptions:** Assumed temp keys wouldn't collide

### What We Did Right
1. **Simple solution:** Eliminated complexity instead of patching
2. **Comprehensive testing:** Created regression test suite
3. **User-first thinking:** Added friendly names while fixing
4. **Documentation:** Thoroughly documented root cause and fix

### Best Practices Reinforced
- ✅ Persist with real data, not placeholders
- ✅ Avoid re-keying/moving data in production
- ✅ Use UUIDs for true uniqueness, not timestamps
- ✅ Simplify state management
- ✅ Test edge cases (multiple sessions, same agent, etc.)

---

## Related Documentation

- **Full Wish Document:** `.genie/wishes/mcp-session-id-collision/mcp-session-id-collision-wish.md`
- **Implementation Report:** `.genie/reports/done-implementor-rc16-bug-fixes-202510172342.md`
- **Regression Test:** `.genie/agents/qa/workflows/bug-102-session-collision.md`
- **GitHub Issue:** https://github.com/namastexlabs/automagik-genie/issues/102

---

## Status

**Fixed in:** v2.4.0-rc.16 (2025-10-17)
**Enhanced in:** v2.4.0-rc.21 (2025-10-18)
**QA Status:** ✅ Verified in RC16, RC21, RC22
**GitHub Issue:** ✅ CLOSED
**Production Status:** ✅ Deployed and stable

---

**Investigation completed by:** Bug #102 Investigation Genie
**Model:** Claude Haiku 4.5
**Date:** 2025-10-18
