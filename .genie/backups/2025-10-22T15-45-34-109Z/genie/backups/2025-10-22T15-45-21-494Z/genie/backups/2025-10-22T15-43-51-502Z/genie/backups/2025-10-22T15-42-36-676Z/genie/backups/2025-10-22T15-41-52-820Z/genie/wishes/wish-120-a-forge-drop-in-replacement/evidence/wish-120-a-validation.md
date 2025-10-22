# Wish #120-A Validation Checklist

**Wish:** Forge Drop-In Replacement (Core Integration)
**Date Created:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Status:** ⏳ Pending Validation
**Version:** v2.4.0-rc.28+

---

## 🎯 Purpose

This checklist provides validation commands and expected outcomes for all success criteria of Wish #120-A. Use this document to verify the Forge integration is working correctly.

---

## ✅ Success Criteria Validation

### 1. Feature Parity - All Commands Work Identically

#### Test 1.1: Run Command

**Command:**
```bash
export FORGE_BASE_URL="http://localhost:3000"
npx automagik-genie run analyze "analyze my codebase"
```

**Expected Output:**
```
▸ Creating Forge task for analyze...
▸ Task attempt created: {uuid}
▸ Worktree: /var/tmp/automagik-forge/worktrees/{uuid}
▸ Branch: forge/{uuid}

  View output:
    npx automagik-genie view analyze-{timestamp}

  Continue conversation:
    npx automagik-genie resume analyze-{timestamp} "..."

  Stop the agent:
    npx automagik-genie stop analyze-{timestamp}
```

**Validation:**
- [ ] Command completes without errors
- [ ] Session created in < 5s
- [ ] Output format matches traditional launcher
- [ ] Session appears in `genie list sessions`

---

#### Test 1.2: Resume Command

**Command:**
```bash
# Get session ID from previous test
SESSION_ID="analyze-{timestamp}"
npx automagik-genie resume $SESSION_ID "continue the analysis"
```

**Expected Output:**
```
▸ Resuming Forge session: {session-name}
▸ Follow-up submitted to Forge
▸ Executor: forge
▸ Task Attempt ID: {uuid}

(Session continues executing...)
```

**Validation:**
- [ ] Command completes without errors
- [ ] Follow-up submitted via Forge API
- [ ] No new process spawned (uses Forge resumeSession)
- [ ] Conversation history preserved

---

#### Test 1.3: View Command

**Command:**
```bash
npx automagik-genie view $SESSION_ID
```

**Expected Output:**
```
Session: {session-name}
Executor: forge
Status: running
Source: Forge logs

--- Transcript ---

(Session output displayed...)
```

**Validation:**
- [ ] Command completes without errors
- [ ] Source indicator shows "Forge logs"
- [ ] Transcript displayed correctly
- [ ] Fallback to CLI log if Forge unavailable

---

#### Test 1.4: Stop Command

**Command:**
```bash
npx automagik-genie stop $SESSION_ID
```

**Expected Output:**
```
▸ Stopping Forge session: {session-name}
✓ Session stopped via Forge API
✓ Task Attempt ID: {uuid}

Session {session-name} stopped (done)
```

**Validation:**
- [ ] Command completes without errors
- [ ] Forge API called (not PID termination)
- [ ] Session status updated to 'stopped'
- [ ] Process terminated gracefully

---

#### Test 1.5: List Command

**Command:**
```bash
npx automagik-genie list sessions
```

**Expected Output:**
```
Session Name          | Executor | Status  | Created             | Last Used
-------------------------------------------------------------------------------------
analyze-2510181530    | forge    | stopped | 2025-10-18 15:30:00 | 2025-10-18 15:35:00
debug-2510181500      | codex    | running | 2025-10-18 15:00:00 | 2025-10-18 15:10:00
```

**Validation:**
- [ ] Command completes without errors
- [ ] Forge sessions show executor='forge'
- [ ] Traditional sessions show executor='codex'/'claude'
- [ ] Both session types displayed correctly
- [ ] Sorted by lastUsed (descending)

---

### 2. CLI Output Format Unchanged

**Test 2.1: Compare Output Before/After**

**Before (Traditional):**
```bash
# Disable Forge
unset FORGE_BASE_URL
npx automagik-genie run test-traditional "test" > /tmp/output-traditional.txt
```

**After (Forge):**
```bash
# Enable Forge
export FORGE_BASE_URL="http://localhost:3000"
npx automagik-genie run test-forge "test" > /tmp/output-forge.txt
```

