# RC20 QA Failure Report
**Date:** 2025-10-18 03:12 UTC
**Severity:** CRITICAL
**Status:** RC20 FAILED - Bug #102 Regression

---

## Executive Summary

RC20 comprehensive QA testing has **FAILED**. Critical regression of Bug #102 discovered:
- Every `run` command creates **TWO sessions with different UUIDs**
- Sessions have identical parameters except sessionId
- Background polling never finds session (V1/V2 format mismatch)
- Times out after 20 seconds

**Verdict:** RC20 is NOT production-ready. Immediate rollback to RC19 recommended until fixed.

---

## Bug Details

### Symptoms

**Test Command:**
```bash
npx automagik-genie run neurons/plan "QA Test 1: Basic session creation"
```

**Expected Result:**
- Single session created with UUID key
- Session tracked in sessions.json
- Polling finds session quickly

**Actual Result:**
```json
{
  "a3eb3467-a3b0-45c7-9670-f7e9cf684028": {
    "agent": "neurons/plan",
    "name": "neurons/plan-2510180309",
    "sessionId": "a3eb3467-a3b0-45c7-9670-f7e9cf684028",
    "runnerPid": 3392981,
    "executorPid": null,
    "status": "running"
  },
  "fdcefb8d-20be-4a09-bba1-5f9d8ce70358": {
    "agent": "neurons/plan",
    "name": "neurons/plan-2510180309",
    "sessionId": "fdcefb8d-20be-4a09-bba1-5f9d8ce70358",
    "runnerPid": 3392981,
    "executorPid": 3392988,
    "status": "completed"
  }
}
```

**Indicators:**
- ✅ UUID keys (not temp-*)
- ✅ Name field present
- ❌ **TWO sessions for ONE command**
- ❌ Same runnerPid (3392981)
- ❌ Same logFile path
- ❌ Different UUIDs
- ❌ "Timeout waiting for session ID" message

---

## Root Cause Analysis

### Code Path

**File:** `.genie/cli/src/lib/background-launcher.ts`
**Line:** 70
**Problem:** V1/V2 format mismatch

```typescript
// WRONG - uses V1 format (liveStore.agents)
const liveEntry = liveStore.agents?.[agentName];
```

**Should be:**
```typescript
// CORRECT - uses V2 format (liveStore.sessions)
const liveEntry = liveStore.sessions?.[entry.sessionId];
```

### Execution Flow

1. **User runs:** `genie run neurons/plan "test"`
2. **Foreground process (run.ts:68-93):**
   - Generates UUID1: `a3eb3467-a3b0-45c7-9670-f7e9cf684028`
   - Creates session entry
   - Saves to `store.sessions[UUID1]`
   - Calls `maybeHandleBackgroundLaunch()`

3. **Background launcher (background-launcher.ts:47-53):**
   - Spawns background runner process with `--backgroundRunner` flag
   - Updates entry with runnerPid
   - Starts polling loop (lines 67-99)

4. **Background runner process (separate invocation of run.ts):**
   - Generates UUID2: `fdcefb8d-20be-4a09-bba1-5f9d8ce70358`
   - Creates SECOND session entry
   - Saves to `store.sessions[UUID2]`
   - Starts agent execution

5. **Polling loop (background-launcher.ts:67-99):**
   - Looks for `liveStore.agents?.[agentName]` (V1 format)
   - Store only has `liveStore.sessions` (V2 format)
   - **NEVER FINDS SESSION**
   - Times out after 20 seconds (line 64)
   - Prints "Timeout waiting for session ID"

**Result:** Two sessions exist, polling fails, user sees timeout

---

## Evidence

### sessions.json Analysis

**Clean slate command:**
```bash
rm -rf .genie/state/agents/sessions.json .genie/state/agents/logs/*
```

**Test 1 execution:**
```bash
npx automagik-genie run neurons/plan "QA Test 1: Basic session creation"
```

**Sessions created:** 2 (should be 1)

**Session 1 (foreground):**
- Key: `a3eb3467-a3b0-45c7-9670-f7e9cf684028`
- sessionId: `a3eb3467-a3b0-45c7-9670-f7e9cf684028` ✅
- runnerPid: 3392981
- executorPid: `null` (never started)
- status: "running" (stuck)

**Session 2 (background runner):**
- Key: `fdcefb8d-20be-4a09-bba1-5f9d8ce70358`
- sessionId: `fdcefb8d-20be-4a09-bba1-5f9d8ce70358` ✅
- runnerPid: 3392981 (SAME as session 1!)
- executorPid: 3392988 (actually ran)
- status: "completed"

### Test 2 - Named Sessions

**Command:**
```bash
npx automagik-genie run code/neurons/implementor --name "qa-test-named" "QA Test 2"
```

