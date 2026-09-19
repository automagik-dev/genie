# G1 Spike — MCP transport + Warp/Claude Code config schema

Date: 2026-07-03 · Worker: g1-spike · Gates: G2, G3

## Verdict: hand-rolled

A hand-rolled newline-delimited JSON-RPC 2.0 stdio server (zero deps) satisfied a **real Claude Code** client end-to-end (`initialize` → `tools/list` → `tools/call`) on two boxes, and speaks the exact MCP protocol (`2024-11-05`) Warp uses. Genie stays 4-runtime-deps-lean — no 5th dep (`@modelcontextprotocol/sdk`) required. The SDK remains the documented fallback (dynamic-imported like `nats` in `omni.ts`) **only if** Warp's live UI later reveals a framing/handshake quirk during Felipe's eyeball check (see Warp evidence below) — nothing observed suggests it will.

Throwaway server: `.genie/wishes/genie-mcp/spike/server.mjs` (runs under both `node` and `bun`; NOT in `src/`).

## Framing

**Newline-delimited JSON** — one JSON-RPC 2.0 object per line on stdin/stdout, no embedded newlines, no `Content-Length` headers. This is the MCP stdio transport (Content-Length framing is LSP, not MCP). Confirmed: real Claude Code connected and invoked a tool against the newline-delimited server with no framing negotiation.

Handshake contract:
- Client → `initialize` (`params.protocolVersion: "2024-11-05"`, `capabilities`, `clientInfo`).
- Server → result envelope `{ protocolVersion, capabilities: { tools: {...} }, serverInfo: { name, version } }`.
- Client → `notifications/initialized` (a notification — **no `id`, no response**; the server must not reply).
- Then `tools/list`, `tools/call`, (optional `ping`, `resources/list`, `resources/read`).
- Notifications (messages with no `id`) get NO response. Unknown method with an `id` → JSON-RPC error `-32601`.
- **Flush before exit:** on stdin `end`, drain stdout before `process.exit(0)` or the last response truncates (mirrors the WISH G2 impl note).

## Evidence per client

### Claude Code — CONFIRMED end-to-end (both Mac + Linux)

- **Mac (local):** project `.mcp.json` was auto-discovered and listed by `claude mcp list` as `⏸ Pending approval` (the expected project-scope security gate — project servers require workspace trust before connecting). Adding the identical server at `--scope local` (auto-approved) health-checked to **`✔ Connected`** (a real `initialize` handshake). A headless `claude -p "...call the echo tool..." --allowedTools mcp__genie-spike__echo` returned the tool's exact output `echo: spike-ok-12345` → proves `initialize` + `tools/list` + `tools/call` through the real client.
- **Linux box `felipe` (where Warp-over-SSH would spawn the server):** the same hand-rolled server health-checked to **`✔ Connected`** under Claude Code `2.1.199`.
- Both registrations were removed after testing.

Claude Code `.mcp.json` notes for G3:
- `type: "stdio"` is **optional** — a server object with `command` present defaults to stdio.
- Project `.mcp.json` servers are **pending approval** until the user trusts the workspace (runs `claude` interactively and accepts the trust dialog) — expected, not a bug; document it.
- Supports `${VAR}` env expansion and an optional per-server `"timeout"` (ms).

### Warp — schema + protocol CONFIRMED; live UI connection NEEDS FELIPE'S EYES

`felipe` is a **Linux** dev box (`warp-terminal` Linux build) that Felipe reaches **via Warp's SSH remote feature** — the Warp GUI runs on Felipe's Mac and drives a `~/.warp/remote-server/` component on `felipe`. Warp opens the repo on the remote, so it discovers `<repo>/.warp/.mcp.json` **on `felipe`** and spawns the stdio server **on `felipe`**.

Confirmed without the GUI:
- **Authoritative schema** — Warp's own bundled skill on the box: `~/.warp/remote-server/bundled_resources/bundled/skills/add-mcp-server/SKILL.md` (see Config Schema below). This is Warp's shipped source of truth, not a third-party doc.
- **Warp's MCP subsystem is live on the remote** — `~/.local/state/warp-terminal/oz/warp.log`: `mcp_static_config: Some(McpStaticConfig{...})` and `Converting 0 legacy MCP servers into templatable MCP servers` (0 because the scratch repo hasn't been opened in a Warp session yet).
- **The server runs where Warp spawns it** — the raw `initialize`/`tools/list` handshake was replayed with `node` on `felipe` and returned correct envelopes.
- **Config staged for eyeball** — `~/genie-mcp-spike/scratch-repo/.warp/.mcp.json` (+ `.mcp.json`) on `felipe`, pointing at `~/genie-mcp-spike/server.mjs`.

