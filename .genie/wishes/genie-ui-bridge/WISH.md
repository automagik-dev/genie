# Wish: genie ui-bridge — the UI's stdio channel into CLI-only genie

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `genie-ui-bridge` |
| **Date** | 2026-07-21 |
| **Author** | Felipe (channel/home/timing ratified via explicit picker 2026-07-21) + Fable orchestrator |
| **Appetite** | medium |
| **Branch** | `wish/genie-ui-bridge` |
| **Repos touched** | genie (this repo only) |
| **Design** | [DESIGN.md](../../brainstorms/genie-ui-bridge/DESIGN.md) |

## Summary

Give the separate-repo genie UI (the dash fork) a sanctioned channel into CLI-only genie: a new `genie ui-bridge` command — a long-lived stdio MCP server the UI spawns and owns — carrying reads (reused from `genie mcp`), exactly two roster write tools, and change-push notifications from an in-child `PRAGMA data_version` watcher. The contract across the repo boundary becomes a versioned protocol with a handshake instead of the raw `genie.db` schema; genie stays zero-daemon because the child lives and dies with the UI. This wish also owns the genie-side `hire_roster` substrate (moved here from `genie-ui-dash` G5 per the design review) and **blocks** `genie-ui-dash` Groups 4–5, which are amended to consume the bridge.

## Scope

### IN

- Genie-side roster substrate: `hire_roster` additive migration in `src/lib/v5/genie-db.ts` (`CREATE TABLE IF NOT EXISTS` + `EXPECTED_TABLES` entry; `user_version` stays 1), roster upsert/delete operations in `src/lib/v5/task-state.ts`, and `StateExport`/`exportState()` extension so roster rows surface in `genie task export`.
- `genie ui-bridge` command: reuses `genie mcp`'s hand-rolled newline-JSON-RPC transport loop + five read tools over `openReadonlyDb`; adds a version-negotiating `initialize` handshake (structured error on incompatible client version), a notifications channel, a write-capable db handle, the `roster_hire`/`roster_unhire` tools, and the watcher loop (fs-watch `-wal` + `PRAGMA data_version` poll at 250–500 ms) emitting change notifications.
- Lifetime contract: exit promptly on stdin EOF; ppid backstop (`process.ppid != original parent`); never opens a socket or port.
- `genie mcp` stays byte-for-byte read-only — write tools exist only in `ui-bridge`; shared plumbing is extracted, not forked.

### OUT

- Any resident server (`genie ui serve`, websocket/HTTP) — parked per design; the protocol can ride a socket later if a remote UI ever materializes.
- Write tools beyond the roster pair — every future write tool is its own recorded decision.
- Hybrid direct-SQLite reads for the UI, remote/multi-machine operation, auth, transport encryption.
- The dash-side bridge client itself — that is `genie-ui-dash` G4/G5 (amended); this wish only publishes the channel.
- Migrating Warp/CC/Codex off the read-only `genie mcp`.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | All six design decisions (channel = UI-owned stdio MCP child; sibling command; adopt-now; data_version push; roster-only write surface; handshake skew policy) are inherited verbatim from the SHIP-stamped [DESIGN.md](../../brainstorms/genie-ui-bridge/DESIGN.md). | Digest-bound design review (SHIP, re-reviewed after fixes); Felipe ratified the three governing choices via explicit picker 2026-07-21. Not re-litigated here. |
| 2 | Shared server plumbing is extracted from `src/term-commands/mcp.ts` into a reusable module both commands import — `mcp` keeps its exact current wire behavior. | "Sibling sharing plumbing" without copy-paste drift; the `genie mcp` surface is protected by an explicit no-write-tools test. |
| 3 | The roster substrate (G1) lands before the bridge command (G2) — the write tools are built on real state code, never inline SQL in the command layer. | Writer invariants live in `task-state.ts` where every other state transition lives. |

## Dependencies

**depends-on:** none
**blocks:** genie-ui-dash

## Success Criteria

- [ ] `genie ui-bridge` completes an initialize handshake over stdio reporting protocol version + genie version; a client declaring an incompatible version receives a structured error, not silence.
- [ ] Read parity: every task/board/wish row surfaced by the bridge's read tools corresponds to the same underlying rows as `genie task export` on the same `.genie/genie.db` (semantic row-level parity test).
- [ ] `roster_hire`/`roster_unhire` create/remove `hire_roster` rows via `task-state.ts` code; rows appear in `genie task export`; a concurrent `genie task create` during roster writes causes no corruption or busy-failure (WAL + busy_timeout concurrency test).
- [ ] Push: an external `genie task create` while the bridge runs yields a change notification to the connected client within 1 s.
- [ ] Lifetime: closing client stdin ends the bridge within 2 s; ppid-backstop path covered by test; the bridge process holds zero listening sockets.
- [ ] `genie mcp` unchanged: a test asserts it registers zero write tools and its initialize response is unmodified.
- [ ] `bun run check` green (typecheck, lint, dead-code, complexity budget, tests).

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 — stateful DB/state-machine work (+2), multi-module touch across genie-db/task-state/export (+1) | engineer-standard / high | `hire_roster` substrate: migration, roster ops, export extension |

