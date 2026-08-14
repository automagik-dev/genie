# Genie pi plugin — native surface

This document is the authoritative layer map for the pi plugin payload. No tool
mutates tasks, wishes, or files, and every payload reports `mutation: "none"`.
The single exception to "reads nothing but reads" is `genie_board` called with a
lane-defining `board` ref: `genie board --json --board <ref>` reconciles
sync-owned card lanes from WISH.md statuses before rendering, which writes lane
moves to `genie.db`. Every other invocation — wish-scoped, unscoped, or a
laneless board — is a pure read, because the CLI reconciles only when the read's
own output renders lanes.

## Layer map

| Layer | Surface | Delivery |
|-------|---------|----------|
| Tools | Seven read-only tools (see table below) | `pi.registerTool` in `extension.ts` |
| Command | `/genie` — doctor health + board counts | `pi.registerCommand` |
| Session hook | `session_start` hint in Genie workspaces | `pi.on('session_start')` |
| Context hook | Bounded board snapshot before each turn | `pi.on('before_agent_start')` (system-prompt append) |
| Skills | pi-native discovery of `~/.agents/skills` / `.agents/skills`; opt-in canonical mirror via `GENIE_PI_CANONICAL_SKILLS=1` | `pi.on('resources_discover')` |
| Agent sync | Auto-install when detected (pi agent dir present OR pi CLI on PATH): symlink `~/.pi/agent/extensions/genie` → `$GENIE_HOME/plugins/pi-genie`; doctor `agent sync: pi`; identity-checked removal on `genie uninstall` | `runAgentSync` `pi` lane (`genie install` / `genie update` / `--sync-only`) |
| Install | Dev fallback: `scripts/install-local.sh` (symlink default, `--copy` detached) | `~/.pi/agent/extensions/genie` |
| Version | `plugins/pi-genie/package.json` synced by release machinery | `scripts/version.ts` |

## Tool-to-CLI mapping (argv-only, never a shell string)

| Tool | CLI invocation | Notes |
|------|----------------|-------|
| `genie_status` | `genie doctor --json` | plus `.genie/` presence check |
| `genie_board` | `genie board --json [--wish <slug>] [--board <ref>]` | reconciles lanes only with a lane-defining `--board` |
| `genie_wish_status` | `genie board --json --wish <slug>` + `genie task list --json --wish <slug>` | plus WISH.md criteria; pure read (no `--board`) |
| `genie_task_list` | `genie task list --json [--wish <slug>] [--status <s>] [--board <ref>]` | |
| `genie_task_status` | `genie task status <id>` | raw capture; parsed when JSON |
| `genie_work_plan` | `genie context --wish <slug> --plan [--group <g>]` | raw versioned JSON |
| `genie_review_plan` | `genie board --json --wish <slug>` + `genie task list --json --wish <slug>` + WISH.md Success/QA sections | |

## Payload contract

Every tool result carries the Hermes-style envelope:

```json
{
  "content": [{ "type": "text", "text": "<json or error text>" }],
  "details": { "mutation": "none", "cwd": "<workspace>", "command": ["genie", "..."], "parsed": true }
}
```

Failures surface the actual genie stderr text (e.g. `genie context --wish <slug> --plan failed:
{"error": "...", "reason": "..."}`) instead of a raw capture.

## MCP parity

The Claude/Codex MCP server (`genie mcp`) exposes five read tools plus twelve
operative write tools (`genie_task_create`, `genie_task_checkout`,
`genie_task_done`, `genie_task_move`, `genie_task_block`, `genie_task_unblock`,
`genie_task_release`, `genie_task_comment`, `genie_task_report`,
`genie_task_heartbeat`, `genie_task_set_wish`, `genie_task_add_dependency`).
pi has no MCP client; this plugin reaches the same state
through the CLI the MCP server wraps, plus the two review/planning tools that
the MCP surface does not cover (`genie_work_plan`, `genie_review_plan`) —
matching the Hermes gap-tool rationale.

## Bounding (context hook)

- Resolves the turn cwd; no `.genie/` directory → no injection.
- `genie board --json` with a ≤5 s subprocess timeout — unscoped, so it defines
  no lanes and never reconciles; the hook is a pure read on every turn.
- At most 8 task rows and 2 KiB of injected text.
- Rows are compact `- <id> [<status>] wish=<slug>` tokens — id/status/wish only,
  never free-form titles, so hostile board rows cannot inject directives.
- Every failure (missing binary, timeout, bad JSON) degrades to no injection.
