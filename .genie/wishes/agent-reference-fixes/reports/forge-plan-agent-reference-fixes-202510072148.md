# Forge Plan: Agent Reference Fixes

**Wish:** @.genie/wishes/agent-reference-fixes/agent-reference-fixes-wish.md
**Generated:** 2025-10-07 21:48 UTC
**Branch:** wish/core-template-separation (stay in current branch)
**Status:** Ready for execution

---

## Plan Summary

Fix 5 broken agent wrapper references with minimal changes:
- **3 path corrections** (analyze, refactor, secaudit)
- **1 wrapper removal** (thinkdeep - never implemented)
- **1 wrapper creation** (explore - make it delegatable)
- **Documentation sync** (README, AGENTS.md)

**Scope Boundaries:**
- ✅ Wrapper file edits only
- ✅ No agent logic changes
- ✅ No file moves or directory restructuring
- ✅ Stay in current branch

---

## Execution Groups

### Group A: Fix Wrapper Paths
**Task File:** @.genie/wishes/agent-reference-fixes/task-a.md
**Effort:** 5 minutes | **Risk:** Low

**Scope:**
- Edit 3 wrapper files to correct paths
- analyze: `modes/analyze.md` → `core/analyze.md`
- refactor: `modes/refactor.md` → `core/refactor.md`
- secaudit: `modes/secaudit.md` → `core/audit.md` (merge to audit)

**Inputs:**
- @.claude/agents/analyze.md
- @.claude/agents/refactor.md
- @.claude/agents/secaudit.md

**Deliverables:**
- 3 wrapper files updated
- All refs resolve to valid files

**Evidence:**
- Git diff: `qa/group-a/wrapper-fixes.diff`
- Validation output: `qa/group-a/validation.log`

**Matrix Checkpoints:**
- Implementation → Code Quality (5 pts): Minimal changes
- Verification → Validation Completeness (6 pts): Refs resolve

**Suggested Persona:** implementor

---

### Group B: Clean Up Invalid Wrapper
**Task File:** @.genie/wishes/agent-reference-fixes/task-b.md
**Effort:** 2 minutes | **Risk:** Low

**Scope:**
- Remove thinkdeep wrapper (agent never implemented)
- Verify wrapper count drops to 22

**Inputs:**
- @.claude/agents/thinkdeep.md

**Deliverables:**
- thinkdeep.md deleted
- Wrapper count = 22 (was 23)

**Evidence:**
- Deletion log: `qa/group-b/deletion.log`
- Wrapper count: `qa/group-b/wrapper-count.txt`

**Matrix Checkpoints:**
- Implementation → Code Quality (5 pts): Clean removal
- Verification → Validation Completeness (4 pts): Confirmed removed

**Suggested Persona:** implementor

---

### Group C: Create Missing Wrapper
**Task File:** @.genie/wishes/agent-reference-fixes/task-c.md
**Effort:** 3 minutes | **Risk:** Low

**Scope:**
- Create explore.md wrapper
- Points to existing `core/modes/explore.md`
- Makes explore Task-delegatable

**Inputs:**
- @.genie/agents/core/modes/explore.md (target)

**Deliverables:**
- `.claude/agents/explore.md` created
- Wrapper resolves correctly

**Evidence:**
- Wrapper contents: `qa/group-c/explore-wrapper.md`
- Validation: `qa/group-c/validation.log`

**Matrix Checkpoints:**
- Implementation → Code Quality (5 pts): Follows conventions
- Verification → Validation Completeness (5 pts): Ref resolves

**Suggested Persona:** implementor

---

### Group D: Update Documentation
**Task File:** @.genie/wishes/agent-reference-fixes/task-d.md
**Effort:** 10 minutes | **Risk:** Low

**Scope:**
- Update .claude/README.md (agent count, secaudit→audit)
- Update AGENTS.md (routing, explore delegatable)
- Remove thinkdeep references

**Inputs:**
- @.claude/README.md
- @AGENTS.md

**Deliverables:**
- Agent count: 22 (was 23)
- secaudit documented as pointing to audit
- explore listed as delegatable
- No thinkdeep references

**Evidence:**
- Git diff: `qa/group-d/doc-updates.diff`
- Validation: `qa/group-d/validation.log`

**Matrix Checkpoints:**
- Implementation → Documentation (5 pts): Complete updates
- Verification → Review Thoroughness (3 pts): Accurate docs

**Suggested Persona:** docgen

---

