# Design: genie MCP server — Warp + Claude Code consume genie state

| Field | Value |
|-------|-------|
| **Slug** | `genie-mcp` |
| **Date** | 2026-07-03 |
| **WRS** | 100/100 |

## Problem
Genie's live state (wishes, tasks, board, what each worktree/pane is working on) is invisible to Warp and to the agents running inside it — there is no interface for Warp or a Claude Code session to read genie's state; the only Warp touchpoint today is a one-shot launch-config emitter.

## Scope
### IN
- A `genie mcp` **stdio MCP server** exposing genie.db state READ-ONLY as MCP tools + resources: `genie_board` (counts + tasks, optional wish filter), `genie_wish_status` (a wish's group/DAG progress), `genie_worktree_context` (resolve the caller's git BRANCH — `wish/<slug>-<group>` — → its wish, group, and tasks; the per-pane "what am I here for"), `genie_task` (detail by id), `genie_active` (all in-progress + who claimed what). Read layer already exists (`task-state.ts`: getBoardByName, listTasks{wish,status}, getTask, getWishGroups, claimed_by).
- The server opens genie.db **read-only via a net-new `new Database(path,{readonly:true})`** (NOT the existing `openSqlite()`, which force-creates + runs write pragmas) and DEGRADES to an empty board when the db file is absent.
- **Auto-registration for Warp + Claude Code**: `genie init` (and `genie launch` per worktree) writes/merges the PROJECT-scoped `<repo>/.warp/.mcp.json` (Warp) AND `<repo>/.mcp.json` (Claude Code), registering the `genie mcp` command under `mcpServers` — JSON parse → merge only the genie entry → preserve all other keys/servers → byte-identical rerun.
- A minimal automated MCP-protocol test driving the stdio server (initialize → tools/list → tools/call) + a non-MCP-path init probe (the MCP transport/dep must not load on `genie board`/`task`/etc.).
- Docs: how Warp/Claude Code pick up the genie MCP server; the honest tab-info limitation.

### OUT
- WRITE tools (claim/complete task, create/advance wish) — a later wish; designed-for but not built (no second mutation path now; avoids racing the CLI/skills + §19/branch-guard rules).
- **Codex coverage** — Codex reads `~/.codex/config.toml` (TOML, global), NOT `.mcp.json`; wiring genie into Codex's global TOML is a separate later item. (Warp *detecting* Codex's config ≠ Codex seeing genie.) This wish covers **Warp + Claude Code** only.
- HTTP/SSE transport / any resident daemon (stdio only — fits the zero-daemon body).
- Pushing tab titles/blocks into Warp from outside — Warp exposes no such API (passive integration only); pane titles come from the launch config, live status from Warp's native Claude-Code integration.
- Any omni work; the global ~/.genie/genie.db omni tables (this is per-repo task/wish state first).

## Approach
`genie mcp` is a stdio JSON-RPC MCP server that opens the per-repo `genie.db` read-only and answers `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`. MCP clients (Warp, Claude Code) launch it on demand as a CLI-command server per the project `.warp/.mcp.json` / `.mcp.json` that `genie init`/`launch` write. `genie_worktree_context` maps the caller's git branch (`wish/<slug>-<group>`, the stable key — the worktree base dir is configurable via `GENIE_WORKTREES_DIR`) + genie.db → the pane's job. Alternatives considered: HTTP/SSE server (rejected — daemon); pushing state into Warp's UI (impossible — no API); a bespoke non-MCP protocol (rejected — MCP is the standard Warp + Claude Code both speak).

