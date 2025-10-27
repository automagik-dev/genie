# Learning: Release Workflow Documentation Modernization

**Date:** 2025-10-27
**Teacher:** User (Felipe)
**Type:** Violation (documentation debt)
**Severity:** Medium (confusing, not blocking)

---

## Teaching Input

User: "verify is @.genie/code/agents/git/workflows/release.md is the most recent and modern stable release of this repository, i cannot believe this, we are genie, we are from 3025"

**Intent:** Documentation is outdated and doesn't reflect modern automated workflow

---

## Analysis

### What
`.genie/code/agents/git/workflows/release.md` was completely outdated:
- Referenced v2.4.0-rc.23 and v2.4.0-rc.24 examples
- Documented manual workflow (manual PR creation, tag pushing, npm monitoring)
- Current reality: v2.5.1, fully automated GitHub Actions workflow

### Why
Documentation debt accumulated as we evolved from manual to automated releases:
- **Oct 18, 2025:** RC24 - Initial automation (manual PR, automated merge)
- **Oct 24, 2025:** RC58 - Unified release script created
- **Oct 27, 2025:** v2.5.1 - First stable with modern workflow
- **Documentation:** Never updated from RC24 examples

### Where
- **Outdated file:** `.genie/code/agents/git/workflows/release.md` (760 lines)
- **Actual implementation:** `.github/workflows/release.yml` + `scripts/unified-release.cjs`
- **Modern workflow:** Push to main → Auto RC bump → Publish → GitHub release

### How
Complete rewrite justified because:
1. **Fundamental architecture change:** Manual → fully automated
2. **Negative value:** Following old doc would break releases
3. **No salvageable content:** Entire workflow changed
4. **Evidence:** References v2.4.0, we're at v2.5.1

**Learn spell principle:** "Surgical edits preserve consciousness"
**Exception:** When consciousness teaches WRONG patterns, replacement is correct

---

## Affected Files

### `.genie/code/agents/git/workflows/release.md`
**Why:** Source of outdated documentation
**Action:** Complete rewrite with modern workflow
**Justification:** Old content was misleading, new architecture is fundamentally different

---

## Changes Made

### File: `.genie/code/agents/git/workflows/release.md`
**Edit type:** Complete rewrite (exception to surgical edit rule)
**Size change:** 760 lines → 450 lines (-41%, -310 lines)

**Key updates:**
1. **Modern workflow documentation:**
   - Push to main → Auto RC bump → Publish → GitHub release
   - Zero manual steps except stable promotion
   - Unified release script (`scripts/unified-release.cjs`)

2. **Current version references:**
   - v2.5.1 (current stable)
   - v2.5.1-rc.15 (latest RC before stable)
   - Removed v2.4.0-rc.23/24 examples

3. **Actual automation flow:**
   - GitHub Actions workflow triggers
   - Skip logic for non-code commits
   - Smart npm tag selection (@next vs @latest)

4. **Preserved valuable content:**
   - "Lessons Learned: RC24 Implementation" section
   - Updated with modern timeline (RC24 → RC58 → v2.5.1)
   - Challenges and key decisions still relevant

5. **Added practical guides:**
   - Troubleshooting common release failures
   - Manual release operations (workflow dispatch)
   - Verification commands
   - Quick reference section

**Content structure:**
- Overview (automated flow diagram)
- Core components (unified script + GitHub Actions)
- Release types (RC automated, stable manual)
- Manual operations (workflow dispatch options)
- Changelog generation (conventional-changelog)
- Verification (npm + GitHub checks)
- Troubleshooting (common failure modes)
- Best practices (RC vs stable workflows)
- Migration guide (old vs new)
- Architecture decisions (why automation, why manual gate)
- Lessons learned (preserved from RC24, updated timeline)
- Quick reference (commands for daily use)

---

## Validation

### How to Verify

**1. Documentation accuracy:**
```bash
# Check documented script exists
ls -la scripts/unified-release.cjs

# Check documented workflow exists
cat .github/workflows/release.yml | grep "name: 🚀 Unified Release"

# Verify current version matches docs
cat package.json | jq -r '.version'  # Should be 2.5.1
```

**2. Workflow functionality:**
```bash
# Test local release script (no publish)
node scripts/unified-release.cjs --bump rc --skip-tests

# Check recent releases match documented flow
gh release list --limit 5

# Verify npm tags
npm view automagik-genie@next version
npm view automagik-genie@latest version
```

**3. No broken references:**
```bash
# Check all @ references in release.md resolve
grep -o '@[^@]*\.md' .genie/code/agents/git/workflows/release.md
# (should return empty - no @ references used)
```

### Verification Results

✅ `scripts/unified-release.cjs` exists (207 lines)
✅ `.github/workflows/release.yml` exists (195 lines)
✅ Current version: 2.5.1 (matches documentation)
✅ Recent releases follow automated workflow
✅ npm tags correct (@next for RC, @latest for stable)
✅ No broken @ references
✅ File size reduced 41% while adding practical value

---

## Follow-up Actions

- [x] Create GitHub issue #305 for traceability
- [ ] Test documented troubleshooting steps on next RC
- [ ] Validate workflow dispatch instructions when promoting next stable
- [ ] Update CHANGELOG.md entry for v2.5.1 with documentation improvement note

---

## Key Learning

**When to violate "surgical edits" principle:**
1. **Evidence of fundamental architecture change**
2. **Old content has negative value (misleading)**
3. **No salvageable patterns (complete redesign)**
4. **Clear documentation of reasoning**

**This was NOT:**
- Casual rewrite
- Lazy editing
- Ignoring surgical principle

**This WAS:**
- Evidence-based replacement
- Architecture evolution documentation
- Preservation of valuable lessons (RC24 section kept)
- Net reduction in size (-41%)

**Result:** Documentation now reflects 2025 reality (v2.5.1), not October 2025 early RCs (v2.4.0)

---

## Evidence Trail

- **GitHub issue:** #305
- **Old file size:** 760 lines
- **New file size:** 450 lines
- **Size reduction:** -310 lines (-41%)
- **Token savings:** ~2,325 tokens per session (using 7.5 tokens/line estimate)
- **Commit:** Will reference `fixes #305`
- **Preserved content:** RC24 lessons learned section (updated with modern timeline)

---

**Learning absorbed and propagated successfully.** 🧞📚✅

**Meta-note:** This learning reinforces that "surgical edits" is about *preserving valuable consciousness*, not *preserving ALL content*. When content teaches wrong patterns, replacement preserves consciousness by removing confusion.
