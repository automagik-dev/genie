# automagik-genie Plugin

Company-standard Claude Code plugin that packages the Genie workflow automation system.

## Features

- **Workflow Skills**: brainstorm, wish, forge, review, plan-review
- **Bootstrap Skills**: genie-base, genie-blank-init
- **Validation Hooks**: Pre-write validation for wish documents
- **Agent Definitions**: implementor, spec-reviewer, quality-reviewer
- **Reference Documents**: wish-template, review-criteria

## Installation

### Global Install (Recommended)

Copy the plugin to your Claude Code plugins directory:

```bash
mkdir -p ~/.claude/plugins
cp -r tools/genie-cli/.claude-plugin ~/.claude/plugins/automagik-genie
```

Or create a symlink for development:

```bash
ln -s $(pwd)/tools/genie-cli/.claude-plugin ~/.claude/plugins/automagik-genie
```

### Install genie-cli (Optional)

The plugin includes an installation script for the genie-cli companion tool:

```bash
bash ~/.claude/plugins/automagik-genie/scripts/install-genie-cli.sh --global
```

## Workflow

The Genie workflow follows this progression:

```
/brainstorm → /wish → /plan-review → /forge → /review → SHIP
```

### 1. Brainstorm (`/brainstorm`)

Explore ideas through dialogue. One question at a time. Outputs validated design.

### 2. Wish (`/wish`)

Convert design into structured plan with:
- Scope (IN/OUT)
- Success criteria
- Execution groups with acceptance criteria
- Validation commands

Creates `.genie/wishes/<slug>/wish.md`

### 3. Plan Review (`/plan-review`)

Fast structural validation of wish document. Catches missing sections before execution.

### 4. Forge (`/forge`)

Execute the plan by dispatching subagents:
- **Implementor**: Executes tasks using TDD
- **Spec Reviewer**: Verifies acceptance criteria (3 loop max)
- **Quality Reviewer**: Checks security/maintainability (2 loop max)

Never implements directly - always dispatches agents.

### 5. Review (`/review`)

Final validation producing:
- **SHIP**: Ready to deploy
- **FIX-FIRST**: Return to forge with specific fixes
- **BLOCKED**: Return to wish for scope changes

## Directory Structure

```
automagik-genie/
├── plugin.json           # Plugin manifest
├── skills/
│   ├── brainstorm/       # Idea exploration
│   ├── wish/             # Plan creation
│   ├── forge/            # Plan execution
│   ├── review/           # Final validation
│   ├── plan-review/      # Wish validation
│   ├── genie-base/       # Workspace bootstrap
│   └── genie-blank-init/ # First activation
├── agents/
│   ├── implementor.md    # Task executor
│   ├── spec-reviewer.md  # Criteria verifier
│   └── quality-reviewer.md # Quality checker
├── hooks/
│   └── hooks.json        # Validation hooks
├── scripts/
│   ├── validate-wish.ts  # Wish validation
│   ├── validate-completion.ts # Forge completion check
│   └── install-genie-cli.sh # CLI installer
└── references/
    ├── wish-template.md  # Wish document template
    └── review-criteria.md # Review severity guide
```

## Verification

After installation, verify the plugin is discovered:

```bash
ls ~/.claude/plugins/automagik-genie/plugin.json
```

Test skills are invocable:
- `/brainstorm` should enter exploration mode
- `/wish` should create wish documents
- `/forge` should dispatch implementor agents
- `/review` should produce SHIP/FIX-FIRST/BLOCKED verdict
