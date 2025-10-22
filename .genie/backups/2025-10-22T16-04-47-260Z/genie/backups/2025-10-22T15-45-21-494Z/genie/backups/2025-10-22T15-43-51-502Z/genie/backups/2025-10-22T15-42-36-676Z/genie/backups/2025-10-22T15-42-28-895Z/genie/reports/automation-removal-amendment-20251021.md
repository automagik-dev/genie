# Amendment #4: Automation Through Removal - Learning Report
**Created:** 2025-10-21
**Amendment:** Seven Amendments #4
**Status:** ✅ COMPLETE - Amendment documented, cleanup executed

---

## 🎯 Core Learning: Automation Through Removal

**Principle Established:**
When features become automatic, Genie reduces its own cognitive load by **removing** obsolete instructions, not documenting the automation.

**Pattern:**
```
Feature becomes automatic → Remove all related instructions
Don't replace with "this is now automatic"
Absence of instructions IS the documentation
```

---

## 📚 Teaching Example: Base Branch Auto-Configuration

### What Changed (Technical)

**Before (Manual):**
- Agents needed to know about `base_branch` parameter
- Instructions explicitly mentioned setting base branch
- Agents had to configure this when creating Forge tasks

**After (Automatic):**
```typescript
// .genie/cli/src/lib/forge-executor.ts lines 52-58
async createSession(params: CreateSessionParams): Promise<string> {
  // Sync current git branch to Forge project's default_base_branch
  try {
    const currentBranch = execSync('git rev-parse --abbrev-ref HEAD',
      { encoding: 'utf8', cwd: process.cwd() }).trim();
    await this.forge.updateProject(projectId, { default_base_branch: currentBranch });
  } catch (error) {
    // If git detection fails, Forge will use its existing default_base_branch
  }

  // Don't pass base_branch - let Forge use its default_base_branch setting
}
```

**Result:** Forge MCP automatically detects current branch and syncs `default_base_branch` setting.

---

## 🧹 Cleanup Executed

### Files Modified (4 total)

#### 1. `.genie/code/skills/forge-architecture.md` (line 23)
**Before:**
```markdown
- **Parameters:** task_id, executor (CLAUDE_CODE, etc.), base_branch (main)
```

**After:**
```markdown
- **Parameters:** task_id, executor (CLAUDE_CODE, etc.)
```

**Tokens saved:** ~6 tokens
**Cognitive load:** Agents no longer think about base_branch parameter

---

#### 2. `.genie/code/agents/git/git.md` (line 221)
**Before:**
```markdown
Use these as a baseline; consult `` for project-specific variations (base branch, CLI helpers, required checks).
```

**After:**
```markdown
Use these as a baseline; consult `` for project-specific variations (CLI helpers, required checks).
```

**Tokens saved:** ~4 tokens
**Cognitive load:** Removed base branch from customization considerations

---

#### 3. `.genie/code/agents/git/git.md` (line 271)
**Before:**
```markdown
Consult `` for repository-specific branch naming, base branches, hooks, or required commands.
```

**After:**
```markdown
Consult `` for repository-specific branch naming, hooks, or required commands.
```

**Tokens saved:** ~4 tokens
**Cognitive load:** Removed base branches from project customization scope

---

#### 4. `.genie/code/agents/git/workflows/pr.md` (line 42)
**Before:**
```markdown
## Never Do
- ❌ Create PR without testing section
- ❌ Skip wish/issue cross-references
- ❌ Use wrong base branch
- ❌ Create PR with uncommitted changes
```

**After:**
```markdown
## Never Do
- ❌ Create PR without testing section
- ❌ Skip wish/issue cross-references
- ❌ Create PR with uncommitted changes
```

**Tokens saved:** ~7 tokens
**Cognitive load:** Agents can't "get base branch wrong" anymore (it's automatic)

---

### What We Kept (Intentional)

#### `.genie/code/workflows/forge.md` (lines 114, 126, 137)
**Kept because:** Explains base branch CONCEPT for mental model (where PRs merge to)

**Example (line 114):**
```markdown
- Task B cannot see Task A's changes until Task A is MERGED to base branch
```

**Why keep:** This teaches worktree isolation concepts, not instructions for manual configuration.

#### Reports and Historical Documentation
**Kept because:** Historical context, not active instructions.

#### Implementation Code
**Kept because:** This is the code that DOES the automation (forge-executor.ts).

---

## 📊 Impact Analysis

### Token Efficiency
- **Total tokens removed:** ~21 tokens (direct mentions)
- **Cognitive load removed:** 4 decision points where agents no longer need to think about base branch

### Before/After Comparison

**Before (Cognitive Load):**
1. Agent reads instruction about base branch
2. Agent decides what base branch to use
3. Agent sets base_branch parameter
4. Agent worries about "wrong base branch" error

**After (Automation):**
1. *(Feature is invisible to agent)*
2. Forge auto-detects current branch
3. Forge updates default_base_branch
4. Tasks use correct base automatically

**Result:** 4 cognitive steps → 0 cognitive steps

---

## 🔍 Additional Automation Opportunities Discovered

### 1. Project ID Auto-Discovery
**Location:** `.genie/code/workflows/forge.md` line 430

**Current instruction:**
```markdown
- Confirm project ID (`9ac59f5a-2d01-4800-83cd-491f638d2f38`) and check for existing tasks
```