**What needs Felipe's eyes (cannot be driven over ssh — Warp is a GUI):** open Warp on the Mac → SSH into `felipe` → `cd ~/genie-mcp-spike/scratch-repo` → check **Settings → AI/Agents → MCP servers**. Expect `genie-spike` listed **"Detected from Warp"** and a green/connected status; optionally ask Warp's agent to call the `echo` tool. Warp auto-detects `.mcp.json` changes on save (no restart). Since Warp speaks the same MCP `2024-11-05` JSON-RPC that Claude Code accepted against this exact server, the risk is low; the only unproven bit is Warp's client-side connect, not the protocol.

## Config schema (both files)

**Identical shape for both clients.** Both use the top-level `mcpServers` key and the stdio `{ command, args, env?, working_directory? }` per-server object — a single JSON body satisfies both files. `type: "stdio"` is optional (omit it).

Locations (PROJECT scope — what G3 writes; distinct from the GLOBAL launch-config path):
- Warp project: `<repo>/.warp/.mcp.json` — spawns from repo root by default. (Global would be `~/.warp/.mcp.json`.) **Distinct from** the launch-config emitter's global `~/.warp/launch_configurations/`.
- Claude Code project: `<repo>/.mcp.json` — checked into version control; team-shared.
- (Warp also reads `~/.claude.json` as a *global* config, per its bundled skill — not used by this wish.)

Warp recognizes these wrapper keys, in order of preference: `mcpServers` (preferred), `mcp_servers`, `servers`, nested `mcp.servers`, or a flat map. G3 writes/merges under **`mcpServers`** and preserves whichever wrapper key an existing file already uses. Never remove existing server entries — add/update only the `genie` entry.

Concrete genie block (what G3 writes to BOTH `<repo>/.warp/.mcp.json` and `<repo>/.mcp.json`):

```json
{
  "mcpServers": {
    "genie": {
      "command": "/absolute/path/to/genie",
      "args": ["mcp"]
    }
  }
}
```

## Spawn `command` form (pinned)

**Use an ABSOLUTE path to the genie binary — NOT bare `"genie"`.** `{"command":"genie","args":["mcp"]}` assumes `genie` is on the spawning process's PATH, which is NOT reliable:
- **Mac (this install):** `genie` is **not** on PATH — it lives only at `~/.genie/bin/genie` (a 59 MB bun-compiled single-file binary). Bare `genie` would fail to spawn.
- **`felipe` (Linux):** `genie` IS on PATH (`/home/genie/.local/bin/genie`, also `~/.genie/bin/genie`).

Recommendation for G3: at `genie init`/`launch` time, resolve the **absolute path of the currently-running genie executable** (for the bun-compiled binary that is `process.execPath`) and write that as `command`, with `args: ["mcp"]`. Fallback: `~/.genie/bin/genie` expanded to an absolute path. This is self-consistent under Warp-over-SSH: `genie init` runs on the box that owns the repo (e.g. `felipe`), so it writes that box's genie path, and Warp spawns the server on that same box. Warp supports `${VAR}` substitution, but a resolved absolute path is simpler and avoids PATH ambiguity.

## Tools contract for G2 (the 5 read-only tools)

All backed by the existing read layer in `src/lib/v5/task-state.ts` (`getBoardByName`, `getTask`, `listTasks{status,wish,boardId}`, `getWishGroups`) over a **net-new `new Database(resolveDbPath(cwd), { readonly: true })`** open (NOT `openSqlite()`); degrade to an empty board when the db file is absent. `resolveDbPath()` (in `src/lib/v5/genie-db.ts`) yields the worktree-shared `.genie/genie.db`.

`tools/call` result envelope (MCP standard): `{ "content": [{ "type": "text", "text": "<JSON.stringify(payload)>" }], "isError": false }`. Optionally also set `structuredContent` to the payload object. Payload shapes below (from `TaskRow`/`WishGroupRow`/`BoardRow`).

