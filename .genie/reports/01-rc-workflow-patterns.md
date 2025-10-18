# RC Workflow Patterns: Branch Naming & Auto-Publish
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-18
**Status:** 📐 ESTABLISHED PATTERNS
**Scope:** Branch naming, versioning, automatic publishing

---

## Branch Naming Convention

### Established Pattern

**Format:** `{issue-number}-{short-description}`

**Examples:**
- `115-session-name-architecture`
- `120-executor-replacement`
- `89-fix-legacy-commands`

### RC Branch Naming

**Decision:** RC branches should link to primary issue, not use generic "rc28" naming.

**Correct:**
```bash
git checkout -b 115-session-name-architecture
# Clear what this RC addresses
```

**Incorrect:**
```bash
git checkout -b rc28  # Too generic, no context
git checkout -b rc28-session-names  # Better, but not linked to issue
```

### Rationale

1. **Traceability:** Branch name → Issue number → GitHub issue
2. **Consistency:** Same pattern everywhere (branches, sessions, wishes)
3. **Searchability:** `git branch | grep 115` finds all #115 work
4. **Semantic meaning:** Know what the branch does without checking
5. **Natural mapping:** Issue #115 = branch `115-*` = session `115-*`

### Multiple Issues in One RC

If RC addresses multiple issues, use primary/blocking issue:

```bash
# RC28 fixes #115 (critical), #89, #15
git checkout -b 115-session-name-architecture

# Commit messages reference others:
git commit -m "fix: session names (#115), legacy commands (#89), auto-close (#15)"
```

---

## Automatic Publishing Workflow

### Current State (Manual)

```bash
# Today: Manual process
1. Developer runs: genie run release "RC28"
2. Release neuron bumps version
3. Manual npm publish
4. Manual GitHub release
5. Manual STATE.md update
```

### Desired State (Automatic)

```bash
# Future: On PR merge to main
1. PR merged → GitHub Action triggers
2. Detect if RC or stable (based on commit/tag)
3. Auto version bump
4. Auto npm publish (@next for RC, @latest for stable)
5. Auto GitHub release
6. Auto STATE.md update
7. Auto commit and push
```

### Implementation Specification

**File:** `.github/workflows/auto-publish.yml`

**Trigger:** PR merge to `main` branch

**Logic:**
```yaml
name: Auto Publish

on:
  push:
    branches:
      - main

jobs:
  publish:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'

      - name: Detect Release Type
        id: release_type
        run: |
          # Check commit message for RC indicator
          if git log -1 --pretty=%B | grep -E '(RC|rc)[0-9]+'; then
            echo "type=rc" >> $GITHUB_OUTPUT
            echo "tag=next" >> $GITHUB_OUTPUT
          else
            echo "type=stable" >> $GITHUB_OUTPUT
            echo "tag=latest" >> $GITHUB_OUTPUT
          fi

      - name: Install Dependencies
        run: pnpm install

      - name: Version Bump
        run: |
          if [ "${{ steps.release_type.outputs.type }}" == "rc" ]; then
            npm version prerelease --preid=rc --no-git-tag-version
          else
            npm version patch --no-git-tag-version
          fi

      - name: Build
        run: pnpm run build

      - name: Publish to npm
        run: npm publish --tag ${{ steps.release_type.outputs.tag }}
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        uses: actions/create-release@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tag_name: v${{ steps.version.outputs.new_version }}
          release_name: Release v${{ steps.version.outputs.new_version }}
          draft: false
          prerelease: ${{ steps.release_type.outputs.type == 'rc' }}

      - name: Update STATE.md
        run: |
          # Run genie workflow to update STATE.md
          npx genie run update "Auto-update STATE.md for release"

      - name: Commit Version Changes
        run: |
          git config --local user.email "genie@namastex.ai"
          git config --local user.name "Automagik Genie"
          git add package.json .genie/SESSION-STATE.md
          git commit -m "chore: auto-update to v$(node -p "require('./package.json').version") [skip ci]"
          git push
```

### RC vs Stable Detection

**Strategy 1: Commit Message (Simplest)**
- RC commit: `chore: RC28 - session name architecture`
- Stable commit: `chore: release v2.4.0`
- Detect via: `git log -1 --pretty=%B | grep -i rc`

**Strategy 2: Branch Name**
- RC branch pattern: `{number}-{description}`
- Stable branch pattern: `release-v{version}`
- Detect via: Check merged branch name

**Strategy 3: Manual Tag (Most Control)**
- Developer adds tag: `git tag v2.4.0-rc.28` or `git tag v2.4.0`
- Workflow only runs on tag push
- Detect via: Tag format (has `-rc` or not)

**Recommended: Strategy 1 (Commit Message)**
- Simplest to implement
- No extra git operations needed
- Clear intent in commit history
- Works with current workflow