**Validation Command:**
```bash
# Compare output structure (ignore session IDs, timestamps)
diff -u <(cat /tmp/output-traditional.txt | sed 's/test-traditional-[0-9]*/SESSION_ID/g' | sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}/DATE/g') \
        <(cat /tmp/output-forge.txt | sed 's/test-forge-[0-9]*/SESSION_ID/g' | sed 's/[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}/DATE/g')
```

**Expected:**
- [ ] No significant differences (ignore session IDs, timestamps)
- [ ] Same command structure
- [ ] Same success/error message format

---

### 3. Migration - Existing Sessions Migrate Without Data Loss

**Test 3.1: Backup Verification**

**Command:**
```bash
# Check backup was created
ls -lh .genie/state/agents/backups/sessions-*.json

# Verify backup is valid JSON
LATEST_BACKUP=$(ls -t .genie/state/agents/backups/sessions-*.json | head -1)
jq '.' "$LATEST_BACKUP" > /dev/null && echo "✓ Valid JSON" || echo "✗ Invalid JSON"

# Count sessions in backup
jq '.sessions | length' "$LATEST_BACKUP"
```

**Validation:**
- [ ] Backup file exists
- [ ] Backup is valid JSON
- [ ] Session count matches pre-migration

---

**Test 3.2: Dry-Run Migration**

**Command:**
```bash
npx automagik-genie migrate --dry-run
```

**Expected Output:**
```
Migration Plan (DRY RUN):
- Total sessions: 15
- Will migrate: 8 (running/pending)
- Will archive: 7 (completed/stopped)
- Forge tasks to create: 8
- No changes made (dry-run mode)
```

**Validation:**
- [ ] Dry-run completes without errors
- [ ] Session counts shown
- [ ] No actual changes made to sessions.json
- [ ] Plan looks reasonable

---

**Test 3.3: Execute Migration**

**Command:**
```bash
npx automagik-genie migrate --execute
```

**Expected Output:**
```
Migration Progress:
✓ Backup created: sessions-20251018-153000.json
✓ Forge health check passed
✓ Project found: Genie Sessions (uuid: ...)
✓ Migrating session 1/8: analyze-2510181500
✓ Migrating session 2/8: debug-2510181510
...
✓ Migration complete: 8 sessions migrated
✓ Archived: 7 completed sessions
✓ sessions.json updated
```

**Validation:**
- [ ] Migration completes without errors
- [ ] All active sessions migrated
- [ ] Completed sessions archived
- [ ] Session count unchanged
- [ ] No data loss

---

**Test 3.4: Post-Migration Validation**

**Command:**
```bash
# Count sessions before migration
PRE_COUNT=$(jq '.sessions | length' .genie/state/agents/backups/sessions-*.json | head -1)

# Count sessions after migration
POST_COUNT=$(jq '.sessions | length' .genie/state/agents/sessions.json)

# Compare
echo "Pre-migration: $PRE_COUNT"
echo "Post-migration: $POST_COUNT"
echo "Difference: $((POST_COUNT - PRE_COUNT))"
```

**Expected:**
- [ ] Difference = 0 (no sessions lost)
- [ ] All session IDs present
- [ ] All session metadata preserved

---

### 4. Error Messages Identical (No New Jargon)

**Test 4.1: Invalid Session ID**

**Command:**
```bash
npx automagik-genie view invalid-session-id
```

**Expected Output (Forge mode):**
```
✗ Session not found: invalid-session-id
```

**Expected Output (Traditional mode):**
```
✗ Session not found: invalid-session-id
```

**Validation:**
- [ ] Error message identical (both modes)
- [ ] No Forge-specific jargon ("task attempt", "worktree")
- [ ] Exit code identical

---

**Test 4.2: Forge Backend Unavailable**

**Command:**
```bash
# Stop Forge backend
# (In Forge directory: Ctrl+C)

# Try to create session
export FORGE_BASE_URL="http://localhost:3000"
npx automagik-genie run test "test"
```

**Expected Output:**
```
⚠️ Forge backend unavailable, using traditional background launcher
▸ Starting session test-2510181530...
(session created with traditional launcher)
```

**Validation:**
- [ ] Warning displayed (Forge unavailable)
- [ ] Graceful fallback to traditional launcher
- [ ] Session still created successfully
- [ ] No error interruption

---

### 5. Configuration Unchanged (No New Required Env Vars)

