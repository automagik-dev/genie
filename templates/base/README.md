# Genie Starter Template

This is the base template for Genie-powered projects. It provides the directory structure and configuration files needed to use Genie in your codebase.

## What's Included

### Core Structure
```
.genie/
├── agents/          # Empty (for your custom agents)
├── custom/          # 22 customization stubs (copy these)
├── product/         # Mission, roadmap templates
├── standards/       # Coding standards templates
├── state/           # Session data (auto-created)
└── wishes/          # Wish documents (created by /wish)

.claude/
├── commands/        # 10 slash commands → npm package
└── agents/          # 25 agent aliases → npm package
```

### Documentation
- **AGENTS.md** — Full Genie workflow guide
- **CLAUDE.md** — Claude Code patterns and conventions
- **README.md** — This file

## Installation

### Via `genie init` (Recommended)
```bash
npx @automagik/genie init
```

### Manual Installation
1. Copy this template to your project root
2. Install Genie CLI: `npm install -g @automagik/genie`
3. Customize `.genie/product/` with your project details
4. Customize `.genie/standards/` with your coding standards
5. Edit `.genie/custom/*.md` to override agent behavior

## Architecture

Genie uses a **two-inventory system**:

1. **NPM Inventory (19 agents)**: Core agents shipped with npm package
   - Referenced via `@.genie/agents/core/<agent>.md`
   - **Never copied to your project**
   - Auto-load customizations from `.genie/custom/<agent>.md`

2. **Custom Inventory**: Your project-specific agents
   - Created in `.genie/agents/<agent>.md`
   - Domain-specific workflows
   - Custom automation

## Quick Start

### 1. Define Your Mission
Edit `.genie/product/mission.md`:
```markdown
# MyProject Mission

## Pitch
Build the fastest GraphQL API for real-time data...

## Users
- API Developers
- Mobile Teams

...
```

### 2. Document Standards
Edit `.genie/standards/best-practices.md`, `naming.md`, `code-style.md`

### 3. Customize Agents
Edit `.genie/custom/<agent>.md` files:
```markdown
# implementor - Project Customization

## Commands
Primary build: `pnpm build`
Tests: `pnpm test`

## File Paths
Tests: `tests/`
Config: `tsconfig.json`

## Project-Specific Notes
- Use dependency injection
- Prefer functional patterns
```

### 4. Start Planning
```bash
/plan     # Interactive product planning
/wish     # Create wish document
/forge    # Break into execution groups
/review   # Validate completion
```

## Slash Commands

Interactive workflows:
- `/plan` — Product planning dialogue
- `/wish` — Wish creation
- `/forge` — Execution breakdown
- `/review` — QA validation
- `/commit` — Commit advisory
- `/install` — Framework setup
- `/prompt` — Prompt refinement
- `/vibe` — Autonomous coordinator
- `/learn` — Meta-learning

## Agent Delegation

Background execution via MCP or Task tool:
```bash
# Strategic
mcp__genie__run with agent="analyze" and prompt="Scope: src/auth"
mcp__genie__run with agent="debug" and prompt="Bug: auth fails"

# Tactical
mcp__genie__run with agent="refactor" and prompt="Targets: api/routes"
mcp__genie__run with agent="tests" and prompt="Layer: unit. Files: src/*.ts"

# Delivery
mcp__genie__run with agent="implementor" and prompt="@.genie/wishes/<slug>"
mcp__genie__run with agent="review" and prompt="Mode: QA. @.genie/wishes/<slug>"
```

## Customization Guide

### Product Context
Edit files in `.genie/product/`:
- `mission.md` — Full mission document
- `mission-lite.md` — Concise version
- `roadmap.md` — Active initiatives
- `tech-stack.md` — Languages, frameworks, tools
- `environment.md` — Setup instructions

### Coding Standards
Edit files in `.genie/standards/`:
- `best-practices.md` — Core principles
- `naming.md` — Naming conventions
- `code-style.md` — Formatting rules
- `code-style/<language>.md` — Language-specific guides

### Agent Customization
Edit files in `.genie/custom/`:
- All 22 stubs match core agents
- Add project-specific commands, paths, notes
- Auto-loaded when agent runs

## Workflow

```
1. /plan      → Planning brief
2. /wish      → Wish document
3. /forge     → Execution groups
4. Implement  → Via agents or manually
5. /review    → Validate completion
6. /commit    → Generate commit message
7. Git flow   → Create PR, merge
```

## Support

- **Documentation**: See `AGENTS.md` and `CLAUDE.md`
- **GitHub**: https://github.com/namastexlabs/automagik-genie
- **Issues**: https://github.com/namastexlabs/automagik-genie/issues

---

**Version**: 0.1.0
**License**: MIT
**Maintainer**: Namastex Labs
