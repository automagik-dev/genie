# RC28 Architecture Fix: Name-Based Session Management
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Status:** 🎯 PROPOSED SOLUTION for #115
**Impact:** Eliminates multiple critical bugs at once

---

## Problem Statement

### Current Broken Architecture

**Bug reproduction (RC27):**
```bash
# Step 1: Run agent
mcp__genie__run(agent="learn", name="bug-test-session-1")
# Returns: "Session ID: 5438dfa7-835d-475e-85cc-e3a950b5e7a7"

# Step 2: Check executor log
head -5 .genie/state/agents/logs/agents-learn-*.log
# Shows: {"session_id":"b654d5f6-6887-4580-ac93-efe8c8ef90b2"}

# Step 3: Try to resume
mcp__genie__resume(sessionId="5438dfa7-835d-475e-85cc-e3a950b5e7a7")
# FAILS: "No conversation found with session ID"
```

**Root cause:** Two different UUIDs for the same session
- MCP tracking: `5438dfa7-835d-475e-85cc-e3a950b5e7a7`
- Executor created: `b654d5f6-6887-4580-ac93-efe8c8ef90b2`

### Multiple Bugs Caused By This

1. **#115 - Session ID collision:** MCP and executor create different IDs
2. **Resume failure:** Can't find session because ID doesn't match
3. **Truncated UUIDs:** `5438dfa7...` confuses LLMs and humans
4. **Copy/paste errors:** Long UUIDs are error-prone
5. **Wait time:** Must wait for executor to generate UUID
6. **Poor UX:** Typing `5438dfa7-835d-475e-85cc-e3a950b5e7a7` vs `my-session`

---

## Proposed Solution

### Name as Primary Identifier

**Key insight:** The `--name` flag already exists and is human-readable. Make it the **primary identifier**.

### New Architecture

**Architectural principle:** UUIDs have never existed. Names are the only concept. Genie has zero awareness of UUIDs - they are purely internal executor implementation details.

**Naming convention:** Session names should match wish names for consistency across branches, wishes, and sessions.

**sessions.json structure:**
```json
{
  "version": 3,
  "sessions": {
    "bug-test-session-1": {
      "name": "bug-test-session-1",
      "agent": "agents/learn",
      "created": "2025-10-18T19:35:28.251Z",
      "status": "completed",
      "logFile": ".genie/state/agents/logs/agents-learn-1760816128160.log"
    }
  }
}
```

**Key changes:**
- ✅ Name is the ONLY identifier (UUIDs completely hidden)
- ✅ Name is mandatory - auto-generated if not provided
- ✅ Simpler storage - no UUID fields at all
- ✅ Executor may use UUIDs internally, but CLI never exposes them

---

## User Experience Improvements

### Before (RC27 - Broken)

```bash
# Run - wait for UUID
$ genie run learn "test"
Session ID: 5438dfa7-835d-475e-85cc-e3a950b5e7a7  # Copy this!

# Resume - must paste exact UUID
$ genie resume 5438dfa7-835d-475e-85cc-e3a950b5e7a7 "continue"
❌ ERROR: No conversation found

# View - need UUID
$ genie view 5438dfa7-835d-475e-85cc-e3a950b5e7a7

# List shows truncated UUIDs
$ genie list sessions
5438dfa7... | learn | completed
```

### After (RC28 - Fixed)

```bash
# Working on wish #120
$ genie run implementor "Add executor replacement" --name 120-executor-replacement
✅ Started: 120-executor-replacement

# Resume - type the wish-based name
$ genie resume 120-executor-replacement "continue"
✅ Resumed: 120-executor-replacement

# View - same name as wish
$ genie view 120-executor-replacement

# List shows semantic names
$ genie list sessions
120-executor-replacement | implementor | running
115-session-architecture | learn | completed
89-fix-legacy-commands | git | completed

# Auto-generated names if not provided
$ genie run learn "quick test"
✅ Started: learn-20251018193528
```

---

## Implementation Details

### 1. Session Lookup Strategy

```typescript
function findSession(name: string): Session {
  // Direct lookup by name - no UUID fallback
  if (!sessions[name]) {
    throw new Error(
      `Session not found: ${name}\n\n` +
      `Available sessions: ${Object.keys(sessions).join(', ')}`
    );
  }

  return sessions[name];
}
```

### 2. Session Naming Patterns

