# Task D: Update Documentation

@.genie/wishes/agent-reference-fixes/agent-reference-fixes-wish.md

## Discovery
**Context:** Documentation needs to reflect the wrapper fixes: agent count changes (22, was 23), secaudit now points to audit, explore is now Task-delegatable.

**Files to Update:**
- `.claude/README.md` - agent inventory, access patterns
- `AGENTS.md` - agent descriptions, routing matrix

**Changes Needed:**
1. Agent count: 22 (removed thinkdeep)
2. secaudit clarification: points to audit.md security mode
3. explore: now available as delegatable agent (was orchestrator-only)

## Implementation

### Step 1: Update .claude/README.md

**Section: Agent Specialization Matrix**
- Verify agent count matches reality
- Add note about explore being delegatable
- Document secaudit→audit relationship

**Section: Directory Structure**
- Confirm wrapper list accurate
- Note thinkdeep removal

### Step 2: Update AGENTS.md

**Section: Routing Decision Matrix**
- Update agent aliases if needed
- Confirm secaudit routes to audit
- Add explore to routing options

**Section: MCP Quick Reference**
- Verify all agent examples use valid names
- Update any references to removed agents

### Step 3: Verify Consistency

**Cross-check:**
```bash
# Count actual wrappers
wrapper_count=$(ls -1 .claude/agents/*.md | wc -l)

# Count documented agents
# (manual review of README and AGENTS.md)

# Verify they match
echo "Wrapper count: $wrapper_count"
echo "Expected: 22"
```

## Verification

**Validation Commands:**
```bash
# 1. Verify agent count in docs matches reality
actual_count=$(ls -1 .claude/agents/*.md | wc -l)
echo "Actual wrapper count: $actual_count"
grep -i "agent count\|22 agents\|23 agents" .claude/README.md AGENTS.md

# 2. Verify secaudit documented correctly
grep -i "secaudit" .claude/README.md AGENTS.md

# 3. Verify explore mentioned as delegatable
grep -i "explore" .claude/README.md AGENTS.md

# 4. Verify thinkdeep removed from docs
! grep -i "thinkdeep" .claude/README.md AGENTS.md && echo "✅ thinkdeep removed" || echo "❌ thinkdeep still referenced"
```

**Expected Outcomes:**
- Agent count reflects 22 (not 23)
- secaudit documented as pointing to audit.md
- explore listed as delegatable agent
- No references to thinkdeep remain

**Evidence Checklist:**
- [ ] .claude/README.md updated with correct counts
- [ ] AGENTS.md routing matrix accurate
- [ ] No stale references to thinkdeep
- [ ] secaudit→audit relationship documented
- [ ] explore marked as Task-delegatable
- [ ] Git diff shows doc-only changes

**Artefact Storage:**
- Git diff: `qa/group-d/doc-updates.diff`
- Validation output: `qa/group-d/validation.log`
- Agent count verification: `qa/group-d/agent-count.txt`

**Success Criteria:**
- ✅ Agent count accurate (22)
- ✅ secaudit→audit documented
- ✅ explore listed as delegatable
- ✅ No thinkdeep references
- ✅ Evidence captured in `qa/group-d/`

**Estimated Effort:** 10 minutes
**Risk Level:** Low (documentation only)
**Rollback:** Revert doc changes via git
