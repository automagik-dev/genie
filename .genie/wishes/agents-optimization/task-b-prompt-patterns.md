# Task B: Extract Prompting Standards

**Group:** B
**Target:** `.genie/agents/genie/neurons/prompt/prompt.md`
**Lines to extract:** AGENTS.md 1001-1115, 1769-1882

---

## [Discovery] Context & Analysis

**What to extract:**
- @ / ! / Feature Reference (lines 1008-1115)
- Task Breakdown Structure (lines 1775-1801)
- Context Gathering Protocol (lines 1803-1828)
- Blocker Report Protocol (lines 1831-1846)
- Done Report Template (lines 1848-1882)

**Current state:**
- AGENTS.md: ~2134 lines (after Task A)
- Target sections contain prompting framework
- prompt.md exists at `.genie/agents/genie/neurons/prompt/prompt.md`

**Dependencies:**
- Requires Task A complete
- Sequential execution (run second)

---

## [Implementation] Extraction Steps

1. **Read target sections from AGENTS.md:**
   - Lines 1001-1115: @ / ! / Feature Reference
   - Lines 1769-1882: Prompting Standards Framework

2. **Append to prompt.md:**
   - Create "## Prompting Standards Framework" section
   - Insert extracted content (preserve all subsections)
   - Ensure @ / ! / patterns clearly documented

3. **Replace in AGENTS.md:**
   - Remove lines 1001-1115, 1769-1882
   - Insert @ reference: `@.genie/agents/neurons/prompt.md (prompting standards)`
   - Keep surrounding sections intact

4. **Validation:**
   - Verify prompt.md contains all patterns
   - Verify AGENTS.md has @ reference
   - Check line count reduction

---

## [Verification] Success Criteria

**Pattern preservation:**
```bash
# @ / ! / patterns
grep -q "@ / ! / Feature Reference" .genie/agents/genie/neurons/prompt/prompt.md && echo "✅ @ patterns preserved"

# Task breakdown
grep -q "Task Breakdown Structure" .genie/agents/genie/neurons/prompt/prompt.md && echo "✅ Task breakdown preserved"

# Context gathering
grep -q "Context Gathering Protocol" .genie/agents/genie/neurons/prompt/prompt.md && echo "✅ Context protocol preserved"

# Blocker reports
grep -q "Blocker Report Protocol" .genie/agents/genie/neurons/prompt/prompt.md && echo "✅ Blocker protocol preserved"
```

**AGENTS.md update:**
```bash
# @ reference added
grep -q "@.genie/agents/neurons/prompt.md" AGENTS.md && echo "✅ Reference added"

# Old content removed
! grep -q "@ / ! / Feature Reference" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~228 lines
wc -l AGENTS.md
# Should be ~1906 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-b-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/agents/genie/neurons/prompt/prompt.md`
