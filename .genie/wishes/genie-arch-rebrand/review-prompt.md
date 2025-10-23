# Review Prompt: Genie Architecture Rebranding (Post-MCP Restart)
**Created:** 2025-10-17
**Commit:** d63d397
**Purpose:** Validate completed work against reality with updated MCP server

---

## 🎯 Orchestration Rule: Reality Validation Protocol

Before approving this wish as complete, perform deep reality-check analysis:

### Analysis Framework

1. **Compare stated goals vs actual implementation**
   - Check if implementation matches Groups A, B, C objectives
   - Verify claimed benefits exist in reality
   - Identify any gaps between plan and implementation

2. **Identify overlooked requirements or edge cases**
   - Test agent resolution with all agent types
   - Check for broken @ references
   - Verify display transformation handles all paths
   - Test template-specific vs universal resolution

3. **Validate all claimed benefits with evidence**
   - Token savings: confirm ~528 lines removed from AGENTS.md
   - Display transformation: verify clean names in MCP output
   - Folder structure: check alignment with architecture
   - No regression: test existing features still work

4. **Check against validation files**
   - Compare @ references against `.genie/qa/template-extraction/grep-at-references.txt`
   - Verify perfect distribution in `.genie/` structure
   - Ensure AGENTS.md is lightweight

---

## 📊 Completed Work Summary

**Commit:** d63d397
**Date:** 2025-10-17
**Stats:** 175 files changed, 1,716 insertions(+), 27,272 deletions(-) = **-25,556 lines net**

### Group A: Folder Reorganization

**Objective:** Reorganize agents from `.genie/agents/genie/*` to flat structure

**Implementation:**
- Created `.genie/agents/{code,create,agents,workflows}/` structure
- Moved template-specific agents to `code/` and `create/` directories
- Moved universal agents to `agents/` directory (17 agents)
- Deleted 150+ obsolete template files

**Files modified:** ~155 files (moves + deletions)

### Group B: Spells Extraction (Token Optimization)

**Objective:** Extract inline protocol content from AGENTS.md into spell files

**Implementation:**
- Created 7 behavioral protocol spell files in `.genie/agents/code/spells/`:
  1. `evidence-based-thinking.md`
  2. `publishing-protocol.md`
  3. `delegation-discipline.md`
  4. `role-clarity-protocol.md`
  5. `execution-integrity-protocol.md`
  6. `triad-maintenance-protocol.md`
  7. `persistent-tracking-protocol.md`

- Updated `code.md` with @ references block
- Updated `AGENTS.md`: replaced 7 inline sections with @ references
- **Token savings:** ~528 lines removed from AGENTS.md

**Files modified:** 9 files (7 new spell files + 2 updates)

### Group C: Display Transformation

**Objective:** Strip template/category folders from agent display names

**Implementation:**
- Implemented `transformDisplayPath()` function with logic:
  - Template folders (`code/`, `create/`): Strip entirely
  - Category folders (`agents/`, `workflows/`): Strip for top-level, preserve for children
  - Parent agents (e.g., `agents/git/git.md`): Display as `git`
  - Child workflows (e.g., `agents/git/issue.md`): Display as `git/issue`

- Applied transformation in 3 locations:
  1. `.genie/cli/src/lib/agent-resolver.ts` - Added function and integration
  2. `.genie/cli/src/cli-core/handlers/shared.ts` - Added function and integration
  3. `.genie/mcp/src/server.ts` - Added function and integration

- Extended `ListedAgent` interface with `displayId` field in 3 files

**Files modified:** 4 files (3 implementations + 1 interface update in list.ts)

**Examples:**
- `code/implementor` → `implementor`
- `agents/git/git` → `git`
- `agents/git/issue` → `git/issue`
- `agents/plan` → `plan`

---

## ✅ Validation Checklist

### AGENTS.md Lightweight Validation

- [ ] **Pre-work baseline:** Read AGENTS.md and count total lines
- [ ] **Token savings verification:** Confirm ~528 lines removed (7 protocol sections)
- [ ] **@ references intact:** All 7 spell @ references present and correct
  ```bash
  grep "@.genie/code/spells/" AGENTS.md | wc -l
  # Expected: 7 references
  ```
- [ ] **No content duplication:** Verify inline content removed, only @ references remain
- [ ] **Headers preserved:** Check section headers with markers (*(CRITICAL)*, etc.) still present

### Perfect Distribution in .genie/

- [ ] **Folder structure matches plan:**
  ```bash
  tree .genie/agents/ -L 2
  # Expected:
  # .genie/agents/
  # ├── code/
  # │   ├── code.md
  # │   ├── spells/ (7 files)
  # │   └── agents/
  # ├── create/
  # │   ├── create.md
  # │   ├── spells/
  # │   └── agents/
  # ├── agents/ (17 universal agents)
  # └── workflows/
  ```

- [ ] **Spell files exist:**
  ```bash
  ls .genie/agents/code/spells/*.md | wc -l
  # Expected: 7 files
  ```

- [ ] **No orphaned files:** Check for files in wrong locations

- [ ] **@ references validation:**
  ```bash
  # Compare current @ usage against baseline
  grep -r "@.genie/" .genie/ | grep -v ".git" | wc -l
  # Compare with: .genie/qa/template-extraction/grep-at-references.txt
  ```

### Display Transformation Validation (POST-RESTART ONLY)

**⚠️ CRITICAL: These checks only work AFTER Claude Desktop restart (MCP server reload)**

- [ ] **MCP server restarted:** Restart Claude Desktop to load updated code

