# Upgrade Genie Framework

## Purpose
Orchestrate Genie framework upgrades with intelligent conflict resolution and user customization preservation.

## When to Use
- User runs `genie update`
- Automatic check detects new version (max once per day)
- Post-install upgrade prompt

## Core Principles

### 1. Preserve User Intent
**Rule:** Never overwrite user customizations without explicit consent

**User Files (Never Touched):**
- `.genie/USERCONTEXT.md`
- `.genie/.session`
- `.genie/reports/**/*.md`
- `.genie/spells/custom-*.md`
- `.genie/code/agents/custom-*.md`

**Framework Files (Upgraded):**
- `AGENTS.md` (root - master genie)
- `CORE_AGENTS.md` (root - core agents)
- `CLAUDE.md` (root - meta-loader)
- `.genie/spells/*.md` (official)
- `.genie/code/AGENTS.md`
- `.genie/workflows/*.md`

### 2. Smart Merge, Not Overwrite
**Rule:** Use git diff to intelligently merge changes

**Strategy:**
```bash
# Generate diff between old and new framework
git diff ${OLD_COMMIT} ${NEW_COMMIT} -- .genie/**/*.md

# Apply only framework files
git apply --check upgrade.patch

# If clean: Apply automatically
# If conflicts: Delegate to Update Agent
```

### 3. User Guidance Required
**Rule:** Conflicts require user input, never auto-resolved

**Conflict Types:**
- **Additive:** User and upstream both added content → Merge both (ask for ordering)
- **Deletive:** Upstream removed section user kept → Ask user to confirm deletion
- **Conflicting:** Both modified same lines → Present options, user decides

### 4. Atomic Operations
**Rule:** Upgrade succeeds completely or rolls back (no partial states)

**Implementation:**
```bash
# Backup before upgrade
cp -r .genie .genie.backup-${timestamp}

# Apply upgrade
git apply upgrade.patch || {
  # On failure: Rollback
  rm -rf .genie
  mv .genie.backup-${timestamp} .genie
  echo "Upgrade failed, rolled back"
}
```

## Upgrade Workflow

### Step 1: Version Check
```javascript
const installed = readFrameworkVersion('.genie/.framework-version')
const available = getGlobalPackageVersion('automagik-genie')

if (semver.gt(available, installed)) {
  console.log(`🔔 New version available: ${available}`)
  const answer = await prompt('Upgrade now? (Y/n)')

  if (answer === 'y') {
    await initiateUpgrade(installed, available)
  }
}
```

### Step 2: Fetch Framework Diff
```bash
# Clone template repo (or use cached)
git clone https://github.com/namastexlabs/automagik-genie /tmp/genie-template

# Generate diff
cd /tmp/genie-template
git diff ${OLD_COMMIT} ${NEW_COMMIT} -- .genie/ > /tmp/upgrade.patch

# Filter to framework files only
git diff ${OLD_COMMIT} ${NEW_COMMIT} -- \
  'AGENTS.md' \
  'CORE_AGENTS.md' \
  'CLAUDE.md' \
  '.genie/spells/*.md' \
  '.genie/code/**/*.md' \
  '.genie/workflows/*.md' \
  > /tmp/framework-upgrade.patch
```

### Step 3: Test Apply (Detect Conflicts)
```bash
cd ${USER_WORKSPACE}

git apply --check /tmp/framework-upgrade.patch

if [ $? -eq 0 ]; then
  echo "✅ Clean merge possible!"
  UPGRADE_TYPE="clean"
else
  echo "⚠️ Conflicts detected"
  UPGRADE_TYPE="conflicts"
fi
```

### Step 4: Clean Merge Path
```bash
if [ "$UPGRADE_TYPE" = "clean" ]; then
  # Backup first
  cp -r .genie .genie.backup-$(date +%s)

  # Apply upgrade
  git apply /tmp/framework-upgrade.patch

  # Update version tracking
  echo "{\"installed_version\": \"${NEW_VERSION}\", ...}" > .genie/.framework-version

  # Commit
  git add .genie/
  git commit -m "Upgrade Genie framework ${OLD_VERSION} → ${NEW_VERSION}"

  echo "✅ Upgrade complete!"
fi
```

