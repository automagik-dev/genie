# Update Agent Analysis: Gaps & Improvements

**Date:** 2025-10-13 24:00 UTC
**Context:** Analyzed actual Forge update (v2.1.1 → v2.1.4) against update.md spec
**Result:** Update succeeded, but documentation needs improvement

---

## Executive Summary

### ✅ Update Was Actually Successful!

The Forge update worked correctly:
- **Zero content loss** (100% preservation)
- **Correct architecture migration** (core agents → npm)
- **All customizations preserved** (specialists, utilities, product, standards, wishes)

### ❌ But Update.md Has Gaps

The `update.md` agent definition doesn't clearly explain the architectural change, leading to confusion about "missing" files.

---

## What Actually Happened (Correctly)

### 1. Architectural Migration ✅

**OLD (v2.1.1):** Full agent definitions in `.genie/agents/`
```
.genie/agents/
├── plan.md (257 lines)
├── wish.md (198 lines)
├── forge.md (643 lines)
├── review.md (160 lines)
├── specialists/ (11 files)
└── utilities/ (18 files)
```

**NEW (v2.1.4):** Core agents from npm + project overrides
```
npm package: @automagik/genie
├── agents/plan.md (base behavior)
├── agents/wish.md (base behavior)
├── agents/forge.md (base behavior)
└── agents/review.md (base behavior)

Project repo: .genie/custom/
├── plan.md (21 lines - Forge overrides)
├── wish.md (34 lines - Forge overrides)
├── forge.md (34 lines - Forge overrides)
├── review.md (34 lines - Forge overrides)
└── ... (19 more custom overrides)

Project repo: .genie/agents/
├── specialists/ (11 files - preserved identically)
└── utilities/ (18 files - preserved identically)
```

**Why this is correct:**
- **Code reuse:** Core logic maintained by framework team
- **Smaller repos:** Only project-specific overrides stored locally
- **Easier updates:** `npm install` updates core agents automatically
- **Clear separation:** Base behavior vs customization

### 2. What Was Preserved ✅

| Category | Files | Lines | Status |
|----------|-------|-------|--------|
| Specialists | 11 | 3,461 | ✅ Identical |
| Utilities | 18 | 2,850 | ✅ Identical |
| Product docs | 5 | 890 | ✅ Identical |
| Standards | 3 | 240 | ✅ Identical |
| Wishes | 12 | 10,000+ | ✅ Identical |
| Reports | 65+ | 20,000+ | ✅ Identical |
| State/logs | All | All | ✅ Identical |

**Total preservation:** 100%

### 3. What Was Changed ✅

| Action | Files | Purpose |
|--------|-------|---------|
| Deleted | 4 (plan, wish, forge, review) | Core agents now from npm |
| Created | 22 custom overrides | Project-specific extensions |
| Added | 3 template files | New v2.1.4 organization features |
| Updated | version.json | v2.1.1 → v2.1.4 |

---

## Issues Found in update.md

### 1. Missing Explanation of Architectural Change

**Current State:** update.md mentions "npm-backed architecture" but doesn't explain:
- What files get deleted (core agents)
- Why they get deleted (loaded from npm now)
- What replaces them (custom overrides)
- How it works (npm base + project overrides merged)

**User Confusion:**
```
User: "why did plan.md, wish.md, forge.md, review.md disappear?"
Update report: "Architecture changed to npm-backed"
User: "But where did the content go? Is it lost?"
```

**Fix Needed:**
Add clear before/after diagrams and explanation of the migration.

### 2. Vague "Old Structure" Detection

**Current Code (lines 95-99):**
```bash
if [ -f ".genie/agents/core/implementor.md" ]; then
  echo "Old structure: core agents in project"
else
  echo "New structure: core agents from npm"
fi
```

**Problem:** This checks for `.genie/agents/core/` but Forge actually had:
```
.genie/agents/
├── plan.md
├── wish.md
├── forge.md
├── review.md
```

Not `.genie/agents/core/implementor.md`!

**Fix Needed:**
Update detection logic to check for the actual old structure:
```bash
if [ -f ".genie/agents/plan.md" ] || [ -f ".genie/agents/wish.md" ]; then
  echo "OLD: Core agents in project → will migrate to npm + custom/"
fi
```

