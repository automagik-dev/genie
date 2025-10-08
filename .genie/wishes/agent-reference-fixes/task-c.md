# Task C: Create Missing Wrapper

@.genie/wishes/agent-reference-fixes/agent-reference-fixes-wish.md

## Discovery
**Context:** `explore.md` mode exists in `.genie/agents/core/modes/explore.md` but has no wrapper in `.claude/agents/`, making it orchestrator-only. Creating a wrapper makes it Task-delegatable.

**Current State:**
```
.genie/agents/core/modes/explore.md EXISTS (2.9K)
.claude/agents/explore.md MISSING
```

**Target State:**
```
.claude/agents/explore.md CREATED
Points to: @.genie/agents/core/modes/explore.md
explore becomes Task-delegatable
```

**Why:** explore is a valid mode that should be accessible via Task tool, not just orchestrator.

## Implementation
**Step 1:** Verify target exists
```bash
ls -lh .genie/agents/core/modes/explore.md
# Expected: File exists, ~2.9K
```

**Step 2:** Create wrapper file
```yaml
---
name: explore
description: Discovery-focused exploratory reasoning without adversarial pressure
model: inherit
---

@.genie/agents/core/modes/explore.md
```

**Step 3:** Verify wrapper resolves
```bash
# Check file created
test -f .claude/agents/explore.md && echo "PASS: wrapper created"

# Check target resolves
target=$(grep "^@.genie/agents/" .claude/agents/explore.md | head -1)
target=${target#@}
test -f "$target" && echo "PASS: target resolves"
```

## Verification
**Validation Command:**
```bash
# Verify wrapper exists and resolves
wrapper=".claude/agents/explore.md"
if [ -f "$wrapper" ]; then
  echo "✅ Wrapper exists"
  ref=$(grep "^@.genie/agents/" "$wrapper" | head -1)
  target=${ref#@}
  if [ -f "$target" ]; then
    echo "✅ Target resolves: $target"
  else
    echo "❌ Target broken: $target"
  fi
else
  echo "❌ Wrapper missing"
fi
```

**Expected Output:**
```
✅ Wrapper exists
✅ Target resolves: .genie/agents/core/modes/explore.md
```

**Evidence Checklist:**
- [ ] explore.md wrapper created
- [ ] Wrapper points to correct path
- [ ] Target file exists and is readable
- [ ] Wrapper follows standard format (frontmatter + @include)

**Artefact Storage:**
- Wrapper contents: `qa/group-c/explore-wrapper.md`
- Validation output: `qa/group-c/validation.log`
- Git diff: `qa/group-c/wrapper-creation.diff`

**Success Criteria:**
- ✅ explore.md wrapper created
- ✅ Reference resolves to valid file
- ✅ Wrapper format consistent with others
- ✅ Evidence captured in `qa/group-c/`

**Estimated Effort:** 3 minutes
**Risk Level:** Low (creating new wrapper file)
**Rollback:** Delete .claude/agents/explore.md
