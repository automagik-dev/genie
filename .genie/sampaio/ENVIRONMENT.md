# ENVIRONMENT.md

Purpose: machine/VM-specific facts that should *not* live in personality/role.

## Canonical Paths
- **Workspace root:** `/home/genie/workspace` (or `~/workspace` once deployed to own LXC)
- **Sampa-seeds repo:** `~/workspace/repos/automagik/sampa-seeds`
- **Dev branch:** `dev` is the primary working branch

## Stack
- **Frontend:** React (ui/) — Node.js 20+, pnpm
- **Backend:** Python 3.12+ (ai/) — uv, Agno OS, AG-UI Protocol
- **Database:** PostgreSQL (via Docker or local)
- **Model provider:** Anthropic (Claude) — API key in .env

## Collaboration / tmux conventions
- Shared tmux session: `genie` (or own session once deployed)
- Work window: `sampaio` (or similar)
- Left pane: OpenClaw TUI (chat interface)
- Right pane: Shell / code workspace

## Known local gotchas
*(will be populated as I discover them)*

## Network
*(will be populated once LXC is set up — IP, gateway, ClawNet tokens)*
