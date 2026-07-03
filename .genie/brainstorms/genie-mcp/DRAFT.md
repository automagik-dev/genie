# Brainstorm: genie MCP server — Warp (and any agent) consumes genie state

## Seed / evidence (2026-07-03)
- genie has NO MCP server / `mcp` command today; it only emits one-shot Warp launch_configurations (warp-launch.ts).
- State lives in `genie.db` (per-repo: tasks/wishes/board; global ~/.genie/genie.db: omni approvals/inbox).
- Warp reality (docs.warp.dev, verified): MCP servers ARE Warp's plugin surface — defined in `.warp/.mcp.json` (project) / `~/.warp/.mcp.json` (global), as a CLI command (stdio) or HTTP/SSE endpoint. Warp reads MCP defs from Claude Code/Codex/other agents + AGENTS.md/WARP.md. Warp embeds Claude Code natively with per-tab status. NO external API to directly push tab titles/blocks — integration is passive (MCP listen / file detect), not active push.
- Implication: "Warp consumes genie state" = a genie MCP server Warp connects to. Same server auto-serves Claude Code + Codex (all MCP clients) → bigger than Warp alone.

## Problem
Genie's state (wishes, tasks, board, what-each-worktree-is-doing) is invisible to Warp and to the agents running inside it; there's no way for Warp/Claude Code to read genie's live state.

## Core idea
A `genie mcp` stdio server exposing genie.db state as MCP tools/resources, auto-registered via `.warp/.mcp.json` (+ `.mcp.json` for Claude Code) by `genie init`/`launch`.

## Open questions
- Read-only state mirror vs read+write (agents drive genie via MCP)?
- Transport: stdio CLI-command (lightweight, no daemon — fits body) vs HTTP/SSE (daemon)?
- Breadth: Warp-only vs universal auto-register (Claude Code + Codex + Warp)?
- Which state matters most (board, wish progress, current-worktree context, activity)?

## WRS: Problem ✅ | Scope ░ | Decisions ░ | Risks ░ | Criteria ░
