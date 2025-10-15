# Claude Code Integration

This directory contains Claude Code agent aliases and commands that reference the Genie npm package.

## Structure

```
.claude/
├── commands/   # Slash commands (interactive workflows)
├── agents/     # Agent aliases (delegatable via Task tool)
└── README.md
```

## How It Works

**All agent definitions live in the `@automagik/genie` npm package.** This directory contains thin wrappers that reference the package.

### Example

**`.claude/agents/implementor.md`:**
```markdown
---
name: implementor
description: Feature implementation agent
model: inherit
---

@.genie/agents/core/implementor.md
```

When you invoke `/implementor` or use the Task tool with `implementor`:
1. Claude Code loads `.claude/agents/implementor.md`
2. The `@` notation loads `@.genie/agents/core/implementor.md` from npm package
3. Customizations from `.genie/custom/implementor.md` are auto-injected

## Commands vs Agents

**Commands (`.claude/commands/*.md`):**
- Interactive workflows (`/plan`, `/wish`, `/forge`, `/review`)
- Invoked via slash commands
- Conversational, guided experience

**Agents (`.claude/agents/*.md`):**
- Background workers (delegatable via `mcp__genie__run` or Task tool)
- Autonomous execution
- Parallel processing

## Customization

**DO NOT edit files in `.claude/`** — they reference the npm package.

**DO customize agents** by editing `.genie/custom/<agent>.md`:

```markdown
# implementor - Project Customization

## Commands
Primary build command: `pnpm build`

## File Paths
Test directory: `tests/`
Config: `tsconfig.json`

## Project-Specific Notes
- Use dependency injection for all services
- Prefer functional patterns over OOP
```

These customizations auto-load when the agent runs.

---

**See also:** `@.claude/README.md` (full architecture guide shipped with npm package)
