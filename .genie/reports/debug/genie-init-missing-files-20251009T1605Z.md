# Debug Report: Genie Init Missing Files

**Timestamp:** 2025-10-09T16:05:13Z
**Command:** `genie init`
**Reported Issues:**
1. AGENTS.md and CLAUDE.md not copied to new repos
2. .claude/ directory not copied to new repos
3. Agents folder copied from NPM to workspace (should reference NPM package instead)

---

## Investigation Summary

### Issue #1: AGENTS.md and CLAUDE.md Not Copied

**Root Cause:** These files don't exist in the templates directory.

**Evidence:**
- `templates/` directory only contains `init-scripts/` subdirectory (.genie/cli/src/commands/init.ts:12)
- `getTemplateClaudePath()` points to `templates/.claude` which doesn't exist
- AGENTS.md and CLAUDE.md exist at repo root but are not in templates/

**File Locations:**
- Source (repo root): `/AGENTS.md`, `/CLAUDE.md`, `/.claude/`
- Expected template location: `/templates/AGENTS.md`, `/templates/CLAUDE.md`, `/templates/.claude/`
- Actual template location: `/templates/` (empty except `init-scripts/`)

**Code Analysis:**
```typescript
// .genie/cli/src/lib/paths.ts:11-13
export function getTemplateClaudePath(): string {
  return path.join(getPackageRoot(), 'templates', '.claude');
}
```

```typescript
// .genie/cli/src/commands/init.ts:114-116
if (await pathExists(templateClaude)) {
  await copyTemplateClaude(templateClaude, claudeDir);
}
```

The init command tries to copy from `templates/.claude` but this directory doesn't exist, so the copy is silently skipped.

### Issue #2: Agents Folder Behavior

**Investigation Status:** Requires deeper analysis of MCP server agent resolution.

**Expected Behavior (per core-template-separation wish):**
- Core agents (plan, wish, forge, review, orchestrator, vibe) should be loaded from NPM package
- Only custom agents should be in workspace `.genie/agents/`
- MCP server should resolve: NPM core agents + workspace custom agents

**Current Behavior:**
According to init.ts:112, the entire `.genie/` directory is copied with blacklist filtering:

```typescript
// .genie/cli/src/commands/init.ts:186-202
async function copyTemplateGenie(templateGenie: string, targetGenie: string): Promise<void> {
  const blacklist = getTemplateRelativeBlacklist(); // ['cli', 'mcp', 'state', 'backups']
  // ... copies everything except blacklisted folders
}
```

**Hypothesis:** Since `.genie/agents/` is not blacklisted, it gets copied entirely to user projects.

**Design Intent (from wish document):**
> Core agents remain in the npm package and load automatically via MCP; template agents/docs are copied to user projects during `genie init` for project-specific customization.

---

## Root Cause Analysis

### Issue #1: Missing Template Files

**Cause:** Template population incomplete.

The `core-template-separation` wish (Phase 2/3) defines what should be in templates:

**Expected Template Structure:**
```
templates/
├── .claude/
│   ├── README.md
│   ├── commands/
│   └── agents/
├── .genie/
│   ├── custom/
│   ├── standards/
│   ├── product/
│   ├── guides/
│   └── state/
├── AGENTS.md
└── CLAUDE.md
```

**Current Template Structure:**
```
templates/
└── init-scripts/
```

**Classification:** Implementation incomplete - wish Phase 2/3 not yet executed.

### Issue #2: Agents Folder Strategy

**Cause:** Phase 2 of core-template-separation wish not completed.

**From wish document (.genie/wishes/core-template-separation/core-template-separation-wish.md:68-81):**
> ### Phase 2 – Core Delivery Catalog Rationalization
> - **Goal:** Collapse legacy delivery prompts into the `core/` directory with matching `.genie/custom/<name>.md` includes for project overrides.
> - **Deliverables:**
>   - All delivery/utility prompts live under `.genie/agents/core/` with project customization in `.genie/custom/`
>   - `.claude/` wrappers and template copies point to the new core paths
>   - Agent resolver/AGENTS.md documentation reflects the flattened structure

**Status Log Entry:**
> - [Pending] Phase 2: Core delivery catalog consolidation applied

**Classification:** Feature not yet implemented - requires MCP server changes + template population.

---

## Impact Assessment

### Issue #1 Impact: **HIGH**
- **Severity:** New users missing critical documentation files
- **Scope:** All new `genie init` installations
- **User Experience:** Confusion about available agents, project conventions
- **Workaround:** Manual copy from package or documentation

### Issue #2 Impact: **MEDIUM**
- **Severity:** Bloated user projects with unnecessary core agent files
- **Scope:** All new `genie init` installations
- **User Experience:** Confusion about which agents to customize
- **Workaround:** Works correctly but violates design intent
- **Future Risk:** Users modify core agents, breaking framework assumptions

---

## Evidence Log

### Commands Executed:
```bash
# Verify template directory contents
ls -la templates/
# Output: only init-scripts/ exists

# Verify source files exist at repo root
ls -la | grep -E "(AGENTS|CLAUDE|\.claude)"
# Output: All three exist at repo root

# Examine init command implementation
cat .genie/cli/src/commands/init.ts
# Lines 11-12: getTemplateClaudePath() → templates/.claude
# Lines 114-116: Conditional copy if path exists (currently false)

# Check path resolution
cat .genie/cli/src/lib/paths.ts
# Lines 11-13: Templates expected at package_root/templates/

# Verify blacklist
cat .genie/cli/src/lib/paths.ts
# Line 16: Blacklist = ['cli', 'mcp', 'state', 'backups']
# Note: 'agents' NOT in blacklist
```

