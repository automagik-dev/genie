# WISH: Session Name Architecture

**Issue:** #146
**Branch:** `115-session-name-architecture`
**Status:** 🚧 IN PROGRESS
**Priority:** 🔴 CRITICAL (Blocks RC28)

---

## Problem Statement

Current session management is BROKEN:
- MCP returns UUID: `5438dfa7...`
- Executor creates different UUID: `b654d5f6...`
- Resume fails: "No conversation found"
- Poor UX: Users copy/paste long UUIDs
- No semantic meaning

**Evidence:** `.genie/reports/rc28-session-name-architecture.md`

---

## Desired Outcome

✅ Sessions use human-readable names as primary identifier
✅ UUIDs NEVER exposed to users or Genie
✅ Natural mapping: branch `146-xyz` → session `146-xyz` → wish `146-xyz`
✅ Resume works 100% of the time
✅ Clean architecture, zero UUID references in output

---

## Solution Design

### Architecture

**Storage (v3):**
```json
{
  "version": 3,
  "sessions": {
    "146-session-name-architecture": {
      "name": "146-session-name-architecture",
      "agent": "neurons/implementor",
      "status": "running",
      "created": "2025-10-18T20:00:00Z"
    }
  }
}
```

**Key principle:** Names are the ONLY public identifier. UUIDs are executor's internal business.

### Implementation Checklist

**Foundation (DONE ✅):**
- [x] Session store v3 with name-based indexing
- [x] Migration v2 → v3
- [x] `findSessionEntry()` simplified to name lookup
- [x] Architecture documentation
- [x] Workflow patterns documentation

**Core Changes (TODO):**
- [ ] Update `shared.ts` - key by name not sessionId
  - [ ] Line 339: `store.sessions[entry.name]`
  - [ ] Line 406: `store.sessions[entry.name]`
  - [ ] Line 343-349: Output name not UUID
- [ ] Update MCP run handler
  - [ ] Return name in output
  - [ ] Generate name if not provided
- [ ] Update MCP resume handler
  - [ ] Accept name parameter
  - [ ] Remove UUID lookup
- [ ] Update CLI handlers
  - [ ] `view` - accept name
  - [ ] `stop` - accept name
  - [ ] `list` - show names
- [ ] Update views
  - [ ] Remove UUID from output
  - [ ] Show names everywhere
- [ ] Test migration v2 → v3
- [ ] Remove all UUID references

---

## Files to Modify

### Critical Path

1. **`.genie/cli/src/cli-core/handlers/shared.ts`**
   - Change all `store.sessions[entry.sessionId]` to `store.sessions[entry.name]`
   - Update output messages (lines 343-349)
   - Remove sessionId requirement checks

2. **`.genie/cli/src/mcp/handlers/run.ts`**
   - Return name in MCP output
   - Ensure name is set before storage

3. **`.genie/cli/src/mcp/handlers/resume.ts`**
   - Parameter: `name` not `sessionId`
   - Direct lookup by name

4. **`.genie/cli/src/cli-core/handlers/view.ts`** (if exists)
   - Accept name parameter

5. **`.genie/cli/src/cli-core/handlers/stop.ts`** (if exists)
   - Accept name parameter

6. **`.genie/cli/src/views/*.ts`**
   - Remove UUID formatting
   - Show names only

---

## Testing Strategy

### Migration Testing
```bash
# Backup current sessions
cp .genie/state/agents/sessions.json .genie/state/agents/sessions.v2.backup

# Run code (should auto-migrate)
genie list sessions

# Verify migration
cat .genie/state/agents/sessions.json | jq '.version'
# Should show: 3

# Check names
cat .genie/state/agents/sessions.json | jq '.sessions | keys'
# Should show names, not UUIDs
```

### Functional Testing
```bash
# Test 1: Run with explicit name
genie run learn "test" --name test-session-1
# Should see: "Started: test-session-1" (NOT a UUID)

# Test 2: Resume by name
genie resume test-session-1 "continue"
# Should work (not fail with "No conversation found")

# Test 3: View by name
genie view test-session-1
# Should show transcript

# Test 4: List shows names
genie list sessions
# Should show: test-session-1 | learn | completed

# Test 5: Auto-generated names
genie run learn "test"
# Should see: "Started: learn-20251018..." (timestamp pattern)

# Test 6: Reject UUID input
genie resume 5438dfa7-835d-475e-85cc-e3a950b5e7a7 "test"
# Should fail with helpful message
```

---

## Success Criteria

1. ✅ All tests pass
2. ✅ No UUIDs in `genie list sessions` output
3. ✅ No UUIDs in run/resume/view/stop output
4. ✅ `grep -r "sessionId" .genie/cli/src/views/` finds ZERO output references
5. ✅ Resume works 100% of the time
6. ✅ Migration from v2 happens automatically
7. ✅ Existing sessions still accessible by name

---

## Risks & Mitigation

**Risk:** Breaking change for users with scripts using UUIDs
**Mitigation:** RC27 already broken, so no backwards compat needed

**Risk:** Migration fails for edge cases
**Mitigation:** Generate safe fallback names (`migrated-{uuid-prefix}`)

**Risk:** Name conflicts
**Mitigation:** Validate name uniqueness before storage

---

## Blockers

None - all dependencies complete.

---

## Notes

- This fixes the #115 UUID mismatch bug at architectural level
- Part of RC28 release
- Breaking change acceptable (RC27 already broken)
- Establishes naming convention for future

---

**Last Updated:** 2025-10-18T20:05:00 UTC
**Next:** Create Forge task, implement remaining changes