**Test 5.1: No Forge Variables**

**Command:**
```bash
# Clear all Forge variables
unset FORGE_BASE_URL
unset FORGE_TOKEN
unset GENIE_PROJECT_ID

# Create session (should use traditional launcher)
npx automagik-genie run test-noforge "test"
```

**Validation:**
- [ ] Session created successfully
- [ ] Uses traditional launcher
- [ ] No errors about missing configuration
- [ ] Same user experience as before Forge

---

**Test 5.2: With Forge Variables**

**Command:**
```bash
# Set minimal Forge config
export FORGE_BASE_URL="http://localhost:3000"

# Create session (should use Forge)
npx automagik-genie run test-forge "test"
```

**Validation:**
- [ ] Session created successfully
- [ ] Uses Forge backend
- [ ] No additional required variables
- [ ] FORGE_TOKEN optional
- [ ] GENIE_PROJECT_ID optional (auto-created)

---

## 🚀 Performance Requirements

### 6. Session Creation < 5s

**Test 6.1: Time Session Creation**

**Command:**
```bash
export FORGE_BASE_URL="http://localhost:3000"

# Time 10 session creations
for i in {1..10}; do
  echo "Test $i:"
  time npx automagik-genie run perf-$i "performance test $i"
  sleep 1
done
```

**Validation:**
```bash
# Calculate average time
# Expected: < 5s per session
```

**Criteria:**
- [ ] Average session creation < 5s
- [ ] No timeouts (100% success rate)
- [ ] Faster than traditional (5-20s baseline)

---

### 7. Reliability - 0 Timeout Failures

**Test 7.1: Stress Test (20 Sessions)**

**Command:**
```bash
export FORGE_BASE_URL="http://localhost:3000"

# Create 20 sessions sequentially
FAILURES=0
for i in {1..20}; do
  npx automagik-genie run stress-$i "stress test $i" || FAILURES=$((FAILURES + 1))
  sleep 0.5
done

echo "Failures: $FAILURES / 20"
echo "Success rate: $(( (20 - FAILURES) * 100 / 20 ))%"
```

**Validation:**
- [ ] Failures = 0
- [ ] Success rate = 100%
- [ ] No timeout errors
- [ ] All sessions created

---

### 8. Parallel Safety - 10+ Concurrent Sessions

**Test 8.1: Parallel Session Creation**

**Command:**
```bash
export FORGE_BASE_URL="http://localhost:3000"

# Create 10 sessions in parallel
for i in {1..10}; do
  npx automagik-genie run parallel-$i "parallel test $i" &
done
wait

# Count successes
npx automagik-genie list sessions | grep -c "parallel-"
```

**Expected:**
```
10
```

**Validation:**
- [ ] All 10 sessions created
- [ ] No collisions (UUID reuse)
- [ ] No filesystem conflicts
- [ ] All sessions independent (worktree isolation)

---

## 📝 Code Quality Requirements

### 9. Code Reduction - ~40% Achieved

**Test 9.1: Line Count Comparison**

**Command:**
```bash
# Count lines in deleted files (from git history)
git show HEAD~1:^.genie/cli/src/lib/background-launcher.ts | wc -l
git show HEAD~1:.genie/cli/src/lib/background-manager.ts | wc -l

# Count lines in new file
wc -l .genie/cli/src/lib/forge-executor.ts

# Calculate reduction
```

**Note:** In Wish #120-A, we kept background-launcher.ts and background-manager.ts for backwards compatibility. Code reduction deferred to future cleanup.

**Validation:**
- [ ] forge-executor.ts implemented (~308 lines)
- [ ] background-launcher.ts kept (fallback)
- [ ] Code reduction validated in future cleanup

---

### 10. Filesystem Audit - Zero Direct Worktree Access

**Test 10.1: Search for Violations**

**Command:**
```bash
# Search for direct worktree access in CLI code
grep -r "/var/tmp/automagik-forge/worktrees/" .genie/cli/src/ || echo "✓ No violations found"

# Search for fs.readFileSync in handlers (except fallback)
grep -r "fs.readFileSync" .genie/cli/src/cli-core/handlers/

# Expected: Only in view.ts (fallback to CLI log)
```

**Validation:**
- [ ] No direct worktree access in handlers
- [ ] All operations go through Forge API
- [ ] Fallback uses CLI log files only

---

### 11. Tests Passing - `pnpm run check`

