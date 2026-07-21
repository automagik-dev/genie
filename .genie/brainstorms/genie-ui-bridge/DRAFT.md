# Brainstorm: genie-ui-bridge — how a separate-repo, stateful UI talks to a CLI-only genie

**Started:** 2026-07-21 · **WRS:** 100/100 (Problem ✅ Scope ✅ Decisions ✅ Risks ✅ Criteria ✅) — crystallized to [DESIGN.md](DESIGN.md)

**Resolved 2026-07-21 (Felipe, explicit picker choices):** channel = (c) UI-owned stdio bridge (MCP); home = sibling `genie ui-bridge` command, `genie mcp` stays read-only; timing = adopt now (amend genie-ui-dash G4/G5 before work starts).

## Problem

If genie-ui (the dash fork) lives in a separate repo and genie stays CLI-only — zero-daemon, no API, no socket — a stateful real-time desktop UI has no sanctioned channel for reads, writes, or change-push; the current genie-ui-dash plan (direct SQLite read + one direct-write module) silently turns the private `genie.db` schema into a cross-repo public API.

## Ground facts (verified, do not re-derive)

- genie is zero-daemon: fork-and-exit CLI; per-repo `.genie/genie.db` (bun:sqlite, WAL, worktree-shared via git-common-dir); docs in git. Only optional daemon: `genie omni serve`.
- Existing machine surfaces: `genie mcp` (read-only stdio MCP, spawned per client, no socket), `genie task export` (full JSON), `genie board --json`, and the SQLite file itself.
- SQLite has no cross-process change notification: push must be built from fs-watch on the `-wal` file + `PRAGMA data_version` polling, wherever the watcher lives.
- Approved wish `genie-ui-dash` currently plans: dash-side `GenieStateService` reads genie.db directly (read-only, fs-watch) + `HireRosterService` writes `hire_roster` rows directly. Fine while both live under one roof; the separate-repo question stresses exactly this.

## The real shape of the question

Genie's "backend" is two separable things: **state storage** (SQLite + wish markdown) and **writer invariants** (the task-state machine, roster upsert rules). A separate-repo UI needs three channels: reads (fast, live), writes (invariant-preserving), change-push. The decision is *what becomes the public contract*: the DB schema, the CLI argv/JSON surface, or a session protocol.

## Candidate approaches

### (a) Direct SQLite + fs-watch — schema-as-API (status quo of the wish)
- UI opens genie.db read-only (better-sqlite3/node:sqlite in Electron main; WAL handles concurrent readers cross-driver), fs-watches wal + polls data_version; writes roster rows itself.
- ✅ Simplest now, no genie changes at all. ✅ Fastest reads.
- ❌ Schema becomes a versioned cross-repo public API — genie can never refactor tables freely again. ❌ Writer invariants duplicated in a second codebase (two writers, one DB). ❌ Version skew (old UI, new schema) fails at the SQL level with no handshake.

### (b) CLI-as-API — UI shells out to `genie … --json`
- All reads via `genie board --json` / `task export`; writes via new `genie roster hire|unhire` commands; change detection still fs-watch/data_version on the db file (watching is cheap and read-only).
- ✅ Contract = CLI flags + JSON shapes (already semi-public, versionable). ✅ genie stays sole writer — invariants live in one place. ✅ Zero new runtime surface.
- ❌ ~30–80 ms process spawn per call (fine at human scale, clunky for chatty UIs). ❌ No push — the UI still owns the watch loop. ❌ JSON output shapes must now be frozen/versioned.

### (c) UI-owned stdio child — protocol-as-API (extend `genie mcp` into the bridge)
- On startup the UI spawns ONE long-lived `genie mcp` (extended) child and speaks MCP over stdio: existing read tools stay; add `roster_hire`/`roster_unhire` write tools (genie's own code = sole writer); add change-push via MCP notifications (the child fs-watches/polls data_version internally and emits resource-updated).
- Child dies when stdin closes → lives and dies with the UI. No socket, no port, nothing resident beyond the UI's own lifetime — genie stays daemon-free by the same trust model `genie mcp` already shipped under.
- Version skew handled by the MCP initialize handshake (server version/capabilities); schema stays private forever.
- ✅ One protocol, mostly already built. ✅ Sole writer preserved. ✅ Real push. ✅ Transport-portable later: the same protocol over a socket IS the remote story if ever needed — no corner painted.
- ❌ genie must accept its first write tools in MCP (today's server is deliberately read-only — a policy change to make explicitly, not slide into). ❌ Slightly more moving parts than (a).

### (d) `genie ui serve` resident server (omni precedent)
- Real websocket/HTTP daemon. ❌ Ports, auth, lifetime management for a single-operator local desktop — ethos violation with no current payoff. Only becomes relevant if UI and repo ever live on different machines. **Parked, not chosen.**

### (e) Hybrid — direct SQLite reads + bridge/CLI writes
- ❌ Two contracts to maintain (schema for reads AND protocol for writes); inherits (a)'s skew problem for the read half. Only justified if bridge read perf proves insufficient — board data is tiny, so it won't.

## Leaning / recommendation (not yet decided — Felipe's call)

**(c)**, concretely as an extension of the existing `genie mcp`: add two write tools + update notifications, UI spawns and owns the child. Protocol-as-API keeps the schema private, keeps genie the sole writer, keeps zero-daemon intact (child ≤ UI lifetime), and the same protocol goes over a socket later if a remote UI ever matters. **Consequence if chosen:** amend genie-ui-dash G4 (GenieStateService → MCP client) and G5 (HireRosterService → calls hire tools; the write path moves INTO genie) — a simplification of the "single write path" story, done before work starts.

## Risks / tensions

- MCP write tools break the "genie mcp is read-only" line in CLAUDE.md/docs — needs an explicit, documented policy carve-out (mirror of the roster exception) or a separate `genie ui-bridge` command sharing the server plumbing to keep `mcp` pristine.
- bun:sqlite (genie) vs Electron-side driver on one WAL db: safe for concurrent read/write (WAL + busy_timeout), but only matters at all under (a)/(e).
- Push loop granularity: data_version polling inside the bridge (e.g. 250–500 ms) is the honest ceiling for "real-time" without a daemon; fine for a kanban, worth stating in criteria.
- Separate-repo release skew: whichever contract wins needs a version handshake + a compat statement (MCP gives this nearly free; CLI JSON needs discipline; raw schema gives none).

## Open questions (blocking Decisions/Criteria)

1. **The channel choice itself** — (a)/(b)/(c) (d,e effectively eliminated above unless Felipe disagrees).
2. If (c): extend `genie mcp` in place vs a sibling `genie ui-bridge` command (same plumbing, keeps `mcp` read-only).
3. Does the initial dash-fork version (genie-ui-dash wish, same-machine, currently effectively same-roof) adopt the chosen channel NOW, or ship (a) as-is and migrate when the repo actually splits?
