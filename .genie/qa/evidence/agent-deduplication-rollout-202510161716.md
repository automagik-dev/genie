# Agent Deduplication Rollout Evidence
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")
**Task:** Apply framework reference pattern to 15 remaining agents

## Progress

**Completed (4/18 agents with framework references):**
1. ✅ implementor.md (already done)
2. ✅ polish.md (already done)
3. ✅ tests.md (already done)
4. ✅ commit.md (NEW - completed this session)

**Remaining (14 agents):**

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

## Pattern Applied (commit.md)

### Added Framework Reference:
```markdown
## Framework Reference

This agent uses the universal prompting framework:
- **Task structure:** @AGENTS.md §Prompting Standards Framework §Task Breakdown Structure
- **Context gathering:** @AGENTS.md §Prompting Standards Framework §Context Gathering Protocol
- **Blocker reports:** @AGENTS.md §Prompting Standards Framework §Blocker Report Protocol
- **Done reports:** @AGENTS.md §Prompting Standards Framework §Done Report Template

Customize phases below for pre-commit validation.
```

### Removed Duplicate Content:
- `<task_breakdown>` generic structure (lines 26-35)
- Replaced with role-specific phase customizations

### Lines Changed:
- commit.md: +19 lines (framework reference), -9 lines (task_breakdown removal), net +10 lines

## Implementation Approach

**Attempted:** Delegation to implementor agent (session failed immediately)
**Fallback:** Direct implementation following implementor pattern
**Status:** 1/15 files completed, 14 remaining

## Next Steps

1. Continue pattern for remaining 14 agents:
   - Add Framework Reference section after frontmatter
   - Remove `<task_breakdown>`, `<context_gathering>`, blocker/done report duplicates
   - Preserve agent-specific customizations
   
2. Verification commands:
   ```bash
   # Check framework references (expect 18)
   grep -l "AGENTS.md §Prompting Standards Framework" .genie/agents/**/*.md | wc -l
   
   # Show line changes
   git diff --stat | grep "agents/"
   
   # Smoke test
   pnpm run check
   ```

3. Create Done Report documenting all changes

## Blockers

- Implementor agent session failed (c9d524ab-ac9c-450d-86fd-960c0af42929)
- Token budget: 82K remaining for 14 files
- Recommendation: Complete in next session OR batch via script

## Evidence

- commit.md diff: framework reference added, task_breakdown removed
- Pattern proven across 4 agents (implementor, polish, tests, commit)
- Ready for rollout to remaining 14 agents