**Command:**
```bash
cd /path/to/automagik-genie

# Run all checks
pnpm run check

# Or individual checks:
pnpm run build:genie  # TypeScript compilation
pnpm run test:genie   # Unit tests
```

**Validation:**
- [ ] Build succeeds (no TypeScript errors)
- [ ] All tests pass
- [ ] No linting errors
- [ ] No type errors

---

### 12. Rollback Plan Documented and Tested

**Test 12.1: Verify Rollback Documentation**

**Command:**
```bash
# Check rollback plan exists
test -f .genie/docs/forge-rollback-plan.md && echo "✓ Found" || echo "✗ Missing"

# Validate rollback plan is complete
grep -q "Emergency Rollback" .genie/docs/forge-rollback-plan.md && echo "✓ Emergency section found"
grep -q "Step-by-step" .genie/docs/forge-rollback-plan.md && echo "✓ Steps documented"
```

**Validation:**
- [ ] Rollback plan exists
- [ ] Emergency rollback procedure documented
- [ ] Step-by-step rollback instructions
- [ ] Validation checklist included

---

**Test 12.2: Test Rollback (Dry-Run)**

**Command:**
```bash
# Simulate rollback
npx automagik-genie migrate --rollback --dry-run

# Expected output:
# Rollback Plan (DRY RUN):
# - Will restore backup: sessions-20251018.json
# - Current sessions will be replaced
# - No changes made (dry-run mode)
```

**Validation:**
- [ ] Rollback dry-run works
- [ ] No actual changes made
- [ ] Backup path shown
- [ ] Clear instructions

---

## 📊 Safety Requirements

### 13. Migration Tested - Dry-Run + Real Migration

**Already validated in Test 3.2 and 3.3 above**

**Checklist:**
- [ ] Dry-run migration tested ✓ (Test 3.2)
- [ ] Real migration executed ✓ (Test 3.3)
- [ ] Backup created before migration ✓ (Test 3.1)
- [ ] Post-migration validation passed ✓ (Test 3.4)

---

### 14. Rollback Tested - Downgrade Procedure

**Test 14.1: Execute Rollback**

**Command:**
```bash
# Backup current state
cp .genie/state/agents/sessions.json .genie/state/agents/sessions-before-rollback.json

# Execute rollback
npx automagik-genie migrate --rollback

# Verify rollback
jq '.sessions | length' .genie/state/agents/sessions.json
```

**Validation:**
- [ ] Rollback completes successfully
- [ ] Sessions restored from backup
- [ ] Session count matches backup
- [ ] No data loss

---

**Test 14.2: Re-Migration After Rollback**

**Command:**
```bash
# Re-run migration
npx automagik-genie migrate --execute

# Verify sessions migrated again
npx automagik-genie list sessions | grep "forge"
```

**Validation:**
- [ ] Re-migration succeeds
- [ ] Sessions migrated to Forge again
- [ ] Rollback/migration cycle works

---

### 15. Pre-commit Hooks - Filesystem Restrictions Enforced

**Test 15.1: Verify Pre-commit Hook Exists**

**Command:**
```bash
# Check pre-commit hook exists
test -f .git/hooks/pre-commit && echo "✓ Found" || echo "✗ Missing"

# Verify hook checks for worktree violations
grep -q "worktrees" .git/hooks/pre-commit && echo "✓ Worktree check found"
```

**Validation:**
- [ ] Pre-commit hook exists
- [ ] Hook checks for direct worktree access
- [ ] Hook blocks violating commits

---

**Test 15.2: Test Pre-commit Hook**

**Command:**
```bash
# Create test file with violation
echo 'fs.readFileSync("/var/tmp/automagik-forge/worktrees/test")' > test-violation.js

# Try to commit (should fail)
git add test-violation.js
git commit -m "test: violation"

# Expected: Commit blocked

# Clean up
rm test-violation.js
git reset HEAD test-violation.js
```

**Validation:**
- [ ] Pre-commit hook blocks violation
- [ ] Clear error message shown
- [ ] Commit not created

---

### 16. Documentation Complete

**Test 16.1: Verify All Documentation Exists**

**Command:**
```bash
# Check required docs exist
test -f .genie/docs/forge-quick-start.md && echo "✓ Quick Start"
test -f .genie/docs/forge-executor-upgrade.md && echo "✓ Upgrade Guide"
test -f .genie/docs/forge-rollback-plan.md && echo "✓ Rollback Plan"
test -f .genie/docs/architecture.md && echo "✓ Architecture"
test -f .genie/evidence/wish-120-a-validation.md && echo "✓ Evidence Checklist"
test -f CONTRIBUTING.md && echo "✓ Contributing (updated)"
```

