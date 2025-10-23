---
name: Forge MCP Task Description Patterns
description: How to create Forge MCP task descriptions for Claude executor
---

# Forge MCP Task Description Patterns (Claude Executor Only)

When creating Forge MCP tasks via `mcp__forge__create_task` with Claude as executor, explicitly instruct Claude to use the subagent and load context from files only.

## Pattern
```
Use the <persona> subagent to [action verb] this task.

`@.genie/code/agents/<persona>.md`
`@.genie/wishes/<slug>/task-<group>.md`
`@.genie/wishes/<slug>/<slug>-wish.md`

Load all context from the referenced files above. Do not duplicate content here.
```

## Example
```
Use the implementor subagent to implement this task.

`@.genie/code/agents/implementor.md`
`@.genie/wishes/claude-executor/task-a.md`
`@.genie/wishes/claude-executor-wish.md`

Load all context from the referenced files above. Do not duplicate content here.
```

## Why This Pattern
- Explicit instruction tells Claude to spawn the subagent
- Agent reference points to actual agent prompt file
- File references provide context paths
- Avoids token waste from duplicating task file contents

## Agent Reference Pattern
- Code agents: `@.genie/code/agents/<agent>.md`
- Universal agents: `@.genie/code/agents/<agent>.md`
- Workflows: `@.genie/code/workflows/<workflow>.md`

**Note:** This pattern is ONLY for Forge MCP task descriptions when using Claude executor. Task file creation (task-*.md) remains unchanged with full context.