**Automation exists:**
```typescript
// forge-executor.ts lines 113-135
private async getOrCreateGenieProject(): Promise<string> {
  const currentRepoPath = process.cwd();
  const projects = await this.forge.listProjects();
  const existingProject = projects.find((p: any) =>
    p.git_repo_path === currentRepoPath
  );

  if (existingProject) {
    return existingProject.id;
  }

  const newProject = await this.forge.createProject({
    name: 'Genie Sessions',
    git_repo_path: currentRepoPath,
    use_existing_repo: true
  });

  return newProject.id;
}
```

**Recommendation:** Remove hardcoded project ID from forge.md line 430. It's automatically discovered/created based on `git_repo_path`.

**Cognitive load to remove:**
- Agents don't need to know specific project UUID
- Agents don't need to confirm project ID
- System handles project lookup/creation automatically

---

### 2. Executor Profile Mapping
**Location:** Various agent files

**Automation exists:**
```typescript
// forge-executor.ts lines 137-168
private mapExecutorToProfile(
  executorKey: string,
  variant?: string,
  model?: string
): { executor: string; variant: string; model?: string } {
  const mapping: Record<string, string> = {
    'claude': 'CLAUDE_CODE',
    'claude-code': 'CLAUDE_CODE',
    'codex': 'CODEX',
    // ... etc
  };

  const normalizedKey = executorKey.trim().toLowerCase();
  const executor = mapping[normalizedKey] || normalizedKey.toUpperCase();
  // ...
}
```

**Current state:** Most instructions already don't mention executor mapping.

**Recommendation:** Scan for any instructions that tell agents to map executor keys manually.

---

### 3. Agent Name Extraction
**Automation exists:**
```typescript
// forge-executor.ts lines 170-173
private extractAgentNameFromTitle(title: string): string {
  const match = title.match(/^Genie: ([^\(]+)/);
  return match ? match[1].trim() : title;
}
```

**Current state:** No instructions found telling agents to manually extract names.

**Status:** ✅ Already clean

---

## 📖 Amendment #4 Documentation

### Added to AGENTS.md (lines 149-193)

**Amendment #4: Automation Through Removal** 🔴 CRITICAL

**Core sections:**
1. **Core Principle** - Reduce cognitive load, don't document automation
2. **Pattern** - Remove instructions when features become automatic
3. **Example** - Base branch auto-configuration (this report)
4. **What we removed** - 4 file changes documented
5. **What we kept** - Conceptual explanations vs instructions
6. **Why this matters** - Continuous self-simplification
7. **Active opportunity scanning** - Behavioral trigger patterns

---

## 🎯 Implementation Checklist

- [x] Document Amendment #4 in AGENTS.md
- [x] Remove base_branch from forge-architecture.md
- [x] Remove base branch from git.md (2 locations)
- [x] Remove base branch from pr.md Never Do list
- [x] Identify project ID auto-discovery opportunity
- [x] Create learning report (this document)
- [ ] **Future:** Remove hardcoded project ID from forge.md:430
- [ ] **Future:** Scan for executor mapping instructions
- [ ] **Future:** Regular "automation removal" audits

---

## 🔄 Pattern for Future Application

**When you hear:**
- "This used to require manual X, now it's automatic"
- "We handle this automatically in the background"
- "No need to configure Y anymore"

**Then you do:**
1. Search codebase for instructions mentioning X or Y
2. Verify automation exists in implementation
3. Remove instructions (don't replace with automation notes)
4. Document removal in learning report
5. Update Amendment #4 example if significant

---

## 💡 Key Insight

**Before this amendment:**
- We would document: "Base branch is now automatic via Forge MCP"
- Agents would read and remember: "base branch is automatic"
- Cognitive load: Still thinking about base branch

**After this amendment:**
- We remove all base branch mentions
- Agents never encounter the concept
- Cognitive load: Zero thoughts about base branch

**The absence of documentation IS the documentation.**

---

## 📈 Success Metrics

### Immediate Impact
- **4 files cleaned** of base branch instructions
- **21+ tokens removed** from instruction set
- **4 cognitive steps eliminated** per task creation

### Long-term Impact
- Established pattern for future automation removals
- Framework for continuous self-simplification
- Behavioral trigger: "automatic" → search & remove

### Validation
```bash
# Verify base branch removed from active instructions
grep -r "base.?branch" .genie/code --include="*.md" | \
  grep -v "reports" | grep -v "wishes" | wc -l
# Result: Only conceptual mentions remain (forge.md explaining isolation)
```

---

## 🔮 Future Automation Candidates

Based on forge-executor.ts analysis:

1. **Project creation/discovery** - Already automatic, remove hardcoded IDs
2. **Executor profile mapping** - Already automatic, verify no manual instructions
3. **Session title formatting** - Already automatic ("Genie: {agent} ({mode})")
4. **Git branch detection** - Already automatic (base_branch sync)
5. **Config path resolution** - Check if agents manually specify config paths

**Next audit:** Q1 2025 or after next major Forge MCP update

---

**Amendment Status:** ✅ ACTIVE - Ready for enforcement and pattern replication
**Report Author:** Genie (Base conversation orchestrator)
**Teaching Method:** Concrete example (base branch) + pattern extraction
**Enforcement:** Behavioral trigger scanning for "automatic" keywords
