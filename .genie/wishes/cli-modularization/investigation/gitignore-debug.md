# .gitignore Investigation: dist/ and snapshots/ Tracking

**Investigation Date:** 2025-09-30
**Branch:** feat/cli-modularization
**Issue:** Built artifacts (`dist/`, `snapshots/`) are tracked in git when they shouldn't be

---

## Executive Summary

**Root Cause:** `.genie/cli/` lacks its own `.gitignore` file, and the root `.gitignore` **explicitly whitelists** `.genie/cli/dist/` with negation patterns, overriding the global `dist/` ignore.

**Impact:**
- 50+ commits with compiled JavaScript in `.genie/cli/dist/`
- Multiple commits with test snapshots in `.genie/cli/snapshots/`
- Repository bloat and merge conflicts on generated code

**Solution:** Create `.genie/cli/.gitignore`, remove tracked artifacts, update root `.gitignore` negation patterns.

---

## Findings

### 1. Missing Local .gitignore

```bash
$ ls -la .genie/cli/.gitignore
ls: cannot access '.genie/cli/.gitignore': No such file exists.
```

**Problem:** `.genie/cli/` has no local `.gitignore` to protect against build artifacts.

---

### 2. Root .gitignore Negation Pattern (Lines 21-23)

```gitignore
# Node.js
node_modules/
...
dist/
!.genie/cli/dist/          # ❌ PROBLEM: Explicitly whitelists this path
!.genie/cli/dist/**        # ❌ PROBLEM: Whitelists all contents
build/
```

**Analysis:**
- Line 21: `dist/` globally ignores all `dist/` directories
- Lines 22-23: `!.genie/cli/dist/` and `!.genie/cli/dist/**` **negate** the ignore, forcing git to track `.genie/cli/dist/`
- This creates an **exception** specifically for CLI build artifacts

**Why This Exists:**
Likely added during CLI development to commit compiled output for distribution/testing, but never removed after establishing proper build workflows.

---

### 3. No snapshots/ Pattern

```bash
$ grep -n "snapshots" .gitignore
[no output]
```

**Problem:** Root `.gitignore` has no rule for `snapshots/` at all, so test snapshots are tracked by default.

---

### 4. Git History Analysis

#### dist/ First Committed
```bash
Commit: af7e91fa (2025-09-28 02:13:49)
Message: "convert genie to ts"
Files: 2015 insertions across 6 files
  .genie/cli/dist/background-manager.js
  .genie/cli/dist/executors/codex-log-viewer.js
  .genie/cli/dist/executors/codex.js
  .genie/cli/dist/executors/types.js
  .genie/cli/dist/genie.js (1246 lines)
  .genie/cli/dist/session-store.js
```

**Timeline:**
- First committed: Sept 28, 2025 (2 days ago)
- Total commits: 50 commits touching `dist/`
- No `.gitignore` existed at time of first commit

#### snapshots/ First Committed
```bash
Commit: ae0f03ee (2025-09-30 16:21:06)
Message: "upd"
First snapshot commit: c9ef44f7 (2025-09-30 18:20:44)
Message: "CLI Polish Group C: Evidence & Status"
```

**Timeline:**
- First committed: Sept 30, 2025 (today)
- Total commits: 8 commits touching `snapshots/`
- Added during CLI polish work

---

### 5. Current State

```bash
$ git ls-files .genie/cli/dist/ | wc -l
50

$ git ls-files .genie/cli/snapshots/ | wc -l
61

$ du -sh .genie/cli/dist/
124K    .genie/cli/dist/

$ du -sh .genie/cli/snapshots/
316K    .genie/cli/snapshots/
```

**Tracked Files:**
- 50 compiled JS files in `dist/`
- 61 test snapshot files
- ~440KB total

---

### 6. tsconfig.json Confirms Build Location

```json
{
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist"  // ✓ Correct: compiles to dist/
  }
}
```

**Analysis:** TypeScript is correctly configured to output to `dist/`. The issue is purely .gitignore configuration.

---

## Root Cause Analysis

### Why This Happened

1. **Initial Commit Without .gitignore**
   - CLI converted to TypeScript on Sept 28
   - No `.genie/cli/.gitignore` created at that time
   - Built output committed immediately

2. **Root .gitignore Negation**
   - Lines 22-23 explicitly whitelist `.genie/cli/dist/`
   - This was likely intentional at some point (distribution? testing?)
   - Never cleaned up after workflow established

3. **No snapshots/ Rule**
   - Snapshots added during QA work (Sept 30)
   - No pattern in root `.gitignore` to catch them
   - No local `.gitignore` to stop them

4. **50 Commits Later**
   - Every rebuild = new commit
   - Merge conflicts on generated code
   - Repository bloat accumulating

---

## Action Plan