- [ ] **Clean display names:**
  ```
  mcp__genie__list_agents
  ```

  **Expected output (verify each):**
  - ✅ `implementor` (NOT `code/implementor`)
  - ✅ `git` (NOT `agents/git/git` or `code/agents/git/git`)
  - ✅ `git/issue` (NOT `agents/git/issue`)
  - ✅ `git/pr` (NOT `agents/git/pr`)
  - ✅ `git/report` (NOT `agents/git/report`)
  - ✅ `plan` (NOT `agents/plan` or `workflows/plan`)
  - ✅ `tests` (NOT `code/tests`)
  - ✅ `polish` (NOT `agents/polish`)

- [ ] **Folder grouping intact:** Verify agents still grouped by folder in output

- [ ] **Agent invocation works:**
  ```
  mcp__genie__run with agent="implementor" and prompt="Test invocation"
  # Should start successfully with clean name
  ```

### TypeScript Compilation

- [ ] **Zero compilation errors:**
  ```bash
  cd .genie/cli && pnpm run build
  # Expected: No errors

  cd .genie/mcp && pnpm run build
  # Expected: No errors
  ```

- [ ] **Verify dist files contain new code:**
  ```bash
  grep "transformDisplayPath" .genie/cli/dist/**/*.js
  grep "transformDisplayPath" .genie/mcp/dist/server.js
  # Both should return matches
  ```

---

## 🔍 Reality Check Questions

**Architecture Alignment:**
1. Does the folder structure reflect the actual delegation hierarchy?
2. Are universal vs template-specific agents correctly classified?
3. Can you trace the path from agent invocation → resolution → display?

**Token Efficiency:**
1. What is the actual line count reduction in AGENTS.md?
2. Are there any remaining duplications we missed?
3. Do the spell files contain complete protocol content?

**Display Logic:**
1. Does `transformDisplayPath()` handle ALL possible agent paths?
2. Are there edge cases we didn't test?
3. Does the fallback logic work for legacy paths?

**Functionality:**
1. Can all 17+ universal agents be invoked?
2. Do template-specific overrides work correctly?
3. Are there any broken @ references?

**Missing Work:**
1. What aspects of the wish are NOT yet complete?
2. Are there follow-up tasks not documented?
3. Did we overlook any requirements from the original wish?

---

## 🧪 Test Scenarios (Post-Restart)

### Scenario 1: Universal Agent Resolution
```
mcp__genie__run with agent="plan" and prompt="Test universal agent"
# Expected: Starts successfully, display shows "plan"
```

### Scenario 2: Template-Specific Agent Resolution
```
mcp__genie__run with agent="implementor" and prompt="Test code agent"
# Expected: Starts successfully, display shows "implementor"
```

### Scenario 3: Parent-Child Workflow
```
mcp__genie__run with agent="git" and prompt="Test parent agent"
# Expected: Starts successfully, display shows "git"

# Then from git agent context, delegate to child:
mcp__genie__run with agent="git/issue" and prompt="Test child workflow"
# Expected: Starts successfully, display shows "git/issue"
```

### Scenario 4: Spells @ Reference Loading
```
# Read any spell file path shown in AGENTS.md
Read with file_path="<spell-file-path-from-`@`-reference>"
# Expected: File exists and contains complete protocol content
```

### Scenario 5: Legacy Path Handling
```
# If any legacy paths still exist (agents/genie/spells/*)
mcp__genie__run with agent="<legacy-path>" and prompt="Test backward compatibility"
# Expected: Either works with fallback, or clear error message
```

---

## 📂 Reference Files

**Validation baseline:**
- `.genie/qa/template-extraction/grep-at-references.txt` - @ reference patterns before this work
- `.genie/qa/template-extraction/before-after-line-counts.txt` - Line counts before optimization

**Completed work documentation:**
- `.genie/STATE.md` - Current session state
- `.genie/TODO.md` - Task #10 entry with full details
- Commit message: d63d397

**Wish specification:**
- `.genie/wishes/genie-arch-rebrand/genie-arch-rebrand-wish.md`

---

## 🎬 Next Actions

1. **Restart Claude Desktop** to reload MCP server with new code
2. **Run validation checklist** above (especially post-restart checks)
3. **Document findings** in new Done Report:
   - What works correctly?
   - What doesn't match expectations?
   - What's missing from original wish?
4. **Update wish status** based on validation results
5. **Create follow-up tasks** for any missing work

---

## 🧠 Review Agent Guidance

**When conducting this review:**

**Use evidence-based thinking:**
- Read actual files, don't assume
- Run commands, verify outputs
- Compare claims against reality
- Document discrepancies

**Check for say-do gaps:**
- Does documentation match implementation?
- Are all claimed features actually present?
- Do outputs match expected patterns?

**Look for overlooked details:**
- Edge cases in transformation logic
- Broken @ references
- Missing validations
- Regression in existing features

**Final verdict format:**
```markdown
## Review Verdict

**Overall Status:** [COMPLETE | INCOMPLETE | NEEDS REFINEMENT]
**Confidence:** [LOW | MEDIUM | HIGH]

**What worked:**
- [List verified successes]

**What's missing:**
- [List gaps between wish and implementation]

**Follow-up tasks:**
- [List required next actions]

**Token efficiency gain:** [Actual line count reduction]
**Display transformation:** [Working | Needs fixes]
**@ references:** [All valid | Some broken]
```

---

**Review complete when:**
✅ All validation checkboxes marked
✅ All test scenarios pass
✅ Reality check questions answered with evidence
✅ Review verdict documented
✅ Follow-up tasks identified (if any)