### Wave 2 (sequential, after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 5 — protocol/lifecycle orchestration (+2), stateful watcher + write path (+2), no deterministic test for perceived push latency beyond the 1s bound (+1) | engineer-complex / high | `ui-bridge` command: plumbing extraction, handshake, write tools, watcher + notifications, lifetime |

Complexity scoring rubric: score each group independently and record the total plus a short rationale in **Complexity**. Add:

- **+2** each for orchestration / agent-lifecycle / routing; cost / model / escalation; stateful work; subjective acceptance.
- **+1** each for multi-package work; OTel-label dependency; no deterministic test; prior rework; prompt-skill change; CI / release work.

Route the total in **Model** by portable role and reasoning effort: **0–1** →
`engineer-trivial` / low; **2–3** → `engineer-standard` / medium or high;
**4–6** → `engineer-complex` / high; **7+** → `engineer-complex` plus an
independent `final-gate` at the highest justified effort. Codex maps these to
the `genie_*` profiles; other runtimes use their matching native roles. Keep
model and effort in runtime session/agent configuration, never skill frontmatter.

## Execution Groups

### Group 1: hire_roster substrate (migration + state ops + export)

**Goal:** Land the genie-side roster state machine so the bridge's write tools have real code to call.

**Deliverables:**
1. `src/lib/v5/genie-db.ts`: `hire_roster` table via the additive pattern (`CREATE TABLE IF NOT EXISTS`, added to `EXPECTED_TABLES`; `user_version` stays 1) — columns: wish slug, agent adapter id, profile (nullable), worktree binding, hired_at, state.
2. `src/lib/v5/task-state.ts`: `hireAgent(...)` / `unhireAgent(...)` idempotent single-row upsert/delete operations with the same WAL + busy_timeout semantics as existing state transitions; `StateExport` + `exportState()` extended with `hire_roster`.
3. Tests colocated per repo pattern: migration on fresh + already-current DBs, idempotency, concurrency (`Promise.allSettled` with a parallel `genie task create`), export inclusion.

**Acceptance Criteria:**
- [ ] Fresh DB and pre-existing current DB both end up with `hire_roster` (schemaIsCurrent path covered).
- [ ] `genie task export` includes roster rows; hire/unhire round-trip proven in tests.
- [ ] Concurrent writer test passes with clean claim-conflict semantics, no `SQLITE_BUSY` flake.

**Validation:**
```bash
cd /home/namastex/workspace/repos/genie && bun test src/lib/v5/ && bun run check
```

**depends-on:** none

---

### Group 2: `genie ui-bridge` command (protocol + write tools + push + lifetime)

**Goal:** Ship the UI-owned stdio child: negotiated handshake, reused reads, roster write tools, change-push, clean lifetime — with `genie mcp` untouched.