### Step 5: Conflict Resolution Path
```bash
if [ "$UPGRADE_TYPE" = "conflicts" ]; then
  # Parse conflicts
  CONFLICTS=$(git apply /tmp/framework-upgrade.patch 2>&1 | grep "error:")

  echo "⚠️ Conflicts in ${CONFLICT_COUNT} files:"
  echo "${CONFLICTS}"

  # Create Forge task for Update Agent
  TASK_ID=$(forge create-task \
    --title "Resolve upgrade conflicts (${OLD_VERSION} → ${NEW_VERSION})" \
    --description "Conflicts: ${CONFLICTS}")

  # Start Update Agent in isolated worktree
  forge start-attempt ${TASK_ID}

  echo "🤖 Update Agent spawned: ${TASK_ID}"
  echo "📍 Monitor: https://forge.namastex.ai/tasks/${TASK_ID}"
  echo ""
  echo "The agent will:"
  echo "  1. Analyze conflicts"
  echo "  2. Preserve your customizations"
  echo "  3. Ask for your input if needed"
  echo "  4. Propose resolution for your review"
}
```

### Step 6: Post-Upgrade Validation
```bash
# After upgrade applied (clean or resolved)

# Validate markdown syntax
find .genie -name "*.md" -exec markdownlint {} \;

# Check cross-references
node .genie/scripts/validate-cross-references.js

# Test skill loading
genie --test-skills

# If validation fails: Rollback
if [ $? -ne 0 ]; then
  echo "❌ Validation failed, rolling back..."
  rm -rf .genie
  mv .genie.backup-${TIMESTAMP} .genie
  echo "Rolled back to ${OLD_VERSION}"
fi
```

## Update Agent Delegation

**When to Delegate:**
- Conflicts detected during `git apply`
- User-modified framework file conflicts with upstream
- Structural changes require intelligent merging

**Agent Workflow:**
@.genie/code/agents/update.md

**Delegation Pattern:**
```javascript
async function resolveConflicts(conflicts, upgradeContext) {
  // Create Forge task
  const task = await forge.createTask({
    project_id: GENIE_PROJECT_ID,
    title: `Resolve upgrade conflicts (${conflicts.length} files)`,
    description: JSON.stringify({
      type: 'framework-upgrade',
      old_version: upgradeContext.oldVersion,
      new_version: upgradeContext.newVersion,
      conflicts: conflicts
    })
  })

  // Start Update Agent in isolated worktree
  const attempt = await forge.startTaskAttempt(task.id)

  // Return monitor info
  return {
    taskId: task.id,
    monitorUrl: `https://forge.namastex.ai/tasks/${task.id}`,
    worktreePath: attempt.worktree_path
  }
}
```

## User Interaction Examples

### Example 1: Clean Upgrade (No Conflicts)
```bash
$ genie update

📦 Checking for updates...
🔔 New version available: v2.5.0-rc.16 (current: v2.5.0-rc.15)

Changes:
  + 3 new spells (qa-validation, parallel-execution, sequential-questioning)
  ~ 12 updated files (AGENTS.md, learn.md, delegate-dont-do.md)
  - 0 deletions

Upgrade now? (Y/n): y

📝 Fetching framework diff...
🧪 Testing merge...
   ✅ No conflicts detected!

📦 Applying upgrade...
   ✅ .genie/AGENTS.md (12 lines added)
   ✅ .genie/spells/learn.md (token efficiency section enhanced)
   ✅ .genie/spells/qa-validation.md (new)
   ... (14 more)

✅ Upgrade complete!
   Installed: v2.5.0-rc.16
   Files updated: 17
   User files preserved: 4

🎉 Your Genie is up to date!
```

### Example 2: Conflicts Detected
```bash
$ genie update

📦 Checking for updates...
🔔 New version available: v2.5.0-rc.16

