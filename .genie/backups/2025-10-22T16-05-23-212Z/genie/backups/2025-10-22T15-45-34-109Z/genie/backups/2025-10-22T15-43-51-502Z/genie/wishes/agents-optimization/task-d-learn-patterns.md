# Task D: Extract Learn Patterns
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Group:** D
**Target:** `.genie/agents/genie/agents/learn/learn.md`
**Lines to extract:** AGENTS.md 1260-1279

---

## [Discovery] Context & Analysis

**What to extract:**
- Meta-Learn & Behavioral Corrections (lines 1260-1279)

**Current state:**
- AGENTS.md: ~1857 lines (after Task C)
- Target section contains meta-learning patterns
- learn.md exists at `.genie/agents/genie/agents/learn/learn.md`

**Dependencies:**
- Requires Task C complete
- Sequential execution (run fourth)

---

## [Implementation] Extraction Steps

1. **Read target sections from AGENTS.md:**
   - Lines 1260-1279: Meta-Learn & Behavioral Corrections

2. **Append to learn.md:**
   - Create "## Meta-Learning Protocol" section
   - Insert extracted content (preserve when/how/anti-patterns)
   - Add cross-references to AGENTS.md updates

3. **Replace in AGENTS.md:**
   - Remove lines 1260-1279
   - Insert @ reference: `@.genie/code/agents/learn.md (meta-learning)`
   - Keep surrounding sections intact

4. **Validation:**
   - Verify learn.md contains all patterns
   - Verify AGENTS.md has @ reference
   - Check line count reduction

---

## [Verification] Success Criteria

**Pattern preservation:**
```bash
# Meta-learning section
grep -q "Meta-Learn" .genie/agents/genie/agents/learn/learn.md && echo "✅ Meta-learning preserved"

# When to use
grep -q "When to Use" .genie/agents/genie/agents/learn/learn.md && echo "✅ Usage patterns preserved"

# Done Report path
grep -q "done-learn-" .genie/agents/genie/agents/learn/learn.md && echo "✅ Evidence protocol preserved"
```

**AGENTS.md update:**
```bash
# @ reference added
grep -q "@.genie/code/agents/learn.md" AGENTS.md && echo "✅ Reference added"

# Old content removed
! grep -q "Meta-Learn & Behavioral Corrections" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~19 lines
wc -l AGENTS.md
# Should be ~1838 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-d-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/agents/genie/agents/learn/learn.md`