**Deliverables:**
1. Extract the newline-JSON-RPC server loop from `src/term-commands/mcp.ts` into a shared module (e.g. `src/lib/v5/mcp-server.ts`); `mcp` re-imports it with zero wire-behavior change.
2. `src/term-commands/ui-bridge.ts`: registers the five read tools + `roster_hire`/`roster_unhire` (calling G1's `task-state.ts` ops via a write-capable handle from `sqlite-open.ts`); version-negotiating `initialize` (bridge protocol version + genie version; structured error on declared-incompatible client); notifications channel emitting change events; watcher loop (`PRAGMA data_version` poll 250–500 ms + fs-watch on `genie.db-wal`); lifetime = stdin EOF exit + ppid backstop; command registered in `src/genie.ts`.
3. Tests: handshake happy/incompatible paths; read parity vs `exportState()`; write tools round-trip + concurrency; push-within-1s (external write → notification); shutdown-within-2s on stdin close; ppid backstop; zero-listening-sockets assertion; `genie mcp` regression test (zero write tools, unchanged initialize response).
4. Contract doc: `src/lib/v5/UI-BRIDGE.md` — protocol version, tool list, notification semantics, skew policy — the page the dash-fork client is built against.

**Acceptance Criteria:**
- [ ] Wish Success Criteria 1–6 pass via this group's tests (criterion 7 via validation).
- [ ] `src/term-commands/mcp.ts` diff is import-refactor only; its tests and wire behavior are unchanged.
- [ ] Contract doc exists and names the protocol version the handshake reports.

**Validation:**
```bash
cd /home/namastex/workspace/repos/genie && bun test src/term-commands/ src/lib/v5/ && bun run check
```

**depends-on:** Group 1

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: spawn `genie ui-bridge` from a scratch stdio client (script harness) in a repo with real wishes — handshake, board read, hire, notification on external `genie task create`, unhire, EOF shutdown.
- [ ] Integration: roster rows written through the bridge appear in `genie task export` and survive normal CLI usage + `genie doctor`.
- [ ] Regression: `genie mcp` consumers (Warp/CC/Codex config from `genie init`) work unchanged; `bun run check` green on dev.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Plumbing extraction subtly changes `genie mcp` wire behavior | Medium | Regression test pins mcp's initialize response + tool list before/after; diff constrained to imports |
| Poll-based push exceeds the 1 s bound under load | Low | Bound is 2–4× the poll interval; test asserts it; interval tunable |
| Orphaned bridge children | Low | stdin EOF covers the crash path; ppid backstop tested (subreaper-aware predicate) |
| Concurrent writers (bridge vs CLI) | Low | WAL + busy_timeout via `sqlite-open.ts`; idempotent single-row ops; concurrency tests in G1 and G2 |
| Scope creep toward a general write API | Medium | OUT-scoped; review gate rejects any tool beyond the roster pair |
| Cognitive-complexity budget on the bridge composition root | Low | Split at real boundaries (transport, watcher, tools) per CLAUDE.md; budget gate enforces |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan Review — 2026-07-21T18:50:26Z
- Reviewer: independent read-only (genie:review plan pipeline)
- Target: .genie/wishes/genie-ui-bridge/WISH.md (design-linked)
- Verdict: SHIP

Design evidence: design-review-evidence.mjs verify DESIGN.md → exit 0
  (SHA-256 1766eea7…471a82, SHIP, reviewer aa8db4e7fd3ff5a6f, 2026-07-21T18:38:54Z); re-verify exit 0.
Checklist: problem testable ✓ · IN/OUT concrete ✓ · every group testable AC (G1,G2) ✓ ·
  bite-sized (G1=3, G2=5, routed engineer-complex) ✓ · deps tagged (G1 none, G2→G1; wish blocks dash) ✓ ·
  validation runnable ✓.
Files verified present: src/term-commands/mcp.ts; src/lib/v5/{genie-db,task-state,sqlite-open,mcp-tools}.ts.
  New files correctly absent (ui-bridge.ts, mcp-server.ts, UI-BRIDGE.md).
Commands verified real: bun test src/lib/v5/ ; bun test src/term-commands/ src/lib/v5/ ; bun run check.
Reuse premise verified: MCP_TOOLS = exactly 5 read tools; transport loop in mcp.ts, tools in mcp-tools.ts → extraction feasible.
Design→wish fidelity: all 5 design IN bullets + SC1–6 covered (wish SC6 stricter, in-scope).
  Design SC7 (UI-repo no-SQLite-driver) correctly DELEGATED to dash G4/G5 grep gate (bridge OUT-scopes the dash client) — not dropped.
  Nothing smuggled (mcp-server.ts extraction + UI-BRIDGE.md are design-sanctioned).
Task rows: genie task list --wish genie-ui-bridge → 2 (group-1, group-2), ready.
Advisory: G2 is a broad group; treat its sub-deliverables as internal seams (Risks table already names the split-at-boundaries mitigation).

_Orchestrator disposition (2026-07-21): SHIP persisted, status set to APPROVED. G2's sub-deliverables to be treated as internal seams per the advisory._

---

## Files to Create/Modify

```
src/lib/v5/genie-db.ts (+ genie-db.test.ts)        # G1 — hire_roster additive migration + EXPECTED_TABLES
src/lib/v5/task-state.ts (+ task-state.test.ts)    # G1 — hire/unhire ops + StateExport/exportState extension
src/lib/v5/mcp-server.ts (new, + test)             # G2 — extracted shared JSON-RPC server loop
src/term-commands/mcp.ts                           # G2 — import-refactor only (wire behavior frozen)
src/term-commands/ui-bridge.ts (+ test)            # G2 — the bridge command
src/genie.ts                                       # G2 — register ui-bridge command
src/lib/v5/UI-BRIDGE.md                            # G2 — protocol contract doc for the dash-fork client
.genie/wishes/genie-ui-bridge/WISH.md              # this document
```
