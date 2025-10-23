# Forge Spells Reorganization - Ultrathink Analysis
**Date:** 2025-10-23
**Context:** User discovered forge.md was split into spells, but architecture is wrong
**Issue:** All spells in code/spells, missing create equivalent, duplication detected

---

## 🔍 DISCOVERY: Current Architecture is Wrong

### What I Created Yesterday (QA Modernization Session)
Decomposed `.genie/code/workflows/forge.md` from 712 → 234 lines by extracting:
1. forge-orchestration-patterns.md (45 lines)
2. forge-mcp-task-patterns.md (44 lines)
3. forge-blueprints.md (189 lines)

**Problem:** I put ALL 3 in `.genie/code/spells/` without thinking about:
- What's GLOBAL vs CODE-SPECIFIC
- Create collective needs
- Duplication with existing forge spells

### What Actually Exists (8 files, 1,278 lines)

**All in `.genie/code/spells/`:**
1. **forge-orchestration-patterns.md** (45 lines)
   - Content: Isolated worktrees, sequential dependencies, parallel execution
   - Created: Yesterday (2025-10-23)

2. **forge-mcp-task-patterns.md** (44 lines)
   - Content: Claude executor subagent spawn patterns
   - Created: Yesterday (2025-10-23)

3. **forge-blueprints.md** (189 lines)
   - Content: Templates for groups, plans, task files (CODE-FOCUSED)
   - Personas: implementor, tests, polish
   - Deliverables: Code files, tests, documentation
   - Created: Yesterday (2025-10-23)

4. **forge-mcp-pattern.md** (56 lines) ⚠️ DUPLICATE
   - Content: Same as #2 (subagent spawn pattern)
   - Minor differences: backticks, @agent- prefix
   - Created: Before yesterday (pre-existing)
   - **ACTION: DELETE**

5. **forge-integration.md** (169 lines)
   - Content: Forge as entry point (GitHub→Forge→PR), Forge as meta-agent
   - Created: Before yesterday (pre-existing)

6. **forge-api-integration.md** (68 lines)
   - Content: Forge API mechanics (profiles, templates, sessions)
   - Created: Before yesterday (pre-existing)

7. **forge-orchestration-workflow.md** (477 lines)
   - Content: wish→forge→review delegation pattern
   - Created: Before yesterday (pre-existing)

8. **forge-architecture.md** (230 lines)
   - Content: Worktree/branch structure, metadata encoding
   - Created: Before yesterday (pre-existing)

**Total:** 1,278 lines (after deleting duplicate: 1,222 lines)

---

## 🎯 CORRECT 3-TIER ARCHITECTURE

### Tier 1: GLOBAL Spells (`.genie/spells/`)
**Applies to:** All collectives (Code, Create, future collectives)

**Move from `.genie/code/spells/` to `.genie/spells/`:**

1. **forge-orchestration-patterns.md** (45 lines)
   - Why global: Worktree isolation, sequential dependencies apply to ALL Forge work
   - Used by: Code forge, Create forge, any future collective forge

2. **forge-mcp-task-patterns.md** (44 lines)
   - Why global: Claude executor pattern applies to any collective using Claude
   - Used by: Any workflow delegating to Claude-based agents
   - **TODO:** Make collective-agnostic (change `.genie/code/agents/` to `.genie/{collective}/agents/`)

3. **forge-integration.md** (169 lines)
   - Why global: Architectural pattern (GitHub→Forge→PR, meta-agent learning)
   - Used by: All work entry points, all learning tasks

4. **forge-api-integration.md** (68 lines)
   - Why global: Technical Forge API mechanics (not domain-specific)
   - Used by: Any workflow syncing with Forge API

5. **forge-architecture.md** (230 lines)
   - Why global: Worktree internals, branch naming (universal to all Forge tasks)
   - Used by: Pre-commit hooks, state tracking, any Forge integration