### 3. Insufficient Done Report Guidance

**Current State:** update.md provides template but doesn't require:
- Before/after agent count comparison
- Explanation of architectural change
- Custom override verification
- Clear "what's different" summary

**User Experience:**
```
User sees: "Update complete"
User thinks: "But files are missing! What happened?"
```

**Fix Needed:**
Require Done Report to include:
```markdown
## Architectural Migration

**OLD Structure:**
- Core agents: 4 files (plan, wish, forge, review) in .genie/agents/
- Total lines: 1,258

**NEW Structure:**
- Core agents: Loaded from npm package @automagik/genie
- Custom overrides: 22 files in .genie/custom/
- Total override lines: 600

**Why:** Framework uses npm distribution for core agents. Your project now only stores custom extensions.
```

### 4. No Custom Override Verification

**Current State:** update.md verifies agent resolution but doesn't test:
- Do custom overrides actually load?
- Do they augment base behavior correctly?
- Are project-specific commands/paths accessible?

**Fix Needed:**
Add verification step:
```bash
# Test custom override loading
echo "Testing custom override integration..."
genie run implementor --dry-run 2>&1 | grep -q "pnpm run build:genie" && \
  echo "✅ Custom implementor commands loaded" || \
  echo "❌ Custom overrides not loading"
```

### 5. Missing Rollback Instructions

**Current State:** update.md shows generic restore command but doesn't explain:
- When to rollback (agent resolution broken? custom overrides not loading?)
- How to test if rollback needed
- What to do if rollback fails

**Fix Needed:**
Add rollback decision tree:
```markdown
## Rollback Decision

Run these tests:
1. Agent resolution: `genie list agents` → Should show 25 agents
2. Custom overrides: `cat .genie/custom/implementor.md` → Should show Forge commands
3. Core agents: `genie run plan --help` → Should work

If ANY fail:
1. Stop: Don't use updated version
2. Rollback: `rm -rf .genie && cp -r .genie-backup-TIMESTAMP .genie`
3. Report issue: Include error messages and backup location
```

### 6. No Migration Dry-Run Mode

**Current State:** update.md dives straight into changes with no preview option.

**User Risk:**
- Can't see what will change before committing
- No way to review architectural impact
- Backup is only safety net

**Fix Needed:**
Add `--dry-run` mode:
```bash
# Show what would change
genie update --dry-run

Output:
📊 Migration Preview
- Delete: 4 core agent files (plan, wish, forge, review)
- Create: 22 custom override files
- Preserve: 11 specialists, 18 utilities
- Add: 3 new template files

Continue? (y/N)
```

### 7. Unclear Custom Override Template

**Current State:** update.md shows example custom override (lines 159-174) but doesn't explain:
- What goes in custom overrides? (project commands, paths, conventions)
- What stays in npm core? (agent logic, task breakdown, orchestration)
- How to decide what to customize?

**Fix Needed:**
Add guidance section:
```markdown
## Custom Override Best Practices

### What to Include
✅ Project-specific commands (`pnpm run build:genie`)
✅ File paths (`source layout: CLI in @.genie/cli/src/`)
✅ Project conventions (evidence paths, done report locations)
✅ Tool-specific flags (language versions, frameworks)

### What to Avoid
❌ Agent orchestration logic (let npm core handle)
❌ Task breakdown patterns (framework responsibility)
❌ Generic guidance (not project-specific)

### Example (Good)
```markdown
# Implementor • Forge Defaults
## Commands
- `pnpm run build:genie` - compile TypeScript
- `cargo build --release` - build Rust backend
```
```

### 8. No Version Compatibility Check

**Current State:** update.md assumes npm package matches local expectations.

**Risk:** User updates npm package to v2.2, but update agent still expects v2.1 structure.

**Fix Needed:**
Add version compatibility check:
```bash
# Check npm package version
NPM_VERSION=$(npm view @automagik/genie version)
EXPECTED_VERSION="2.1.4"

if [ "$NPM_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "⚠️ Warning: npm package is v$NPM_VERSION but update expects v$EXPECTED_VERSION"
  echo "Continue anyway? (y/N)"
fi
```

