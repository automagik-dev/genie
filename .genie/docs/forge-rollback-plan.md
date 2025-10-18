# Forge Executor Rollback Plan

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Version:** 1.0.0
**Related:** Wish #120-A (Forge Drop-In Replacement)

---

## 📋 Purpose

This document provides step-by-step procedures to rollback from the Forge executor backend to the previous background-launcher.ts implementation in case of critical issues.

**When to rollback:**
- Migration fails with data loss
- Critical bugs discovered in Forge executor
- Performance degradation (>30s session creation times)
- Forge backend unavailable/unstable
- Data corruption detected

---

## 🚨 Emergency Rollback (Quick)

If you need to rollback immediately due to a critical issue:

```bash
# 1. Stop all running sessions
npx automagik-genie stop --all

# 2. Restore sessions.json from backup
cp .genie/state/agents/backups/sessions-*.json .genie/state/agents/sessions.json

# 3. Revert to previous version
git checkout <commit-before-forge-integration>

# 4. Reinstall dependencies
npm install

# 5. Verify rollback
npx automagik-genie list
```

**Time to complete:** ~2-5 minutes

---

## 📊 Detailed Rollback Procedure

### Pre-Rollback Checklist

Before starting rollback, gather the following information:

- [ ] Current git commit hash: `git rev-parse HEAD`
- [ ] Number of active sessions: `npx automagik-genie list | grep -c "running"`
- [ ] Latest backup path: `ls -t .genie/state/agents/backups/ | head -1`
- [ ] Reason for rollback: ________________________________

### Step 1: Stop All Sessions

**Objective:** Ensure no sessions are running during rollback

```bash
# List all running sessions
npx automagik-genie list

# Stop each session individually
npx automagik-genie stop <session-id>

# Or stop all at once (if available)
npx automagik-genie stop --all
```

**Validation:**
```bash
# Should show no running sessions
npx automagik-genie list | grep "running"
# Expected: No output
```

---

### Step 2: Backup Current State

**Objective:** Create a snapshot before rollback (in case we need to investigate)

```bash
# Create investigation directory
mkdir -p .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)

# Backup current sessions.json
cp .genie/state/agents/sessions.json \
   .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)/

# Backup current logs
cp -r .genie/state/agents/logs/ \
      .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)/

# Document the issue
echo "Rollback reason: [DESCRIBE ISSUE HERE]" > \
  .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)/README.md

echo "Git commit: $(git rev-parse HEAD)" >> \
  .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)/README.md
```

**Validation:**
```bash
# Verify backup exists
ls -lh .genie/state/rollback-investigation/
```

---

### Step 3: Restore sessions.json from Backup

**Objective:** Restore pre-migration session state

```bash
# Find latest backup
LATEST_BACKUP=$(ls -t .genie/state/agents/backups/sessions-*.json | head -1)

echo "Found backup: $LATEST_BACKUP"

# Verify backup is valid JSON
jq '.' "$LATEST_BACKUP" > /dev/null || {
  echo "❌ Backup is corrupted! Aborting rollback."
  exit 1
}

# Restore backup
cp "$LATEST_BACKUP" .genie/state/agents/sessions.json

# Verify restore
jq '.sessions | length' .genie/state/agents/sessions.json
```

**Validation:**
```bash
# Check sessions.json is valid
cat .genie/state/agents/sessions.json | jq '.'

# Verify session count matches pre-migration
jq '.sessions | length' .genie/state/agents/sessions.json
# Expected: Should match your pre-migration count
```

---

### Step 4: Revert Git to Pre-Forge Commit

**Objective:** Restore code to pre-Forge integration state

```bash
# Find commit before Forge integration
# (Look for commit message like "feat: Forge executor integration")
git log --oneline --grep="Forge" -n 10

# Identify the commit BEFORE Forge integration
# For example: abc1234

# Option A: Create new branch from pre-Forge commit (recommended)
git checkout -b rollback-from-forge abc1234

# Option B: Hard reset (destructive, use with caution)
# git reset --hard abc1234

# Verify we're on correct commit
git log --oneline -n 1
```

**Validation:**
```bash
# Verify background-launcher.ts exists
test -f .genie/cli/src/lib/background-launcher.ts && echo "✅ Found" || echo "❌ Missing"

# Verify forge-executor.ts is gone (or not used)
git diff HEAD~1 .genie/cli/src/lib/forge-executor.ts
```

---

### Step 5: Reinstall Dependencies

**Objective:** Ensure all npm dependencies match the reverted version

