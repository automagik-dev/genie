# Genie pi plugin — native surface

This document is the authoritative layer map for the pi plugin payload. Every
tool is read-only; every payload reports `mutation: "none"`.

## Layer map

| Layer | Surface | Delivery |
|-------|---------|----------|
| Tools | Seven read-only tools (see table below) | `pi.registerTool` in `extension.ts` |
| Command | `/genie` — doctor health + board counts | `pi.registerCommand` |
| Session hook | `session_start` hint in Genie workspaces | `pi.on('session_start')` |
| Context hook | Bounded board snapshot before each turn | `pi.on('before_agent_start')` (system-prompt append) |
| Skills | pi-native discovery of `~/.agents/skills` / `.agents/skills`; opt-in canonical mirror via `GENIE_PI_CANONICAL_SKILLS=1` | `pi.on('resources_discover')` |
| Agent sync | Auto-install: symlink `~/.pi/agent/extensions/genie` → `$GENIE_HOME/plugins/pi-genie`; doctor `agent sync: pi` | `runAgentSync` `pi` lane (`genie install` / `genie update` / `--sync-only`) |
| Install | Dev fallback: `scripts/install-local.sh` (symlink default, `--copy` detached) | `~/.pi/agent/extensions/genie` |
| Version | `plugins/pi-genie/package.json` synced by release machinery | `scripts/version.ts` |

## Tool-to-CLI mapping (argv-only, never a shell string)

| Tool | CLI invocation | Notes |
|------|----------------|-------|
| `genie_status` | `genie doctor --json` | plus `.genie/` presence check |
| `genie_board` | `genie board --json [--wish <slug>] [--board <ref>]` | |
| `genie_wish_status` | `genie board --json --wish <slug>` + `genie task list --json --wish <slug>` | plus WISH.md criteria |
| `genie_task_list` | `genie task list --json [--wish <slug>] [--status <s>] [--board <ref>]` | |
| `genie_task_status` | `genie task status <id>` | raw capture; parsed when JSON |
| `genie_work_plan` | `genie launch <slug> --dry-run [--groups <csv>]` | raw YAML-ish text |
| `genie_review_plan` | `genie board --json --wish <slug>` + `genie task list --json --wish <slug>` + WISH.md Success/QA sections | |

## Payload contract

Every tool result carries the Hermes-style envelope:

```json
{
  "content": [{ "type": "text", "text": "<json or error text>" }],
  "details": { "mutation": "none", "cwd": "<workspace>", "command": ["genie", "..."], "parsed": true }
}
```

Failures surface the actual genie stderr text (e.g. `genie launch <slug> --dry-run failed:
Error: No ready tasks for wish "..."`) instead of a raw capture.

## MCP parity

The Claude/Codex MCP server (`genie mcp`) exposes five read-only tools
(`genie_board`, `genie_wish_status`, `genie_worktree_context`, `genie_task`,
`genie_active`). pi has no MCP client; this plugin reaches the same state
through the CLI the MCP server wraps, plus the two review/planning tools that
the MCP surface does not cover (`genie_work_plan`, `genie_review_plan`) —
matching the Hermes gap-tool rationale.

## Bounding (context hook)

- Resolves the turn cwd; no `.genie/` directory → no injection.
- `genie board --json` with a ≤5 s subprocess timeout.
- At most 8 task rows and 2 KiB of injected text.
- Rows are compact `- <id> [<status>] wish=<slug>` tokens — id/status/wish only,
  never free-form titles, so hostile board rows cannot inject directives.
- Every failure (missing binary, timeout, bad JSON) degrades to no injection.
