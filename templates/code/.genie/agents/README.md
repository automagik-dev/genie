# Custom Project Agents

This directory is for your **project-specific agents** that are not part of the Genie framework.

## Architecture

Genie uses a **two-inventory system**:

1. **NPM Inventory (19 agents)**: Core agents shipped with the `@automagik/genie` npm package
   - Referenced via `@.genie/agents/core/<agent>.md` in your project
   - Never copied to your project
   - Auto-load customizations from `.genie/custom/<agent>.md`

2. **Custom Inventory (this directory)**: Your project-specific agents
   - Domain-specific workflows
   - Custom automation agents
   - Project-specific tooling

## Creating Custom Agents

Add your own agent files here with frontmatter:

```markdown
---
name: my-custom-agent
description: Brief description of what this agent does
genie:
  executor: claude
  model: sonnet
  permissionMode: default  # If agent needs file write access
---

# Your Agent Prompt Here
```

## Referencing Agents

**From slash commands (.claude/commands/):**
```markdown
@.genie/agents/my-custom-agent.md
```

**From MCP:**
```bash
mcp__genie__run with agent="my-custom-agent" and prompt="..."
```

## Best Practices

- Keep agents focused on single responsibilities
- Document validation commands and evidence paths
- Use `.genie/custom/<core-agent>.md` to override core agent behavior
- Store agent outputs in `.genie/state/agents/` or wish `qa/` folders

---

**Note:** This directory intentionally starts empty. Core Genie agents live in the npm package.