```bash
# Clean node_modules
rm -rf node_modules/

# Clean package-lock.json (optional, only if there were dependency changes)
rm -f package-lock.json

# Reinstall
npm install

# Rebuild TypeScript (if applicable)
npm run build
```

**Validation:**
```bash
# Verify installation
npm ls | grep -E "(commander|chalk|inquirer)"

# Verify genie CLI works
npx automagik-genie --version
```

---

### Step 6: Test Rollback Success

**Objective:** Verify Genie CLI works with old backend

```bash
# Test 1: List sessions (should work)
npx automagik-genie list

# Test 2: Run a simple session
npx automagik-genie run analyze "test rollback" --background

# Test 3: View the session
SESSION_ID=$(cat .genie/state/agents/sessions.json | jq -r '.sessions | keys[-1]')
npx automagik-genie view "$SESSION_ID"

# Test 4: Resume the session
npx automagik-genie resume "$SESSION_ID" "continue test"

# Test 5: Stop the session
npx automagik-genie stop "$SESSION_ID"
```

**Expected Results:**
- ✅ All commands execute without errors
- ✅ Sessions are created with background-launcher.ts (check logs)
- ✅ Session IDs are consistent
- ✅ No Forge-related errors

---

### Step 7: Clean Up Forge Tasks (Optional)

**Objective:** Delete orphaned Forge tasks created during migration

**Note:** This step is OPTIONAL and only needed if you want to clean up Forge database.

```bash
# List all Genie tasks in Forge
# (Requires Forge CLI or API access)

# Manual cleanup via Forge UI:
# 1. Open Forge UI: http://localhost:3000
# 2. Navigate to "Genie Sessions" project
# 3. Select all tasks with status "running" or "pending"
# 4. Click "Delete Tasks"

# Or via Forge CLI (if available):
# forge task delete --project "Genie Sessions" --all
```

---

### Step 8: Document the Rollback

**Objective:** Record what happened for future reference

```bash
# Update rollback investigation README
cat >> .genie/state/rollback-investigation/$(date +%Y%m%d-%H%M%S)/README.md <<EOF

## Rollback Completed

**Date:** $(date -u)
**Restored from backup:** $LATEST_BACKUP
**Git commit reverted to:** $(git rev-parse HEAD)
**Sessions restored:** $(jq '.sessions | length' .genie/state/agents/sessions.json)

## Post-Rollback Tests

- [ ] List sessions: PASSED
- [ ] Run session: PASSED
- [ ] View session: PASSED
- [ ] Resume session: PASSED
- [ ] Stop session: PASSED

## Issues Encountered During Rollback

[Document any issues here]

EOF

# Create GitHub issue (optional)
gh issue create \
  --title "Forge Executor Rollback - $(date +%Y-%m-%d)" \
  --body "Rolled back from Forge executor integration due to: [REASON]" \
  --label "rollback,forge,bug"
```

---

## 🔄 Rollback Migration Script

### Option: Automated Rollback

If migration was performed via `genie migrate --execute`, you can use the automated rollback:

```bash
# Automatic rollback (uses latest backup)
npx automagik-genie migrate --rollback

# Rollback to specific backup
npx automagik-genie migrate --rollback --backup=/path/to/backup.json
```

**What the script does:**
1. Restores sessions.json from specified backup
2. Deletes migration marker (`_migrated: true`)
3. Logs rollback event

**What the script does NOT do:**
- Does not revert git commits
- Does not delete Forge tasks
- Does not reinstall dependencies

---

## 🧪 Rollback Validation Checklist

After completing rollback, verify the following:

### Functional Tests

- [ ] `npx automagik-genie list` shows pre-migration sessions
- [ ] `npx automagik-genie run analyze "test"` creates session successfully
- [ ] Session creation time < 10s (no Forge timeout)
- [ ] Logs appear in `.genie/state/agents/logs/`
- [ ] `npx automagik-genie view <session-id>` shows logs correctly
- [ ] `npx automagik-genie resume <session-id> "test"` works
- [ ] `npx automagik-genie stop <session-id>` terminates session

### Data Integrity

- [ ] sessions.json has expected session count
- [ ] All session IDs are unique
- [ ] No duplicate entries in sessions.json
- [ ] Session statuses are accurate (no stuck "running")
- [ ] Archive file preserved (if exists): `.genie/state/agents/sessions-archive.json`

### Code Integrity

- [ ] `git status` shows clean working tree (or expected changes)
- [ ] `background-launcher.ts` exists and is used
- [ ] `forge-executor.ts` is not imported in handlers
- [ ] No TypeScript compilation errors
- [ ] All tests pass (if applicable)

---

## 🚧 Known Rollback Limitations

