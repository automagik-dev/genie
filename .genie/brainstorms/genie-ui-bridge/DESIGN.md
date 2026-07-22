# Design: genie-ui-bridge — UI-owned stdio bridge between a separate-repo UI and CLI-only genie

| Field | Value |
|-------|-------|
| **Slug** | `genie-ui-bridge` |
| **Date** | 2026-07-21 |
| **WRS** | 100/100 |

## Problem

A separate-repo, stateful, real-time genie UI (the dash fork) has no sanctioned channel to a genie that is deliberately CLI-only — no API, no socket, no daemon — and the current fallback (direct SQLite access) silently turns the private `genie.db` schema into a cross-repo public API with writer invariants duplicated in two codebases. This matters now because the approved `genie-ui-dash` wish (G4 read path, G5 write path) is about to build on the fallback shape; Felipe ratified adopting the channel before that work starts.

## Scope

### IN

- A new `genie ui-bridge` CLI command: a long-lived **stdio** MCP server the UI spawns and owns — reads (board/tasks/wishes, reusing `genie mcp`'s read tools + transport loop), exactly two write tools (`roster_hire`, `roster_unhire`), and change-push notifications driven by an in-child watcher (fs-watch on the `-wal` file + `PRAGMA data_version` polling, 250–500 ms). Beyond the reused read plumbing this is net-new protocol surface: a version-negotiating handshake, a notifications channel, a write-capable db handle (the shared `openReadonlyDb` is read-only), and the two write tools.
- Genie-side roster substrate (does not exist today; moves here from the amended wish's G5): `hire_roster` additive migration in `genie-db.ts` (+ `EXPECTED_TABLES` entry), roster upsert/delete operations in `task-state.ts`, and `StateExport`/`exportState()` extension so roster rows surface in `genie task export`.
- Lifetime contract: the child exits promptly on stdin EOF; it never opens a socket or port; nothing survives the UI. Zero-daemon stays intact under the same trust model `genie mcp` shipped with.
- Version-skew contract: the MCP initialize handshake carries the bridge protocol version + genie version; the UI refuses or warns on incompatibility. The `genie.db` schema stays private to genie permanently.
- `genie mcp` untouched and still strictly read-only — the write tools exist only in `ui-bridge`.
- Adoption in the dash fork (amendment to the approved `genie-ui-dash` wish before its work starts): G4 `GenieStateService` becomes a bridge MCP client (no SQLite driver against genie.db in the UI repo); G5 `HireRosterService` becomes calls to the bridge write tools — the "single write path" moves INTO genie, where it belongs.

### OUT

- Any resident server (`genie ui serve`, websocket/HTTP) — parked; the same protocol can ride a socket later if a remote UI ever materializes.
- Hybrid direct-SQLite reads — one contract, not two; board-scale data does not need raw-SQL speed.
- Write tools beyond the roster pair — the bridge is not a general write API; every future write tool is its own explicit decision.
- Remote/multi-machine operation, auth, and transport encryption — meaningless for a stdio child on one box.
- Migrating other `genie mcp` consumers (Warp/CC/Codex) to the bridge — they keep the read-only `mcp` server.

## Approach

The UI spawns exactly one `genie ui-bridge` child at startup and speaks MCP over stdio for all three channels: reads, writes, and push. The bridge **reuses** what `genie mcp` already ships — the hand-rolled newline-delimited JSON-RPC 2.0 transport loop and the five read tools over `openReadonlyDb` — and **adds** the net-new surface: (1) a version-negotiating `initialize` handshake (today's is a fixed response that ignores the client's version), (2) a resources/notifications channel emitting change events, (3) a write-capable db handle alongside the read-only one, (4) the two roster write tools calling genie's own state code, and (5) the watcher loop (`PRAGMA data_version` poll + WAL fs-watch) that drives the notifications so the UI re-reads only when something changed. The contract across the repo boundary is therefore a **versioned protocol with a handshake**, not the raw schema and not frozen CLI JSON.

Alternatives considered and why they lost:
- **Direct SQLite + fs-watch (schema-as-API):** fastest and zero genie changes, but the schema becomes a public API forever, writer invariants split across repos, and version skew fails at the SQL level with no handshake. Rejected by Felipe 2026-07-21.
- **CLI-as-API (`genie … --json` per call):** keeps genie sole writer, but ~30–80 ms spawn per interaction, no push channel (UI must own the watch loop), and every JSON output shape must be frozen. Rejected.
- **Resident `genie ui serve` (omni precedent):** a real daemon with ports and lifetime management for a single-operator local desktop — ethos violation with no current payoff. Parked.
- **Hybrid (direct reads + bridge writes):** two contracts to maintain; inherits the schema-as-API skew problem for the read half. Rejected.
- **Extending `genie mcp` in place instead of a sibling command:** less code but erodes the documented "mcp is read-only" wall for every existing consumer. Felipe chose the sibling command.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Channel = UI-owned stdio child speaking MCP (protocol-as-API). | Keeps schema private, genie the sole writer, zero-daemon intact (child ≤ UI lifetime); the read tools + transport loop are reused from `genie mcp`, while handshake negotiation, notifications, and write tools are honest net-new work; transport-portable if remote ever matters. Felipe's explicit choice over (a)/(b). |
| 2 | Sibling command `genie ui-bridge` sharing `genie mcp`'s plumbing; `mcp` stays pristine read-only. | No policy erosion for existing Warp/CC/Codex consumers; the write capability is a separate, deliberate surface. Felipe's explicit choice. |
| 3 | Adopt now: amend `genie-ui-dash` G4/G5 to consume the bridge before work starts; the bridge work blocks those groups. | No throwaway direct-SQLite code, no two-writer interim state, no migration tax later. Felipe's explicit choice. |
| 4 | Push = in-child watcher (fs-watch `-wal` + `PRAGMA data_version` poll at 250–500 ms) emitting MCP resource-updated notifications. | SQLite has no cross-process notify; polling inside the child is the honest daemon-free ceiling and is ample for a kanban. |
| 5 | Write surface = exactly `roster_hire` / `roster_unhire`, implemented on genie's own roster/task-state code with WAL + busy_timeout semantics. | The single-write-path exception stays single, and its invariants live in one codebase — genie's. |
| 6 | Skew policy: initialize handshake carries protocol + genie versions; UI warns/refuses on mismatch; schema changes never propagate across the repo boundary. | Separate release cadences are survivable only with a negotiated contract. |

## Risks & Assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | MCP client plumbing in Electron main adds complexity vs raw SQL reads | Low | The UI already plans an MCP-ish seam for agents; board payloads are tiny; one client, one child |
| 2 | Poll-based push feels laggy | Low | 250–500 ms data_version polling is sub-perceptual for a kanban; interval stated in criteria, tunable |
| 3 | Orphaned bridge children | Low | stdin EOF covers the normal crash path (a dead parent closes the pipe write-end → child sees EOF); a ppid self-check (`process.ppid != original parent` — Linux may reparent to a subreaper, not always pid 1) is the backstop; test both paths |
| 4 | Concurrent writers (bridge roster write vs genie CLI) | Low | Same `sqlite-open.ts` WAL + busy_timeout semantics; roster ops are single-row idempotent; concurrency test required |
| 5 | Scope creep: bridge becomes a general write API | Medium | OUT-scoped explicitly; every new write tool requires its own recorded decision |
| 6 | genie-ui-dash wish already APPROVED with the direct-SQLite shape | Low | Amendment lands before work starts; amended G4/G5 get a fresh plan review per the review contract |

## Success Criteria

- [ ] `genie ui-bridge` completes an MCP initialize handshake over stdio reporting protocol version + genie version; a client with an incompatible declared version gets a structured error, not silence.
- [ ] Read parity: for the same `.genie/genie.db`, every task/board/wish row surfaced by the bridge's read tools corresponds to the same underlying rows in `genie task export` (semantic row-level parity — the projections differ by design, the data may not).
- [ ] `roster_hire`/`roster_unhire` create/remove `hire_roster` rows via genie's own state code; a concurrent `genie task create` from the CLI during roster writes produces no corruption or SQLITE_BUSY failure (WAL + busy_timeout concurrency test).
- [ ] Push: an external `genie task create` while the bridge is running yields an MCP change notification to the connected client within 1 s.
- [ ] Lifetime: closing the client's stdin ends the bridge process within 2 s; killing the parent process orphans nothing (ppid self-check test). `ss`/`lsof` shows the bridge holding zero listening sockets.
- [ ] `genie mcp` surface unchanged: a test asserts it registers zero write tools.
- [ ] Dash-fork adoption gate (post-amendment): the UI repo contains no SQLite driver import targeting `genie.db` — reads and writes flow only through the bridge client (grep/test gate).

## Next Step

After an independent design review returns SHIP, persist the evidence below and verify its content digest before running `wish`.

<!-- genie-design-review:start -->
## Design Review Evidence

- **Verdict:** SHIP
- **Reviewed content SHA-256:** `1766eea70f9fc1ee902ee1a7321e6969803f72c9eab01c8a918f751377471a82`
- **Reviewer:** genie:reviewer aa8db4e7fd3ff5a6f
- **Reviewed at:** 2026-07-21T18:38:54.000Z
<!-- genie-design-review:end -->