---

## Recommended Fixes

### Priority 1: Critical (Prevents Confusion)

1. **Add Architectural Change Explanation**
   - Before/after directory structure diagrams
   - Clear explanation of npm + custom pattern
   - Why files "disappear" (they move to npm)

2. **Fix Structure Detection Logic**
   - Check for actual old files (plan.md, wish.md, etc.)
   - Don't assume `.genie/agents/core/` exists

3. **Enhance Done Report Template**
   - Require architectural migration section
   - Show before/after agent counts
   - Explain what's different

### Priority 2: Important (Improves Safety)

4. **Add Custom Override Verification**
   - Test that overrides actually load
   - Verify project-specific commands accessible

5. **Add Rollback Decision Tree**
   - Clear tests to run
   - When to rollback
   - How to report issues

### Priority 3: Nice to Have (Better UX)

6. **Add Dry-Run Mode**
   - Preview changes before executing
   - Show impact summary

7. **Add Custom Override Guidance**
   - What to include/avoid
   - Best practices
   - Examples

8. **Add Version Compatibility Check**
   - Verify npm package matches expectations
   - Warn if mismatch

---

## Proposed update.md Changes

### Add After Line 55 (Discovery Phase)

```markdown
### Step 1.5: Explain Architectural Change (if old structure)

**If core agents found in project:**

Show user clear before/after:

```
📊 ARCHITECTURE MIGRATION REQUIRED

Your project uses OLD structure:
  .genie/agents/
  ├── plan.md (257 lines)
  ├── wish.md (198 lines)
  ├── forge.md (643 lines)
  └── review.md (160 lines)

New v2.1.4 structure:
  npm package: @automagik/genie
  ├── agents/plan.md (core logic)
  └── ... (other core agents)

  Your project: .genie/custom/
  ├── plan.md (21 lines - project overrides)
  └── ... (other overrides)

WHAT THIS MEANS:
- Core agent logic moves to npm package (maintained by framework)
- Your project keeps only custom extensions
- No content loss - full backup created
- Easier updates - `npm install` gets new core agents

WHAT WILL CHANGE:
- Delete: 4 core agent files from .genie/agents/
- Create: 22 custom override files in .genie/custom/
- Preserve: All specialists, utilities, wishes, reports

Continue? (y/N)
```
```

### Replace Lines 95-130 (Detection Logic)

```markdown
### Step 2: Detect Installation Type

**Improved Detection:**

```bash
# Check for old structure (core agents in project)
OLD_AGENTS=0
[ -f ".genie/agents/plan.md" ] && OLD_AGENTS=$((OLD_AGENTS + 1))
[ -f ".genie/agents/wish.md" ] && OLD_AGENTS=$((OLD_AGENTS + 1))
[ -f ".genie/agents/forge.md" ] && OLD_AGENTS=$((OLD_AGENTS + 1))
[ -f ".genie/agents/review.md" ] && OLD_AGENTS=$((OLD_AGENTS + 1))

if [ $OLD_AGENTS -gt 0 ]; then
  echo "DETECTED: old_genie (v2.0.x - v2.1.3)"
  echo "ACTION: Migration required ($OLD_AGENTS core agents → npm + custom/)"
elif [ -d ".genie/agents/" ] && [ -d ".genie/custom/" ]; then
  echo "DETECTED: already_new (v2.1.4+)"
  echo "ACTION: Template update only"
else
  echo "DETECTED: clean (no Genie installation)"
  echo "ACTION: Use install agent instead"
fi
```
```

### Add After Line 405 (Verification)

```markdown
### Post-Update Validation (NEW)

```bash
# 1. Verify architectural migration succeeded
echo "Testing npm core + custom override integration..."

# Check core agents from npm
NPM_AGENTS=$(npm ls -g @automagik/genie --depth=0 2>/dev/null | grep -c "@automagik/genie")
if [ $NPM_AGENTS -gt 0 ]; then
  echo "✅ Core agents available from npm"
else
  echo "❌ npm package not found - reinstall: npm install -g @automagik/genie@latest"
  exit 1
fi

