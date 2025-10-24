# CLI Troubleshooting Guide

Technical debugging patterns for Genie CLI developers. This is a reference document for troubleshooting infrastructure issues, not loaded during agent sessions.

## Update System Architecture

### Three Independent Update Paths

The Genie update system has **three independent paths** that must ALL work correctly:

1. **Git-diff Update** - When workspace is git repo with remote
2. **NPM Update** - When installed globally via npm/pnpm
3. **Smart Router** - Migrates between installation types

**Critical:** Each path must be independently functional. One broken path = infinite loop.

### Update Process Three-Bug Pattern

**Pattern:** Three independent bugs in three independent paths create failure cascade.

**The Cascade:**
```
False positive detection → Early return without update → Version check loops
```

#### Bug Type 1: False Positive Detection

**Location:** `detectInstallType()` in migrate.js

**Problem:** Incorrectly identifies new installations as "old structure"

**Example:**
```javascript
// Checks for .genie/agents/workflows/*.md
// But NEW structure (v2.1.0+) ALSO has these (from templates)
// Result: Modern installations flagged as "old_genie"
```

**Fix Strategy:**
```javascript
// Check version files FIRST (if exists, not "old_genie")
if (fs.existsSync('.genie/state/version.json')) {
  const version = JSON.parse(fs.readFileSync('.genie/state/version.json'));
  if (version.version >= '2.1.0') {
    return 'modern'; // Not old_genie
  }
}
// Then check directory structure
```

#### Bug Type 2: Early Return Without Version Update

**Location:** `runInit()` in init.js

**Problem:** Returns early when 'old_genie' detected, skipping version file write

**Example:**
```javascript
// Line 134: return early
if (installType === 'old_genie') {
  console.log('Old installation detected...');
  return; // ❌ Version file not updated
}

// Line 214: writeVersionState() never reached
writeVersionState(currentVersion);
```

**Result:** `.genie/state/version.json` stays at old version, causing infinite loop

**Fix Strategy:**
```javascript
// Option 1: Update version BEFORE returning
if (installType === 'old_genie') {
  writeVersionState(currentVersion); // ✅ Update first
  console.log('Old installation detected...');
  return;
}

// Option 2: Auto-force reinit with --yes
if (installType === 'old_genie') {
  console.log('Old installation detected, running full reinit...');
  await runInit({ ...options, force: true, yes: true });
  return;
}
```

#### Bug Type 3: No Escape Hatch in Version Check

**Location:** genie-cli.js version check loop

**Problem:** Always redirects to init on version mismatch, doesn't check if init will succeed

**Example:**
```javascript
// Lines 178-261: Version check
const currentVersion = getCurrentVersion();
const workspaceVersion = getWorkspaceVersion();

if (currentVersion !== workspaceVersion) {
  // ❌ No check if init will complete successfully
  execSync('genie init', { stdio: 'inherit' });
}
```

**Result:** Infinite loop when init blocked by false positive

**Fix Strategy:**
```javascript
// Add max retry limit
let retryCount = 0;
const MAX_RETRIES = 3;

if (currentVersion !== workspaceVersion) {
  if (retryCount >= MAX_RETRIES) {
    console.error('Update failed after 3 attempts. Please run: genie init --force');
    process.exit(1);
  }
  retryCount++;
  execSync('genie init', { stdio: 'inherit' });
}
```

### Evidence Flow: Infinite Loop

```
1. User runs `genie`
   ↓
2. Version check (genie-cli.js:204)
   Sees: workspace=2.4.2-rc.80, package=2.5.0-rc.20
   ↓
3. Triggers: `genie init`
   ↓
4. detectInstallType() returns 'old_genie' (FALSE POSITIVE)
   Modern installation with .genie/agents/workflows/*.md
   ↓
5. Shows "Old Installation" message (lines 120-130)
   Returns early (line 134)
   ↓
6. Version files NOT updated
   ↓
7. User runs `genie` again
   ↓
8. SAME version mismatch → LOOP FOREVER
```

## Three-Bug Fix Checklist

When debugging update failures:

- [ ] **Check detection logic** - Does `detectInstallType()` have false positives?
- [ ] **Check version updates** - Does EVERY return path update version files?
- [ ] **Check escape hatch** - Does version check loop have retry limit?
- [ ] **Test all three paths** - Git-diff, NPM, Smart router independently
- [ ] **Verify false positive** - Can modern installation be flagged as old?

## Testing Strategy

### Test Path Independence

**Each path must work WITHOUT the others:**

```bash
# Test 1: Git-diff update (in git workspace)
cd <genie-workspace>
git checkout old-version
genie update
# Verify: Updates via git diff

# Test 2: NPM update (outside git or no remote)
cd /tmp/test-workspace
genie init
# Modify package to old version
genie update
# Verify: Updates via npm

# Test 3: Smart router (old → new structure)
cd <old-genie-workspace>
genie init
# Verify: Migrates structure, updates version
```

### Test Escape Conditions

**Verify loops have exits:**

```bash
# Simulate false positive
cd <modern-workspace>
# Manually set old version
echo '{"version":"2.4.2"}' > .genie/state/version.json

# Run update
genie
# Verify: Doesn't loop forever (max 3 retries)
```

## Common Update Failures

### Failure 1: "Stuck on old version"

**Symptom:** `genie --version` shows new, workspace shows old, `genie` keeps running init

**Debug:**
```bash
# Check workspace version
cat .genie/state/version.json

# Check package version
npm list -g automagik-genie

# Check detection
node .genie/cli/src/migrate.js
```

**Likely cause:** Bug Type 2 (early return without version update)

### Failure 2: "Infinite init loop"

**Symptom:** `genie` runs init, init returns, `genie` runs init again

**Debug:**
```bash
# Check if version file updated after init
ls -la .genie/state/version.json
cat .genie/state/version.json

# Check detection result
# Add console.log to detectInstallType()
```

**Likely cause:** Bug Type 1 (false positive) + Bug Type 2 (no version update)

### Failure 3: "NPM update fails silently"

**Symptom:** `genie update` runs but version doesn't change

**Debug:**
```bash
# Check if workspace is git repo
git remote -v

# Check if npm update path triggered
# Add logging to update.ts
```

**Likely cause:** Wrong path selected, update logic didn't execute

## Prevention

### Before Releasing Update

- [ ] Test all three paths independently
- [ ] Verify version files updated on EVERY code path
- [ ] Check for false positive conditions
- [ ] Add retry limits to loops
- [ ] Test migration from previous version

### Code Review Checklist

- [ ] Does `detectInstallType()` check version files first?
- [ ] Does EVERY return path in init update version?
- [ ] Does version check loop have max retries?
- [ ] Are all three paths tested in CI?

## Evidence

**Origin:**
- Learning #5: `learn.md` lines 130-138 (Update Process - Three Independent Bugs)
- Learning #10: `learn.md` lines 198-229 (Three-Bug Pattern - Update Loop)

**Real Failures:**
- Users stuck upgrading 2.4.2-rc.80 → 2.5.0-rc.18
- Infinite loop: init → detect old → return → version unchanged → loop

**Fixes Applied:**
- Commit b8913b23: Use workspace package version for update detection
- Commit 6e67f012: Smart router upgrade baseline fix

**Analysis:** `.genie/reports/learn/update-process-three-bugs-20251023.md`

## Related

- `.genie/cli/src/migrate.js` - Installation type detection
- `.genie/cli/src/commands/init.ts` - Initialization logic
- `.genie/cli/src/commands/update.ts` - Update logic
- `.genie/cli/src/genie-cli.ts` - Version check loop