**Wish-based naming (preferred):**
```typescript
// When working on a wish/issue
// Pattern: {issue-number}-{short-description}
// Examples:
"120-executor-replacement"
"115-session-name-architecture"
"89-fix-legacy-commands"
```

**Auto-generated names (fallback):**
```typescript
function generateSessionName(agent: string): string {
  const timestamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');
  return `${agent}-${timestamp}`;
  // Example: "learn-20251018193528"
}
```

**Benefits of wish-based naming:**
- ✅ Natural mapping: wish #120 → session "120-executor-replacement"
- ✅ Easy to find: same name everywhere (branches, wishes, sessions)
- ✅ Semantic meaning: know what the session is about
- ✅ Consistent pattern: always follows wish naming convention

### 3. Name Validation

```typescript
function validateSessionName(name: string): void {
  // Rules:
  // - Length: 1-64 chars
  // - Pattern: alphanumeric, dash, underscore only
  // - No spaces (easier to type)

  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    throw new Error('Invalid session name. Use: a-z, 0-9, -, _');
  }
}
```

### 4. Migration for Existing Sessions

```typescript
function migrateToV3(oldSessions: V2Sessions): V3Sessions {
  const newSessions: V3Sessions = {};

  for (const [uuid, session] of Object.entries(oldSessions)) {
    const name = session.name || `migrated-${uuid.slice(0, 8)}`;

    newSessions[name] = {
      name,
      agent: session.agent,
      created: session.created,
      status: session.status,
      logFile: session.logFile
      // UUIDs discarded - not needed in v3
    };
  }

  return { version: 3, sessions: newSessions };
}
```

---

## Files to Modify

### Core Changes

1. **`.genie/cli/src/session-store/index.ts`**
   - Change storage key from UUID to name
   - Add `findSession()` with fallback logic
   - Add `validateSessionName()`
   - Add `generateSessionName()`