**Result:** SAME PATTERN
- Created TWO sessions:
  - `281f9033-85e9-4e55-aaa9-60118df1fb8c`
  - `725f99fe-e4ff-4bec-9247-c79f507e886d`
- Both have name: "qa-test-named" ✅
- Both have same runnerPid
- Both point to same logFile
- Only sessionId differs

---

## Impact Assessment

### Severity: CRITICAL

**User-facing issues:**
1. ❌ `list` shows duplicate sessions (confusing)
2. ❌ User doesn't know which sessionId to use
3. ❌ `view` with wrong sessionId shows nothing
4. ❌ `resume` with wrong sessionId fails
5. ❌ "Timeout" message suggests failure (but agent actually runs)
6. ❌ sessions.json grows 2x faster than expected

**System issues:**
1. ❌ Storage waste (2x sessions)
2. ❌ Log file fragmentation possible
3. ❌ Session cleanup harder (orphaned entries)
4. ❌ Background polling broken (always times out)

### Affected Commands

- ✅ `run` - Creates duplicates (CRITICAL)
- ⚠️ `list` - Shows duplicates
- ⚠️ `view` - Depends on which sessionId
- ⚠️ `resume` - Depends on which sessionId
- ⚠️ `stop` - Depends on which sessionId

### Regression Status

**Bug #102 Status:**
- RC19 and before: Collision (same temp-* key, fragmented logs)
- RC20 attempted fix: UUID keys instead of temp-*
- RC20 actual result: **WORSE** - duplicate sessions with different UUIDs

---

## Fix Proposal

### Change Required

**File:** `.genie/cli/src/lib/background-launcher.ts`

**Line 70 - Current (WRONG):**
```typescript
const liveEntry = liveStore.agents?.[agentName];
```

**Line 70 - Fixed (CORRECT):**
```typescript
const liveEntry = liveStore.sessions?.[entry.sessionId];
```

**Why this works:**
- Uses V2 format (`sessions` not `agents`)
- Uses sessionId as key (already available from `entry`)
- Finds the correct session created by background runner
- No timeout, fast polling success

### Additional Cleanup

Remove all V1 format references:
```bash
grep -r "liveStore.agents" .genie/cli/src/
```

Should return ZERO results after fix.

---

## Validation Plan for RC21

### Pre-release Testing

**1. Clean slate test:**
```bash
rm -rf .genie/state/agents/sessions.json .genie/state/agents/logs/*
npx automagik-genie run neurons/plan "Test 1"
cat .genie/state/agents/sessions.json | jq '.sessions | length'
# Expected: 1 (not 2)
```

**2. UUID key format:**
```bash
cat .genie/state/agents/sessions.json | jq '.sessions | keys'
# Expected: Single UUID (not two)
```

**3. Name field:**
```bash
npx automagik-genie run neurons/plan --name "test-session" "Test 2"
cat .genie/state/agents/sessions.json | jq '.sessions | to_entries | .[].value.name'
# Expected: ["neurons/plan-TIMESTAMP", "test-session"]
```

**4. Polling success:**
```bash
npx automagik-genie run neurons/plan "Test 3" 2>&1 | grep "Timeout"
# Expected: NO OUTPUT (polling succeeds)
```

**5. Session count after 5 runs:**
```bash
for i in {1..5}; do
  npx automagik-genie run neurons/plan "Test $i"
  sleep 1
done
cat .genie/state/agents/sessions.json | jq '.sessions | length'
# Expected: 5 (not 10)
```

### Post-release Validation

- ✅ All CLI commands work with single session
- ✅ `list` shows correct session count
- ✅ `view` works with sessionId from output
- ✅ `resume` continues correct session
- ✅ No "Timeout" messages
- ✅ No V1 format references in code

---

## Recommendation

**Action:** HALT RC20 release
**Next steps:**
1. Apply fix to background-launcher.ts
2. Run full validation plan
3. Release RC21 with fix
4. Re-run comprehensive QA

**Timeline:**
- Fix: 5 minutes
- Rebuild: 1 minute
- Test: 10 minutes
- Release: 5 minutes
- **Total: ~20 minutes to RC21**

---

## QA Tests Completed

**Before failure:**
- ✅ Clean slate setup
- ⚠️ Session creation (discovered bug)

**Aborted (bug blocking):**
- ⏸️ Session listing
- ⏸️ Session viewing
- ⏸️ Session resume/stop
- ⏸️ Bug #4 validation
- ⏸️ MCP integration
- ⏸️ Edge cases
- ⏸️ Regression tests

**Reason for abort:** Duplicate session creation makes all downstream tests unreliable.

---

## Conclusion

RC20 has a **CRITICAL regression** of Bug #102. The fix changed symptoms (temp-* keys → UUID keys) but introduced worse behavior (duplicate sessions).

**Verdict:** RC20 FAILED QA - DO NOT DEPLOY

**Next:** Implement background-launcher.ts fix → RC21 → Re-test
