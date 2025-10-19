# 🧞 MCP Session ID Collision Fix WISH
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** ✅ COMPLETE
**Roadmap Item:** bug-fixes/mcp – @.genie/product/roadmap.md §Reliability
**Mission Link:** @.genie/product/mission.md §Reliability
**Standards:** @.genie/standards/best-practices.md §Core Principles
**Completion Score:** 100/100 (all groups complete)

## Context Ledger
- **Problem:** Session ID `4946bad6-98f4-4822-b90b-6abc09d21fc7` appeared THREE times in `mcp__genie__list_sessions()` output with different agents and creation times
- **Goal:** Fix session collision to ensure each session has a unique session ID
- **Impact:** Prevents session tracking confusion, cross-contamination of session state, and unreliable session management
- **Blocking Area:** Session persistence and key management in CLI

## Bug Report (GitHub Issue #102)

### Description
Session ID collision where the same UUID appeared multiple times with different agents and timestamps:

1. **genie/agents/git** (created 2025-10-17T18:15:51.377Z, last used 2025-10-17T18:16:14.468Z)
2. **agents/learn** (created 2025-10-15T22:00:04.917Z, last used 2025-10-17T18:15:44.532Z)
3. **agents/git** (created 2025-10-15T22:02:32.691Z, last used 2025-10-17T18:14:37.960Z)

### Impact
**Severity:** HIGH

