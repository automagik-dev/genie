# Code Collective
**Last Updated:** !`date -u +"%Y-%m-%d %H:%M:%S UTC"`

Genie's Code collective hosts hands-on software delivery agents. Everything under `agents/` is executable through `genie run <id>`. Keep documentation, workflows, and skills alongside to keep context tight.

## Layout

- `agents/` — executable agents (plan, review, implementor, etc.)
- `qa/`, `skills/`, `teams/` — supporting material consumed by agents

A collective is considered active when this `AGENTS.md` marker exists. The CLI and MCP only load agents from directories that contain both this marker and an `agents/` folder.
