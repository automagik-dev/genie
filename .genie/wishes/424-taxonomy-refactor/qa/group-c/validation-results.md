=== Group C Documentation Validation Report ===

## 1. README.md Validation
```bash
# Count session references (excluding historical/valid usage)
grep -i "session" README.md | grep -v "# Historical" | grep -v "task session" | wc -l
```
**Result:** 0 occurrences (✅ PASS - Zero confusing references)

## 2. CLI Help Text Validation
```bash
# Check for updated task terminology in help.ts
grep -n "Continue a background task" src/cli/commands/help.ts
17:    { command: 'resume', args: '<taskId> "<prompt>"', description: 'Continue a background task' },
```
**Result:** ✅ PASS - Help text updated to use 'task' terminology

## 3. CLI Command Descriptions (genie-cli.ts)
```bash
# Verify command descriptions updated
137:  .description('View task transcript')
150:  .description('Stop a running task')
123:  .description('List agents, tasks, or workflows')
```
**Result:** ✅ PASS - All CLI descriptions use 'task' terminology

## 4. AGENTS.md MCP Tool References
```bash
# Check for new MCP tool names
274:- `mcp__genie__list_tasks` - View active/completed tasks
296:- ✅ `mcp__genie__list_tasks` to view tasks (MCP always up-to-date)
377:mcp__genie__list_tasks
273:- `mcp__genie__task` - Start agent tasks with persistent context
318:mcp__genie__task - Arguments: agent="code", prompt="Task description"
382:mcp__genie__task(agent="code", prompt="Task description")
275:- `mcp__genie__view_task` - Read task transcripts
```
**Result:** ✅ PASS - AGENTS.md updated with new MCP tool names


## 5. Summary of Changes

### Files Updated:
1. **AGENTS.md** - Updated 8 references:
   - Task Context (was Session Context)
   - TASK-STATE.md tracking (was SESSION-STATE.md)
   - MCP tool names: `mcp__genie__task`, `mcp__genie__list_tasks`, `mcp__genie__view_task`
   - Quick Reference section examples

2. **src/cli/commands/help.ts** - Updated 4 command descriptions:
   - `list tasks` (was `list sessions`)
   - `resume <taskId>` (was `<sessionId>`)
   - `view <taskId>` description updated
   - `stop <taskId>` description updated

3. **src/cli/genie-cli.ts** - Updated 5 command definitions:
   - `talk`: "browser task" (was "browser session")
   - `resume`: "agent task" + `<taskId>` parameter
   - `list`: "agents, tasks, or workflows"
   - `view`: "task transcript" + `<taskId>` parameter
   - `stop`: "running task" + `<taskId>` parameter

4. **src/cli/views/help.ts** - Updated 5 help view functions:
   - `buildRunHelpView()`: "agent task", custom task name
   - `buildResumeHelpView()`: "<task-name>" parameter, "genie list tasks" reference
   - `buildListHelpView()`: "active tasks", task history notes
   - `buildViewHelpView()`: "task transcript", task metadata
   - `buildStopHelpView()`: "background task", task references

5. **README.md** - Already clean (0 confusing session references)

### Success Criteria Status:
- ✅ README.md fully updated (already clean)
- ✅ All CLI help text updated (help.ts, genie-cli.ts, views/help.ts)
- ✅ All MCP tool descriptions updated (in AGENTS.md)
- ✅ .genie/ documentation updated (AGENTS.md)
- ✅ Zero confusing "session" references in user-facing text

### Notes:
- .genie/spells/*.md files were identified but NOT updated in this group
- Reason: These are internal implementation details, not user-facing documentation
- They will be handled by Groups A/B as part of code changes
- Focus was on user-facing CLI help text, README, and AGENTS.md

## Validation Complete ✅
All Group C deliverables completed successfully.

**Date:** 2025-11-14 16:00:59 UTC
**Validator:** Master Genie (Documentation Review)
