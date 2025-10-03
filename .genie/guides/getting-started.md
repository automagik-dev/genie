# Getting Started with the Genie Template

This guide explains how to install and use the Genie template in any repository. It focuses on agents, workflows, and non-destructive guardrails — not any particular domain.

## 1. Prerequisites

- Node.js (for the CLI) and git
- Optional: language toolchains used by your target project (Rust, TS, etc.)

## 2. Install the Template into a Repo

In your target repository (blank or existing), copy the following folders/files from this template:

```text
.genie/
.claude/commands/
AGENTS.md
README.md (optional; merge relevant sections)
```

Commit them on a feature branch, e.g., `chore/add-genie-template`.

## 3. Optional: Local Environment File

Create `.env` in your project if agents/scripts need local configuration. Use placeholders specific to your domain. Example:

```env
APP_ENV=dev
LOG_LEVEL=debug
PROJECT_NAME={{PROJECT_NAME}}
```

Load the variables into your shell when working locally:

```bash
set -a && source .env && set +a
```

## 4. Verify MCP Tools

```
mcp__genie__list_agents
mcp__genie__run with agent="plan" and prompt="[Discovery] quick repo scan [Implementation] outline wish [Verification] list next steps"
```

## 5. Start Your First Wish

Use the plan → wish → forge flow. Store evidence under `.genie/wishes/<slug>/` as your project requires (no defaults).

```
mkdir -p .genie/wishes/sample
mcp__genie__run with agent="wish" and prompt="Create a wish for onboarding Genie template to {{PROJECT_NAME}}."
```

## 6. Project Context

- Define your own metrics and validation hooks in each wish/forge plan.
- Customize `.genie/product/*` to your project’s needs (mission, roadmap, environment).

## 7. Next Steps

- Add/adjust agents as needed under `.genie/agents/`.
- Customize `.genie/agents/specialists/*.md` with your project’s personas (implementor, qa, polish, tests, self-learn, bug-reporter).
- Keep AGENTS.md synchronized with your Local Agent Map.

## Troubleshooting

- **Permissions**: If a run fails due to write permissions, create an agent with `sandbox: read-only` in the frontmatter or adjust write paths.
- **Missing system packages**: Ensure runtime/toolchains for your project are installed.

## Additional Resources

- [Environment Configuration](../product/environment.md)
- [Technical Stack](../product/tech-stack.md)

Stay within these references so the documentation remains the single source of truth.
