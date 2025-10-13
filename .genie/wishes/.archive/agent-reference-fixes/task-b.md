# Task B: Clean Up Invalid Wrapper

@.genie/wishes/agent-reference-fixes/agent-reference-fixes-wish.md

## Discovery
**Context:** `.claude/agents/thinkdeep.md` wrapper references `@.genie/agents/core/modes/thinkdeep.md` which doesn't exist. The agent was never implemented.

**Current State:**
```
.claude/agents/thinkdeep.md exists
.genie/agents/core/modes/thinkdeep.md DOES NOT EXIST
```

**Target State:**
```
.claude/agents/thinkdeep.md REMOVED
Agent count: 22 (was 23)
```

**Decision:** Remove wrapper since agent was never implemented and isn't in roadmap.

## Implementation
**Step 1:** Verify thinkdeep doesn't exist
```bash
ls -la .genie/agents/core/modes/thinkdeep.md
# Expected: No such file or directory
```

**Step 2:** Remove wrapper
```bash
rm .claude/agents/thinkdeep.md
```

**Step 3:** Verify wrapper count
```bash
ls -1 .claude/agents/*.md | wc -l
# Expected: 22 (was 23)
```

## Verification
**Validation Command:**
```bash
# Confirm thinkdeep wrapper is gone
test -f .claude/agents/thinkdeep.md && echo "FAIL: wrapper still exists" || echo "PASS: wrapper removed"

# Confirm agent file never existed
test -f .genie/agents/core/modes/thinkdeep.md && echo "UNEXPECTED: agent exists" || echo "CONFIRMED: agent never existed"

# Count wrappers
echo "Wrapper count: $(ls -1 .claude/agents/*.md | wc -l)"
```

**Expected Output:**
```
PASS: wrapper removed
CONFIRMED: agent never existed
Wrapper count: 22
```

**Evidence Checklist:**
- [ ] Confirmation that thinkdeep.md removed
- [ ] Wrapper count verified as 22
- [ ] Git log shows deletion
- [ ] No other files affected

**Artefact Storage:**
- Deletion confirmation: `qa/group-b/deletion.log`
- Wrapper count: `qa/group-b/wrapper-count.txt`
- Git status: `qa/group-b/git-status.txt`

**Success Criteria:**
- ✅ thinkdeep wrapper removed
- ✅ Wrapper count = 22
- ✅ No broken references remain
- ✅ Evidence captured in `qa/group-b/`

**Estimated Effort:** 2 minutes
**Risk Level:** Low (removing non-functional file)
**Rollback:** Restore from git history if needed