---

## Migration Path

### Phase 1: Manual with Documentation (Today)

✅ Establish branch naming convention
✅ Document auto-publish specification
✅ Continue manual releases via release neuron

### Phase 2: Semi-Automatic (Next Sprint)

1. Create `.github/workflows/auto-publish.yml`
2. Test with dry-run mode first
3. Require manual approval before publish
4. Gradually increase automation

### Phase 3: Full Automation (Future)

1. Remove manual approval gate
2. Every merge to main = automatic release
3. Release neuron becomes validation tool only
4. STATE.md updates automatically

---

## Branch Creation Checklist

When starting new RC work:

```bash
# 1. Identify primary issue
Issue: #115 - Session name architecture

# 2. Create branch with issue-based name
git checkout -b 115-session-name-architecture

# 3. Create matching session if using Genie
genie run implementor "..." --name 115-session-name-architecture

# 4. Create wish document if needed
.genie/wishes/115-session-name-architecture.md

# 5. Work completes → PR title matches branch
PR Title: "[RC28] Session Name Architecture (#115)"

# 6. Merge → Auto-publish triggered
Commit message: "chore: RC28 - session name architecture (#115)"
```

---

## Auto-Publish Triggers

### What Should Trigger Auto-Publish?

**YES - Trigger publish:**
- ✅ PR merged to main
- ✅ Commit message contains "RC" or version bump
- ✅ Tests passing
- ✅ Build succeeds

**NO - Don't trigger:**
- ❌ Draft PR
- ❌ Commits with `[skip ci]`
- ❌ Documentation-only changes
- ❌ WIP commits

### Tag Strategy

**@next tag (RC releases):**
```bash
npm publish --tag next
# Users install: npm install automagik-genie@next
```

**@latest tag (Stable releases):**
```bash
npm publish --tag latest
# Users install: npm install automagik-genie (defaults to @latest)
```

---

## Success Criteria

### Branch Naming

✅ All new branches follow `{issue}-{description}` format
✅ Branch names match session names
✅ Branch names match wish document names
✅ Easy to trace branch → issue → PR

### Auto-Publish

✅ RC merges publish to @next automatically
✅ Stable merges publish to @latest automatically
✅ GitHub releases created automatically
✅ STATE.md updated automatically
✅ No manual npm publish commands needed
✅ Clear differentiation between RC and stable

---

## Examples

### Example 1: RC28 Branch

```bash
# Issue #115 is the primary blocker for RC28
git checkout -b 115-session-name-architecture

# Work on the fix
# ...

# Commit with RC indicator
git commit -m "feat: name-based sessions (#115)

Implements session management using human-readable names instead of UUIDs.

Fixes: #115
Part of: RC28
Breaking change: Session IDs are now names, not UUIDs"

# Create PR
gh pr create --title "[RC28] Session Name Architecture (#115)" \
  --body "Fixes #115, part of RC28 release"

# Merge → Auto-publish to @next
```

### Example 2: Stable Release

```bash
# Ready for stable release
git checkout -b release-v2.4.0

# Finalize changes
git commit -m "chore: release v2.4.0

Promotes RC28 to stable release."

# Create PR
gh pr create --title "Release v2.4.0" \
  --body "Stable release incorporating RC28 fixes"

# Merge → Auto-publish to @latest
```

---

## Implementation Checklist

### Immediate (Today)

- [x] Document branch naming convention
- [x] Document auto-publish specification
- [ ] Create 115-session-name-architecture branch
- [ ] Apply pattern to current work

### Short-term (This Week)

- [ ] Create `.github/workflows/auto-publish.yml`
- [ ] Add npm token to GitHub secrets
- [ ] Test workflow in dry-run mode
- [ ] Validate STATE.md auto-update

### Medium-term (Next Sprint)

- [ ] Enable auto-publish for RC releases
- [ ] Monitor first few automatic releases
- [ ] Refine detection logic if needed
- [ ] Update release neuron to validate only

### Long-term (Future)

- [ ] Full automation (no manual releases)
- [ ] Automatic changelog generation
- [ ] Automatic migration guide generation
- [ ] Automatic deprecation warnings

---

## Conclusion

**Branch naming:** Use `{issue-number}-{short-description}` for all branches, including RCs.

**Auto-publish:** Implement GitHub Actions workflow that detects RC vs stable based on commit message and publishes to appropriate npm tag.

**Next steps:**
1. Create `115-session-name-architecture` branch
2. Implement auto-publish workflow
3. Test with dry-run
4. Enable for real releases

---

**Document created:** 2025-10-18T19:47:00 UTC
**Pattern:** Branch = Issue-based naming
**Automation:** GitHub Actions on PR merge
**Tags:** @next for RC, @latest for stable