Reference types (`task-state.ts`): `TaskStatus = 'blocked'|'ready'|'in_progress'|'done'`; `TaskRow = { id, boardId, title, status, claimedBy, claimedAt, wish, group, createdAt, updatedAt }`; `WishGroupRow = { wish, name, status, dependsOn:string[], assignee, startedAt, completedAt }`; `BoardRow = { id, name, createdAt }`.

1. **`genie_board`** — board counts + tasks, optional wish filter.
   - inputSchema: `{ type:"object", properties:{ board:{type:"string", description:"board name; default repo board"}, wish:{type:"string", description:"filter to a wish slug"} }, required:[] }`
   - payload: `{ board: string|null, counts: { blocked:number, ready:number, in_progress:number, done:number, total:number }, tasks: TaskSummary[] }` where `TaskSummary = { id, title, status, claimedBy, wish, group }`.
   - impl: `getBoardByName(db, board)` → `listTasks(db, { boardId, wish? })`; tally counts.

2. **`genie_wish_status`** — a wish's group/DAG progress.
   - inputSchema: `{ type:"object", properties:{ wish:{type:"string", description:"wish slug"} }, required:["wish"] }`
   - payload: `{ wish: string, groups: { name, status, dependsOn:string[], assignee, startedAt, completedAt }[], tasks: TaskSummary[] }`.
   - impl: `getWishGroups(db, wish)` + `listTasks(db, { wish })`.

3. **`genie_worktree_context`** — resolve the caller's git BRANCH `wish/<slug>-<group>` → its wish/group/tasks (the per-pane "what am I here for").
   - inputSchema: `{ type:"object", properties:{ branch:{type:"string", description:"override; default = current git branch"} }, required:[] }`
   - payload: `{ branch: string|null, resolved: boolean, wish: string|null, group: string|null, tasks: TaskSummary[] }`.
   - impl: read the current branch (`git rev-parse --abbrev-ref HEAD` / `git symbolic-ref`); parse `wish/<slug>-<group>`; on match → `listTasks(db, { wish })` filtered to the group (`resolved:true`); on no match → `resolved:false` with the repo-level board tasks as fallback. Resolve by BRANCH, not path (worktree base dir is configurable via `GENIE_WORKTREES_DIR`).

4. **`genie_task`** — full detail by id.
   - inputSchema: `{ type:"object", properties:{ id:{type:"string", description:"task id, e.g. t_..."} }, required:["id"] }`
   - payload: the full `TaskRow` (`{ id, boardId, title, status, claimedBy, claimedAt, wish, group, createdAt, updatedAt }`) or `{ error: "not_found", id }` (surface a not-found result, not a protocol error).
   - impl: `getTask(db, id)`.

5. **`genie_active`** — all in-progress tasks + who claimed what.
   - inputSchema: `{ type:"object", properties:{}, required:[] }`
   - payload: `{ tasks: { id, title, status, claimedBy, claimedAt, wish, group }[] }`.
   - impl: `listTasks(db, { status: 'in_progress' })`.

Also implement `initialize` (advertise `capabilities.tools`), `tools/list` (the 5 above), and `ping`. `resources/list`/`resources/read` are optional for G2 (the wish lists them but the 5 tools are the required contract); if included, expose the board/wishes as resources mirroring the same payloads.

## Non-MCP startup probe (for G2)

The MCP transport must not load on `genie board`/`task`/`--help`. Because the hand-rolled server is plain stdin/stdout JSON with zero imports, this is trivially satisfied by keeping the server module lazy (only reached inside the `genie mcp` command body). If the SDK fallback is ever taken, dynamic-import it inside `genie mcp` only (nats precedent, `omni.ts`).

## Cleanup done

- Removed both Claude Code registrations (Mac local-scope + felipe local-scope).
- Left intentionally for Felipe's Warp eyeball: `~/genie-mcp-spike/` on `felipe` (server.mjs + scratch-repo with `.warp/.mcp.json` + `.mcp.json`). Safe to `rm -rf ~/genie-mcp-spike` after the Warp check.
- Local Mac scratch repo is under `/var/folders/.../T/` (OS-cleaned tmp).
