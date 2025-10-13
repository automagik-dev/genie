# Task A: Fix Wrapper Paths

@.genie/wishes/agent-reference-fixes/agent-reference-fixes-wish.md

## Discovery
**Context:** Three wrapper files in `.claude/agents/` point to incorrect paths. The actual agent files exist in `core/` but wrappers expect them in `modes/` or other locations.

**Current State:**
```
.claude/agents/analyze.md → @.genie/agents/core/modes/analyze.md (BROKEN)
.claude/agents/refactor.md → @.genie/agents/core/modes/refactor.md (BROKEN)
.claude/agents/secaudit.md → @.genie/agents/core/modes/secaudit.md (BROKEN)
```

**Target State:**
```
.claude/agents/analyze.md → @.genie/agents/core/analyze.md (VALID)
.claude/agents/refactor.md → @.genie/agents/core/refactor.md (VALID)
.claude/agents/secaudit.md → @.genie/agents/core/audit.md (VALID - security mode exists in audit)
```

**Files to Edit:**
- `.claude/agents/analyze.md`
- `.claude/agents/refactor.md`
- `.claude/agents/secaudit.md`

## Implementation
**Step 1:** Fix analyze wrapper
```bash
# Edit .claude/agents/analyze.md
# Change: @.genie/agents/core/modes/analyze.md
# To: @.genie/agents/core/analyze.md
```

**Step 2:** Fix refactor wrapper
```bash
# Edit .claude/agents/refactor.md
# Change: @.genie/agents/core/modes/refactor.md
# To: @.genie/agents/core/refactor.md
```

**Step 3:** Fix secaudit wrapper (merge to audit)
```bash
# Edit .claude/agents/secaudit.md
# Change: @.genie/agents/core/modes/secaudit.md
# To: @.genie/agents/core/audit.md
```

**Expected Diff:**
```diff
--- a/.claude/agents/analyze.md
+++ b/.claude/agents/analyze.md
-@.genie/agents/core/modes/analyze.md
+@.genie/agents/core/analyze.md

--- a/.claude/agents/refactor.md
+++ b/.claude/agents/refactor.md
-@.genie/agents/core/modes/refactor.md
+@.genie/agents/core/refactor.md

--- a/.claude/agents/secaudit.md
+++ b/.claude/agents/secaudit.md
-@.genie/agents/core/modes/secaudit.md
+@.genie/agents/core/audit.md
```

## Verification
**Validation Command:**
```bash
# Verify no broken references
for f in .claude/agents/*.md; do
  ref=$(grep "^@.genie/agents/" "$f" 2>/dev/null | head -1)
  if [ -n "$ref" ]; then
    target=${ref#@}
    if [ ! -f "$target" ]; then
      echo "BROKEN: $(basename $f) -> $ref"
    else
      echo "OK: $(basename $f)"
    fi
  fi
done
```

**Expected Output:**
```
OK: analyze.md
OK: refactor.md
OK: secaudit.md
(all other agents...)
```

**Evidence Checklist:**
- [ ] Git diff captured showing 3 wrapper path changes
- [ ] Validation script shows 0 broken references
- [ ] All 3 target files exist and are readable
- [ ] No unintended changes to other wrappers

**Artefact Storage:**
- Git diff: `qa/group-a/wrapper-fixes.diff`
- Validation output: `qa/group-a/validation.log`
- Before/after file listing: `qa/group-a/before-after.txt`

**Success Criteria:**
- ✅ All 3 wrapper paths updated
- ✅ All 3 refs resolve to valid files
- ✅ No logic changes to agent prompts
- ✅ Evidence captured in `qa/group-a/`

**Estimated Effort:** 5 minutes
**Risk Level:** Low (simple path updates)
**Rollback:** Revert 3-line Edit changes
