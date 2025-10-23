# Learning: Every Commit Must Link to Wish or GitHub Issue

**Date:** 2025-10-23
**Teacher:** Felipe Rosa
**Type:** violation
**Severity:** critical

---

## Teaching Input

User: "amend the commit to pass the push test and push it... and open learn spell.. you will learn how not to do this ever again... all the produced commits, must follow the rules."

**Context:** I created a commit implementing `genie update` command but failed the pre-push validation because the commit message lacked a wish or GitHub issue reference.

---

## Violation

**What I did wrong:**
1. Created large feature commit without checking for existing GitHub issues
2. Added commit message footer `Resolves: #38` (wrong format)
3. Failed pre-push validation: "Not linked to wish or GitHub issue"
4. Had to amend commit multiple times to fix

**Root cause:** Did not check commit message requirements before committing

---

## Analysis

**What:** Commit messages must reference work items (wish or issue) for traceability
**Why:** Track WHY code was written, connect commits to requirements
**Where:** All commits on main branch
**How:** Use `fixes #NNN` or `wish: wish-slug` format

### Pre-Push Commit Advisory Requirements

**Every commit must:**
1. Link to a wish (`wish: wish-slug`) OR
2. Link to a GitHub issue (`fixes #NNN`, `closes #NNN`, `resolves #NNN`)

**Correct formats:**
```
fixes #38
closes #123
resolves #456
wish: wish-120-a-forge-drop-in-replacement
```

**Wrong formats:**
```
Resolves: #38         ❌ (colon not recognized)
Related to #38        ❌ (doesn't close issue)
Issue #38             ❌ (not a linking keyword)
```

### Affected Files

- All commits must follow this rule
- Enforced by `.git/hooks/pre-push` → `scripts/commit-advisory.cjs`
- Validation regex looks for: `fixes #\d+`, `closes #\d+`, `resolves #\d+`, or `wish: wish-[\w-]+`

---

## Correct Workflow

### Before Creating ANY Commit:

**1. Check for existing work items:**
```bash
# Check for related GitHub issues
gh issue list --search "keyword"

# Check for related wishes
ls .genie/wishes/ | grep -i keyword
```

**2. Create GitHub issue if needed:**
```bash
# If no issue exists and work doesn't warrant a wish
gh issue create --title "Feature: Add auto-upgrade system" \
                --body "Description..." \
                --label "enhancement"
```

**3. Commit with proper reference:**
```bash
# Link to issue
git commit -m "feat: Add genie update command

[commit body...]

fixes #38"

# OR link to wish
git commit -m "feat: Add genie update command

[commit body...]

wish: wish-120-a-forge-drop-in-replacement"
```

**4. Verify before push:**
```bash
# Dry run to check validation
git push --dry-run

# If blocked, amend commit
git commit --amend

# Push with main override if needed
GENIE_ALLOW_MAIN_PUSH=1 git push
```

---

## Changes Made to My Consciousness

### Added to learn.md

**New section: Commit Message Requirements (lines after meta-learning notes)**

```markdown
## Commit Message Requirements 🔴 CRITICAL

**Every commit must link to a work item for traceability.**

### Required Format

All commits must reference:
- GitHub issue: `fixes #NNN`, `closes #NNN`, or `resolves #NNN`
- OR Wish: `wish: wish-slug`

### Before Committing

1. **Check for existing issues:**
   ```bash
   gh issue list --search "keyword"
   ```

2. **Check for existing wishes:**
   ```bash
   ls .genie/wishes/ | grep -i keyword
   ```

3. **Create issue if needed:**
   ```bash
   gh issue create --title "..." --body "..." --label "enhancement"
   ```

4. **Commit with reference:**
   ```bash
   git commit -m "feat: Description

   [body...]

   fixes #38"
   ```

### Correct Formats

✅ `fixes #38`
✅ `closes #123`
✅ `resolves #456`
✅ `wish: wish-120-a-forge-drop-in-replacement`

### Wrong Formats

❌ `Resolves: #38` (colon not recognized)
❌ `Related to #38` (doesn't close issue)
❌ `Issue #38` (not a linking keyword)

### Enforcement

- Pre-push hook: `.git/hooks/pre-push`
- Validator: `scripts/commit-advisory.cjs`
- Override (use sparingly): `GENIE_ALLOW_MAIN_PUSH=1 git push`

**Why:** Track WHY code was written. Connect commits to requirements. Enable traceability from code → issue → discussion → decision.
```

---

## Validation

### How to Verify This Learning

**Test 1: Check commit advisory detection**
```bash
# Create test commit without issue reference
git commit --allow-empty -m "test: No issue reference"

# Try to push (should fail)
git push --dry-run

# Expected: ❌ Blocking Issues - Not linked to wish or GitHub issue
```

**Test 2: Check correct format acceptance**
```bash
# Amend with correct format
git commit --amend -m "test: With issue reference

fixes #38"

# Try to push (should pass advisory)
git push --dry-run

# Expected: ✅ GitHub Issues: #38
```

**Test 3: Verify learning persisted**
```bash
# Check learn.md has new section
grep -A 5 "Commit Message Requirements" .genie/spells/learn.md

# Expected: Section exists with commit format rules
```

### Follow-up Actions

- [x] Document violation in this report
- [x] Update learn.md with commit requirements section
- [x] Create learning evidence
- [ ] Never repeat this violation (validated over next 10 commits)

---

## Evidence

**This session:**
- Commit `ab7c2052` - First attempt (wrong format: `Resolves: #38`)
- Commit `7a1b7919` - Second attempt (still wrong format)
- Commit `de7fe2fd` - Final success (correct format: `fixes #38`)
- Push log: Pre-push blocked twice, succeeded with `GENIE_ALLOW_MAIN_PUSH=1`

**Pre-push output:**
```
## ❌ Blocking Issues (1)

1. **Not linked to wish or GitHub issue**
   Commit: `7a1b7919` - feat: Add genie update command with git diff-based smart mer
   WHY: Every commit must trace to a work item (wish or issue) so we can track WHY code was written
   HOW TO FIX (choose one):

   **Link to existing wish:**
   git commit --amend -m "feat: ...

wish: wish-slug"

   **Link to GitHub issue:**
   git commit --amend -m "feat: ...

fixes #NNN"
```

**Lesson absorbed:** Check requirements BEFORE committing. Use correct format (`fixes #NNN`, not `Resolves: #NNN`).

---

**Learning absorbed and propagated successfully.** 🧞📚✅
