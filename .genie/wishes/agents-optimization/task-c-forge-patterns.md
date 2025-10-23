# Task C: Extract Forge Patterns
**Group:** C
**Target:** `.genie/agents/genie/agents/forge/forge.md`
**Lines to extract:** AGENTS.md 1209-1258

---

## [Discovery] Context & Analysis

**What to extract:**
- Forge MCP Task Pattern (lines 1209-1258)

**Current state:**
- AGENTS.md: ~1906 lines (after Task B)
- Target section contains Forge MCP task patterns
- forge.md exists at `.genie/agents/genie/agents/forge/forge.md`

**Dependencies:**
- Requires Task B complete
- Sequential execution (run third)

---

## [Implementation] Extraction Steps

1. **Read target sections from AGENTS.md:**
   - Lines 1209-1258: Forge MCP Task Pattern

2. **Append to forge.md:**
   - Create "## Forge MCP Task Pattern" section
   - Insert extracted content (preserve examples and validation)
   - Add cross-references to wish/task patterns

3. **Replace in AGENTS.md:**
   - Remove lines 1209-1258
   - Insert @ reference: `@.genie/code/agents/forge.md (forge patterns)`
   - Keep surrounding sections intact

4. **Validation:**
   - Verify forge.md contains all patterns
   - Verify AGENTS.md has @ reference
   - Check line count reduction

---

## [Verification] Success Criteria

**Pattern preservation:**
```bash
# Forge MCP pattern
grep -q "Forge MCP Task Pattern" .genie/agents/genie/agents/forge/forge.md && echo "✅ Forge pattern preserved"

# @ syntax examples
grep -q "@agent-" .genie/agents/genie/agents/forge/forge.md && echo "✅ @ syntax preserved"

# Validation section
grep -q "Critical Distinction" .genie/agents/genie/agents/forge/forge.md && echo "✅ Validation preserved"
```

**AGENTS.md update:**
```bash
# @ reference added
grep -q "@.genie/code/agents/forge.md" AGENTS.md && echo "✅ Reference added"

# Old content removed
! grep -q "Forge MCP Task Pattern" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~49 lines
wc -l AGENTS.md
# Should be ~1857 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-c-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/agents/genie/agents/forge/forge.md`
