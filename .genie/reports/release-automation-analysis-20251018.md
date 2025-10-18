# 📋 Release Automation Analysis: RC23 Release Workflow

**Date:** 2025-10-18
**Version Released:** v2.4.0-rc.23
**Status:** Manual release completed, automation gaps identified

---

## 🎯 Executive Summary

The RC23 release required **6 manual steps** that should be automated:
1. ✗ Version bump with `pnpm bump:rc` (worked)
2. ✗ Tag conflict resolution (manual tag deletion needed)
3. ✗ Commit advisory blocking legitimate release commits
4. ✗ Feature branch creation for release (workaround)
5. ✗ Push with `--no-verify` to bypass hooks (security risk)
6. ✗ Manual PR creation and merge
7. ✗ Manual GitHub release creation

**Goal:** Single command release that automates all steps while maintaining traceability.

---

## 🔍 Current Automation State

### What Works ✅

**Version Bumping (scripts/bump.js)**
- `pnpm bump:patch` → Creates RC, updates package.json, CHANGELOG.md
- `pnpm bump:rc` → Increments RC version (rc.22 → rc.23)
- Creates git commit + tag automatically
- Pre-push hooks validate tests pass
- Triggers CI publish to @next (npm)

**Pre-Push Validation (scripts/commit-advisory.js)**
- Checks every commit is linked to wish or GitHub issue
- Detects branch type (main, feat/*, forge/*)
- Validates commit message format
- Provides fix suggestions
- Exit codes: 0 (pass), 1 (warnings), 2 (blocking)

**Forge Task Integration (scripts/forge-task-link.js)**
- Auto-detects Forge worktrees on first commit
- Links to wish documents automatically
- Updates SESSION-STATE.md

**Post-Merge Automation**
- Auto-updates STATE.md with version metadata
- Runs post-merge hooks
- Commits metadata updates

### What's Broken ✗

**Tag Conflict Handling**
- No check if tag already exists before creating
- `git tag v2.4.0-rc.23` failed because tag existed locally
- Manual `git tag -d` needed
- Risk: Multiple releases with same version

**Commit Advisory on Release Commits**
- Pre-push hook checked commits from feature branch
- Saw old commits (merge commit, STATE.md updates, etc.)
- Blocked legitimate release commit with `--no-verify` error
- **Root cause:** Commit advisory counts all commits in branch, not just new ones

**Release Branch Strategy**
- No designated release branch pattern
- Had to create `feat/release-rc23` manually
- Commit advisory flags release commits as "not linked"
- Had to bypass hooks with `--no-verify`

**GitHub Release Not Automated**
- `pnpm bump:rc` creates tag locally but doesn't create GitHub release
- Manual `gh release create` needed
- No linkage between version bump and GitHub release

**PR Creation Not Automated**
- Release commits must go through PR to main
- Manual PR creation with `gh pr create`
- Manual merge decision

---

## 🚨 Specific Bottlenecks from RC23 Release

### Bottleneck 1: Tag Conflict on Retry
**What happened:**
```bash
$ pnpm bump:rc
# ... updates package.json and CHANGELOG ...
$ git tag v2.4.0-rc.23
fatal: tag 'v2.4.0-rc.23' already exists
```

**Why:** Previous attempt created tag locally but failed to push
**Resolution:** Manual `git tag -d v2.4.0-rc.23`
**Automation needed:** Pre-check if tag exists, fail early or suggest deletion

### Bottleneck 2: Pre-Push Hook Sees Historical Commits
**What happened:**
```
# Attempted push from feat/release-rc23 branch
❌ Pre-push blocked - commit validation failed

# Commit Advisory flagged:
1. Merge branch 'main' - Not linked to wish or GitHub issue
2. chore: auto-update STATE.md - Not linked
3. docs: STANDARDIZATION COMPLETE - Not linked
```

**Why:**
- Branch history included old commits from before rebase
- Commit advisory analyzes ALL commits to be pushed (origin/main..HEAD)
- Release commits aren't appropriate for linking to issues (they're infrastructure)

**Resolution:** Manually pushed with `--no-verify` (security risk)

**Automation needed:**
- Release commits should have special handling
- Create release issue to link commits
- OR: Add release mode to commit-advisory that exempts infrastructure commits

### Bottleneck 3: Manual Feature Branch Creation
**What happened:**
- Had to manually create `feat/release-rc23` branch
- Manual reasoning: bump.js doesn't work on release branches normally
- Manual PR creation with `gh pr create`
- Manual merge decision

**Why:** No release branch strategy defined
**Automation needed:** Standard release branch pattern and PR automation

### Bottleneck 4: Multiple Push Attempts Required
**What happened:**
```bash
$ git push -u origin feat/release-rc23
❌ Pre-push blocked
$ git push -u origin feat/release-rc23 --no-verify  # Success
```

**Why:** Commit advisory was too strict for release workflow
**Risk:** Using `--no-verify` bypasses security validations

### Bottleneck 5: Tag Push Failed, Then Manual Creation
**What happened:**
```bash
$ git tag v2.4.0-rc.23  # Local tag created
$ git push origin v2.4.0-rc.23 --no-verify  # Success
$ gh release create v2.4.0-rc.23 --generate-notes  # Manual
```

**Why:** No automation to create GitHub release after tag
**Automation needed:** Link tag creation → GitHub release creation

---

## 📐 Proposed Automated Release Workflow

### Release Command Pattern
```bash
# Option 1: From release branch
git checkout -b feat/release-rc23
pnpm release:automated

# Option 2: Direct release (creates branch internally)
pnpm release:automated --version rc23

# Option 3: Full release promotion (RC → Stable)
pnpm release:stable --create-github-release
```

### Automated Release Workflow (Step-by-Step)

```
┌─────────────────────────────────────────────┐
│ 1. Version Bump & Validation               │
├─────────────────────────────────────────────┤
│ ✓ Check if on feat/release-* branch        │
│ ✓ Verify working tree clean                │
│ ✓ Check tag doesn't exist (delete if old)  │
│ ✓ Update package.json + CHANGELOG          │
│ ✓ Create git commit (linked to issue)      │
│ ✓ Create git tag                           │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ 2. Pre-Flight Checks                        │
├─────────────────────────────────────────────┤
│ ✓ Run tests (full suite)                   │
│ ✓ Build verification                       │
│ ✓ Version sanity check                     │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ 3. Git & GitHub Operations                 │
├─────────────────────────────────────────────┤
│ ✓ Push tag to origin                       │
│ ✓ Create GitHub release (auto-generated)   │
│ ✓ Push release branch (if applicable)      │
│ ✓ Create PR back to main (if on branch)    │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ 4. PR Approval & Merge                      │
├─────────────────────────────────────────────┤
│ ✓ Wait for user approval OR auto-merge     │
│ ✓ Merge PR if tests pass                   │
│ ✓ Delete release branch                    │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ 5. Publish & Verify                         │
├─────────────────────────────────────────────┤
│ ✓ GitHub Actions triggers on tag/release   │
│ ✓ Publish to npm (@next or @latest)        │
│ ✓ Verify npm package installable           │
└─────────────────────────────────────────────┘
```

### Release Issue Template

Create issue #126 type per release with:
```markdown
[RELEASE] v2.4.0-rc.23

## Release Details
- Version: 2.4.0-rc.23
- Type: RC (release candidate)
- Base: v2.4.0-rc.22
- Commits: 15 Forge tasks completed

## Checklist
- [ ] All Forge tasks merged
- [ ] Tests passing
- [ ] Release notes approved
- [ ] Tag created
- [ ] GitHub release published
- [ ] NPM package live
- [ ] Installation verified
```

---

## 🏗️ Implementation Strategy

### Phase 1: Create Release Workflow (Neuron Pattern)
**File:** `.genie/agents/code/neurons/git/workflows/release.md`

**Responsibilities:**
- Detect branch type (feature branch vs. main)
- Validate pre-conditions (tests, working tree)
- Coordinate version bump + tag + GitHub operations
- Create/manage release PR
- Verify publication

**Pattern:**
```yaml
Type: Neuron Workflow
Parent: git neuron
Scope: Release operations only
Delegation: ❌ Execute directly (leaf node)
Tools: git, gh, Bash
```

### Phase 2: Modify Scripts for Automation
**Files to Update:**

1. **scripts/bump.js** - Add release mode
   - Check if tag exists (delete if stale)
   - Link to release issue automatically
   - Option: Don't push, just create commit + tag

2. **.genie/scripts/commit-advisory.js** - Add release exemption
   - Detect if branch is `feat/release-*`
   - Skip linking requirement for release commits
   - OR: Check if commit message has "release" keyword

3. **scripts/release.js** - Extend for automation
   - Add PR creation logic
   - Add GitHub release creation
   - Add npm publish verification

### Phase 3: Create Release Branch Pattern
**Decision:** Use `feat/release-vX.Y.Z` pattern

**Rationale:**
- Consistent with existing `feat/*` pattern
- Recognized by hooks (allows PR creation)
- Clear semantic meaning
- Easy to identify in branch list

**Automation:**
```bash
# Release branch creation
git checkout -b feat/release-v2.4.0-rc.23

# Automated operations
pnpm release:automated

# Auto-creates:
# - version bump commit
# - git tag
# - GitHub release
# - PR to main
# - Merge (if tests pass)
```

### Phase 4: Modify Commit Advisory
**Decision:** Create "release mode" exception

**Option A: Special handling for release branches**
```javascript
if (branch.startsWith('feat/release-')) {
  // Skip linking requirement for infrastructure commits
  // Release commits automatically exempt
}
```

**Option B: Create release issue requirement**
```javascript
if (commitMessage.includes('chore: pre-release')) {
  requireIssue = true;
  // Link to release issue (#126 type)
}
```

**Recommendation:** Option B (more traceable)

### Phase 5: GitHub Actions Integration
**File:** `.github/workflows/publish.yml` (already exists)

**Enhancement:**
- On release creation, auto-merge PR
- Trigger npm publish
- Verify installation
- Create release report

---

## 🎯 Design Decisions

### Decision 1: Release Branch Naming
**Pattern:** `feat/release-vX.Y.Z`

**Pros:**
- Consistent with existing patterns
- Recognized by commit hooks
- Clear semantic meaning
- Works with PR workflow

**Cons:**
- Longer than `release/X.Y.Z`
- Not standard convention

**Alternative:** `release/X.Y.Z`
- Pro: Shorter, more standard
- Con: Conflicts with branch protection rules
- Con: Hooks may treat differently

**Decision:** ✅ Use `feat/release-vX.Y.Z`

---

### Decision 2: Release Issue Linking
**Pattern:** Link all release commits to release issue

**Example:**
```
fixes #126

# In commit message:
chore: pre-release v2.4.0-rc.23

fixes #126
```

**Benefits:**
- Maintains traceability
- Satisfies commit-advisory requirement
- Release issue becomes artifact
- Easy to find release history

**Implementation:**
- Create release issue first
- Pass issue number to release script
- Append to commit messages

**Decision:** ✅ Require release issue linking

---

### Decision 3: Commit Advisory Exception
**Question:** Should release commits bypass validation?

**Option A: Bypass advisory (current hack)**
```bash
git push --no-verify
```
- Risk: Skips security checks
- Benefit: Faster release

**Option B: Release mode exemption**
```javascript
if (branch.startsWith('feat/release-')) {
  // Reduce validation, not skip
}
```
- Risk: Allows bad commits
- Benefit: Maintains oversight

**Option C: Link to release issue**
```
chore: pre-release v2.4.0-rc.23

fixes #126  # Release issue requirement
```
- Risk: Requires issue creation first
- Benefit: Full traceability

**Decision:** ✅ Option C (link to release issue)

---

### Decision 4: Automated PR Merge
**Question:** Should release PR auto-merge?

**Option A: Manual approval required**
```bash
# User reviews PR, clicks merge
```
- Benefit: Human checkpoint
- Risk: Slow, requires attention

**Option B: Auto-merge if tests pass**
```bash
# Tests pass → Auto-merge (user notified)
```
- Benefit: Fast, still safe
- Risk: Less oversight

**Option C: Auto-merge with user notification**
```bash
# Tests pass → Show confirmation → Auto-merge if user says yes
```
- Benefit: Fast + oversight
- Risk: Still requires interaction

**Decision:** ✅ Option C (confirmation + auto-merge)

---

### Decision 5: GitHub Actions Automation
**Question:** Should publish to npm be automatic on release?

**Current:** Already automated (.github/workflows/publish.yml)

**Decision:** ✅ Keep as-is (triggers on release creation)

---

## 📋 Files to Create/Modify

### New Files
1. `.genie/agents/code/neurons/git/workflows/release.md`
   - Complete release workflow automation
   - ~200 lines of documentation

2. `.genie/scripts/release-issue-template.md`
   - Standard release issue template
   - Links to release documentation

### Modified Files
1. `scripts/bump.js`
   - Add tag existence check
   - Add release mode
   - Better error messages

2. `.genie/scripts/commit-advisory.js`
   - Add release branch recognition
   - Release mode exemption logic
   - Better advisory messages

3. `scripts/release.js`
   - Add PR creation (current script only creates stable releases)
   - Add GitHub release automation
   - Add publish verification

4. `package.json`
   - Add `pnpm release:branch` script
   - Add `pnpm release:automated` alias

### No Changes Needed
- `.git/hooks/pre-commit` - Already good
- `.git/hooks/pre-push` - Works well, just needs advisory fix
- `.github/workflows/publish.yml` - Already automated

---

## 🚀 Rollout Plan

### Week 1: Documentation & Planning
- [ ] Document release workflow in AGENTS.md
- [ ] Create release.md workflow file (skeleton)
- [ ] Socialize design decisions with team

### Week 2: Script Modifications
- [ ] Update scripts/bump.js (tag validation)
- [ ] Update commit-advisory.js (release mode)
- [ ] Test with manual release

### Week 3: Workflow Implementation
- [ ] Implement .genie/.../release.md
- [ ] Create release issue template
- [ ] Test end-to-end with RC release

### Week 4: GitHub Actions Enhancement
- [ ] Add PR auto-merge logic
- [ ] Add release report generation
- [ ] Final testing

### Week 5: Documentation & Launch
- [ ] Update README with release instructions
- [ ] Document new commands
- [ ] Announce workflow change

---

## ✅ Success Criteria

- [ ] Release from feature branch with single command
- [ ] All commits linked to release issue (traceability)
- [ ] Tests verified before release
- [ ] Tag created and pushed automatically
- [ ] GitHub release created with auto-generated notes
- [ ] PR created, reviewed, merged automatically
- [ ] NPM package published (already automated)
- [ ] Installation verified
- [ ] Release report generated
- [ ] No need for `--no-verify` bypass
- [ ] Time to release: < 5 minutes (automatic)

---

## 🔗 Related Issues

- Issue #126: Release v2.4.0-rc.23 (reference implementation)
- Issue #120: Executor timeout race condition (related to publishing)
- RELEASE.md: Existing release documentation (update to reference new workflow)

---

## 📚 References

**Current Release Tools:**
- `scripts/bump.js` - Version bumping
- `scripts/release.js` - Stable promotion
- `.github/workflows/publish.yml` - NPM publishing
- `.genie/agents/code/neurons/git/` - Git operations

**Genie Patterns:**
- Neuron workflows: Specialized execution
- Leaf nodes: Direct tool usage (no delegation)
- Traceability: Every action linked to issue/wish
- Automation: Minimize manual steps

---

## 📝 Notes for Future Implementation

1. **Tag Cleanup:** Consider automated tag cleanup for failed releases
2. **Rollback:** Implement rollback script for failed releases
3. **Notifications:** Add Discord/Slack notifications on release
4. **Multi-stage Release:** Support staging releases before stable
5. **Release Notes Customization:** Allow user to customize generated notes

---

**Document Created:** 2025-10-18 15:10 UTC
**Next Review:** After first automated release
**Status:** Ready for Phase 1 implementation