- Session tracking is unreliable
- Cannot determine which session belongs to which agent
- Potential cross-contamination of session state
- Breaks core assumption: session ID = unique identifier
- `mcp__genie__view` behavior ambiguous (which agent's session is returned?)

### Related Issues
- #90: mcp__genie__view truncation (auto-fixed as side effect)
- #91: Sessions referenced in documentation missing from sessions.json
- #92: Zombie sessions stuck in running status
- #89: CLI session output references non-existent ./genie command
- #66: Session disappears after resume with 'No run found' error

## Root Cause Analysis

### Problem 1: Temporary Session Keys
The CLI created sessions with temporary keys (`temp-{agent}-{timestamp}`) and immediately persisted them:

```typescript
// ❌ WRONG (Before)
const tempSessionId = `temp-${resolvedAgentName}-${startTime}`;
const entry: SessionEntry = { /* ... */, sessionId: tempSessionId };
store.sessions[tempSessionId] = entry;  // ← Immediate persist with temp key
await persistStore(ctx, store);
```

### Problem 2: Re-Keying Collision
After sessionId extraction from background process, the session was re-keyed from temp to UUID:

```typescript
// ❌ WRONG (Before)
if (oldSessionId !== trimmed) {
  delete store.sessions[oldSessionId];  // ← Causes collision
  store.sessions[trimmed] = entry;       // ← Creates new entry
}
```

**Consequence:**
- Multiple log files created per session (fragmentation)
- Session history truncated (Bug #90)
- Collision when multiple sessions created in same millisecond
- Ambiguous session identity

## Solution Implemented

### Fix Version
- **RC16:** Initial fix (eliminate temp keys, remove re-keying)
- **RC21:** Enhanced session lifecycle management

### Part 1: Eliminate Temporary Keys

**File:** `.genie/cli/src/cli-core/handlers/run.ts`

```typescript
// ✅ CORRECT (After)
const entry: SessionEntry = {
  agent: resolvedAgentName,
  name: parsed.options.name || generateSessionName(resolvedAgentName),
  // ... other fields
  sessionId: null  // Will be filled by extraction
};
// Don't persist yet - wait for sessionId extraction
```

### Part 2: Persist with Real SessionId

**File:** `.genie/cli/src/cli-core/handlers/shared.ts`

```typescript
// ✅ CORRECT (After)
if (sessionId) {
  entry.sessionId = sessionId;
  entry.lastUsed = new Date().toISOString();
  // Persist with sessionId as key (first time)
  store.sessions[sessionId] = entry;
  void persistStore(ctx, store);
}
```

### Part 3: Remove Re-Keying Logic

**File:** `.genie/cli/src/lib/session-helpers.ts`

```typescript
// ✅ CORRECT (After)
export function findSessionEntry(
  store: SessionStore,
  sessionIdOrName: string,
  paths: Required<ConfigPaths>
) {
  // 1. Direct lookup by sessionId (UUID) or session key
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    if (entry && (entry.sessionId === trimmed || sid === trimmed)) {
      return { agentName: entry.agent, entry };
    }
  }

  // 2. Lookup by friendly name
  for (const [sid, entry] of Object.entries(store.sessions || {})) {
    if (entry && entry.name === trimmed) {
      return { agentName: entry.agent, entry };
    }
  }

  // 3. Fallback: scan log files (no re-keying)
  // ...
}
```

**Result:**
- No re-keying → No session key collision
- No fragmentation → Full history preserved
- One session entry per run
- One log file per session

## Bonus Feature: Friendly Session Names

As part of the fix, friendly session names were added to improve developer experience:

### Schema Enhancement
**File:** `.genie/cli/src/session-store.ts`

```typescript
export interface SessionEntry {
  agent: string;
  name?: string;  // Friendly session name (user-provided or auto-generated)
  sessionId: string | null;
  // ... rest of fields
}

export function generateSessionName(agentName: string): string {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[-:T]/g, '')
    .slice(2, 12); // YYMMDDHHmm
  return `${agentName}-${timestamp}`;
}
```

### User Experience Improvement

**Before:**
```bash
mcp__genie__list_sessions
# Found 3 sessions:
# 1. 2d5884fd-a3c4-4e9b-8f5c-1234567890ab
# 2. 3e6995ge-b4d5-5f0c-9g6d-2345678901bc
# 3. 4f7aa6hf-c5e6-6g1d-0h7e-3456789012cd
```

**After:**
```bash
mcp__genie__list_sessions
# Found 3 sessions:
# 1. 2d5884fd-a3c4-4e9b-8f5c-1234567890ab
#    Name: bug-102-investigation
#    Agent: analyze
# 2. 3e6995ge-b4d5-5f0c-9g6d-2345678901bc
#    Name: auth-feature
#    Agent: implementor
# 3. 4f7aa6hf-c5e6-6g1d-0h7e-3456789012cd
#    Name: analyze-2310171530
#    Agent: analyze
```

### CLI Parameter Support

```bash
# User-provided name
npx automagik-genie run analyze --name "bug-102-investigation"

# Auto-generated name
npx automagik-genie run analyze
# Creates: "analyze-2310171545"
```

## Execution Groups

### Group A: Root Cause Investigation ✅ COMPLETE
- ✅ Analyzed session creation logic in run.ts
- ✅ Identified temp key generation causing collision
- ✅ Documented re-keying logic in session-helpers.ts
- ✅ Confirmed fragmentation connection to Bug #90
- ✅ Created comprehensive report (done-implementor-rc16-bug-fixes-202510172342.md)

### Group B: Implement Fix ✅ COMPLETE
- ✅ Removed temp key generation from run.ts
- ✅ Updated shared.ts to persist with real sessionId
- ✅ Removed re-keying logic from session-helpers.ts
- ✅ Added name field to SessionEntry schema
- ✅ Implemented generateSessionName() function
- ✅ Updated all handlers (resume, view, stop) to use shared findSessionEntry
- ✅ Added --name CLI parameter support
- ✅ Updated MCP server to support name parameter

### Group C: QA Validation ✅ COMPLETE
- ✅ Created regression test (bug-102-session-collision.md)
- ✅ Verified single session creation
- ✅ Verified unique UUID generation
- ✅ Confirmed sessions.json uses sessionId as keys (not agent names)
- ✅ Tested friendly name lookup
- ✅ Tested auto-generated names
- ✅ Verified full transcript preservation
- ✅ Confirmed no session collision or cross-contamination

### Group D: Release ✅ COMPLETE
- ✅ RC16 published (2025-10-17) - Initial fix
- ✅ RC21 published (2025-10-18) - Enhanced session lifecycle
- ✅ All builds passing (0 errors, 0 warnings)
- ✅ QA tests passing
- ✅ Issue #102 closed

## Files Modified

**Core Implementation (11 files):**
1. `.genie/cli/src/session-store.ts` - Schema + generateSessionName
2. `.genie/cli/src/cli-core/types.ts` - CLIOptions interface
3. `.genie/cli/src/lib/types.ts` - CLIOptions interface
4. `.genie/cli/src/lib/cli-parser.ts` - --name parameter
5. `.genie/cli/src/cli-core/handlers/run.ts` - Remove temp keys
6. `.genie/cli/src/cli-core/handlers/shared.ts` - Persist with sessionId
7. `.genie/cli/src/lib/session-helpers.ts` - Name lookup + remove re-keying
8. `.genie/cli/src/cli-core/handlers/resume.ts` - Use shared findSessionEntry
9. `.genie/cli/src/cli-core/handlers/view.ts` - Use shared findSessionEntry
10. `.genie/cli/src/cli-core/handlers/stop.ts` - Use shared findSessionEntry
11. `.genie/mcp/src/server.ts` - Name support in MCP tools

## Evidence Checklist

### Bug Fix Evidence
- ✅ No temp keys created
- ✅ Sessions persisted with sessionId from the start
- ✅ No re-keying logic executed
- ✅ One session entry per run
- ✅ One log file per session
- ✅ Full conversation history preserved
- ✅ No session ID collision in list_sessions
- ✅ sessions.json uses sessionId as keys
- ✅ Each view command returns correct session
- ✅ No cross-contamination of session state

### Feature Evidence
- ✅ Friendly names displayed in list_sessions
- ✅ Name-based lookup working (resume/view/stop)
- ✅ Auto-generated names follow format: {agent}-{YYMMDDHHmm}
- ✅ CLI --name parameter working
- ✅ MCP name parameter working

### Build Evidence
- ✅ CLI build: 0 errors, 0 warnings
- ✅ MCP build: 0 errors, 0 warnings
- ✅ Pre-commit hooks passing
- ✅ All tests passing

## Regression Test

**Location:** `.genie/agents/qa/workflows/bug-102-session-collision.md`

**Test Frequency:** Every RC release

**Last Tested:** RC22 (2025-10-18)

**Result:** ✅ PASS

**Test Coverage:**
- Multiple sessions with same agent type → All unique IDs
- Multiple sessions with different agent types → All unique IDs
- list_sessions output → No duplicates
- sessions.json structure → sessionId as keys
- view commands → Correct session returned
- Name-based lookup → Working correctly

## Tracking

- **GitHub Issue:** #102 ✅ CLOSED
- **Fixed in:** v2.4.0-rc.16 (initial), v2.4.0-rc.21 (enhanced)
- **QA Status:** Verified in RC16, RC21, RC22 testing
- **Related Fixes:** Bug #90 (auto-fixed), Bug #66 (side effect fix)

## Risks & Mitigations

### Risk 1: Schema Migration
- **Risk:** Existing sessions won't have `name` field
- **Mitigation:** Field is optional, old sessions continue working
- **Impact:** LOW (old sessions show ID only, no breakage)

### Risk 2: Name Collision
- **Risk:** Two sessions with same user-provided name
- **Mitigation:** Lookup finds first match by creation order
- **Impact:** LOW (edge case, user can use different names)
- **Future Enhancement:** Uniqueness validation or timestamp suffix

## Future Enhancements

### Enhancement 1: Session Archiving
- Add `archived: boolean` field to SessionEntry
- Filter archived sessions from list_sessions by default
- Implement `genie archive <sessionId>` command

### Enhancement 2: Name Uniqueness Validation
- Warn when creating session with duplicate name
- Optional: Auto-append timestamp suffix if collision detected

### Enhancement 3: Bulk Session Operations
- `genie stop --all` (stop all running sessions)
- `genie archive --older-than 7d` (archive old sessions)

## <spec_contract>
- **Scope:** Fix session ID collision, ensure unique session IDs, add friendly names
- **Out of scope:** Session archiving, bulk operations, name uniqueness validation
- **Success metrics:** 0 duplicate session IDs, 100% unique UUIDs, friendly names working
- **External tasks:** None
- **Dependencies:** Node >= 18
</spec_contract>

## Status Log
- [2025-10-18] ✅ **WISH COMPLETE** - Issue #102 closed, RC21 published, QA passing
- [2025-10-18] ✅ RC22 QA - Bug fix holds, no regressions
- [2025-10-18] ✅ RC21 QA - Enhanced session lifecycle, all tests pass
- [2025-10-17T23:42Z] ✅ RC16 Implementation - Fix complete, builds passing
- [2025-10-17T23:30Z] ✅ Root Cause Analysis - Temp keys and re-keying identified
- [2025-10-17] 🐛 Bug #102 reported - Session ID collision discovered

## Summary

**Bug:** Session ID collision causing unreliable session tracking, cross-contamination risk, and ambiguous session identity.

**Root Cause:** Temporary session keys re-keyed to UUIDs, causing log fragmentation and potential collisions.

**Solution:**
1. Eliminated temp keys entirely
2. Wait for sessionId extraction before persisting
3. Persist with sessionId as key from the start
4. Removed re-keying logic
5. Added friendly session names (bonus feature)

**Result:**
- ✅ One session entry per run
- ✅ One log file per session
- ✅ No session ID collision
- ✅ Full conversation history preserved
- ✅ User-friendly session management

**Status:** ✅ COMPLETE and verified in production (RC16+)