### Phase 1: Create Local .gitignore (Immediate)

**File:** `.genie/cli/.gitignore`

```gitignore
# Build output
dist/
*.js
*.js.map
*.d.ts

# Test artifacts
snapshots/
coverage/
.nyc_output/

# Dependencies
node_modules/

# IDE
.vscode/
.idea/

# Temp
*.log
.DS_Store
```

### Phase 2: Remove Root Negation Patterns (Immediate)

**File:** `.gitignore` (root)

**Current (lines 21-23):**
```gitignore
dist/
!.genie/cli/dist/          # ❌ REMOVE THIS
!.genie/cli/dist/**        # ❌ REMOVE THIS
```

**Fixed:**
```gitignore
dist/
```

### Phase 3: Add snapshots/ Pattern (Immediate)

**File:** `.gitignore` (root)

**Add after line 120 (Testing section):**
```gitignore
# Testing
coverage/
.nyc_output
*.coverage
.coverage.*
htmlcov/
snapshots/          # ← ADD THIS
```

### Phase 4: Untrack Artifacts (Required)

```bash
# Remove from git index (keeps local files)
git rm -r --cached .genie/cli/dist/
git rm -r --cached .genie/cli/snapshots/

# Verify removal
git status

# Commit cleanup
git add .gitignore .genie/cli/.gitignore
git commit -m "chore: Untrack build artifacts and test snapshots

- Remove .genie/cli/dist/ from version control
- Remove .genie/cli/snapshots/ from version control
- Create .genie/cli/.gitignore with build/test patterns
- Remove root .gitignore negation for .genie/cli/dist/
- Add snapshots/ pattern to root .gitignore

Artifacts were incorrectly tracked due to explicit negation
patterns in root .gitignore. Build output should never be
committed to version control.

50 dist/ commits and 8 snapshot commits removed from tracking."
```

### Phase 5: Rebuild Clean (Verification)

```bash
# Rebuild from source
cd .genie/cli
pnpm run build

# Verify ignored
git status  # Should show "nothing to commit"

# Verify functionality
./genie --help
```

---

## Validation Checklist

- [ ] `.genie/cli/.gitignore` created with comprehensive patterns
- [ ] Root `.gitignore` lines 22-23 removed (negation patterns)
- [ ] Root `.gitignore` has `snapshots/` pattern added
- [ ] `git rm --cached` executed for both directories
- [ ] Commit created with cleanup message
- [ ] `pnpm run build` succeeds
- [ ] `git status` clean after rebuild
- [ ] `./genie --help` works correctly
- [ ] No `dist/` or `snapshots/` in `git ls-files` output

---

## Preventive Measures

### 1. Documentation Update
Add to `.genie/cli/README.md`:
```markdown
## Build Output

Build artifacts in `dist/` are **not** tracked in version control.
Run `pnpm run build` to compile TypeScript sources.
```

### 2. CI/CD Check
Add pre-commit hook or CI check:
```bash
#!/bin/bash
if git ls-files | grep -q "\.genie/cli/dist/"; then
  echo "ERROR: Build artifacts detected in commit"
  exit 1
fi
```

### 3. Onboarding Note
Add to `CONTRIBUTING.md`:
```markdown
### CLI Development
- Never commit `dist/` or `snapshots/` directories
- Run `pnpm run build` locally to test
- CI will rebuild from source
```

---

## Questions for Review

1. **Distribution Strategy:** Does `.genie/cli/dist/` need to be published to npm?
   - If YES: Use `files` field in `package.json` (npm handles distribution separately)
   - If NO: Current cleanup is sufficient

2. **Snapshot Strategy:** Are snapshots for:
   - Regression testing (keep out of git, regenerate in CI)
   - Documentation (keep in git, but in `docs/` not `snapshots/`)

3. **Branch Strategy:** Should cleanup happen:
   - In this branch (feat/cli-modularization) before merge
   - In a dedicated cleanup branch
   - After merge to main

---

## Risk Assessment

**Low Risk:**
- Files exist locally after `git rm --cached`
- Can be rebuilt instantly with `pnpm run build`
- No functionality changes

**Medium Risk:**
- 50 commits in git history still contain artifacts (use `git filter-branch` or `bfg` to purge if repo size is concern)

**No Risk:**
- This is a private/internal repo (no public npm package affected)

---

## Recommendation

**Execute Phase 1-4 immediately** in this branch before merging feat/cli-modularization.

**Reasoning:**
1. Prevents merge conflicts on generated code
2. Reduces branch diff size (111 files → ~30 source files)
3. Establishes correct patterns before CLI becomes stable
4. Quick fix (5 minutes) with no breaking changes

**Next Steps:**
1. Human approves action plan
2. Execute Phase 1-4 commands
3. Verify with checklist
4. Continue with modularization work on clean baseline
