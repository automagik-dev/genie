# Wish: genie MCP server — Warp + Claude Code consume genie state

| Field | Value |
|-------|-------|
| **Status** | DONE — G1 spike (hand-rolled) + G2 server + G3 auto-register all SHIP-reviewed (2026-07-03); Warp live-UI QA awaits Felipe |
| **Slug** | `genie-mcp` |
| **Date** | 2026-07-03 |
| **Author** | Felipe + Genie |
| **Appetite** | ~3-4 days |
| **Branch** | `wish/genie-mcp` (from `dev`; PR to `dev`) |
| **Design** | [DESIGN.md](../../brainstorms/genie-mcp/DESIGN.md) |

## Summary

Genie's live state (wishes, tasks, board, what each worktree/pane is working on) is invisible to Warp and to the agents running inside it — the only Warp touchpoint today is a one-shot launch-config emitter. This wish adds a `genie mcp` stdio MCP server that exposes `genie.db` state READ-ONLY as MCP tools/resources, auto-registered into the project `.warp/.mcp.json` + `.mcp.json` by `genie init`/`launch`, so Warp and Claude Code (any MCP client) can read genie's live state — each Warp pane's agent can even ask "what wish/group am I here for."

## Scope

### IN
- `genie mcp` **stdio MCP server** answering `initialize` / `tools/list` / `tools/call` / `resources/list` / `resources/read`, exposing READ-ONLY: `genie_board` (counts + tasks, optional wish filter), `genie_wish_status` (a wish's group/DAG progress), `genie_worktree_context` (resolve the caller's git BRANCH `wish/<slug>-<group>` → its wish/group/tasks), `genie_task` (detail by id), `genie_active` (in-progress + who claimed what).
- The server opens genie.db read-only via a **net-new `new Database(path,{readonly:true})`** (NOT `openSqlite()`, which force-creates + runs write pragmas) and DEGRADES to an empty board when the db file is absent.
- **Auto-registration** for Warp + Claude Code: `genie init` (and `genie launch` per worktree) JSON-merge-writes the project `<repo>/.warp/.mcp.json` AND `<repo>/.mcp.json`, registering `genie mcp` under `mcpServers` — parse → merge only the genie entry → preserve all other keys/servers → byte-identical rerun.
- An automated MCP-protocol test (initialize → tools/list → tools/call), a readonly + absent-db test, and a non-MCP-path init probe (the MCP transport/dep must not load on `board`/`task`/`--help`).
- Docs: how Warp/Claude Code pick up the genie MCP server + the honest tab-info limitation (ask-don't-push).

### OUT
- WRITE tools (claim/complete task, create/advance wish) — a later wish; no second mutation path now.
- **Codex** coverage — Codex reads `~/.codex/config.toml` (TOML, global), NOT `.mcp.json`; wiring genie into Codex is a separate later item. This wish covers Warp + Claude Code only.
- HTTP/SSE transport / any resident daemon (stdio only).
- Pushing tab titles/blocks into Warp from outside — Warp exposes no such API (passive integration only).
- Any omni work; the global `~/.genie/genie.db` omni tables.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Read-only mirror now; write later | Delivers the "Warp consumes genie state" ask safely; no mutation path racing the CLI/skills/§19 |
| 2 | stdio CLI-command server, not HTTP/SSE | Zero-daemon lightweight-body fit; the MCP client launches it on demand, reads genie.db, exits |
| 3 | Auto-register Warp + Claude Code (.warp/.mcp.json + .mcp.json); Codex deferred | Both speak MCP and both are covered by these two project files; Codex uses a different global TOML format |
| 4 | Read-only DB open is NET-NEW code (G2 owns it) | `openSqlite()` always opens read-write with write pragmas; the server opens `{readonly:true}` itself + degrades on absent db |
| 5 | G1 SPIKE decides hand-rolled MCP vs official SDK | genie is 4-deps-lean; a hand-rolled JSON-RPC-over-stdio avoids a 5th dep (Bun.YAML precedent) BUT must satisfy real Warp + Claude Code clients — verify against both first; dynamic-import the SDK (nats precedent) if needed |
| 6 | `genie_worktree_context` resolves by git BRANCH, not path | The worktree base dir is configurable (`GENIE_WORKTREES_DIR`); branch `wish/<slug>-<group>` is the stable key |
| 7 | Config writes are JSON parse/merge/preserve, not line-append | Never clobber a user's existing MCP servers; byte-identical rerun |

## Success Criteria

- [x] `genie mcp` answers MCP `initialize` + `tools/list` + `tools/call` over stdio and returns real genie.db state (board / wish_status / worktree_context) — automated protocol test; opens the db read-only and degrades to an empty board when absent.
- [x] `genie init` JSON-merge-writes idempotent `<repo>/.warp/.mcp.json` + `<repo>/.mcp.json` registering `genie mcp` (byte-identical on rerun; a pre-existing MCP server is preserved).
- [ ] A real Warp AND a real Claude Code session connect to `genie mcp` and read genie state (manual QA recorded in qa.md).
- [x] Non-mcp paths (`genie board`/`task`/`--help`) do not initialize the MCP transport/dep (startup probe).
- [x] Full `bun run check` + build green; CI green on the PR.

## Execution Strategy

| Wave | Groups | Notes |
|------|--------|-------|
| 1 | Group 1 | Spike: transport verdict + Warp/CC config schema — gates G2/G3 |
| 2 | Group 2, Group 3 | Server ∥ auto-registration (disjoint: `src/term-commands/mcp.ts`+lib vs `init.ts`/`launch.ts` config-writing) |

---

## Execution Group 1: Spike — MCP transport + Warp/Claude Code config schema
**Goal:** Decide hand-rolled-MCP-vs-SDK and pin the exact config format by testing against real Warp + Claude Code MCP clients before building.

**Deliverables:**
1. A throwaway minimal stdio MCP server (under `.genie/wishes/genie-mcp/spike/`) implementing `initialize` + `tools/list` + one trivial `tools/call`, registered via a project `.warp/.mcp.json` AND `.mcp.json` in a scratch repo, and CONNECTED FROM real Warp AND real Claude Code — record whether the hand-rolled JSON-RPC satisfies both clients (or the official SDK is required).
2. `.genie/wishes/genie-mcp/SPIKE.md`: verdict (hand-rolled | SDK), the exact `.warp/.mcp.json` + `.mcp.json` schema (keys, the `command`/`args` shape, project vs global location), the spawn `command` form that actually runs on this install (global `genie` vs the dist/bun path), and the tools/resources JSON contract Group 2 must implement.

**Acceptance Criteria:**
- [x] SPIKE.md documents the transport verdict + the confirmed config schema + command form, with evidence from BOTH real clients.
- [x] The scratch config uses the PROJECT `<repo>/.warp/.mcp.json` (confirmed distinct from the global `~/.warp/launch_configurations/`).

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
test -f .genie/wishes/genie-mcp/SPIKE.md
grep -qiE '^## Verdict: (hand-rolled|SDK)' .genie/wishes/genie-mcp/SPIKE.md
grep -q 'mcpServers' .genie/wishes/genie-mcp/SPIKE.md
grep -qiE 'command' .genie/wishes/genie-mcp/SPIKE.md
```

**depends-on:** none

---

## Execution Group 2: `genie mcp` server + read-only tools
**Goal:** A working stdio MCP server exposing genie.db state read-only, per the G1 verdict.

**Deliverables:**
1. `src/term-commands/mcp.ts` (+ a lib module for the tool implementations) — `genie mcp` stdio server per G1 (hand-rolled or dynamic-imported SDK); the 5 read-only tools/resources over genie.db reads (`getBoardByName`, `listTasks{wish,status}`, `getTask`, `getWishGroups`, `claimed_by`); registered in `src/genie.ts`.
2. Net-new **`new Database(path,{readonly:true})`** open (NOT `openSqlite()`), degrading to an empty board when the db file is absent; `genie_worktree_context` resolves by the git branch `wish/<slug>-<group>` with a repo-level-board fallback when the branch doesn't match.
3. If the SDK is used, dynamic-import it inside `genie mcp` only (nats precedent).
4. Tests: an MCP-protocol test (spawn `genie mcp`, drive initialize → tools/list → tools/call, assert real genie.db state); a readonly + absent-db test; a non-mcp init probe (the MCP transport/dep is NOT loaded on `board`/`task`/`--help`).

**Acceptance Criteria:**
- [x] `genie mcp` answers initialize/tools/list/tools/call over stdio with real genie.db state; opens read-only; degrades to empty board on absent db.
- [x] Non-mcp paths don't initialize the MCP transport/dep (probe test).
- [x] typecheck + `bun test` for the mcp module + build green; `--help` lists `mcp`.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test src/term-commands/mcp.test.ts
bun run typecheck
bun run build
bun dist/genie.js --help | grep -qE '^  mcp' || { echo "FAIL: mcp command missing"; exit 1; }
# protocol smoke: initialize returns a result envelope (capture to a var to
# neutralize SIGPIPE/pipefail; timeout guards a non-exiting server; first line only)
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}'
OUT=$(printf '%s\n' "$INIT" | timeout 10 bun dist/genie.js mcp 2>/dev/null | head -n1 || true)
echo "$OUT" | grep -q '"result"' || { echo "FAIL: mcp initialize no result"; exit 1; }
```

> **G2 impl note:** the stdio server must flush the pending `initialize` response BEFORE exiting on stdin `end` — do NOT `process.exit(0)` on `stdin.on('end')` before async response writes drain, or stdout truncates. Also confirm a `claimed_by` column exists on TaskRow for `genie_active` (one-line check).

**depends-on:** group-1

---

## Execution Group 3: Auto-registration + docs
**Goal:** `genie init`/`launch` wire `genie mcp` into Warp + Claude Code, preserving any existing config.

**Deliverables:**
1. `genie init` (and `genie launch` per worktree) JSON-merge-writes `<repo>/.warp/.mcp.json` + `<repo>/.mcp.json` registering the `genie mcp` command (per the G1 command form) under `mcpServers`: parse existing → add/update only the `genie` entry → preserve all other servers/keys → byte-identical on rerun. Create the file when absent.
2. Docs: a short guide on how Warp + Claude Code pick up the genie MCP server, the state it exposes, and the honest tab-info limitation (ask-don't-push).
3. Tests: idempotent merge test — empty case AND a pre-populated `.mcp.json` with ANOTHER server (assert the other server survives + byte-identical rerun); `genie init` in a fixture repo registers `genie mcp` in both files.

**Acceptance Criteria:**
- [x] `genie init` writes/merges both files registering `genie mcp`; a pre-existing MCP server is preserved; rerun is byte-identical.
- [x] Docs updated; the tab-info limitation stated honestly.
- [x] Full `bun run check` green.

**Validation:**
```bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
GENIE_JS="$PWD/dist/genie.js"
bun run build
bun test src/term-commands/init.test.ts
D=$(mktemp -d)/repo; mkdir -p "$D"; git -C "$D" init -q
# pre-populate .mcp.json with another server; assert it survives + genie is added
printf '%s\n' '{"mcpServers":{"other":{"command":"x"}}}' > "$D/.mcp.json"
( cd "$D" && bun "$GENIE_JS" init >/dev/null 2>&1 )
python3 -c "import json;d=json.load(open('$D/.mcp.json'))['mcpServers'];assert 'other' in d,'other server dropped';assert 'genie' in d,'genie not registered'"
test -f "$D/.warp/.mcp.json"
bun run check
```

**depends-on:** group-1

---

## Cross-wish dependencies
- **Builds on** warp-integration (the launch worktree/branch convention `wish/<slug>-<group>` that `genie_worktree_context` resolves).
- **Enables** (later wishes): MCP WRITE tools; Codex TOML wiring; richer per-agent genie context.