## Validation Hooks

### Pre-Implementation
```bash
# Capture current state
ls -1 .claude/agents/*.md > before-state.txt
for f in .claude/agents/*.md; do
  ref=$(grep "^@.genie/agents/" "$f" 2>/dev/null | head -1)
  if [ -n "$ref" ]; then
    target=${ref#@}
    test -f "$target" || echo "BROKEN: $(basename $f)"
  fi
done > before-broken.txt
```

### Post-Implementation
```bash
# Verify all refs resolve
for f in .claude/agents/*.md; do
  ref=$(grep "^@.genie/agents/" "$f" 2>/dev/null | head -1)
  if [ -n "$ref" ]; then
    target=${ref#@}
    if [ ! -f "$target" ]; then
      echo "❌ BROKEN: $(basename $f) -> $ref"
      exit 1
    fi
  fi
done
echo "✅ All wrapper references valid"

# Verify wrapper count
count=$(ls -1 .claude/agents/*.md | wc -l)
if [ "$count" -eq 22 ]; then
  echo "✅ Wrapper count correct: 22"
else
  echo "❌ Wrapper count wrong: $count (expected 22)"
  exit 1
fi

# Run smoke tests
pnpm run test:genie
```

### Rollback Plan
```bash
# All changes are git-tracked
git diff .claude/agents/ .genie/agents/forge.md AGENTS.md .claude/README.md
git checkout .claude/agents/ .genie/agents/forge.md AGENTS.md .claude/README.md
```

---

## Dependencies & Sequencing

**Sequential:**
- Groups A, B, C can run in parallel (independent)
- Group D must run AFTER A/B/C complete (depends on final state)

**No External Dependencies:** All changes are local file edits

---

## Branch Strategy

**Decision:** Stay in current branch `wish/core-template-separation`

**Rationale:**
- User explicitly requested staying in this branch
- Changes are minimal (wrapper fixes only)
- No risk of conflicts with branch purpose

**Commit Strategy:**
- Single commit after all groups complete
- Message: "fix: resolve 5 broken agent wrapper references"
- Reference wish in commit body

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Breaking existing scripts | Medium | Low | All agent names stay the same |
| Documentation drift | Low | Medium | Group D ensures sync |
| Incorrect path fixes | Medium | Low | Validation hooks catch issues |
| Merge conflicts | Low | Low | Staying in current branch |

**Overall Risk:** Low

---

## Success Metrics (from wish evaluation matrix)

**Target Score:** 95+/100

**Key Checkpoints:**
- Discovery (30 pts): Context complete, decisions made ✅
- Implementation (40 pts):
  - Code Quality (15 pts): Minimal wrapper edits
  - Test Coverage (10 pts): Validation hooks pass
  - Documentation (5 pts): README/AGENTS.md synced
  - Execution Alignment (10 pts): Stayed in branch, no scope creep
- Verification (30 pts):
  - Validation Completeness (15 pts): All refs resolve, smoke tests pass
  - Evidence Quality (10 pts): Diffs, logs, validation outputs captured
  - Review Thoroughness (5 pts): Human approval, status updated

---

## Approval Log

- [2025-10-07 14:45Z] Wish approved by user
- [2025-10-07 21:48Z] Forge plan generated
- [2025-10-07 21:48Z] Task files created (A, B, C, D)
- **Pending:** Human review of forge plan

---

## Follow-Up Checklist

**After Implementation:**
- [ ] Run validation hooks (verify all refs resolve)
- [ ] Run smoke tests (`pnpm run test:genie`)
- [ ] Review git diff before commit
- [ ] Update wish status to IN_PROGRESS → COMPLETE
- [ ] File Done Report in `reports/done-implementor-agent-reference-fixes-<timestamp>.md`
- [ ] Run `/review` for completion audit

**Optional:**
- [ ] Test MCP agent listing (`mcp__genie__list_agents`)
- [ ] Manually invoke fixed agents to confirm functionality

---

## Notes

**Key Decisions:**
- secaudit absorbed into audit.md (security mode already exists)
- thinkdeep deprecated (never implemented, not in roadmap)
- explore made delegatable (was orchestrator-only)
- analyze and refactor kept separate (complementary, not redundant)

**forge.md Fix:**
- Fixed forge.md line 23 to save plans in wish folder: `.genie/wishes/<slug>/reports/`
- Was incorrectly pointing to: `.genie/state/reports/`

**Execution Time:** ~20 minutes total (all groups)
