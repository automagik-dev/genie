# Genie Plugin

Company-standard Claude Code/OpenClaw plugin for the Genie workflow.

## Features

- **Core workflow skills**: `/brainstorm`, `/wish`, `/work`, `/review`
- **Bootstrap skills**: `genie-base`, `genie-blank-init`
- **Shared skill source**: `plugins/genie/skills -> ../../skills`
- **Agents + hooks + references** for wish execution and validation

## Workflow

```text
/brainstorm → /wish → /work → /review → SHIP
```

### 1) `/brainstorm`
Explore options, validate direction, and produce a design handoff.

### 2) `/wish`
Turn a validated idea into `.genie/wishes/<slug>/wish.md` with scope, criteria, and validation commands.

### 3) `/work`
Execute wish tasks with bounded fix loops and per-group validation evidence.

### 4) `/review`
Universal review gate (plan, execution, PR) returning `SHIP`, `FIX-FIRST`, or `BLOCKED`.

## Directory Structure

```text
genie/
├── .claude-plugin/plugin.json
├── openclaw.plugin.json
├── genie.ts
├── skills -> ../../skills
├── agents/
├── hooks/
├── scripts/
└── references/
```

## Verification

```bash
ls ~/.claude/plugins/genie/plugin.json
openclaw plugins list | rg genie
```

Smoke-test the core commands:
- `/brainstorm`
- `/wish`
- `/work`
- `/review`
