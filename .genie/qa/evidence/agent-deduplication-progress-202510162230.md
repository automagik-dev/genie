# Agent Deduplication Progress Report
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Date:** 2025-10-16 22:30Z
**Status:** IN PROGRESS (Paused for session reset)
**Completion:** 3/14 agents done (21%)

## Context

Applying agent deduplication pattern to remove duplicate framework content. **CRITICAL correction**: Discovered @ usage loads entire AGENTS.md into context automatically - this DEFEATS the purpose of deduplication.

## Correct Pattern (No @)

```markdown
## Framework Reference

This agent uses the universal prompting framework documented in AGENTS.md §Prompting Standards Framework:
- Task Breakdown Structure (Discovery → Implementation → Verification)
- Context Gathering Protocol (when to explore vs escalate)
- Blocker Report Protocol (when to halt and document)
- Done Report Template (standard evidence format)

Customize phases below for [AGENT_ROLE].
```

**Why no @:**
- `@AGENTS.md` loads entire file into context automatically
- Multiple agents with @ = context overload
- Reference-only = model looks up ONLY if needed
- Each file can only be @ once per .md file

## Completed Agents (3)

✅ **roadmap.md** - Framework Reference added (no @), `<task_breakdown>` converted to Workflow Phases
✅ **orchestrator.md** - Framework Reference added (no @), no duplicates (mode-specific content only)
✅ **install.md** - Framework Reference added (no @), `<task_breakdown>` converted to Workflow Phases

## Violations Fixed (2)

- roadmap.md: Initially added with @, corrected to remove @
- orchestrator.md: Initially added with @, corrected to remove @

## Needs Fixing (1)

❌ **commit.md** - Has Framework Reference but WITH @ (violates pattern)

## Remaining Agents (11)

**Neurons (6):**
- git.md (has 2 `<task_breakdown>` sections)
- learn.md
- prompt.md
- release-old-backup.md
- release.md
- (commit.md - fix @ violation)

**Workflows (6):**
- forge.md
- plan.md
- qa.md
- review.md
- vibe.md
- wish.md

## Already Done (3 - Need @ Check)

Need to verify these don't have @ violations:
- implementor.md
- polish.md
- tests.md

## Validation Commands

```bash
# Count agents with Framework Reference (should be 18 when done)
grep -l "Framework Reference" .genie/agents/**/*.md | wc -l

# Check for @ violations (should be 0 when done)
grep "Framework Reference" -A 5 .genie/agents/**/*.md | grep "@AGENTS.md" | wc -l

# Verify line reduction
git diff main --stat | grep "agents/"
```

## MCP Session Failure

Delegation to implementor failed due to infrastructure bug (MCP session c9d524ab failed without output). Documented exception to delegation discipline - executing directly due to infrastructure limitation.

**Evidence:** `.genie/qa/evidence/mcp-session-failure-202510162215.md`

## Next Steps

1. Fix commit.md @ violation
2. Check implementor/polish/tests for @ violations
3. Apply pattern to remaining 11 agents
4. Validate all 18 agents reference framework correctly
5. Run validation commands
6. Commit with evidence

## Token Management

Session paused at 168K/200K tokens (84% usage) to preserve state and reset context.
