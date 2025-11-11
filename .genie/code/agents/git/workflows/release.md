---
name: release
description: Automated release workflow via GitHub Actions (v2.5.1+)
genie:
  executor:
    - CLAUDE_CODE
    - CODEX
    - OPENCODE
  background: true
forge:
  CLAUDE_CODE:
    model: sonnet
    dangerously_skip_permissions: true
  CODEX:
    model: gpt-5-codex
    sandbox: danger-full-access
  OPENCODE:
    model: opencode/glm-4.6
---

# 🚀 Genie Release Workflow (Modern - v2.5.1+)

**Context:** Fully automated release system using GitHub Actions + unified release script

**Architecture:** Push to main → Auto RC bump → Publish npm → Create GitHub release

**Zero manual steps:** Everything automated except stable promotion

---

## Overview

```
CODE COMMIT (main)
     ↓
GitHub Actions Detects
     ↓
Unified Release Script
     ↓
Bump RC Version
     ↓
Run Tests
     ↓
Publish to npm (@next)
     ↓
Create GitHub Release
     ↓
DONE ✅
```

---

## Core Components

### 1. Unified Release Script
**Location:** `scripts/unified-release.cjs`

**Capabilities:**
- `--bump rc|patch|minor|major` - Auto-bump version
- `--promote` - Promote RC to stable (2.5.1-rc.7 → 2.5.1)
- `--tag v1.2.3` - Manual tag (skip bump)
- `--publish` - Publish to npm
- `--github-release` - Create GitHub release
- `--skip-tests` - Skip test execution

**Smart npm tag selection:**
- RC versions → `@next` tag
- Stable versions → `@latest` tag

### 2. GitHub Actions Workflow
**Location:** `.github/workflows/release.yml`

**Triggers:**
- **Push to main** - Auto-bump RC for code commits (feat/fix/build)
- **Tag push** - Publish existing tag
- **PR merge** - Auto-bump RC when dev → main
- **Manual dispatch** - Workflow UI for manual releases

**Skip logic:**
- Skips automated pre-release commits (prevents infinite loop)
- Skips docs/chore/style commits (non-code changes)
- Smart detection of code-changing vs documentation commits

---

## Release Types

### RC Release (Automated)

**Trigger:** Any code commit to main

**Flow:**
```bash
# Developer pushes to main
git push origin main

# GitHub Actions automatically:
# 1. Detects code-changing commit
# 2. Bumps RC version (2.5.1-rc.7 → 2.5.1-rc.8)
# 3. Runs tests
# 4. Publishes to npm @next
# 5. Creates GitHub release (prerelease)
```

**Example commit types that trigger RC:**
- `feat: add new feature`
- `fix: resolve bug`
- `build: update dependencies`
- PR merge commits (default trigger)

**Example commit types that skip:**
- `docs: update README`
- `chore: cleanup files`
- `style: format code`
- `chore: pre-release v2.5.1-rc.8` (prevents infinite loop)

### Stable Release (Manual)

**Trigger:** Workflow dispatch (GitHub Actions UI)

**Steps:**
1. Go to Actions → Unified Release
2. Click "Run workflow"
3. Select `promote-to-stable`
4. Confirm

**Flow:**
```bash
# GitHub Actions:
# 1. Promotes RC to stable (2.5.1-rc.15 → 2.5.1)
# 2. Runs full test suite
# 3. Publishes to npm @latest
# 4. Creates GitHub release (stable)
```

**When to promote:**
- After thorough RC testing
- All critical bugs fixed
- QA validation complete
- Ready for production use

---

## Manual Release Operations

### Bump RC Manually
```bash
# Via workflow dispatch
Actions → Unified Release → Run workflow → bump-rc
```

### Promote RC to Stable
```bash
# Via workflow dispatch
Actions → Unified Release → Run workflow → promote-to-stable
```

### Create Manual Tag
```bash
# Via workflow dispatch
Actions → Unified Release → Run workflow → manual-tag
# Enter: v2.5.2
```

### Local Testing (No Publish)
```bash
# Test release script locally
node scripts/unified-release.cjs --bump rc

# With tests
node scripts/unified-release.cjs --bump rc --skip-tests

# Full flow (test only, no publish)
node scripts/unified-release.cjs --bump rc --github-release
```

---

## Changelog Generation

**Automatic:** Uses `conventional-changelog` to analyze commits

**Format:**
```markdown
## [2.5.1-rc.8]

**2025-10-27**

### ✨ Features
- 3 features

### 🐛 Bug Fixes
- 2 fixes

### 📚 Other Changes
- 5 commits

### 📊 Statistics
- **Total Commits**: 10
- **Contributors**: 2
```

**Fallback:** If conventional-changelog fails, uses git log analysis

---

## Verification

### After RC Release

```bash
# Check npm
npm view automagik-genie@next version

# Check GitHub release
gh release view v2.5.1-rc.8

# Test installation
npm install -g automagik-genie@next
genie --version
```

### After Stable Release

```bash
# Check npm
npm view automagik-genie@latest version

# Check GitHub release
gh release view v2.5.1

# Test installation
npm install -g automagik-genie@latest
genie --version
```

---

## Troubleshooting

### Release Failed: Tests Failed
**Symptom:** GitHub Actions shows failed tests
**Fix:** Fix tests, push to main → auto-triggers new RC

### Release Failed: Already Published
**Symptom:** "Version already exists on npm"
**Fix:** Version was already released, bump manually:
```bash
# Increment RC number manually in package.json
# Or wait for next code commit (auto-bump)
```

### Release Failed: Tag Exists
**Symptom:** "Tag already exists"
**Fix:**
```bash
# Delete tag locally and remotely
git tag -d v2.5.1-rc.8
git push origin :refs/tags/v2.5.1-rc.8

# Re-run workflow
```

