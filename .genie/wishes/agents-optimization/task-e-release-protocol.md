# Task E: Extract Release Protocol
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Group:** E
**Target:** `.genie/agents/genie/agents/release/release.md`
**Lines to extract:** AGENTS.md 1361-1402

---

## [Discovery] Context & Analysis

**What to extract:**
- Publishing Protocol (lines 1361-1402)

**Current state:**
- AGENTS.md: ~1838 lines (after Task D)
- Target section contains release/publishing protocol
- release.md exists at `.genie/agents/genie/agents/release/release.md`

**Dependencies:**
- Requires Task D complete
- Sequential execution (run fifth)

---

## [Implementation] Extraction Steps

1. **Read target sections from AGENTS.md:**
   - Lines 1361-1402: Publishing Protocol (CRITICAL)

2. **Append to release.md:**
   - Create "## Publishing Protocol" section
   - Insert extracted content (preserve all forbidden/required patterns)
   - Emphasize CRITICAL nature of delegation

3. **Replace in AGENTS.md:**
   - Remove lines 1361-1402
   - Insert @ reference: `@.genie/code/agents/release.md (publishing protocol - CRITICAL)`
   - Keep surrounding behavioral overrides

4. **Validation:**
   - Verify release.md contains all patterns
   - Verify AGENTS.md has @ reference
   - Check line count reduction

---

## [Verification] Success Criteria

**Pattern preservation:**
```bash
# Publishing Protocol
grep -q "Publishing Protocol" .genie/agents/genie/agents/release/release.md && echo "✅ Publishing protocol preserved"

# Forbidden actions
grep -q "npm publish.*bypasses" .genie/agents/genie/agents/release/release.md && echo "✅ Forbidden actions preserved"

# Required workflow
grep -q "Required workflow" .genie/agents/genie/agents/release/release.md && echo "✅ Required workflow preserved"

# Recent violations
grep -q "Recent violation" .genie/agents/genie/agents/release/release.md && echo "✅ Evidence preserved"
```

**AGENTS.md update:**
```bash
# @ reference added (must include "CRITICAL")
grep -q "`@.genie/code/agents/release.md`*CRITICAL" AGENTS.md && echo "✅ Reference added"

# Old content removed
! grep -q "Publishing Protocol.*CRITICAL" AGENTS.md && echo "✅ Content removed"
```

**Line count:**
```bash
# Expected reduction: ~41 lines
wc -l AGENTS.md
# Should be ~1797 lines after this extraction
```

---

## Evidence Location

**Done Report:** `.genie/wishes/agents-optimization/reports/done-implementor-task-e-<timestamp>.md`
**Diff:** `git diff AGENTS.md .genie/agents/genie/agents/release/release.md`