2. **`.genie/cli/src/mcp/handlers/run.ts`**
   - Return name ONLY in output (never expose UUIDs)
   - Generate name if not provided
   - Pass name to executor (executor may generate UUID internally, but we don't track it)

3. **`.genie/cli/src/mcp/handlers/resume.ts`**
   - Accept name ONLY
   - Use `findSession()` for lookup

4. **`.genie/cli/src/cli-core/handlers/run.ts`**
   - Same changes as MCP run handler

5. **`.genie/cli/src/cli-core/handlers/resume.ts`**
   - Same changes as MCP resume handler

6. **`.genie/cli/src/views/session-list.ts`**
   - Display names ONLY (no UUIDs anywhere)
   - Remove all UUID-related formatting

### Tests to Add

7. **`.genie/cli/tests/session-name-lookup.test.ts`**
   ```typescript
   test('resume by name', () => {
     const session = findSession('my-test');
     expect(session.name).toBe('my-test');
   });

   test('reject UUID input', () => {
     expect(() => findSession('5438dfa7-...')).toThrow('Session not found');
   });

   test('auto-generate name', () => {
     const name = generateSessionName('learn');
     expect(name).toMatch(/^learn-\d{14}$/);
   });
   ```

---

## Benefits Summary

### Bugs Eliminated

- ✅ **#115 - Session ID collision:** Name is single source of truth
- ✅ **Resume failure:** Works with name regardless of UUID mismatch
- ✅ **Truncated UUIDs:** Show full names instead
- ✅ **Copy/paste errors:** Type names, not UUIDs
- ✅ **Wait time:** Instant return (don't wait for executor UUID)

### UX Improvements

- ✅ **Human readable:** `my-test` vs `5438dfa7-835d-475e-85cc-e3a950b5e7a7`
- ✅ **Faster workflow:** No waiting for session ID generation
- ✅ **Less error-prone:** Names are easy to remember and type
- ✅ **Better debugging:** Names have semantic meaning
- ✅ **Zero UUID exposure:** Clean architecture, no legacy baggage

### Developer Benefits

- ✅ **Simpler debugging:** Logs show meaningful names
- ✅ **Easier testing:** Predictable session identifiers
- ✅ **Cleaner code:** Remove UUID passing complexity
- ✅ **Future proof:** Names scale better than UUIDs

---

## Migration Path

### Single Phase: Clean Break (RC28)

**No backwards compatibility - names only from day one.**

1. ✅ Implement name-only session management
2. ✅ Auto-migrate existing sessions to names
3. ✅ Remove all UUID exposure from CLI/MCP
4. ✅ Update all commands to accept name ONLY
5. ✅ Clear error messages if UUID accidentally used
6. ❌ No UUID fallback - keep it simple

**Rationale:**
- RC27 is broken anyway (nothing to be backwards compatible with)
- Clean architecture beats backwards compatibility
- Genie should have ZERO awareness UUIDs ever existed
- Consistent naming enables wish → session → branch mapping
- Drop-in replacement, breaking changes acceptable

---

## Testing Strategy

### Manual QA Checklist

```bash
# Test 1: Wish-based naming (preferred workflow)
genie run implementor "Work on issue #120" --name 120-executor-replacement
genie resume 120-executor-replacement "continue"
✅ Should work - name matches wish/branch

# Test 2: Run without name (auto-generate)
genie run learn "quick test"
# Note the auto-generated name: learn-20251018193528
genie resume learn-20251018193528 "continue"
✅ Should work

# Test 3: Reject UUID input (Genie doesn't know what UUIDs are)
genie resume 5438dfa7-835d-475e-85cc-e3a950b5e7a7 "continue"
❌ Should fail with: "Session not found: 5438dfa7-835d-475e-85cc-e3a950b5e7a7
Available sessions: 120-executor-replacement, learn-20251018193528"

# Test 4: Name validation
genie run learn "test" --name "invalid name with spaces"
❌ Should fail with: "Invalid session name. Use: a-z, 0-9, -, _"

# Test 5: List sessions shows semantic names
genie list sessions
✅ Should show:
120-executor-replacement | implementor | running
115-session-architecture | learn | completed
89-fix-legacy-commands | git | completed

# Test 6: View/stop by wish-based name
genie view 120-executor-replacement
genie stop 120-executor-replacement
✅ Should work - natural mapping
```

### Automated Tests

```typescript
describe('Name-based session management', () => {
  test('create with explicit name');
  test('create with auto-generated name');
  test('resume by name');
  test('reject UUID for resume');
  test('reject UUID for view');
  test('reject UUID for stop');
  test('view by name');
  test('stop by name');
  test('list shows names');
  test('name validation');
  test('migration from v2 to v3');
  test('concurrent sessions with different names');
  test('session name conflicts');
});
```

---

## Implementation Priority

### Must Have (RC28)

1. ✅ Name-ONLY session storage (no UUIDs exposed)
2. ✅ `findSession()` with name lookup (no fallback)
3. ✅ Auto-generate names if not provided
4. ✅ Update MCP/CLI handlers to never show UUIDs
5. ✅ Migration script for existing sessions
6. ✅ Name validation with clear errors
7. ✅ Clear error if UUID accidentally used

### Nice to Have (RC28)

1. ⚙️ Session name tab completion
2. ⚙️ Suggest wish-based name when in .genie/wishes/ directory
3. ⚙️ Auto-extract name from active branch (e.g., branch "120-executor-replacement" → session name suggestion)

### Future (RC29+)

1. 🔮 Auto-link sessions to wishes based on matching names
2. 🔮 Session search by pattern (e.g., all sessions for issue #120)
3. 🔮 Wish metadata shows associated session names
4. 🔮 Branch name → session name → wish name consistency validation

---

## Success Criteria

RC28 is successful when:

1. ✅ All session commands accept name ONLY (reject UUIDs)
2. ✅ Resume works 100% of the time (no ID mismatch possible)
3. ✅ Zero UUID-related bugs in QA (UUIDs don't exist in user-facing code)
4. ✅ Names shown in ALL output (grep codebase finds zero UUID outputs)
5. ✅ Existing sessions migrated seamlessly
6. ✅ Documentation contains ZERO UUID examples
7. ✅ Error messages guide users to use names if UUID accidentally provided

---

## Conclusion

**Name-based session management solves the root cause of #115 and related bugs.**

Instead of fixing UUID synchronization between MCP and executor, we eliminate the problem entirely by making human-readable names the primary identifier.

**Next steps:**
1. Implement in RC28 (high priority)
2. Remove ALL UUID-related code from user-facing paths
3. Establish wish-based naming convention in docs
4. Full QA testing with new architecture
5. No announcement needed - RC27 was broken, RC28 is the real release

---

**Document created:** 2025-10-18T19:40:00 UTC
**For release:** RC28
**Fixes:** #115, resume failures, truncated UUIDs, UX issues