### 1. Forge Tasks Not Deleted Automatically

**Issue:** Tasks created in Forge during migration are NOT automatically deleted.

**Workaround:** Manual cleanup via Forge UI or API.

**Long-term solution:** Implement `deleteTask()` in ForgeClient.

---

### 2. Session IDs May Change

**Issue:** Forge uses different UUID generation than background-launcher.ts.

**Impact:** Session IDs from Forge-created sessions will differ from pre-migration.

**Workaround:** Use session names instead of IDs when possible.

---

### 3. Logs May Be Lost

**Issue:** Logs stored in Forge worktrees are not accessible after rollback.

**Impact:** Cannot view logs for sessions created during Forge integration.

**Workaround:** Export logs before rollback:

```bash
# Export logs for all sessions
for session in $(jq -r '.sessions | keys[]' .genie/state/agents/sessions.json); do
  npx automagik-genie view "$session" > "logs-${session}.txt"
done
```

---

### 4. Partial Migrations Cannot Be Undone

**Issue:** If migration was interrupted midway, some sessions may be in Forge, others in sessions.json.

**Workaround:** Run migration again with `--force` to complete, OR restore from backup manually.

---

## 📚 Troubleshooting Common Rollback Issues

### Issue: "Backup not found"

**Symptom:**
```
❌ Backup not found: .genie/state/agents/backups/sessions-*.json
```

**Cause:** No backup was created before migration.

**Solution:**
1. Check if archive exists: `.genie/state/agents/sessions-archive.json`
2. If yes, restore from archive:
   ```bash
   cp .genie/state/agents/sessions-archive.json .genie/state/agents/sessions.json
   ```
3. If no, reconstruct sessions.json manually from logs:
   ```bash
   # List log files
   ls -lh .genie/state/agents/logs/
   # Extract session IDs and recreate sessions.json
   ```

---

### Issue: "Sessions.json is corrupted"

**Symptom:**
```
❌ SyntaxError: Unexpected token in JSON at position 123
```

**Cause:** sessions.json has invalid JSON syntax.

**Solution:**
```bash
# Validate JSON
jq '.' .genie/state/agents/sessions.json

# If corrupted, restore from backup
cp .genie/state/agents/backups/sessions-*.json .genie/state/agents/sessions.json

# If no backup, create empty sessions.json
echo '{"version":2,"sessions":{}}' > .genie/state/agents/sessions.json
```

---

### Issue: "Git revert conflicts"

**Symptom:**
```
❌ error: Your local changes to the following files would be overwritten by checkout
```

**Cause:** Uncommitted changes in working directory.

**Solution:**
```bash
# Option 1: Stash changes
git stash
git checkout <commit>
git stash pop

# Option 2: Commit changes first
git add .
git commit -m "wip: before rollback"
git checkout <commit>
```

---

## 📞 Support & Escalation

If rollback fails or you encounter data loss:

1. **DO NOT proceed further** - stop immediately
2. **Create backup of current state:**
   ```bash
   tar -czf genie-state-backup-$(date +%Y%m%d-%H%M%S).tar.gz .genie/
   ```
3. **Document the issue:**
   - What command was run?
   - What error occurred?
   - What is current git commit?
   - What is current sessions.json state?
4. **Open GitHub issue:**
   ```bash
   gh issue create \
     --title "Rollback Failed - Data Loss Risk" \
     --body "[Paste documentation here]" \
     --label "bug,critical,rollback"
   ```
5. **Contact maintainers** (if urgent)

---

## ✅ Rollback Success Criteria

Rollback is considered successful when:

- [ ] All pre-migration sessions are restored
- [ ] Genie CLI works without Forge-related errors
- [ ] Session creation time < 10s (no timeout issues)
- [ ] All handler commands work (run, resume, view, stop, list)
- [ ] No data loss (session count matches backup)
- [ ] Git is on stable commit (pre-Forge or rollback branch)
- [ ] Documentation updated with rollback details

---

## 🔄 Re-Migration After Rollback

If you want to try Forge integration again after rollback:

1. **Fix the root cause** of the original rollback
2. **Test in development environment** first
3. **Create fresh backup:**
   ```bash
   cp .genie/state/agents/sessions.json \
      .genie/state/agents/backups/sessions-pre-retry-$(date +%Y%m%d).json
   ```
4. **Run migration again:**
   ```bash
   npx automagik-genie migrate --dry-run  # Preview first
   npx automagik-genie migrate --execute  # Then execute
   ```
5. **Monitor for issues** during first 24 hours

---

**End of Rollback Plan**

**Last Reviewed:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
