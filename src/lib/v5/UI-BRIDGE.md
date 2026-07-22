# genie ui-bridge — protocol contract

The page the separate-repo genie UI (the dash fork) is built against. `genie
ui-bridge` is a long-lived **stdio** MCP server the UI spawns and owns: reads
reused from `genie mcp`, exactly two roster write tools, and change-push
notifications from an in-child watcher. Genie stays zero-daemon — the child lives
and dies with the UI and **never opens a socket or port**.

> Sibling, not a fork. `genie mcp` remains strictly read-only; the write surface
> exists only here. The two commands share one transport (`src/lib/v5/mcp-server.ts`).

## Versions

| Name | Value | Meaning |
|------|-------|---------|
| **Bridge protocol version** | **`1.0`** | Versions the bridge CONTRACT: tool set, notification semantics, write surface. Reported by the handshake as `bridgeProtocolVersion`. |
| MCP wire version | `2024-11-05` | The MCP transport version, reported as `protocolVersion`. Unchanged from `genie mcp`. |
| Genie version | `<genie CLI version>` | Reported as `genieVersion` (and `serverInfo.version`). Independent release cadence. |

The exact protocol version string the handshake reports is **`1.0`**.

## Transport

Newline-delimited JSON-RPC 2.0 — exactly one JSON object per line on
stdin/stdout, no `Content-Length` framing, no embedded newlines. Requests carry
an `id`; the id-less lines the server emits are notifications (below).

## Handshake — `initialize`

The client SHOULD declare its bridge protocol version in the initialize params:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize",
  "params": { "protocolVersion": "2024-11-05", "bridgeProtocolVersion": "1.0" } }
```

Server reply on a compatible (or unstated) version:

```json
{ "jsonrpc": "2.0", "id": 1, "result": {
    "protocolVersion": "2024-11-05",
    "bridgeProtocolVersion": "1.0",
    "genieVersion": "5.x.y",
    "capabilities": { "tools": {}, "experimental": { "genieChangeNotifications": true } },
    "serverInfo": { "name": "genie-ui-bridge", "version": "5.x.y" } } }
```

### Skew policy

Compatibility is by **MAJOR** version. A client that declares
`bridgeProtocolVersion` whose major differs from the server's receives a
**structured JSON-RPC error — never silence**:

```json
{ "jsonrpc": "2.0", "id": 1, "error": {
    "code": -32001,
    "message": "Incompatible genie ui-bridge protocol version: client declared \"2.0\", server speaks \"1.0\"",
    "data": { "serverBridgeProtocolVersion": "1.0", "clientBridgeProtocolVersion": "2.0" } } }
```

A client that declares **no** `bridgeProtocolVersion` is accepted best-effort and
left to decide from the reported `bridgeProtocolVersion` / `genieVersion`
(the UI warns or refuses on a mismatch it cares about). The `genie.db` schema is
**never** part of this contract — it stays private to genie permanently; skew is
survived only through this negotiated handshake.

## Tools

### Read tools (reused from `genie mcp`, identical semantics)

| Tool | Purpose | Required args |
|------|---------|---------------|
| `genie_board` | Board status counts + tasks | — (`board`, `wish` optional) |
| `genie_wish_status` | A wish's execution groups (DAG) + tasks | `wish` |
| `genie_worktree_context` | Resolve a `wish/<slug>-<group>` branch → wish/group/tasks | — (`branch` optional) |
| `genie_task` | Full detail for one task by id | `id` |
| `genie_active` | All `in_progress` tasks + who claimed each | — |

Read results are a read-only projection of `.genie/genie.db`; they degrade to an
empty board when the db is absent. Every task/board/wish row they surface
corresponds to the same underlying rows as `genie task export`
(`exportState()`) — the projections differ, the data does not.

### Write tools (bridge-only — the single write surface)

`roster_hire` and `roster_unhire` call genie's own `task-state.ts` roster ops
(never raw SQL) over a WRITE-capable handle from the canonical `genie-db` →
`sqlite-open` open path (WAL + `busy_timeout`). The write surface is EXACTLY
these two tools; any future write tool is a separate, recorded decision.

**`roster_hire`** — idempotent upsert keyed on `(wish, agentAdapterId)`; a re-hire
refreshes `profile`/`worktree`/`state` but preserves the original `hiredAt`.

```json
{ "name": "roster_hire", "arguments": {
    "wish": "w-alpha",            // required — wish slug
    "agentAdapterId": "codex-1",  // required — agent adapter id (runtime/provider slot)
    "worktree": "/wt/codex-1",    // required — see "worktree is required" below
    "profile": "high",            // optional — provider profile
    "state": "hired" } }          // optional — lifecycle state (defaults to "hired")
```

Result: the persisted `HireRosterRow`
(`{ wish, agentAdapterId, profile, worktree, hiredAt, state }`).

**`roster_unhire`** — idempotent delete.

```json
{ "name": "roster_unhire", "arguments": { "wish": "w-alpha", "agentAdapterId": "codex-1" } }
```

Result: `{ wish, agentAdapterId, removed }` — `removed` is `false` when no row
existed (a no-op), `true` on a real removal.

**`worktree` is required on hire.** This confirms the `hire_roster.worktree NOT
NULL` design: a worktree is always known at hire time because dash binds the
genie-launch worktree when it hires an agent. The bridge enforces it — a
`roster_hire` missing any required field returns an in-band
`{ "error": "invalid_arguments", "missing": [...] }` payload (isError-style,
consistent with `genie_task`'s `not_found`), not a protocol crash.

## Notifications — change push

An in-child watcher polls `PRAGMA data_version` every 250–500 ms (default 300 ms)
and fs-watches the db directory as a wake hint. When the db changes (any other
connection committed — an external `genie task create`, a roster write, etc.) the
server emits an **id-less** notification line:

```json
{ "jsonrpc": "2.0", "method": "notifications/genie/changed", "params": { "dataVersion": 42 } }
```

Semantics: a wake signal, not a diff. The UI re-reads via the read tools; it must
not assume the notification carries the change. Latency bound: an external write
yields a notification within **1 s** (2–4× the poll interval; the fs-watch wake
usually delivers it far sooner). SQLite has no cross-process notify — this poll is
the honest daemon-free ceiling, and is ample for a kanban.

## Lifetime contract

- **stdin EOF → exit within 2 s.** A dead parent closes the pipe write-end; the
  child sees EOF, stops its watcher + backstop, closes its handles, flushes
  stdout, and exits `0` promptly.
- **ppid backstop.** For the case where the parent dies but the stdin write-end
  stays open (a subreaper, or an inherited pipe), the child polls its parent pid
  and exits when it changes from the one captured at startup. Subreaper-aware: it
  does **not** assume reparenting to pid 1, and treats the `0` unknown-ppid
  sentinel as "not orphaned".
- **No socket, ever.** The bridge holds zero listening sockets; it speaks only on
  stdio. Verify with `ss -tlnp` / `lsof` against the child pid — no rows.
- **Zero-daemon.** Nothing survives the UI; the child is fork-and-die under the
  same trust model `genie mcp` shipped with.