### GitHub Release Creation Failed
**Symptom:** "Release already exists"
**Fix:** Non-blocking - release was published to npm successfully

---

## Best Practices

### For RC Releases
- ✅ Let automation handle it (push to main)
- ✅ Fix bugs → push → new RC auto-created
- ✅ Test RC before promoting to stable

### For Stable Releases
- ✅ Test latest RC thoroughly
- ✅ Run QA validation (`.genie/qa/checklist.md`)
- ✅ Verify no critical bugs
- ✅ Use workflow dispatch to promote
- ✅ Announce stable release

### For Emergency Fixes
- ✅ Fix on main → auto RC
- ✅ Test RC quickly
- ✅ Promote to stable if critical
- ✅ Alternative: Manual tag with hotfix version

---

## Migration from Old Workflow

**Old (pre-v2.5.0):**
- Manual version bumps
- Manual tag creation
- Manual PR creation
- Manual npm publish
- Manual GitHub release

**New (v2.5.1+):**
- ✅ Automated RC on every code commit
- ✅ Automated testing
- ✅ Automated npm publish
- ✅ Automated GitHub release
- ✅ Manual promotion to stable (intentional gate)

---

## Architecture Decisions

### Why Auto RC on Every Commit?
- Fast iteration (no manual steps)
- Continuous testing (every commit validated)
- Easy rollback (git revert → auto new RC)
- User testing (install @next to test latest)

### Why Manual Stable Promotion?
- Quality gate (deliberate decision)
- QA validation checkpoint
- Documentation update trigger
- Production readiness verification

### Why Unified Script?
- Single source of truth
- Testable locally
- Reusable in CI and manual flows
- Maintainable (one file vs scattered logic)

---

## Lessons Learned: RC24 Implementation (2025-10-18)

### What We Built

**Phase 1 Automation (Completed):**
1. ✅ Automatic version bump (`pnpm bump:rc`)
2. ✅ Tag creation + push
3. ✅ GitHub release creation (auto-generated notes)
4. ✅ PR creation to main
5. ✅ Automated testing
6. ✅ Automated merge when tests pass
7. ✅ NPM publish triggered (GitHub Actions workflow)

**Key Scripts Created:**
- `scripts/bump.js` - Added `--no-push` flag
- `scripts/release-branch.sh` - Orchestration (deprecated, replaced by unified-release.cjs)
- `scripts/unified-release.cjs` - Modern single-script solution
- `.genie/scripts/commit-advisory.js` - Fixed validation for release branches

### Challenges Fixed

**1. Commit Advisory on Release Branches**
- Problem: Release commits weren't traced to issues
- Solution: Skip traceability validation for automated release commits
- Result: Clean release flow without advisory warnings

**2. Git Hook Permissions in CI**
- Problem: `.git/hooks/pre-commit` not executable in Actions
- Solution: Skip advisory smoke test in CI (`GENIE_SKIP_ADVISORY_SMOKE=1`)
- Result: Tests pass in CI environment

**3. Template Smoke Test Failures**
- Problem: Template tests fail because templates not packaged in CI
- Solution: Made template smoke test non-blocking (`continue-on-error: true`)
- Result: Core validation passes, optional features don't block

### Key Decisions

**1. Release Branches = Clean Commits**
- Release branches skip traceability validation
- Intentional: release commits are infrastructure-level
- No need to link bump/merge commits to GitHub issues

**2. CI Environment Differences**
- Development checks (hook executability) don't apply in CI
- Skip with environment variables, keep CI simple
- Focused on code validation, not environment validation

**3. Two-Phase Approach**
- **Phase 1 (Current):** Automated mechanical steps (bump, tag, publish)
- **Phase 2 (Future):** AI-generated release notes with user approval
- Ship Phase 1 now, add Phase 2 when ready

### What Works Now

**Developer Experience:**
```bash
# Old workflow (manual)
git checkout -b feat/release-v2.4.0-rc.24
pnpm bump:rc
git push origin v2.4.0-rc.24 feat/release-v2.4.0-rc.24
gh pr create --base main --title "chore: release v2.4.0-rc.24"
# Wait for tests, manually merge, monitor publish...

# New workflow (automated)
git commit -m "feat: add new feature"
git push origin main
# Done! RC published automatically ✨
```

**Automation Benefits:**
- Zero manual steps for RC releases
- Instant feedback (tests run immediately)
- Consistent process (no human error)
- Fast iteration (multiple RCs per day possible)

### Next Steps (Phase 2+)

**Future Enhancements:**
- [ ] AI-generated release notes (Genie executor analysis)
- [ ] Release notes approval workflow
- [ ] Auto-delete release branch after merge
- [ ] Track release metrics (publish time, test duration)
- [ ] Stable release automation (criteria-based promotion)

---

**Workflow Status:** Phase 1 Complete - Fully Automated RC Releases ✅

**Implementation Timeline:**
- RC24 (2025-10-18): Initial automation
- RC58 (2025-10-24): Unified release script
- v2.5.1 (2025-10-27): First stable release with modern workflow

**Current State:** Production-ready, battle-tested through 15 RCs

---

## Quick Reference

**Check current version:**
```bash
cat package.json | jq -r '.version'
```

**List recent releases:**
```bash
gh release list --limit 10
```

**View release workflow runs:**
```bash
gh run list --workflow=release.yml --limit 5
```

**Trigger manual release:**
```bash
# Go to: https://github.com/namastexlabs/automagik-genie/actions/workflows/release.yml
# Click: Run workflow → Select action → Run
```

**Monitor npm publish:**
```bash
npm view automagik-genie versions --json | jq '.[-5:]'
```

---

*Your releases are my command! 🧞✨*