### File References:
- Init implementation: `.genie/cli/src/commands/init.ts:11-116`
- Path resolution: `.genie/cli/src/lib/paths.ts:7-17`
- Wish document: `.genie/wishes/core-template-separation/core-template-separation-wish.md`
- Copy function: `.genie/cli/src/lib/fs-utils.ts:18-32`

---

## Recommended Resolution Paths

### Option 1: 🔧 Quick Fix (Immediate)
**Action:** Populate templates directory with missing files.

**Steps:**
1. Create `templates/.claude/` structure
2. Copy AGENTS.md and CLAUDE.md to templates/
3. Verify init command copies correctly

**Risk:** Low
**Effort:** 1-2 hours
**Regression Check:** Run `genie init` in clean directory, verify all files present

**Implementation:**
```bash
# Create template structure
mkdir -p templates/.claude/{commands,agents}
cp AGENTS.md CLAUDE.md templates/
cp -r .claude/* templates/.claude/
```

### Option 2: 📋 Full Workflow (Comprehensive)
**Action:** Complete Phase 2/3 of core-template-separation wish.

**Steps:**
1. Create planning brief for Phase 2/3 completion
2. Run `/wish` to formalize template population
3. Run `/forge` to break down implementation
4. Implement:
   - Template directory structure
   - MCP agent resolution (NPM core + workspace custom)
   - Update blacklist or copy strategy
5. Run `/review` to validate

**Risk:** Medium (MCP server changes required)
**Effort:** 4-8 hours
**Benefits:**
- Completes architectural vision
- Reduces user confusion
- Enables clean framework updates

### Option 3: 🚫 Document Workaround (Minimal)
**Action:** Update documentation with manual setup instructions.

**Steps:**
1. Add post-init setup guide to `.genie/guides/getting-started.md`
2. Document manual copy commands
3. Update init help text with warning

**Risk:** Low
**Effort:** 30 minutes
**Downsides:**
- Poor user experience
- Doesn't fix root cause
- Manual steps error-prone

---

## Recommendation

**Preferred:** Option 1 (Quick Fix) + Option 2 (Full Workflow) staged approach.

**Rationale:**
1. **Immediate fix** (Option 1): Unblocks new users with minimal risk
2. **Long-term solution** (Option 2): Completes architectural vision per wish document
3. **Sequencing:** Quick fix provides working state while full workflow is planned/implemented

**Next Steps:**
1. Execute Option 1 immediately (populate templates/)
2. Create planning brief for Option 2 (Phase 2/3 completion)
3. Run `/wish` with Phase 2/3 scope
4. Implement per forge plan

---

## Related Work

- **Wish:** `.genie/wishes/core-template-separation/core-template-separation-wish.md`
- **Status:** Phase 0 ✅ COMPLETE, Phase 1 ✅ COMPLETE, Phase 2 🔄 PENDING, Phase 3 🔄 PENDING
- **Blockers:** None - ready for Phase 2/3 execution
- **Dependencies:** MCP server agent resolution strategy

---

## Validation Commands

### For Quick Fix (Option 1):
```bash
# Verify template structure
ls -R templates/

# Test init in clean directory
cd /tmp/test-genie-init
genie init --yes
ls -la | grep -E "(AGENTS|CLAUDE|\.claude)"

# Verify all files present
test -f AGENTS.md && echo "✓ AGENTS.md"
test -f CLAUDE.md && echo "✓ CLAUDE.md"
test -d .claude && echo "✓ .claude/"
```

### For Full Workflow (Option 2):
```bash
# Agent catalog verification
genie list agents

# MCP resolution test
# (Requires test harness - see wish QA plan)

# Blacklist verification
grep "getTemplateRelativeBlacklist" .genie/cli/src/lib/paths.ts
```

---

## Appendix: File Manifest

### Files Referenced:
- `.genie/cli/src/commands/init.ts` - Init command implementation
- `.genie/cli/src/lib/paths.ts` - Path resolution functions
- `.genie/cli/src/lib/fs-utils.ts` - File system utilities
- `.genie/wishes/core-template-separation/core-template-separation-wish.md` - Architecture wish
- `AGENTS.md` - Agent documentation (repo root)
- `CLAUDE.md` - Project instructions (repo root)
- `.claude/` - Command/agent aliases (repo root)
- `templates/` - Template directory (currently incomplete)

### Key Code Snippets:

**Template Path Resolution:**
```typescript
// .genie/cli/src/lib/paths.ts:7-17
export function getPackageRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

export function getTemplateGeniePath(): string {
  return path.join(getPackageRoot(), '.genie');
}

export function getTemplateClaudePath(): string {
  return path.join(getPackageRoot(), 'templates', '.claude');
}

export function getTemplateRelativeBlacklist(): Set<string> {
  return new Set(['cli', 'mcp', 'state', 'backups']);
}
```

**Copy Logic:**
```typescript
// .genie/cli/src/commands/init.ts:112-116
await copyTemplateGenie(templateGenie, targetGenie);

if (await pathExists(templateClaude)) {
  await copyTemplateClaude(templateClaude, claudeDir);
}
```
