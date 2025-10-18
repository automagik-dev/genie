# Commit Advisory Guide
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**When:** Automatically runs on `git push` before code reaches remote
**Purpose:** Ensures every commit is traced to work items (wishes/GitHub issues)

---

## What Gets Validated

### ✅ Automatic Checks

1. **Branch Safety**
   - Warns if pushing to main/master directly
   - Suggests feature branches for traced work

2. **Commit Traceability** (BLOCKING)
   - Every commit must reference a wish or GitHub issue
   - Patterns recognized: `wish:`, `fixes #NNN`, `closes #NNN`, `.genie/wishes/slug`

3. **Bug Fix Validation** (BLOCKING)
   - Bug fix commits (commit message starts with `fix:` or `bug:`) MUST have GitHub issue
   - Pattern: `fixes #123` or `closes #456` in commit message

4. **Alignment Checking** (WARNING)
   - Compares files changed vs files listed in wish document
   - Warns if alignment < 30%

5. **Multi-Wish Detection** (WARNING)
   - Flags if commits reference multiple wishes
   - Suggests keeping work focused to single wish per push

---

## How to Fix Issues

### Case 1: Commits Not Linked to Anything

**Error:**
```
Commit "my awesome feature" not linked to wish or issue
Fix: Add wish reference or GitHub issue link to commit message
```

**Solution:** Amend commit message to reference wish or issue:

```bash
# Add wish reference
git commit --amend -m "feat: my awesome feature

wish: feature-name-slug"

# OR add GitHub issue reference
git commit --amend -m "feat: my awesome feature

fixes #123"
```

### Case 2: Bug Fix Without GitHub Issue

**Error:**
```
Bug fix commit "fixed typo in config" must reference GitHub issue
Fix: Add "fixes #NNN" to commit message
```

**Solution:**

```bash
# First, create a GitHub issue for the bug:
gh issue create --title "Typo in config" --body "Description..."

# Note the issue number (e.g., #456)

# Then amend commit to reference it:
git commit --amend -m "fix: typo in config

fixes #456"
```

### Case 3: Pushing to Main Directly

**Warning:**
```
Pushing to "main" branch directly
Suggestion: Use feature branch (feat/wish-slug) for traced work
Override: Set GENIE_ALLOW_MAIN_PUSH=1
```

**Solution A:** Create proper feature branch (recommended)

```bash
# Start over on feature branch
git reset HEAD~2  # Or however many commits
git checkout -b feat/wish-slug-name
git add .
git commit -m "feat: description

wish: wish-slug-name"
git push -u origin feat/wish-slug-name
```

**Solution B:** Override if pushing directly to main is intentional

```bash
GENIE_ALLOW_MAIN_PUSH=1 git push
```

### Case 4: Commits Don't Align with Wish

**Warning:**
```
Commits don't align well with wish "feature-name" scope
Files touched: 15, wish files: 5, overlap: 1
Suggestion: Verify wish is current/active
```

**Solution:** Either:

1. **Update the wish** to include the files you're actually touching, or
2. **Create a new wish** if the scope has changed
3. **Split commits** into separate wishes if they're covering multiple concerns

---

## Environment Variables

Override advisory behavior:

```bash
# Allow pushing to main without warning
GENIE_ALLOW_MAIN_PUSH=1 git push

# Skip wish validation entirely (use sparingly!)
GENIE_SKIP_WISH_CHECK=1 git push

# Combine both
GENIE_ALLOW_MAIN_PUSH=1 GENIE_SKIP_WISH_CHECK=1 git push
```

---

## Exit Codes

- `0` = All checks passed ✅
- `1` = Warnings only (user can override with env vars)
- `2` = Blocking errors (must fix before push)
- `3` = Script error (git command failed)

---

## Commit Message Patterns

### Recognized Wish References

```bash
# Pattern 1: Explicit wish slug
git commit -m "feat: feature name

wish: feature-slug"

# Pattern 2: GitHub issue reference (if tracking issue for wish)
git commit -m "feat: feature name

fixes #123"

# Pattern 3: File path reference
git commit -m "feat: feature name

.genie/wishes/feature-slug/"

# Pattern 4: Combined
git commit -m "feat: feature name

wish: feature-slug
fixes #123"
```

### Bug Fix Recognition

```bash
# These are recognized as bug fixes:
git commit -m "fix: bug description"
git commit -m "bug: bug description"
git commit -m "Bug fix: bug description"

# Must then include issue reference:
git commit -m "fix: bug description

fixes #123"  # ← Required
```

---

## Tips

**1. Create wish first, then commit with reference:**
```bash
# Create wish
.genie/agents/workflows/wish.md → creates .genie/wishes/feature-slug/

# Commit with reference
git commit -m "feat: feature implementation

wish: feature-slug"
```

**2. For bug fixes, create issue first:**
```bash
# Create GitHub issue
gh issue create -t "Bug: description" -b "Details..."

# Note issue number from output

# Commit with reference
git commit -m "fix: bug description

fixes #123"
```

**3. Quick validation without pushing:**
```bash
# Test advisory without actually pushing
node .genie/scripts/commit-advisory.js
```

---

## Architecture

**Workflow:** `.genie/agents/neurons/git/commit-advisory.md`
**Implementation:** `.genie/scripts/commit-advisory.js`
**Hook Integration:** `.git/hooks/pre-push`

**Why Haiku Model:**
- Fast analysis (2-5 seconds per push)
- No complex reasoning needed
- Cost efficient for frequent checks

**Why Pre-Push:**
- Catches issues before they hit remote
- Gentle feedback (run locally)
- Easy to fix and retry
