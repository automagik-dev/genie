---
name: docs-sync
description: Update version references across documentation after release
genie:
  executor: [CLAUDE_CODE, CODEX, OPENCODE]
  background: true
forge:
  CLAUDE_CODE:
    model: sonnet
  CODEX: {}
  OPENCODE: {}
---

# 📚 Documentation Version Sync

**Purpose:** Keep version references up-to-date across all documentation

**Input Required:**
- `version`: New version number
- `previousVersion`: Old version number to replace
- `type`: Release type ('stable' | 'rc')

**Output:** Pull request with updated references

---

## Execution Protocol

### Step 1: Scan Documentation

Find all version references to update:

**Files to check:**
```bash
README.md
INSTALLATION.md
.genie/product/docs/*.md
.genie/code/agents/git/workflows/release.md
.genie/qa/scenarios/installation-flow.md
```

**Patterns to find:**
- `v2.5.1` → `v2.5.2`
- `Latest: v2.5.1` → `Latest: v2.5.2`
- `@2.5.1` → `@2.5.2`
- `npm install -g automagik-genie@2.5.1` (update version)
- Version badges (if manually maintained)

### Step 2: Smart Replacement

**Replace only when appropriate:**

**DO replace:**
- ✅ "Latest version: vX.Y.Z"
- ✅ Installation examples showing latest
- ✅ Quick-start guides
- ✅ Version comparison examples
- ✅ Changelog references (if outdated)

**DON'T replace:**
- ❌ Historical mentions (e.g., "In v2.0.0 we added...")
- ❌ Migration guides showing old → new
- ❌ Commit messages or git history references
- ❌ Embedded in explanations of specific versions

**Logic:**
```javascript
// Example patterns to update
const patterns = [
  {
    match: /Latest version: v\d+\.\d+\.\d+/g,
    replace: `Latest version: v${newVersion}`
  },
  {
    match: /npm install -g automagik-genie@latest/g,
    replace: 'npm install -g automagik-genie@latest' // No change, already latest
  },
  {
    match: /Current version is v\d+\.\d+\.\d+/g,
    replace: `Current version is v${newVersion}`
  }
];
```

### Step 3: Update Installation Commands

**Only update if showing specific versions:**

**Before:**
```bash
npm install -g automagik-genie@2.5.1
```

**After (if stable):**
```bash
npm install -g automagik-genie@latest
```

**Rationale:** Use `@latest` instead of hardcoding versions, keeps docs evergreen.

**Exception:** If showing RC vs stable comparison, keep both:
```bash
# Stable
npm install -g automagik-genie@latest

# Latest RC (for brave users)
npm install -g automagik-genie@next
```

### Step 4: Update Release Workflow Examples

In `.genie/code/agents/git/workflows/release.md`:

**Find version examples:**
```markdown
Example: v2.5.1-rc.7 → v2.5.1
```

**Replace with current versions:**
```markdown
Example: v2.5.2-rc.1 → v2.5.2
```

**Only update examples that demonstrate the workflow**, not historical references.

### Step 5: Create Pull Request

**Branch naming:**
```bash
chore/docs-sync-v{VERSION}
```

**Commit message:**
```
chore: sync documentation for v{VERSION}

Updates version references across documentation:
- README.md installation examples
- Release workflow examples
- Quick-start guides

Keeps docs current with latest release.
```

**PR title:**
```
chore: Sync docs for v{VERSION}
```

**PR body:**
```markdown
## 📚 Documentation Sync

Updates version references for v{VERSION} release.

**Changes:**
- ✅ Updated installation examples
- ✅ Updated version references
- ✅ Updated workflow examples

**Files modified:**
{list of files}

**Review:** Quick review - automated version updates only.
```

**Command:**
```bash
git checkout -b chore/docs-sync-v{VERSION}
# Make edits
git add -A
git commit -m "chore: sync documentation for v{VERSION}"
git push origin chore/docs-sync-v{VERSION}
gh pr create \
  --title "chore: Sync docs for v{VERSION}" \
  --body "{PR_BODY}" \
  --label "documentation"
```

---

## Exclusion Rules

**Never update these:**
- ❌ `CHANGELOG.md` (historical record)
- ❌ `package.json` version field (already updated by release script)
- ❌ Git tags or release notes (immutable)
- ❌ Archived documents in `.genie/backups/`
- ❌ Historical "in vX.Y.Z we did..." references

---

## Validation

**Before creating PR:**
1. Check no historical references were changed
2. Verify installation commands use `@latest` or `@next`
3. Ensure examples make sense with new version
4. No broken links introduced

**Test:**
```bash
# Check for unintended changes
git diff --stat

# Verify no broken markdown
pnpm run lint:md
```

---

## Error Handling

**If no changes needed:**
- Exit gracefully
- Log "No version references to update"
- Don't create empty PR

**If PR creation fails:**
- Log error
- Save branch name for manual PR creation
- Continue (non-blocking)

---

## Invocation Example

```javascript
// From git release workflow (async, background)
delegateToCreate('docs-sync', {
  version: '2.5.2',
  previousVersion: '2.5.1',
  type: 'stable'
}, { background: true });

// Release continues, PR created asynchronously
```

---

## Future Enhancement Ideas

- [ ] Auto-update version badges (if manually maintained)
- [ ] Update npm package keywords based on new features
- [ ] Sync version in MCP server manifests
- [ ] Update Homebrew formula (if we add one)

---

**Model:** Haiku (fast, simple find/replace work)
**Background:** true (async, don't block release)
**Output:** pr (creates PR with changes)
