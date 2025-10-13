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
6. **Set up user profile** (recommended):
   ```bash
   mkdir -p ~/.genie
   # Copy context template to ~/.genie/context.md
   # Template includes: session state, decision queue, user preferences
   ```

## User Profile System (Session Continuity)

Genie includes a **user profile system** that eliminates session amnesia and maintains context across sessions.

### Setup

Create `~/.genie/context.md` (user-local, not committed):
```markdown
# 🧞 Genie Context: Your Name

**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`
**Current Repo:** !`basename $(pwd)`

## 📊 Runtime Context (Auto-Updated)
**Branch:** !`git branch --show-current`
**Status:** !`git status --short | head -10`
**Recent Commits:** !`git log --oneline -5`

## 🎯 Current Focus
**Task:** [What you're working on]
**Status:** [ACTIVE/PENDING]
**Next Action:** [Next step]

## ⏳ Decision Queue (One at a Time)
### Decision 1: [Topic] [NEXT]
**Question:** [The question]
**Context:** [Background]

## 👤 User Profile
**Communication Preferences:**
- ✅ Sequential decisions (one at a time)
- ✅ Evidence-based approach
- ✅ Collaborative planning
```

### How It Works

1. **Automatic Loading**: CLAUDE.md includes `@~/.genie/context.md`
2. **Runtime Commands**: `!command` syntax executes automatically (fresh git status, date)
3. **Session Greeting**: Claude greets you with current context and where you left off
4. **Decision Queue**: Decisions presented one at a time (humans are single-attention beings)
5. **Cross-Repo**: Lives in `~/.genie/`, follows you across all projects

### Benefits

- ✅ **No session amnesia** - Context persists between sessions
- ✅ **Always fresh** - Git status, branch, commits updated automatically
- ✅ **Single-attention workflow** - One decision at a time, queued
- ✅ **Relationship memory** - Preferences and history maintained
- ✅ **Cross-project** - One profile for all repos

### Example Session Start

```
Hey [Your Name]! 👋

**Current focus:** Issue audit compliance fixes
**Where we left off:** Committed Phase 2 template structure
**Branch:** main
**Status:** 1 file modified

**Next up:** Decision 1 about Issue #41. Ready to discuss?
```

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
