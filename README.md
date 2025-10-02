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

- CLI runner: `./genie`
- Node/TS + Rust friendly; works in any repo (domain-agnostic)

## CLI Architecture

The Genie CLI has been refactored into a highly modular architecture for maximum maintainability:

### Modularization Achievement
- **Before**: Single monolithic file with 2,105 lines
- **After**: Clean orchestrator with 143 lines (93% reduction)
- **Impact**: Enhanced maintainability, testability, and extensibility

### Architecture Layers
1. **Orchestration Layer** (`genie.ts`) - Thin entry point that routes commands
2. **Command Layer** (`commands/`) - Isolated command implementations
3. **Library Layer** (`lib/`) - Shared utilities and configuration
4. **Executor Layer** (`executors/`) - Pluggable backend adapters
5. **View Layer** (`views/`) - Output rendering and formatting
6. **Infrastructure** (`background-manager.ts`, `session-store.ts`) - Process and state management

### Key Benefits
- **Clear separation of concerns** - Each module has a single responsibility
- **Easy to extend** - Add new commands by creating a file in `commands/`
- **Testable in isolation** - Modules can be unit tested independently
- **Pluggable executors** - Support for different backend engines (Codex, etc.)

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

2) Run the CLI:
- `./genie --help`
- `./genie run plan "[Discovery] Load @.genie/product/mission.md and @.genie/product/roadmap.md. [Implementation] Evaluate feature 'user-notes' (not on roadmap) and prepare a wish brief. [Verification] Provide wish-readiness checklist + blockers." --no-background`

3) Customize `.genie/product/*` (mission, roadmap, environment) and start your first wish.

## Repository Structure

```
.genie/product/      # Mission, roadmap, environment
.genie/agents/       # Entrypoints at root, shared utilities/, repo-specific specialists/
.genie/wishes/       # Wish blueprints and status logs
 .genie/state/        # CLI-managed session data (inspect via ./genie commands)
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

Plan → Wish → Forge → Review:
```bash
# Plan: off-roadmap feature
./genie run plan "[Discovery] mission @.genie/product/mission.md, roadmap @.genie/product/roadmap.md. [Implementation] Assess 'user-notes' scope + risks; prepare wish brief. [Verification] Wish readiness + blockers."

# Wish: create the contract
./genie run wish "slug: user-notes; title: User notes MVP; context: @.genie/product/mission.md, @.genie/product/tech-stack.md; <spec_contract> { deliverables, acceptance, risks }"

# Forge: break into execution groups
./genie run forge "[Discovery] Use @.genie/wishes/user-notes-wish.md. [Implementation] Execution groups + commands. [Verification] Validation hooks + evidence paths."

# Review: replay validations and produce QA verdict
./genie run review "[Discovery] Use @.genie/wishes/user-notes-wish.md. [Implementation] Replay checks. [Verification] QA verdict + follow-ups."

# Resume a planning session
./genie list sessions
./genie view RUN-1234 --full
./genie resume RUN-1234 "Follow-up: address risk #2 with options + trade-offs."
```

CLI Help:
```bash
./genie --help
./genie run --help
```

### Conversations & Resume
`resume` enables an actual, continuous conversation with agents and is how you continue multi‑turn tasks.

- Start a session: `./genie run <agent> "<prompt>"`
- Resume the same session: `./genie resume <sessionId> "<next prompt>"`
- Inspect context so far: `./genie view <sessionId> --full`
- Discover session ids: `./genie list sessions`

Tips
- Use one session per wish/feature/bug to keep transcripts focused.
- Prefer `resume` for follow‑ups; start a new `run` when scope changes significantly and reference the prior session.
