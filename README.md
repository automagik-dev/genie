# Genie Template Repository

Genie agent templates and CLI orchestration that can be installed into any repository. Replace project specifics with placeholders and use `.genie/agents/install.md` to bootstrap into your target codebase.

## Vision

Provide reusable planning, wishing, forging, review, and commit workflows with evidence-first prompts and a consistent CLI, independent of domain.

## What’s Included

- Unified prompts for plan, wish, forge, review, commit
- Specialist agents (bug-reporter, git-workflow, implementor, polish, project-manager, qa, self-learn, tests)
- CLI wrappers in `.claude/commands/` that @include agents
- Workspace-managed sessions and logs under `.genie/state/`

## Core Features

- Evidence-first orchestration (Discovery → Implementation → Verification)
- Guardrails (no destructive actions without approval)
- Template placeholders: `{{PROJECT_NAME}}`, `{{DOMAIN}}`, `{{TECH_STACK}}`, `{{APIS}}`, `{{METRICS}}`

## Technical Stack

- MCP Server: Genie agents accessible via `mcp__genie__*` tools
- Node/TS + Rust friendly; works in any repo (domain-agnostic)

## MCP & CLI Architecture

Genie ships as both a Model Context Protocol (MCP) server and a local CLI. The CLI is
primarily used to bootstrap and maintain the `.genie/` workspace, while the MCP tools
power agent execution inside editors.

### Bootstrap Commands

1. Initialise the current project:

   ```bash
   npx automagik-genie init --provider codex
   ```

   This copies the packaged `.genie` templates, creates backups of any existing
   `.genie`/`.claude` folders, and records your provider defaults.

2. Apply template updates later on:

   ```bash
   npx automagik-genie update --dry-run
   npx automagik-genie update
   ```

3. Restore a previous snapshot if needed:

   ```bash
   npx automagik-genie rollback --list
   npx automagik-genie rollback --latest
   ```

4. Access agent orchestration and the MCP server via `genie`:

   ```bash
   genie run plan "[Discovery] mission @.genie/product/mission.md"
   genie mcp --transport stdio
   ```

### Available MCP Tools
- `mcp__genie__run` - Start a new agent session
- `mcp__genie__view` - View session transcript
- `mcp__genie__resume` - Continue an existing session
- `mcp__genie__list_sessions` - List all sessions
- `mcp__genie__list_agents` - List available agents
- `mcp__genie__stop` - Stop a running session

### Key Benefits
- **Integrated with Claude Code** - Use Genie directly in your AI workflow
- **Session management** - Persistent conversations with agents
- **Pluggable executors** - Support for different backend engines (Codex, Claude, etc.)

For detailed documentation, see [.genie/cli/README.md](.genie/cli/README.md)

## Documentation

- [Mission](.genie/product/mission.md) - Template repo goals and non-destructive guardrails
- [Technical Stack](.genie/product/tech-stack.md) - CLI + agent architecture
- [Roadmap](.genie/product/roadmap.md) - Template development phases
- [Environment Config](.genie/product/environment.md) - Config keys and placeholders
- [Getting Started](.genie/guides/getting-started.md) - Install this Genie into any repo

## Current Status

Phase 1: Template sweep in progress (neutralizing project-specific content).

## Install (into an existing repo)

1) Copy these from this template into your repo:
- `.genie/` (all)
- `.claude/commands/`
- `AGENTS.md`

2) Use MCP tools to run agents:
- List available agents: `mcp__genie__list_agents`
- Start a planning session: `mcp__genie__run` with agent `plan`

3) Customize `.genie/product/*` (mission, roadmap, environment) and start your first wish.

## Repository Structure

```
.genie/product/      # Mission, roadmap, environment
.genie/agents/       # Entrypoints at root, shared utilities/, repo-specific specialists/
.genie/wishes/       # Wish blueprints and status logs
.genie/state/        # Session data (inspect via mcp__genie__list_sessions and mcp__genie__view)
vendors/             # External reference repos
AGENTS.md            # Framework overview & guardrails
CLAUDE.md            # AI assistant guidelines
```

## Submodules (Optional)

See `vendors/README.md` for managing external references if needed for your project.

## Notes

- This is a domain-agnostic template. Replace placeholders with your project specifics after installation.

## Philosophy

Orchestration-first. Evidence-first. Human-approved. Domain-agnostic templates that install cleanly anywhere.

## Quick Start Examples

Plan → Wish → Forge → Review workflow using MCP tools:

```
# List available agents
mcp__genie__list_agents

# Plan: off-roadmap feature
mcp__genie__run with agent="plan" and prompt="[Discovery] mission @.genie/product/mission.md, roadmap @.genie/product/roadmap.md. [Implementation] Assess 'user-notes' scope + risks; prepare wish brief. [Verification] Wish readiness + blockers."

# Wish: create the contract
mcp__genie__run with agent="wish" and prompt="slug: user-notes; title: User notes MVP; context: @.genie/product/mission.md, @.genie/product/tech-stack.md; <spec_contract> { deliverables, acceptance, risks }"

# Forge: break into execution groups
mcp__genie__run with agent="forge" and prompt="[Discovery] Use @.genie/wishes/user-notes-wish.md. [Implementation] Execution groups + commands. [Verification] Validation hooks + evidence paths."

# Review: replay validations and produce QA verdict
mcp__genie__run with agent="review" and prompt="[Discovery] Use @.genie/wishes/user-notes-wish.md. [Implementation] Replay checks. [Verification] QA verdict + follow-ups."

# Resume a planning session
mcp__genie__list_sessions
mcp__genie__view with sessionId="<session-id>" and full=true
mcp__genie__resume with sessionId="<session-id>" and prompt="Follow-up: address risk #2 with options + trade-offs."
```

### Conversations & Resume
The `mcp__genie__resume` tool enables continuous conversation with agents for multi-turn tasks.

- Start a session: `mcp__genie__run` with agent and prompt
- Resume the session: `mcp__genie__resume` with sessionId and prompt
- Inspect context: `mcp__genie__view` with sessionId and full=true
- Discover sessions: `mcp__genie__list_sessions`

Tips
- Use one session per wish/feature/bug to keep transcripts focused.
- Prefer `resume` for follow-ups; start a new `run` when scope changes significantly and reference the prior session.