⚠️ Conflicts detected in 2 files:
   - .genie/code/AGENTS.md (you added custom section, upstream restructured)
   - .genie/spells/learn.md (both modified token efficiency)

🤖 Launching Update Agent to resolve conflicts...

Creating Forge task: Resolve upgrade conflicts
   Task ID: task_abc123
   Worktree: /var/tmp/automagik-forge/worktrees/task_abc123

🔗 Monitor progress: https://forge.namastex.ai/tasks/abc123

The Update Agent will:
  1. Analyze your customizations
  2. Integrate upstream changes
  3. Ask for your input on ambiguous conflicts
  4. Propose resolution for your review

Continue? (Y/n): y

[Update Agent working in background...]

🔔 Update Agent needs your input!

File: .genie/code/AGENTS.md
Conflict: You added "Custom Workflows" section (lines 45-60).
          Upstream restructured the file.

Options:
  1. Keep your section (merge after upstream's new structure)
  2. Move content into upstream's new "Workflows" section
  3. Show me both versions (manual edit)

Your choice (1/2/3): 1

✅ Got it! Proceeding with option 1.

[Resolving remaining conflicts...]

✅ All conflicts resolved!

Resolution summary:
  ✅ .genie/code/AGENTS.md - Custom section preserved at line 78
  ✅ .genie/spells/learn.md - User examples + upstream formulas merged

Apply this resolution? (Y/n): y

✅ Upgrade complete! Customizations preserved.
🎉 Genie is now on v2.5.0-rc.16!
```

## Version Tracking Schema

**File:** `.genie/.framework-version`

```json
{
  "installed_version": "2.5.0-rc.16",
  "installed_commit": "bd1cc98a",
  "installed_date": "2025-10-23T08:30:00Z",
  "package_name": "automagik-genie",
  "customized_files": [
    ".genie/spells/custom-deployment.md",
    ".genie/code/agents/my-custom-agent.md"
  ],
  "deleted_files": [
    ".genie/spells/deprecated-spell.md"
  ],
  "last_upgrade_date": "2025-10-23T08:30:00Z",
  "previous_version": "2.5.0-rc.15"
}
```

## Rollback Strategy

**Automatic Rollback (Upgrade Fails):**
```bash
# Backup created before upgrade
.genie.backup-1729672200/

# On failure:
rm -rf .genie
mv .genie.backup-1729672200 .genie
echo "Rolled back to v2.5.0-rc.15"
```

**Manual Rollback:**
```bash
genie update --rollback

Available backups:
  1. v2.5.0-rc.15 (2025-10-23 07:40 UTC)
  2. v2.5.0-rc.14 (2025-10-22 14:20 UTC)

Rollback to (1/2): 1

Rolling back to v2.5.0-rc.15...
✅ Rollback complete!
```

## Edge Cases

### Offline Mode
```bash
$ genie update

📦 Checking for updates... (offline mode)

Using cached template repo:
  Location: ~/.genie/templates/automagik-genie
  Last updated: 2025-10-22 (1 day old)

⚠️ Cache may be stale. Upgrade anyway? (Y/n): y

[Proceeds with cached version...]
```

### Interrupted Upgrade
```bash
$ genie

⚠️ Incomplete upgrade detected!
   Started: 2025-10-23 08:30 UTC
   Status: conflicts-resolving

Options:
  1. Resume upgrade (continue where you left off)
  2. Rollback (restore to v2.5.0-rc.15)
  3. Abandon (delete incomplete state)

Your choice (1/2/3): _
```

## Success Metrics

- 🎯 Zero data loss (user files never overwritten)
- 🎯 <60s for clean merges
- 🎯 Interactive conflict resolution (user always in control)
- 🎯 Atomic operations (never partial state)
- 🎯 Rollback capability (undo anytime)

## Future Enhancements

- **Preview Mode:** `genie update --preview` (show diff before applying)
- **Selective Upgrade:** `genie update --only-spells` (granular control)
- **Auto-Upgrade:** Configure auto-upgrade on `npm install -g`
- **Analytics:** Track common conflicts, improve merge strategies