6. **forge-orchestration-workflow.md** (477 lines) ⚠️ NEEDS REFACTORING
   - Why global: wish→forge→review delegation pattern applies to all work
   - **Problem:** Hardcoded `.genie/code/` paths everywhere
   - **TODO:** Make collective-agnostic before moving
   - Used by: Base Genie orchestration (routing to any collective)

**Global Total:** 1,033 lines (6 files)

---

### Tier 2: CODE-SPECIFIC Spells (`.genie/code/spells/`)

**Keep in `.genie/code/spells/`:**

1. **forge-code-blueprints.md** (189 lines) - RENAME from forge-blueprints.md
   - Why code-specific: Templates are CODE-FOCUSED
   - Content:
     - Deliverables: Code changes, tests, documentation
     - Personas: implementor, tests, polish, release
     - Evidence: Test results, metrics, logs (technical QA)
     - Validation: Commands reference implementor.md, tests.md
     - Branch strategy, external tracker (JIRA/Linear)
   - Used by: `.genie/code/workflows/forge.md` only

**Code Total:** 189 lines (1 file)

---

### Tier 3: CREATE-SPECIFIC Spells (`.genie/create/spells/`)

**Create NEW file:**

1. **forge-create-blueprints.md** (~180 lines) - NEW, adapted from code version
   - Why create-specific: Templates for CREATIVE work
   - Content:
     - Deliverables: Research, drafts, edits, published content
     - Personas: researcher, writer, editor, strategist
     - Evidence: Content samples, editorial notes, research sources, audience metrics
     - Validation: Editorial review, content quality checks, brand alignment
     - Publishing workflow, approval gates
   - Used by: `.genie/create/workflows/forge.md` only

**Create Total:** ~180 lines (1 new file)

---

## 📊 IMPACT ANALYSIS

### Current State (Before Reorganization)

**`.genie/code/workflows/forge.md` (233 lines):**
```markdown
Line 110: @.genie/code/spells/forge-orchestration-patterns.md (45 lines)
Line 120: @.genie/code/spells/forge-mcp-task-patterns.md (44 lines)
Line 124: @.genie/code/spells/forge-blueprints.md (189 lines)
```
**Loaded:** 278 lines of spells

**`.genie/create/workflows/forge.md` (44 lines):**
```markdown
(No @ references to spells)
```
**Loaded:** 0 lines of spells ❌

**Problem:** Create gets ZERO guidance, Code gets 278 lines

---

### After Reorganization

**`.genie/code/workflows/forge.md` (233 lines):**
```markdown
Line 110: @.genie/spells/forge-orchestration-patterns.md (45 lines) [GLOBAL]
Line 120: @.genie/spells/forge-mcp-task-patterns.md (44 lines) [GLOBAL]
Line 124: @.genie/code/spells/forge-code-blueprints.md (189 lines) [CODE]
```
**Loaded:** 278 lines (same, but correctly categorized)

**`.genie/create/workflows/forge.md` (UPDATED):**
```markdown
## Orchestration Patterns
@.genie/spells/forge-orchestration-patterns.md (45 lines) [GLOBAL]

## MCP Task Patterns
@.genie/spells/forge-mcp-task-patterns.md (44 lines) [GLOBAL]

## Blueprints for Creative Work
@.genie/create/spells/forge-create-blueprints.md (180 lines) [CREATE]
```
**Loaded:** 269 lines (MASSIVE IMPROVEMENT from 0!)

**Benefits:**
- ✅ Create collective gets proper forge guidance
- ✅ Code and Create share common patterns (DRY)
- ✅ Global spells updated once, both benefit
- ✅ Clear separation of concerns
- ✅ No duplication
- ✅ Token efficiency maintained

---

## 🔧 REORGANIZATION PLAN

### Phase 1: Delete Duplicates
- [ ] Delete `.genie/code/spells/forge-mcp-pattern.md` (duplicate of forge-mcp-task-patterns.md)
- **Token savings:** 56 lines