**Validation:**
- [ ] Quick Start guide exists
- [ ] Upgrade guide exists
- [ ] Rollback plan exists
- [ ] Architecture doc exists
- [ ] Evidence checklist exists (this file!)
- [ ] CONTRIBUTING.md mentions Forge

---

## 🎯 Final Validation Summary

### All Success Criteria

- [ ] **Feature Parity:** All commands work identically (Tests 1.1-1.5)
- [ ] **CLI Output:** Format unchanged (Test 2.1)
- [ ] **Migration:** Zero data loss (Tests 3.1-3.4)
- [ ] **Error Messages:** Identical, no new jargon (Tests 4.1-4.2)
- [ ] **Configuration:** No new required env vars (Tests 5.1-5.2)
- [ ] **Performance:** Session creation < 5s (Test 6.1)
- [ ] **Reliability:** 0 timeout failures (Test 7.1)
- [ ] **Parallel Safety:** 10+ concurrent sessions (Test 8.1)
- [ ] **Code Quality:** forge-executor.ts implemented (Test 9.1)
- [ ] **Filesystem Audit:** Zero violations (Test 10.1)
- [ ] **Tests Passing:** `pnpm run check` passes (Test 11)
- [ ] **Rollback Plan:** Documented and tested (Tests 12.1-12.2)
- [ ] **Migration Tested:** Dry-run + real (Tests 13, 3.2-3.3)
- [ ] **Rollback Tested:** Downgrade validated (Tests 14.1-14.2)
- [ ] **Pre-commit Hooks:** Enforced (Tests 15.1-15.2)
- [ ] **Documentation:** All docs complete (Test 16.1)

---

## 📋 Evidence Collection Commands

### Capture All Evidence

**Command:**
```bash
# Create evidence directory
mkdir -p .genie/evidence/wish-120-a

# 1. Capture version info
npx automagik-genie --version > .genie/evidence/wish-120-a/version.txt

# 2. Capture session list
npx automagik-genie list sessions > .genie/evidence/wish-120-a/sessions-list.txt

# 3. Capture Forge health check
curl $FORGE_BASE_URL/health > .genie/evidence/wish-120-a/forge-health.json

# 4. Capture performance benchmark
time npx automagik-genie run perf-test "benchmark" 2>&1 | tee .genie/evidence/wish-120-a/perf-benchmark.txt

# 5. Capture test results
pnpm run check 2>&1 | tee .genie/evidence/wish-120-a/test-results.txt

# 6. Capture file changes
git diff HEAD~5 --stat > .genie/evidence/wish-120-a/file-changes.txt

# 7. Create evidence archive
tar -czf .genie/evidence/wish-120-a-$(date +%Y%m%d).tar.gz .genie/evidence/wish-120-a/
```

---

## 🚀 Quick Validation (5 Minutes)

**Minimal validation for smoke testing:**

```bash
#!/bin/bash
# Quick validation script

export FORGE_BASE_URL="http://localhost:3000"

echo "1. Health check..."
curl -s $FORGE_BASE_URL/health | jq '.'

echo "2. Create session..."
npx automagik-genie run test-quick "quick validation test"

echo "3. List sessions..."
npx automagik-genie list sessions | grep test-quick

echo "4. View session..."
SESSION_ID=$(npx automagik-genie list sessions | grep test-quick | awk '{print $1}')
npx automagik-genie view $SESSION_ID | head -20

echo "5. Stop session..."
npx automagik-genie stop $SESSION_ID

echo "✓ Quick validation complete!"
```

**Save as:** `.genie/evidence/quick-validation.sh`

---

## 📚 Reference

- **Wish Document:** `.genie/wishes/wish-120-a-forge-drop-in-replacement/wish-120-a-forge-drop-in-replacement.md`
- **Implementation Summary:** `.genie/discovery/wish-120-a-implementation-summary.md`
- **Quick Start:** `.genie/docs/forge-quick-start.md`
- **Upgrade Guide:** `.genie/docs/forge-executor-upgrade.md`
- **Rollback Plan:** `.genie/docs/forge-rollback-plan.md`
- **Architecture:** `.genie/docs/architecture.md`

---

**Validation Status:** ⏳ Pending

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

**Validated By:** _______________ (Name)

**Date Validated:** _______________ (Date)