# Check custom overrides load
genie run implementor --help 2>&1 | grep -q "implementor" && \
  echo "✅ Custom overrides loading" || \
  echo "❌ Custom overrides not loading"

# Verify project-specific commands accessible
if [ -f ".genie/custom/implementor.md" ]; then
  grep -q "pnpm run" ".genie/custom/implementor.md" && \
    echo "✅ Project-specific commands present" || \
    echo "⚠️ Custom override exists but may be empty"
fi

# Test agent resolution
AGENT_COUNT=$(genie list agents 2>/dev/null | grep -c "agents available")
if [ $AGENT_COUNT -gt 20 ]; then
  echo "✅ Agent resolution working (${AGENT_COUNT} agents)"
else
  echo "❌ Agent resolution broken - consider rollback"
fi
```
```

### Update Done Report Template (Lines 412-464)

```markdown
**Add new section after "## Discovery":**

```markdown
## Architectural Migration (if applicable)

### OLD Structure (v2.1.1)
- **Core agents in project:** 4 files (plan, wish, forge, review)
- **Total lines:** 1,258
- **Location:** `.genie/agents/`

### NEW Structure (v2.1.4)
- **Core agents:** Loaded from npm package `@automagik/genie`
- **Custom overrides:** 22 files in `.genie/custom/`
- **Total override lines:** 600

### What Changed
**Deleted (moved to npm):**
- `.genie/agents/plan.md` (257 lines) → `npm:@automagik/genie/agents/plan.md`
- `.genie/agents/wish.md` (198 lines) → `npm:@automagik/genie/agents/wish.md`
- `.genie/agents/forge.md` (643 lines) → `npm:@automagik/genie/agents/forge.md`
- `.genie/agents/review.md` (160 lines) → `npm:@automagik/genie/agents/review.md`

**Created (project-specific):**
- `.genie/custom/plan.md` (21 lines) - Forge planning overrides
- `.genie/custom/wish.md` (34 lines) - Forge wish overrides
- `.genie/custom/forge.md` (34 lines) - Forge forge overrides
- `.genie/custom/review.md` (34 lines) - Forge review overrides
- ... (18 more custom overrides)

**Preserved (no changes):**
- `.genie/agents/specialists/` (11 files, 3,461 lines)
- `.genie/agents/utilities/` (18 files, 2,850 lines)

### Why This Change
- **Code reuse:** Core agent logic maintained by Genie framework team
- **Smaller repos:** Projects only store custom extensions (600 lines vs 1,258)
- **Easier updates:** `npm install` updates core agents automatically
- **Clear separation:** Base behavior (npm) vs customization (project)
```
```

---

## Testing the Fixes

### 1. Test Structure Detection
```bash
# Create mock old structure
mkdir -p /tmp/test-genie/.genie/agents
touch /tmp/test-genie/.genie/agents/{plan,wish,forge,review}.md

# Run detection
cd /tmp/test-genie
# Should detect: "old_genie (v2.0.x - v2.1.3)"
```

### 2. Test Custom Override Loading
```bash
# After update, verify
genie run implementor --help 2>&1 | grep "implementor"
# Should show agent is available

cat .genie/custom/implementor.md | grep "pnpm"
# Should show project-specific commands
```

### 3. Test Agent Resolution
```bash
genie list agents
# Should show 25 agents (npm core + custom)
```

---

## Summary

### What Worked ✅
- Backup creation
- Content preservation (100%)
- Architectural migration (core → npm)
- Custom override generation
- Version update

### What Needs Improvement ❌
1. **Documentation:** Explain architectural change clearly
2. **Detection:** Fix old structure detection logic
3. **Verification:** Test custom overrides actually load
4. **Guidance:** Add rollback decision tree
5. **Safety:** Add dry-run mode
6. **Templates:** Improve custom override guidance

### Next Steps
1. Update `.genie/agents/core/update.md` with proposed changes
2. Test updated agent on fresh Forge-like repo
3. Verify all edge cases handled
4. Document new update flow in AGENTS.md

---

**Analysis Complete:** 2025-10-13 24:00 UTC
**Analyst:** Claude Code
**Files Analyzed:** update.md (636 lines), Forge update reports (665 lines)