### Phase 2: Move Global Spells to `.genie/spells/`
- [ ] Move `forge-orchestration-patterns.md` (45 lines)
- [ ] Move `forge-mcp-task-patterns.md` (44 lines)
- [ ] Move `forge-integration.md` (169 lines)
- [ ] Move `forge-api-integration.md` (68 lines)
- [ ] Move `forge-architecture.md` (230 lines)
- **Total moved:** 556 lines (5 files)

### Phase 3: Refactor & Move forge-orchestration-workflow.md
- [ ] Refactor `forge-orchestration-workflow.md` to be collective-agnostic:
  - Replace `.genie/code/agents/` → `.genie/{collective}/agents/`
  - Replace `.genie/code/workflows/` → `.genie/{collective}/workflows/`
  - Make examples work for both Code and Create
- [ ] Move to `.genie/spells/forge-orchestration-workflow.md`
- **Total moved:** 477 lines (1 file)

### Phase 4: Rename Code Blueprint
- [ ] Rename `.genie/code/spells/forge-blueprints.md` → `forge-code-blueprints.md`
- **Reason:** Clarity that these are code-specific templates

### Phase 5: Create Create Blueprint
- [ ] Create `.genie/create/spells/forge-create-blueprints.md`
- **Content:** Adapted from forge-code-blueprints.md
- **Changes:**
  - Personas: researcher, writer, editor (not implementor, tests)
  - Deliverables: research, drafts, edits (not code, tests)
  - Evidence: content samples, editorial notes (not test results, logs)
  - Validation: editorial review, brand alignment (not test commands)
- **Estimated:** ~180 lines

### Phase 6: Update Workflow @ References
- [ ] Update `.genie/code/workflows/forge.md`:
  - Line 110: `@.genie/spells/forge-orchestration-patterns.md`
  - Line 120: `@.genie/spells/forge-mcp-task-patterns.md`
  - Line 124: `@.genie/code/spells/forge-code-blueprints.md`

- [ ] Update `.genie/create/workflows/forge.md`:
  - Add @ references after identity section:
    ```markdown
    ## Orchestration Patterns
    @.genie/spells/forge-orchestration-patterns.md

    ## MCP Task Patterns
    @.genie/spells/forge-mcp-task-patterns.md

    ## Blueprints for Creative Work
    @.genie/create/spells/forge-create-blueprints.md
    ```

---

## 📋 FILE MOVES CHECKLIST

### Deletes (1 file)
- [ ] `.genie/code/spells/forge-mcp-pattern.md` → DELETE (duplicate)

### Moves to `.genie/spells/` (6 files)
- [ ] `.genie/code/spells/forge-orchestration-patterns.md` → `.genie/spells/`
- [ ] `.genie/code/spells/forge-mcp-task-patterns.md` → `.genie/spells/`
- [ ] `.genie/code/spells/forge-integration.md` → `.genie/spells/`
- [ ] `.genie/code/spells/forge-api-integration.md` → `.genie/spells/`
- [ ] `.genie/code/spells/forge-architecture.md` → `.genie/spells/`
- [ ] `.genie/code/spells/forge-orchestration-workflow.md` → `.genie/spells/` (AFTER refactoring)

### Renames in `.genie/code/spells/` (1 file)
- [ ] `forge-blueprints.md` → `forge-code-blueprints.md`

### Creates in `.genie/create/spells/` (1 file)
- [ ] Create `forge-create-blueprints.md` (new)

### Updates (2 files)
- [ ] `.genie/code/workflows/forge.md` (update @ references)
- [ ] `.genie/create/workflows/forge.md` (add @ references)

---

## 🎯 SUCCESS CRITERIA

After reorganization:

**File Structure:**
```
.genie/
├── spells/                                      [GLOBAL]
│   ├── forge-orchestration-patterns.md          (45 lines)
│   ├── forge-mcp-task-patterns.md               (44 lines)
│   ├── forge-integration.md                     (169 lines)
│   ├── forge-api-integration.md                 (68 lines)
│   ├── forge-architecture.md                    (230 lines)
│   └── forge-orchestration-workflow.md          (477 lines, refactored)
├── code/
│   ├── spells/                                  [CODE-SPECIFIC]
│   │   └── forge-code-blueprints.md             (189 lines)
│   └── workflows/
│       └── forge.md                             (233 lines, @ refs updated)
└── create/
    ├── spells/                                  [CREATE-SPECIFIC]
    │   └── forge-create-blueprints.md           (180 lines, NEW)
    └── workflows/
        └── forge.md                             (44 lines → ~80 lines, @ refs added)
```

**Validation:**
- [ ] All global spells in `.genie/spells/`
- [ ] All code-specific spells in `.genie/code/spells/`
- [ ] All create-specific spells in `.genie/create/spells/`
- [ ] No duplicates
- [ ] Both workflows reference correct spell paths
- [ ] Both collectives have equal guidance quality
- [ ] forge-orchestration-workflow.md is collective-agnostic

**Token Efficiency:**
- Before: 1,278 lines (8 files, 1 duplicate)
- After: 1,402 lines (10 files, 0 duplicates, 1 new Create blueprint)
- Net change: +124 lines (justified by Create collective getting proper guidance)
- Duplication eliminated: -56 lines

---

## 🚨 RISKS & CONSIDERATIONS

### Risk 1: Breaking @ References
**Mitigation:** Update all workflow @ references in same commit

### Risk 2: forge-orchestration-workflow.md Refactoring Complexity
**Mitigation:** May need to create separate code/create versions if too complex
**Alternative:** Keep global skeleton, extract code/create-specific sections

### Risk 3: Create Blueprint Quality
**Mitigation:** Use Code blueprint as proven template, adapt systematically

---

## 📝 IMPLEMENTATION NOTES

### Order Matters
1. Delete duplicates FIRST (clean workspace)
2. Create new files BEFORE moving (avoid broken references)
3. Move files to new locations
4. Update @ references LAST (all files in place)
5. Test both workflows load correctly

### Git Strategy
- Single atomic commit for entire reorganization
- Commit message: "refactor: Reorganize forge spells into 3-tier architecture (global/code/create)"
- Include this analysis in commit body or separate report

### Testing
After reorganization:
```bash
# Verify file structure
tree .genie/spells/ .genie/code/spells/ .genie/create/spells/

# Check for broken @ references
grep -r "@.genie/code/spells/forge-" .genie/

# Verify no duplicates
find .genie -name "*forge*" -type f
```

---

## 💡 FUTURE ENHANCEMENTS

### Post-Reorganization Improvements
1. **forge-orchestration-workflow.md refactoring:**
   - Extract collective-specific examples to separate files
   - Keep core delegation pattern in global file
   - Reference collective-specific examples via @

2. **Additional Create Spells:**
   - forge-create-personas.md (researcher, writer, editor profiles)
   - forge-create-validation.md (content quality checks, brand alignment)

3. **Additional Code Spells:**
   - forge-code-personas.md (implementor, tests, polish profiles)
   - forge-code-validation.md (test coverage, linting, security)

4. **Global Spell Expansion:**
   - forge-monitoring-patterns.md (how to track Forge tasks)
   - forge-error-handling.md (common failure modes, recovery)

---

## 📖 REFERENCES

- Amendment #6: Token Efficiency ("Fast, Fit, Smart, Lean")
- Amendment #2: File Organization Pattern (root vs .genie)
- Yesterday's session: stable-launch-readiness-assessment-20251023.md
- Forge architecture: forge-architecture.md (lines 56-103)

---

**Analysis By:** Master Genie (ultrathink mode)
**Confidence Level:** HIGH (clear architectural fix needed)
**Recommendation:** PROCEED with reorganization