## Decisions
| Decision | Rationale |
|----------|-----------|
| Read-only mirror now; write later | Delivers the "Warp consumes genie state" ask safely; no second mutation path racing the CLI/skills/§19 |
| stdio CLI-command server, not HTTP/SSE | Zero-daemon lightweight-body fit; MCP client launches it on demand, reads genie.db, exits |
| Auto-register Warp + Claude Code (.warp/.mcp.json + .mcp.json) | Both speak MCP and both are covered by these two project files; Codex uses a different (global TOML) format → deferred. Registering both is nearly free and bigger than Warp-only |
| Read-only open is NET-NEW code, owned by G2 | The existing `openSqlite()` always opens read-write with write pragmas; the server must open `{readonly:true}` itself + handle db-absent — not a reuse |
| G1 SPIKE decides hand-rolled MCP vs official SDK | genie is 4-deps-lean (hand-rolled JSON-RPC-over-stdio avoids a 5th dep, like Bun.YAML) BUT must actually satisfy real Warp + Claude Code MCP clients — verify against both before committing (dynamic-import the SDK like nats if needed) |
| `genie_worktree_context` resolves by BRANCH, not path | The worktree base dir is configurable; the branch `wish/<slug>-<group>` is the stable key |
| Merge-if-exists config writes (JSON parse/merge/preserve) | Never clobber a user's existing `.warp/.mcp.json` / `.mcp.json` servers; this is new merge logic, not the gitignore line-append |

## Risks & Assumptions
| Risk | Severity | Mitigation |
|------|----------|------------|
| Hand-rolled MCP subtly incompatible with Warp/CC clients | HIGH | G1 spike tests a minimal server against BOTH real clients before building; fall back to the official SDK (dynamic-imported like nats) if hand-roll fails |
| `.warp/.mcp.json` schema / location wrong | HIGH | G1 verifies the exact schema + pins the PROJECT path `<repo>/.warp/.mcp.json` (distinct from the GLOBAL `~/.warp/launch_configurations/` the emitter uses) against a real Warp |
| MCP dep bloats non-mcp startup | MEDIUM | If SDK is used, dynamic-import it inside `genie mcp` only (nats precedent, omni.ts:10); assert via a startup probe that `board`/`task` never load it |
| Read-only DB open is unbuilt capability | MEDIUM | G2 owns a net-new `new Database(path,{readonly:true})` + db-absent degrade-to-empty; do NOT rely on `openSqlite()` |
| Config write clobbers a user's MCP servers | MEDIUM | JSON parse → merge only the genie `mcpServers` entry → preserve other keys → byte-identical rerun; test empty + populated |
| Spawn `command` not on PATH for all installs | MEDIUM | G1/G3 confirm the launch command form (global `genie` vs the dist/bun install path) so the registered command actually runs |
| worktree→wish branch resolution outside a launch worktree | LOW | Fall back to repo-level board when the branch isn't `wish/<slug>-<group>`; document |

## Execution Groups (seed for /wish)
| Group | Deliverable | Depends on | Validation |
|-------|-------------|------------|------------|
| G1 Spike | Verify: (a) minimal hand-rolled MCP stdio server satisfies real Warp + Claude Code clients (or SDK needed); (b) exact PROJECT `.warp/.mcp.json` + `.mcp.json` schema + the spawn `command` form. SPIKE.md verdict + confirmed config shape | none | SPIKE.md exists; documents transport verdict + config schema + command form with evidence from real clients |
| G2 Server | `genie mcp` stdio server + the 5 read-only tools/resources; net-new readonly genie.db open with db-absent degrade; dynamic dep load if SDK | G1 | MCP-protocol test: initialize→tools/list→tools/call returns real genie.db state; readonly + absent-db test; non-mcp init probe (dep not loaded on board/task) |
| G3 Auto-register | `genie init`/`launch` JSON-merge-write `<repo>/.warp/.mcp.json` + `<repo>/.mcp.json` (preserve other servers); docs | G1 | idempotent merge test (empty + pre-populated with another server, byte-identical rerun preserving the other server); `genie init` in a fixture registers `genie mcp`; docs updated |

## Success Criteria
- [ ] `genie mcp` answers MCP `initialize` + `tools/list` + `tools/call` over stdio and returns real genie.db state (board / wish_status / worktree_context) — automated protocol test; opens the db read-only and degrades to empty board when absent.
- [ ] `genie init` JSON-merge-writes idempotent `<repo>/.warp/.mcp.json` + `<repo>/.mcp.json` registering `genie mcp` (byte-identical on rerun; a pre-existing MCP server is preserved).
- [ ] A real Warp AND a real Claude Code session connect to `genie mcp` and read genie state (manual QA recorded in qa.md).
- [ ] Non-mcp paths (`genie board`/`task`/`--help`) do not initialize the MCP transport/dep (startup probe).
- [ ] `bun run check` + build green.
