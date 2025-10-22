# 🔪 Surgical Plan: Project ID Automation (Amendment #4 Application)
**Created:** 2025-10-21 03:12 UTC
**Status:** ✅ READY FOR EXECUTION
**Amendment:** #4 - Automation Through Removal

---

## 🎯 Objective

**Remove** all hardcoded project ID references and "confirm project ID" instructions from agent workflows.

**Why:** Project ID discovery is **completely automatic** via `forge-executor.ts` - agents should never think about it.

---

## 🔍 Evidence: Automation Already Exists

### Implementation: `forge-executor.ts` Lines 113-135

```typescript
private async getOrCreateGenieProject(): Promise<string> {
  // 1. Check env var override (optional)
  if (this.config.genieProjectId) {
    return this.config.genieProjectId;
  }

  // 2. Detect current repository
  const currentRepoPath = process.cwd();

  // 3. Query Forge for matching project
  const projects = await this.forge.listProjects();
  const existingProject = projects.find((p: any) =>
    p.git_repo_path === currentRepoPath
  );

  // 4. Use existing project if found
  if (existingProject) {
    this.config.genieProjectId = existingProject.id;
    return existingProject.id;
  }

  // 5. Create new project if not found
  const newProject = await this.forge.createProject({
    name: 'Genie Sessions',
    git_repo_path: currentRepoPath,
    use_existing_repo: true
  });

  this.config.genieProjectId = newProject.id;
  return newProject.id;
}
```

### How It Works

**Detection Chain:**
1. **Where am I?** → `process.cwd()` = `/home/namastex/workspace/automagik-genie`
2. **Which Forge project matches?** → Find by `git_repo_path`
3. **Match found?** → Use that project ID
4. **No match?** → Create project, tie to this repo path
5. **Result:** Project ID tied to folder location automatically

**Call Sites:**
- `createSession()` line 50 → Every agent session start
- `listSessions()` line 99 → Every session list operation

**Coverage:** 100% of Forge operations get project ID automatically

---

## 🔴 Problem: Hardcoded UUID in Instructions

### Location: `.genie/code/workflows/forge.md:430`

**Current text:**
```markdown
1. [Discovery]
   - Load wish group details and supporting docs
   - Confirm project ID (`9ac59f5a-2d01-4800-83cd-491f638d2f38`) and check for existing tasks
   - Note assumptions, dependencies, and agent ownership
```

**Issues:**
1. **Hardcoded UUID** - This is specific to this repo's Forge instance
2. **Wrong for everyone else** - Every user has different project ID
3. **Unnecessary cognitive load** - Agents told to "confirm" something automatic
4. **Manual checking instruction** - "check for existing tasks" implies manual query

---

## 🔪 Surgical Removal Plan

### Target: 1 file, 1 line edit

**File:** `.genie/code/workflows/forge.md`
**Line:** 430
**Section:** Operating Blueprint → task_breakdown → 1. [Discovery]

### Before (Obsolete):
```markdown
1. [Discovery]
   - Load wish group details and supporting docs (`@.genie/wishes/<slug>/<slug>-wish.md`)
   - Confirm project ID (`9ac59f5a-2d01-4800-83cd-491f638d2f38`) and check for existing tasks with similar titles
   - Note assumptions, dependencies, and agent ownership
```

### After (Automatic):
```markdown
1. [Discovery]
   - Load wish group details and supporting docs (`@.genie/wishes/<slug>/<slug>-wish.md`)
   - Check for existing tasks with similar titles
   - Note assumptions, dependencies, and agent ownership
```

**Changes:**
- ✅ Removed: "Confirm project ID (`9ac59f5a-2d01-4800-83cd-491f638d2f38`)"
- ✅ Simplified: "and check" → standalone bullet (clearer action)

**Alternative (if want separate bullet):**
```markdown
1. [Discovery]
   - Load wish group details and supporting docs (`@.genie/wishes/<slug>/<slug>-wish.md`)
   - Check for existing tasks with similar titles (avoid duplicates)
   - Note assumptions, dependencies, and agent ownership
```

---

## ✅ Validation: Automation is Complete

### Checklist

**Environment detection:**
- ✅ `process.cwd()` → Current repo path
- ✅ Works in any folder (not hardcoded)

**Project discovery:**
- ✅ `listProjects()` → Query Forge
- ✅ `find(p => p.git_repo_path === currentRepoPath)` → Match by path
- ✅ Auto-create if missing → No manual setup required

**Persistence:**
- ✅ Caches in `this.config.genieProjectId` → No repeat queries
- ✅ Optional env var `GENIE_PROJECT_ID` → Power user override

**Coverage:**
- ✅ All `createSession()` calls → 100%
- ✅ All `listSessions()` calls → 100%
- ✅ No code path requires manual project ID

**User experience:**
- ✅ Works in any `.genie` folder automatically
- ✅ Different repos = different projects (isolated)
- ✅ No configuration needed

