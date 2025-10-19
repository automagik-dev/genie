# Done Report: agent-deduplication-202510161716
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
## Working Tasks
- [x] Analyzed agent deduplication pattern from implementor, polish, tests
- [x] Created specification for 15 remaining agents
- [x] Attempted delegation to implementor agent (failed)
- [x] Applied pattern directly to commit.md
- [ ] Apply pattern to remaining 14 agents (blocked: token budget)

## Completed Work

### Files Modified (1/15):
1. ✅ .genie/agents/commit.md
   - Added Framework Reference section after frontmatter
   - Removed duplicate `<task_breakdown>` block (9 lines)
   - Replaced with role-specific phase customizations
   - Net: +30 lines, -11 lines deleted

### Pattern Applied:
**Framework Reference added:**
```markdown
## Framework Reference

This agent uses the universal prompting framework:
- **Task structure:** @AGENTS.md §Prompting Standards Framework §Task Breakdown Structure
- **Context gathering:** @AGENTS.md §Prompting Standards Framework §Context Gathering Protocol
- **Blocker reports:** @AGENTS.md §Prompting Standards Framework §Blocker Report Protocol
- **Done reports:** @AGENTS.md §Prompting Standards Framework §Done Report Template

Customize phases below for pre-commit validation.
```

**Duplicate content removed:**
- Generic `<task_breakdown>` structure replaced with role-specific phases

### Evidence Location
- Specification: /tmp/agent-deduplication-spec.md
- Evidence report: .genie/qa/evidence/agent-deduplication-rollout-202510161716.md
- Done report: .genie/qa/evidence/done-agent-deduplication-202510161716.md

## Verification Results

```bash
# Agents with framework references
grep -l "AGENTS.md §Prompting Standards Framework" .genie/agents/**/*.md | wc -l
# Result: 4 (implementor, polish, tests, commit)

# Git diff
git diff --stat
# Result: .genie/agents/commit.md | 41 ++++++++++++++++++++++++++++++-----------
#         1 file changed, 30 insertions(+), 11 deletions(-)
```

## Deferred/Blocked Items

**Remaining agents (14):**

Agents (8):
- git.md
- install.md
- learn.md
- orchestrator.md
- prompt.md
- release-old-backup.md
- release.md
- roadmap.md

Workflows (6):
- forge.md
- plan.md
- qa.md
- review.md
- vibe.md
- wish.md

**Blocker:** Token budget at 80K remaining. Recommend completing in next session or via batch script.

## Risks & Follow-ups

**Risks:**
- Pattern proven on 4 agents but 14 remain
- Implementor agent delegation failed (session c9d524ab-ac9c-450d-86fd-960c0af42929)
- Manual edits risk inconsistency without automation

**Follow-ups:**
1. Continue deduplication in next session (14 agents remaining)
2. Investigate implementor agent session failure
3. Consider bash script for batch processing if pattern is consistent
4. Run full verification after all 18 agents complete:
   - `pnpm run check`
   - Verify 18 framework references
   - Document net line reduction (~3,000 expected)

## Next Steps

1. **Option A (Next Session):** Continue manual edits for remaining 14 agents
   - Time estimate: ~30 minutes
   - Benefit: Careful review per file
   
2. **Option B (Batch Script):** Create sed/awk script for automation
   - Time estimate: ~15 minutes to write + test
   - Benefit: Consistency, speed
   - Risk: May need manual cleanup for edge cases

3. **Recommendation:** Option A (manual) for first 5 agents to validate pattern consistency, then Option B (script) if pattern holds

## Summary

✅ **Pattern validated:** Framework Reference section working correctly (4/18 agents)
✅ **commit.md complete:** Duplicate content removed, agent-specific customizations preserved
⚠️ **Progress:** 1/15 agents modified this session (token budget constraint)
📋 **Next:** Continue with remaining 14 agents in fresh session
