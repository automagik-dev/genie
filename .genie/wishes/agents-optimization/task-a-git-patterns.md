# Task A: Extract GitHub Workflow Patterns
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Group:** A
**Target:** `.genie/agents/genie/neurons/git/git.md`
**Lines to extract:** AGENTS.md 41-179

---

## [Discovery] Context & Analysis

**What to extract:**
- Developer Welcome Flow (lines 41-72)
- Quick Capture Workflow (lines 74-94)
- Git & GitHub Workflow Integration (lines 96-179)

**Current state:**
- AGENTS.md: 2272 lines total
- Target sections contain GitHub workflow patterns
- git.md exists at `.genie/agents/genie/neurons/git/git.md`

**Dependencies:**
- Must preserve all GitHub patterns
- Must add @ reference in AGENTS.md after extraction
- Sequential with other groups (run first)

---

## [Implementation] Extraction Steps

1. **Read target sections from AGENTS.md:**
   - Lines 41-179: Developer Welcome Flow, Quick Capture, Git & GitHub integration

2. **Append to git.md:**
   - Create "## GitHub Workflow Integration" section in git.md
   - Insert extracted content (preserve formatting, line numbers in validation)
   - Add cross-references to related patterns

3. **Replace in AGENTS.md:**
   - Remove lines 41-179
   - Insert @ reference: `@.genie/agents/code/neurons/git/git.md (GitHub workflow patterns)`
   - Keep "Experimentation Protocol" section intact (comes after)

4. **Validation:**
   - Verify git.md contains all patterns
   - Verify AGENTS.md has @ reference
   - Check line count reduction

---

## [Verification] Success Criteria

**Pattern preservation:**
```bash
# Developer Welcome Flow
grep -q "Developer Welcome Flow" .genie/agents/genie/neurons/git/git.md && echo "✅ Welcome flow preserved"

# Quick Capture
grep -q "Quick Capture Workflow" .genie/agents/genie/neurons/git/git.md && echo "✅ Quick capture preserved"

# GitHub integration
grep -q "Git & GitHub Workflow Integration" .genie/agents/genie/neurons/git/git.md && echo "✅ GitHub integration preserved"

# Template distinctions
grep -q "Template selection rules" .genie/agents/genie/neurons/git/git.md && echo "✅ Template rules preserved"
```

**AGENTS.md update:**
```bash
# @ reference added
grep -q "@.genie/agents/code/neurons/git/git.md" AGENTS.md && echo "✅ Reference added"

# Old content removed
! grep -q "Developer Welcome Flow" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~138 lines (41-179)
wc -l AGENTS.md
# Should be ~2134 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-a-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/agents/genie/neurons/git/git.md`