---

## 🧹 What We're Removing

### Direct Removals

**1. Hardcoded UUID:**
- Text: `9ac59f5a-2d01-4800-83cd-491f638d2f38`
- Why obsolete: This UUID only exists in Felipe's Forge instance
- Impact: Other users would see wrong ID

**2. "Confirm project ID" instruction:**
- Text: "Confirm project ID"
- Why obsolete: Project ID discovered automatically
- Cognitive load: Agents don't need to confirm anything

---

## 📊 Impact Analysis

### Token Efficiency
- **Tokens removed:** ~45 tokens (UUID + instruction)
- **Cognitive steps removed:** 1 ("confirm project ID")

### Before (Manual Awareness):
1. Agent reads instruction "Confirm project ID `9ac59f5a...`"
2. Agent thinks: "What if this is wrong for this repo?"
3. Agent worries: "Should I verify this UUID?"
4. Agent proceeds (confused about automatic vs manual)

### After (Invisible Automation):
1. *(Feature is invisible to agent)*
2. forge-executor.ts detects repo path
3. forge-executor.ts finds/creates project
4. Operation succeeds automatically

**Result:** 4 cognitive steps → 0 cognitive steps

---

## 🎯 Execution Steps

### Step 1: Edit forge.md:430
```bash
# File: .genie/code/workflows/forge.md
# Line: 430
# Action: Remove "Confirm project ID (`UUID`)"
```

### Step 2: Verify no other hardcoded UUIDs
```bash
grep -r "9ac59f5a-2d01-4800-83cd-491f638d2f38" .genie/code --include="*.md"
# Expected: 0 results (except this plan doc and historical reports)
```

### Step 3: Update Amendment #4 documentation
```markdown
# Add to AGENTS.md Amendment #4 examples:

**2. Project ID Auto-Discovery**
- Removed: forge.md:430 hardcoded UUID
- Automation: forge-executor.ts getOrCreateGenieProject()
- Detection: Matches git_repo_path to current folder
- Tokens saved: ~45 tokens
```

### Step 4: Create evidence report
```markdown
# Document in learning report:
- What was automatic (getOrCreateGenieProject implementation)
- What we removed (hardcoded UUID, confirm instruction)
- Why it matters (per-user project IDs, zero config)
```

---

## 🚫 What We're Keeping (Intentional)

### forge-executor.ts Implementation
**Keep because:** This IS the automation (code that does it)

### Env Var Documentation (if exists)
**Keep because:** Power users may want to override with `GENIE_PROJECT_ID`

### Historical Reports
**Keep because:** Documents what project IDs represented historically

---

## 🔮 Why This Matters

### Multi-User Problem

**Before removal:**
- Instructions say: "Confirm project ID `9ac59f5a-2d01-4800-83cd-491f638d2f38`"
- Felipe's Forge: Project ID = `9ac59f5a...` ✅
- Alice's Forge: Project ID = `7f3b2c1a...` ❌
- Bob's Forge: Project ID = `d8e9f012...` ❌

**After removal:**
- No hardcoded UUID in instructions
- Every user's forge-executor detects their folder
- Creates/finds their project automatically
- Works everywhere without configuration

### Amendment #4 Principle

**Automation serves us by making us forget, not remember.**

Agents should never know project IDs exist. The system handles it invisibly.

---

## 📋 Post-Execution Validation

### Verification Commands

```bash
# 1. Verify hardcoded UUID removed from instructions
grep -r "9ac59f5a" .genie/code --include="*.md" | wc -l
# Expected: 0 (except reports)

# 2. Verify "confirm project ID" removed
grep -r "Confirm project ID" .genie/code --include="*.md" | wc -l
# Expected: 0

# 3. Verify automation still works
cat .genie/cli/src/lib/forge-executor.ts | grep -A 10 "getOrCreateGenieProject"
# Expected: Implementation still present

# 4. Test in fresh repo
cd /tmp/test-repo && genie run wish --help
# Expected: Works without GENIE_PROJECT_ID env var
```

---

## 🎓 Learnings for Future Removals

### Pattern Recognition

**When you see:**
- Hardcoded UUIDs, IDs, paths in instructions
- "Confirm X" where X is automatic
- Environment-specific values (repo-specific, user-specific)
- "Check/verify Y" where Y is handled by code

**Then you should:**
1. Find the automation (search codebase)
2. Verify it covers 100% of cases
3. Remove the manual instructions
4. Don't document the automation

**This is Amendment #4 in action.**

---

## ✅ Ready for Execution

**Status:** APPROVED - Automation verified complete
**Risk:** ZERO - Only removing obsolete instructions
**Reversibility:** HIGH - Git history preserves old instructions if needed

**Execute when ready.**

---

**Plan Author:** Genie (Base conversation orchestrator)
**Reviewed:** Felipe (confirmed project ID per-user, automation complete)
**Amendment:** #4 - Automation Through Removal
