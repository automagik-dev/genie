# Wish: Operative MCP — write tools for the genie stdio server

| Field | Value |
|-------|-------|
| **Status** | APPROVED |
| **Slug** | `mcp-write-tools` |
| **Date** | 2026-08-11 |
| **Author** | Felipe |
| **Appetite** | medium |
| **Branch** | `wish/mcp-write-tools` |
| **Repos touched** | automagik-dev/genie |
| **Design** | _No brainstorm — direct wish_ |

## Summary

`genie mcp` is today a deliberately read-only stdio MCP server (5 read tools over a readonly SQLite open). This wish makes it fully operative: the server opens `.genie/genie.db` through the standard CLI write path and exposes the operative-core mutation verbs (create, checkout, done, move, block/unblock, release, comment, report, heartbeat, set-wish, add-dependency) as MCP tools that mirror `genie task` CLI semantics exactly. Agents connected over MCP can then drive the board without shelling out to the CLI.

## Scope

### IN

- Switch `genie mcp` from the readonly healing open to a write-path open built on the same fail-closed `resolveProjectContext` binding validation: a wrapper that runs `openDb` and translates every throw (`MalformedDbError`, `ForeignDbError`, `BusyDbError`, any `GenieDbError`) into the loop's `null` contract — never an escaped exception.
- Read-only-degrade fallback: when the write open fails because the database file/filesystem is not writable, fall back to the existing readonly healing open — with `validateReadonlyDb: isCurrentGenieDb` kept strict, so the fallback serves exactly the **fully current** db that passes it (today's behavior, preserved). Read tools keep serving; write tools then return a typed `read_only_database` error payload.
- An opt-in per-result error channel in the shared loop so a tool result can carry `isError: true`, defaulting to today's `isError: false` for every existing payload (read tools' `{ error: 'not_found' }` and ui-bridge's roster `{ error: 'invalid_arguments' }` stay `isError: false`).
- Add operative-core write tools in a **separate registry export** (`MCP_TOOLS` stays the read registry ui-bridge splices): `genie_task_create`, `genie_task_checkout`, `genie_task_done`, `genie_task_move`, `genie_task_block`, `genie_task_unblock`, `genie_task_release`, `genie_task_comment`, `genie_task_report`, `genie_task_heartbeat`, `genie_task_set_wish`, `genie_task_add_dependency` — each a thin wrapper over the exact `task-state.ts` function `v5-task.ts` uses.
- One catch boundary per write tool mapping thrown task-state error classes to typed `isError: true` payload codes (mapping table in Group 2); `genie_task_done` runs `completeTask` + `recomputeReady` like the CLI.
- Explicit identity args: `genie_task_checkout` requires `worker`; every other mutating tool accepts an optional `author`; the server-process env identity (`GENIE_AGENT_NAME`/`GENIE_AGENT_ID` via `resolveWorkerIdentity`) is only the fallback when the arg is absent — so multiple agents on one long-lived server attribute correctly.
- Update the `read-only` wording across the shipped surface: `src/term-commands/mcp.ts`, `src/term-commands/init.ts`, `CLAUDE.md` mcp row, `skills/genie/reference/lifecycle.md` + its `plugins/genie/` mirror, `plugins/hermes-genie/references/{hermes-integration-map,mutation-gates,native-surface}.md`, `plugins/pi-genie/references/native-surface.md`, and the module-header comments in `mcp.ts`/`mcp-tools.ts`/`mcp-server.ts`.
- End-to-end stdio smoke test: initialize → `tools/list` shows 5 read + 12 write tools → create → checkout → done round-trip observable via `genie_board` and the CLI.

### OUT

- Destructive/snapshot operations stay CLI-only: `task delete`, `task export --write`, `task import`, `task sync`, board CRUD, hire-roster writes.
- No behavior changes to `genie ui-bridge` — it keeps injecting its own readonly open and splicing `MCP_TOOLS`; its tests must pass with unchanged assertions.
- No write-mode flag, permission layer, or per-tool authorization inside the server (the MCP client's permission system is the control point).
- No inline roadmap sync on MCP writes — publication to `.genie/roadmap.json` continues via the existing `task sync` git hooks, same as CLI writes.
- No changes to the global `~/.genie/genie.db` (omni queue/inbox).
- No public Mintlify docs changes — the `.docs-vendor` submodule is not checked out here; if a `genie mcp` mention exists there, it is a follow-up in the docs repo.
- No MCP protocol/transport changes — same hand-rolled newline-delimited JSON-RPC loop, same `2024-11-05` version, no capability negotiation.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Read-write is the default; no `--write` flag | User decision. One mode, matches intent; every registered client (`.mcp.json`, `.warp/.mcp.json`, Codex route) passes no args, so no config migration needed. |
| 2 | Operative-core tool set, destructive ops excluded | User decision. Delete/import/sync are recovery/snapshot verbs with diverged-state resolution semantics; agents get the worker+orchestrator loop, humans keep the recovery levers. |
| 3 | Write tools wrap `task-state.ts` functions, never reimplement | The CLI already defines and tests the mutation semantics (atomic claim via `CheckoutConflictError`, ready-set recompute, event attribution); the MCP layer stays a projection+dispatch shell with a catch boundary per tool. |
| 4 | Keep the fail-closed context resolver and hardened binding validation on the write path | Writes into a substituted/symlinked db are strictly worse than reads; the write open must pass the same `resolveProjectDatabaseBinding` gate before `openDb` touches the file. |
| 5 | The no-create guarantee rests on resolver ordering, not open behavior | An absent `genie.db` resolves to `project-database-unavailable` and the loop refuses to call any open on a non-`ok` context — so the write open (whose `openSqlite` would `mkdirSync`/create) is unreachable outside a healthy genie repo. MCP never creates `.genie/` or the db; first creation stays a CLI act. The write open *heals* additive lag by construction, subsuming that half of the healing shim for this server. |
| 6 | The loop seam change is behavioral, not cosmetic: generalized injected-open name/JSDoc **plus** an opt-in per-result error channel | `isError` is hardcoded `false` for handler results today; typed write failures require a channel. It is opt-in per result so every existing read-tool and ui-bridge payload keeps `isError: false` — inferring from an `error` key would silently flip `genie_task` not-found and roster invalid-arguments. |
| 7 | The readonly healing open stays in production as the read-only-degrade fallback, and `validateReadonlyDb` stays the strict `isCurrentGenieDb` | On a write-protected db/filesystem, today's server serves reads for a **fully current** database (the healing open returns before any write attempt and the strict validator passes) — that is the case the fallback must preserve; a pure write open would kill all 5 read tools there (`PRAGMA journal_mode = WAL` fails). The marker-stale shape-current case never reaches a tool call today and is NOT claimed. The validator is not weakened (its docstring forbids weak validation on write paths) and not moved: the strict check applies to whichever handle the open produces. |
| 8 | Identity is an explicit tool argument with env fallback | The CLI's env-derived identity works because each invocation is a fresh process; an MCP server is spawned once per client session with frozen env, so per-call `worker`/`author` args are required for correct multi-agent attribution. |

## Simplicity Case

- **Simplest complete design:** same server, same transport, same tool-registry shape — swap the injected open for a throw-translating wrapper around the standard CLI write open, add an opt-in error flag to the result path, and add thin tool wrappers over existing, tested `task-state.ts` mutations. No new state, no new process model, no new files-on-disk contracts.
- **Added machinery:** the write-open wrapper and per-result error channel — both required by present contracts (the loop's `null`-not-throw open contract; MCP's `isError` semantics for mutation failures). WAL + `busy_timeout` (already shared via `sqlite-open.ts`) is the concurrency story, identical to concurrent CLI writers.
- **Deferred until measured:** per-tool authorization/approval gating (trigger: a deployment where MCP clients must be less trusted than CLI users); a read-only mode flag (trigger: a concrete consumer that needs the old guarantee); exposing destructive verbs (trigger: an agent workflow that demonstrably needs delete/import and can't shell out).
- **Complexity removed:** the healing shim's *additive-lag* purpose disappears on this path (the write open heals by construction); the shim survives solely as the read-only-degrade fallback. No daemon, no lockfile, no queue.

## Dependencies

**depends-on:** none
**blocks:** none

## Success Criteria

- [ ] `tools/list` over stdio returns the 5 existing read tools plus the 12 write tools, each with a JSON input schema.
- [ ] A create → checkout → done round-trip driven purely over MCP mutates `.genie/genie.db`: the task appears via `genie_board`, claim state via `genie_active`, and `genie task list` (CLI) shows the same rows.
- [ ] Cross-process claim contention (two spawned `genie mcp` servers, or one server plus a concurrent CLI writer) yields exactly one winner and a typed `claim_conflict` `isError: true` result for the loser — never `SQLITE_BUSY` or `-32603`.
- [ ] `genie_task_done` recomputes the ready set: a dependent task flips to `ready` observable in the same session.
- [ ] Thrown task-state domain errors (`UnknownTaskError`, `CheckoutConflictError`, `LaneError`, `CycleError`, blocked/not-ready/complete/release transition errors) surface as typed `isError: true` payloads per the Group 2 mapping — never `-32603`.
- [ ] Existing payloads keep `isError: false`: `genie_task` not-found and ui-bridge roster `invalid_arguments` are asserted unchanged.
- [ ] Foreign (`user_version` = 99), foreign-at-v0, and incomplete-v1 databases still produce the typed fail-closed tool error (the three existing `mcp.test.ts` cases), not a crash or `-32603`.
- [ ] On a **fully current** db whose file/filesystem is write-protected, all 5 read tools serve (strict validator intact) and write tools return typed `read_only_database`.
- [ ] Two different `worker` args on one server process produce two different `claimed_by` values.
- [ ] Fail-closed behavior preserved: outside a genie repo (or absent db / unsupported layout) every tool call returns the typed context error, and afterwards neither `.genie/` nor `genie.db` exists.
- [ ] `genie ui-bridge` tests pass with unchanged assertions; the import-graph probe still holds (`mcp-tools.ts` unreachable from `genie.ts`; no static `mcp-tools`/`bun:sqlite` import in `mcp.ts`).
- [ ] Repo-wide `rg -i 'read-only'` finds no remaining claim that the genie MCP server is read-only, modulo a named allowlist (unrelated `CLAUDE.md` uses, readonly-open internals in `mcp-tools.ts`/ui-bridge, sqlite comments).
- [ ] A task created over MCP is published to `.genie/roadmap.json` by an ordinary `genie task sync` (no new sync path).

## Execution Strategy

### Wave 1 (sequential)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 4 — stateful work (+2), contract-sensitive shared seam with a second consumer (+1), degrade-mode failure handling (+1) | engineer-complex / high | Write-path open wrapper, read-only-degrade fallback, opt-in error channel in the shared loop — ui-bridge behavior unchanged |

### Wave 2 (sequential, after Group 1)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 2 | engineer | 3 — stateful work (+2), breadth across 12 verbs with attribution/error-mapping parity (+1) | engineer-standard / high | The 12 operative write tools in a separate registry + colocated tests mirroring CLI semantics |

### Wave 3 (sequential, after Group 2)

| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 3 | engineer | 2 — stateful e2e assertions (+2), otherwise mechanical strings/docs | engineer-standard / medium | End-to-end stdio round-trip test + repo-wide read-only wording sweep |

## Execution Groups

### Group 1: Write-capable server core

**Goal:** `genie mcp` opens `.genie/genie.db` through the standard hardened write path — with throw translation, read-only degrade, and a typed-error result channel — while ui-bridge and all fail-closed guarantees stay behavior-identical.

**Deliverables:**
1. Write-open wrapper in the lazily-loaded tool module: `resolveProjectContext` binding → `resolveProjectDatabaseBinding` revalidation → `openDb`, with **every** throw (`MalformedDbError`, `ForeignDbError`, `BusyDbError`, any error) caught and translated to the loop's `null` contract — the injected open never lets an exception escape (the loop calls it outside any `try`).
2. Read-only-degrade fallback: when the write open fails on a not-writable file/filesystem, fall back to the readonly healing open with `validateReadonlyDb: isCurrentGenieDb` unchanged — serving exactly the fully-current db that passes it. The degraded state is **recomputed per open** (derived from which open produced the current handle), never latched: the loop reopens per call and nulls the handle on context transitions, so a repaired filesystem restores writes and a later failure re-degrades. The healing shim remains this path's production consumer.
3. Shared-loop seam change in `mcp-server.ts`: generalized injected-open field name/JSDoc **and** an opt-in per-result error channel — a tagged handler result the loop **unwraps** before serialization (the payload placed in `content[0].text`/`structuredContent` is the inner value, so wire shapes are unchanged) while setting `isError: true`; every untagged result defaults to `isError: false`. Mechanical call-site update in `ui-bridge.ts` with zero behavior change.
4. Tests: the three fail-closed db cases (user_version=99, foreign-at-v0, incomplete-v1) still return the typed tool error — noting the incomplete-v1 case is refused by the strict validator, not the open, since `openDb` succeeds there without backfilling task columns; non-repo cwd creates neither `.genie/` nor `genie.db`; write-protected fully-current db serves reads; read-tool and roster payloads keep `isError: false`; import-graph probe facts hold.

**Acceptance Criteria:**
- [ ] `genie mcp` in a genie repo serves tools against a writable handle; WAL + `busy_timeout` match `sqlite-open.ts` behavior.
- [ ] Foreign/malformed/busy databases produce the typed fail-closed tool error — no escaped exception, no `-32603`, no startup crash.
- [ ] Outside a genie repo (or with `genie.db` absent), tool calls return the typed context error and no file or directory is created (guarantee enforced by resolver ordering: a non-`ok` context never reaches the open).
- [ ] Write-protected **fully current** db: all 5 read tools serve under the intact strict validator; the per-open degraded state is observable to write tools and clears when a subsequent write open succeeds.
- [ ] `src/term-commands/ui-bridge.test.ts` passes without modification to its assertions; existing `error`-keyed payloads stay `isError: false`.
- [ ] Import-graph probe: `mcp-tools.ts` stays unreachable from `genie.ts`, and `mcp.ts` has no static `mcp-tools`/`bun:sqlite` import.

**Validation:**
```bash
bun test src/term-commands/mcp.test.ts src/term-commands/ui-bridge.test.ts src/lib/v5/mcp-tools.test.ts && bun run check
```
Scope: this touches shared v5 core (`mcp-server.ts`) with two consumers, so the focused suites that can disprove the seam change run first, then the repository-documented full gate (`bun run check`, which ends in the full `bun test`) — sufficient per repo policy for shared-core changes.

**depends-on:** none

---

### Group 2: Operative write tools

**Goal:** The 12 operative-core mutation verbs are MCP tools whose observable db effects are indistinguishable from their `genie task` CLI counterparts.

**Deliverables:**
1. Write-tool registry as a **separate export** (e.g., `MCP_WRITE_TOOLS`) in the same lazy dynamic import — `MCP_TOOLS` stays the read registry ui-bridge splices; `genie mcp` concatenates both. Verbs: `genie_task_create`, `genie_task_checkout`, `genie_task_done`, `genie_task_move`, `genie_task_block`, `genie_task_unblock`, `genie_task_release`, `genie_task_comment`, `genie_task_report`, `genie_task_heartbeat`, `genie_task_set_wish`, `genie_task_add_dependency` — each dispatching to the exact `task-state.ts` function `v5-task.ts` uses.
2. One catch boundary per tool mapping thrown error classes to typed `isError: true` payload codes: `CheckoutConflictError` → `claim_conflict`, `UnknownTaskError` → `not_found`, `LaneError` → `invalid_lane`, `CycleError` → `dependency_cycle`, `TaskBlockedError`/`TaskNotReadyError`/`TaskCompleteError`/`TaskReleaseError` → `refused_transition` (with the class name in `detail`), and — as a backstop for a write reaching a degraded readonly handle past the degraded check — SQLite readonly-write failures (`SQLITE_READONLY`-class errors) → `read_only_database`; other unexpected errors still propagate to the loop's `-32603` backstop. Shapes documented in each tool's description.
3. Explicit identity: `worker` required on `genie_task_checkout`; optional `author` on the other mutating verbs; fallback to the server process's `resolveWorkerIdentity()`/`resolveAuthorKind()` env identity only when the arg is absent.
4. Colocated tests per verb following the existing `mcp-tools.test.ts` fixtures: happy path, mapped domain failure, attribution (two `worker` values → two `claimed_by` values on one in-process registry), and cross-process claim contention (two spawned servers or server + CLI writer) asserting one winner + typed `claim_conflict` (no `SQLITE_BUSY`).
5. Update `mcp.test.ts`'s "exactly the 5 read-only tools" `tools/list` assertion to the new 17-tool surface.

**Acceptance Criteria:**
- [ ] Every verb's observable db effect equals the CLI equivalent's (asserted by driving the tool then reading via `task-state.ts` queries).
- [ ] `genie_task_done` triggers `recomputeReady`; a dependent task becomes `ready` in the same test.
- [ ] Cross-process contention: exactly one success, loser gets typed `claim_conflict`.
- [ ] Every mapped error class produces its payload code; none reaches the client as `-32603`.
- [ ] Attribution: distinct `worker`/`author` args produce distinct `claimed_by`/event-author rows on one server.
- [ ] `MCP_TOOLS` export unchanged (name set and payload shapes); ui-bridge's splice untouched.

**Validation:**
```bash
bun test src/lib/v5/mcp-tools.test.ts src/lib/v5/task-state.test.ts src/term-commands/mcp.test.ts && bun run check
```
Scope: shared v5 core behavior — focused behavior suites that exercise each verb and the state machine, then the repository full gate per repo policy.

**depends-on:** Group 1

---

### Group 3: End-to-end proof + read-only wording sweep

**Goal:** A real stdio client round-trip proves the operative server, and no shipped surface still calls the genie MCP server read-only.

**Deliverables:**
1. E2e stdio test (in `mcp.test.ts`, reusing its spawn harness): initialize → `tools/list` (5 read + 12 write) → `genie_task_create` → `genie_task_checkout` → `genie_task_done` → `genie_board` reflects the terminal state; a follow-up `genie task sync` publishes the card to `.genie/roadmap.json`.
2. Wording sweep across the shipped surface: `src/term-commands/mcp.ts` (command description + module header), `src/term-commands/init.ts` (messages + comments), `CLAUDE.md` mcp row, `skills/genie/reference/lifecycle.md` and its byte-identical mirror `plugins/genie/skills/genie/reference/lifecycle.md`, `plugins/hermes-genie/references/hermes-integration-map.md`, `plugins/hermes-genie/references/mutation-gates.md`, `plugins/hermes-genie/references/native-surface.md`, `plugins/pi-genie/references/native-surface.md`, and header comments in `mcp-tools.ts`/`mcp-server.ts`.
3. Sweep criterion implemented as a repo-wide `rg -i 'read-only'` with a named allowlist (unrelated `CLAUDE.md` uses such as the H3 SessionStart bound, genuine readonly-open internals, sqlite/API doc comments) — recorded in the group's evidence so the criterion can disprove an omission.

**Acceptance Criteria:**
- [ ] E2e round-trip passes against a spawned `genie mcp` process on a real tmpdir repo fixture.
- [ ] Repo-wide `rg -i 'read-only'` output equals the named allowlist — no genie-MCP read-only claim survives, including plugin mirrors.
- [ ] `genie init` output names the operative server accurately.
- [ ] Skill-mirror parity holds where enforced (byte-identical mirrors updated together).

**Validation:**
```bash
bun test src/term-commands/mcp.test.ts src/term-commands/init.test.ts && bun run check
```
Scope: the e2e test and init strings are disproved by their focused suites; the full gate covers lint plus the plugin/skill parity checks the repo enforces — repository-documented gate justifies the scope.

**depends-on:** Group 2

---

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] Functional: from a Claude Code session with the project `.mcp.json`, `mcp__genie__genie_task_create` → `checkout` → `done` works and `genie board` (CLI) shows the moves.
- [ ] Integration: a Warp pane and a Claude Code session against the same repo both mutate the shared `.genie/genie.db` without lock errors; `genie task sync` publishes MCP-created cards to `roadmap.json`.
- [ ] Regression: read tools (`genie_board`, `genie_active`, `genie_wish_status`, `genie_worktree_context`, `genie_task`) return the same payload shapes (including `isError: false` on not-found); `genie ui-bridge` clients unaffected; `genie mcp` outside a repo still fails closed and creates nothing.

---

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Every MCP client silently gains write power on update — trust-surface widening | Medium | Deliberate user decision (read-write default). The MCP client's permission system is the control point (genie's own PreToolUse hooks are matcher-scoped to Bash/Read/Write-class tools, not `mcp__genie__*`); destructive verbs stay CLI-only. Called out in release notes. |
| Seam change in `mcp-server.ts` drifts ui-bridge behavior | Medium | The change is behavioral (error channel) but opt-in per result; ui-bridge tests must pass without assertion changes (Group 1 acceptance) and existing `error`-keyed payloads are pinned `isError: false`. |
| Attribution semantics diverge from CLI (worker/author fallbacks) | Medium | Explicit per-call identity args (Decision 8) with env fallback; Group 2 asserts distinct args → distinct attribution on one server, plus per-verb parity of observable db effects. |
| A missed read-only claim ships in a plugin mirror | Low | Group 3's criterion is a repo-wide `rg` against a named allowlist, not a fixed file list; mirror parity gates in `check` catch drifted mirrors. |
| Write open reaches a foreign/malformed db and crashes the server | Low (after fix) | The wrapper translates every throw to `null`; the three existing fail-closed db tests are pinned in Group 1 acceptance. |

---

## Review Results

_The read-only reviewer returns evidence; the invoking orchestrator appends a timestamped block here after plan, execution, and PR reviews._

### Plan review v1 — 2026-08-11 — FIX-FIRST

Reviewer verdict: **FIX-FIRST** (no re-scoping; wave ordering and locked decisions confirmed sound). Confirmed: the `McpServerConfig` seam supports a caller-owned write open (`mcp-server.ts:98`, ui-bridge precedent); fail-closed resolution is open-mode-independent; no client config migration needed; `AGENTS.md` clean; `bun run check` transitively runs the full suite.

Gaps (all addressed in this revision):
- **H1** `openDb` throws typed errors but the loop calls the injected open outside any `try` → startup crash / `-32603`; three existing fail-closed db tests would break. → Write-open wrapper translating every throw to `null` (Group 1 D1/D4, Decision 5).
- **H2** `isError: true` unreachable — loop hardcodes `false`; naive `error`-key inference would flip `genie_task` not-found and roster payloads. → Opt-in per-result error channel, untagged results stay `false` (Group 1 D3, Decision 6).
- **H3** task-state domain errors are thrown classes (`CheckoutConflictError` etc.), not returned values; no catch boundary planned. → Per-tool catch boundary + explicit class→code mapping (Group 2 D2).
- **M1** "absent db created only under `ok` context" was untestable (absent db ⇒ non-`ok` context). → No-create guarantee restated as resolver ordering (Decision 5).
- **M2** Dropping the healing shim would kill read tools on write-protected dbs (WAL pragma fails) with no detecting test. → Read-only-degrade fallback keeps the shim in production (Group 1 D2, Decision 7).
- **M3** Env-derived identity freezes at server spawn → all agents attribute as one. → Explicit `worker`/`author` args with env fallback (Group 2 D3, Decision 8).
- **M4** Wording sweep missed `skills/genie/reference/lifecycle.md`, plugin mirrors, hermes/pi reference files; `rg` criterion couldn't disprove omissions; public-docs claim unverifiable (submodule absent). → Repo-wide sweep with named allowlist (Group 3 D2/D3); public-docs assertion dropped.
- **M5** `mcp.test.ts` "exactly 5 tools" assertion unlisted; registry placement could break ui-bridge's splice. → Separate `MCP_WRITE_TOOLS` export, `MCP_TOOLS` pinned unchanged, test update listed (Group 2 D1/D5).
- **L1** Import-graph AC restated to the two facts the probe locks. **L2** Claim-contention test now cross-process. **L3** Trust mitigation reworded to the MCP client's permission system.

### Plan review v2 — 2026-08-11 — FIX-FIRST

Reviewer verdict: **FIX-FIRST**. H1–H3, M1, M3–M5, L1–L3 confirmed resolved with correct mechanisms; M2 partially resolved. One new MEDIUM and three LOW gaps (all addressed in this revision):

- **N1 (MEDIUM)** The degrade criterion said "shape-current db serves reads", but the loop's strict `validateReadonlyDb: isCurrentGenieDb` provably refuses the shape-current-but-marker-stale handle; also the incomplete-v1 fail-closed case is owned by the validator, not the open (`openDb` succeeds without backfilling task columns). → Resolution chosen: **narrow the criterion to fully-current dbs** (today's actual serving behavior; zero new machinery). Strict validator explicitly retained, neither weakened nor moved (Decision 7, Group 1 D2/D4, SC/AC restated). The marker-stale case is explicitly not claimed.
- **N2 (LOW)** Degraded flag lifecycle unspecified across per-call reopens. → Degraded state recomputed per open, never latched (Group 1 D2, AC).
- **N3 (LOW)** Tagged results risked changing wire payload shapes. → Loop unwraps the tag before serialization; inner value is the payload (Group 1 D3).
- **N4 (LOW)** No backstop for a write reaching a degraded readonly handle. → `SQLITE_READONLY`-class errors → `read_only_database` mapping row (Group 2 D2).

### Plan review v3 — 2026-08-11 — SHIP

Reviewer verdict: **SHIP**. All eleven v1 findings and all four v2 findings verified resolved with mechanisms that match the code; N1's narrowing applied consistently in all six carrying locations with no "shape-current" residue; no new contradictions; prior resolutions unregressed. Acceptance criteria falsifiable, per-group validation can disprove its own changes, scope consistent with the locked decisions, Group 1 → 2 → 3 ordering correct.

Two LOW notes for the implementing engineer (do not gate execution):
1. Group 1 D2's parenthetical "the loop reopens per call" overstates automatic recovery — the loop reopens only when `ctx.db` is null and stops re-resolving once the context settles at `ok`; the requirement (degraded state never latched, derived from the handle) and its AC are correct as written.
2. A read-only-filesystem open failure and a malformed file both surface as `MalformedDbError` — read D2 as "write open fails → fall back → strict validator adjudicates". The write-protected test needs the existing root/VFS guard pattern from `mcp-tools.test.ts` (~505–533) to stay expressible on all CI images.

Status advanced to APPROVED by the invoking orchestrator on this evidence.

---

### Execution review — Group 1 — 2026-08-11 — SHIP (after 2 fix loops)

Local execution review (reviewer g1-reviewer): **SHIP** — all 6 acceptance criteria met with evidence; focused suites green; diff scope clean; no CRITICAL/HIGH/MEDIUM gaps. Three LOW advisories recorded: sidecar-recovery machinery beyond the plan's Simplicity Case (later re-audited), `walSidecarsEmpty` ENOENT nit, and the reopen-behavior confirmation matching plan-review v3 note 1.

Quality review (reviewer g1-quality-reviewer): **FIX-FIRST** — F1 (MEDIUM) `walSidecarsEmpty` returned false on ENOENT, defeating recovery in its primary scenario (absent -wal); F2 (MEDIUM) zero test coverage for the sidecar machinery, branch unreproducible on the target platform as written; F3 (LOW) BusyDbError conflated with degrade (a merely-busy writable db would be mislabeled read-only for the session); F4 (LOW) TOCTOU shrink; F5 (LOW) comment accuracy (DDL residual overclaim; wal-index field names); F7 (LOW) `openDb` contract docstring. → Fix loop 1 (commit f4bfc55e9) landed all.

Re-review: **FIX-FIRST** — G1 (HIGH): the sidecar-recovery branch was unreachable in production on macOS/bun. The real poison marker (zeroed iChange@8/nPage@20 wal-index header, 0-byte -wal) does NOT throw in `openDb`; `tryWriteOpen` returned a non-degraded broken handle whose writes fail raw `SQLiteError: disk I/O error` — violating the "degraded clears when a subsequent write open succeeds" AC and escaping Group 2's SQLITE_READONLY-class mapping as `-32603`. → Fix loop 2 (commit 531a88507).

Fix loop 2 design adjustment (evidence-backed): the re-reviewer's prescribed post-open `hasStaleReadonlyWalIndex` re-check was not directly usable — byte-diff of the full 32768-byte `-shm` showed the REAL poison is byte-for-byte IDENTICAL to a healthy virgin header (0 differing bytes, multiple runs), so the predicate alone false-positives on every healthy open. Minimal distinguishing state lives on the HANDLE: after a successful non-busy open, when the stale-header predicate is true, run `PRAGMA wal_checkpoint(PASSIVE)` — healthy opens self-heal and return a busy:0 row; poison throws SQLITE_READONLY (→ close, return null, existing recovery+retry runs); busy returns a busy row (never throws). PASSIVE never discards frames; recovery guards unchanged (absent/empty -wal only, re-checked immediately before removal). F3 busy carve-out intact.

Final re-review: **SHIP** — byte-identity finding reproduced independently; probe classification empirically verified under live writer contention (same-process and cross-process; busy rows, never spurious throws; live writers produce non-stale headers so the probe is skipped); F1-F7 and all pinned surfaces intact; focused suites 83/83; full gate exactly the 2 known environment flakes (Codex doctor 120ms latency budget on this machine; updateCommand unwritable-record-store test); S1→S2 reproduced 4/4 on the pure production path with a writable non-degraded handle and a successful INSERT. Residual LOWs (non-gating, recorded): seam test is a deliberate per-platform pin of the macOS/bun poison shape (may need a platform-conditional on Linux CI); defensive `instanceof BusyDbError` probe mapping errs safe (no recovery on ambiguity).

Orchestrator validation: focused suites `bun test src/term-commands/mcp.test.ts src/term-commands/ui-bridge.test.ts src/lib/v5/mcp-tools.test.ts src/lib/v5/mcp-server.test.ts` → 83 pass / 0 fail; full `bun run check` → 3189 pass / 2 fail (identical to pre-change baseline; the 2 failures are environment flakes unrelated to mcp). Platform finding recorded in code comments: macOS/bun silently opens a write-protected db as READONLY (no throw) and its close leaves a zeroed readonly wal-index header in `-shm` that poisons later writers; W_OK pre-check makes degrade deterministic; sidecar recovery repairs it.

Group 1 completed by the invoking orchestrator on this evidence (task t_msoqsd8sdb8df48b done).

### Execution review — Group 2 — 2026-08-11 — SHIP (+1 in-merge MEDIUM advisory landed)

Local execution review (reviewer g2-reviewer): **SHIP** — all 6 acceptance criteria verified with evidence (CLI parity per verb via task-state reads + live wire smoke; recomputeReady on done; cross-process two-server claim race with exactly one winner + typed claim_conflict, no SQLITE_BUSY/-32603; every mapped error class produces its payload code; attribution with distinct worker/author args and byte-for-byte v5-task.ts env-fallback resolvers; MCP_TOOLS export byte-identical and ui-bridge splice untouched — ui-bridge.test.ts only re-pinned the `genie mcp` surface 5→17). Focused suites 203/0; full gate 3203 pass / 14 fail, name-for-name the pristine-HEAD baseline set. LOW advisories: (L1) UnknownBoardError outside the closed mapping table → -32603 on a normal user error (unknown board arg); (L2) env-fallback test coverage of probe arms; (L3) Group 3 scope note.

Quality review (reviewer g2-quality-reviewer): **SHIP** — no security/correctness/perf defects. Verified: stdio-only transport, all args parameterized SQL via task-state, no fs-reaching args; identity spoofability unchanged vs CLI; requireWriteHandle refuses null (database_unavailable) and degraded (read_only_database) FIRST with the SQLITE_READONLY-class backstop (errno&0xff) past the guard; claim-path contention translates to typed conflict with the busy carve-out intact; write layer is a clean Decision-3 shell (one runWrite over exact task-state fns, shared mapWriteError with a single ordered class table, only UnknownBoardError reachable-unmapped); no read-tool hot-path regression. L1 ruling (MEDIUM, orchestrator's call): map UnknownBoardError → `not_found` — the -32603 leak on a documented tool arg violates the "never -32603 for domain errors" spirit; recommended in-merge. LOWs: stale module header (Group 3 wording sweep owns it), resolver duplication mitigated by byte-identical CLI copy + boundary tests, untested defensive database_unavailable arm, env probe arms covered via the CLI copy.

In-merge fix (fixer, commit 16305aae6, verified by the quality reviewer): mapWriteError adds `UnknownBoardError` → `{ error: 'not_found', detail: err.ref, message: err.message }`; genie_task_create description documents the code; one new test asserts typed not_found (detail === 'no_such_board', never -32603, no row created). CONFIRMED by re-review — exactly the L1 scope, +13/-2 lines in 2 files.

Orchestrator validation: focused suites 204 pass / 0 fail (`mcp-tools`, `task-state`, `mcp`, `ui-bridge`); full `env -u FORCE_COLOR bun run check` → 3204 pass / 14 fail, identical baseline set, no new failures.

Group 2 completed by the invoking orchestrator on this evidence (task t_msoqsdb5429d06e8 done).

### Execution review — Group 3 — 2026-08-11 — SHIP (+4 comment rewordings landed)

Local execution review (reviewer g3-reviewer): **SHIP** — e2e round-trip passes against a spawned `genie mcp` on a real tmpdir fixture (initialize → tools/list 17 → create → checkout → done → genie_board terminal state → `genie task sync` publishes the card to `.genie/roadmap.json`, asserted); repo-wide `rg -i 'read-only'` = 263 hits == 263-entry named allowlist, zero uncovered / zero extra; `genie init` output names the operative server ("read + write tools"); skill mirrors byte-identical (64/64 files across skills/ vs plugins/genie/skills/). Full gate 3205 pass / 14 fail, name-for-name identical to the pristine-HEAD baseline (re-verified at base commit 8211b56ac).

Quality review (reviewer g3-quality-reviewer): **SHIP** — dx-docs/qa/repo-hygiene lenses. Wording accurate and self-consistent: 5 read + 12 write tools, degrade fallback + CLI-only destructive ops clearly bounded, permission model correctly attributed to the MCP client; read/write tool names in docs match the registries byte-for-byte; e2e test deterministic (7/7) and robust (JSON.parse + objectContaining, no sleeps/ports); mirror parity holds. Six LOW findings: (1-2) stale "readonly `genie mcp` server" descriptors in mcp.test.ts comments; (3) same class in tests/integration/codex-project-route-migration.test.ts; (4) ui-bridge.ts LAZY-LOAD comment phrasing implying genie mcp's open is read-only; (5) README Hermes-native tool-count drift (pre-existing, out of scope); (6) wish docs untracked.

Landing fix (fixer, commit 2279c24c6): the four genie-MCP-server descriptor rewordings (mcp.test.ts ×2, codex-project-route-migration.test.ts, ui-bridge.ts). (5) recorded as a follow-up (Hermes native surface count — not an MCP-server claim); (6) resolved by the orchestrator committing the wish docs. No FIX-FIRST/BLOCKED items.

Orchestrator validation: focused suites 72 pass / 0 fail (`mcp`, `init`, codex-project-route-migration, `ui-bridge`); full `env -u FORCE_COLOR bun run check` → 3205 pass / 14 fail, baseline set unchanged.

Group 3 completed by the invoking orchestrator on this evidence (task t_msoqsdde40b31ee9 done).

## Files to Create/Modify

```
src/term-commands/mcp.ts                                      write-path open wiring, description, header
src/lib/v5/mcp-server.ts                                      injected-open seam + opt-in error channel
src/lib/v5/mcp-tools.ts                                       write-open wrapper, degrade fallback, MCP_WRITE_TOOLS (or sibling module), header
src/lib/v5/mcp-tools.test.ts                                  per-verb parity + attribution + contention tests
src/term-commands/mcp.test.ts                                 tools/list surface, fail-closed pins, e2e stdio round-trip
src/term-commands/ui-bridge.ts                                mechanical seam-rename call site (behavior unchanged)
src/term-commands/init.ts                                     read-only wording sweep
CLAUDE.md                                                     mcp command row wording
skills/genie/reference/lifecycle.md                           wording sweep
plugins/genie/skills/genie/reference/lifecycle.md             wording sweep (mirror)
plugins/hermes-genie/references/hermes-integration-map.md     wording sweep
plugins/hermes-genie/references/mutation-gates.md             wording sweep
plugins/hermes-genie/references/native-surface.md             wording sweep
plugins/pi-genie/references/native-surface.md                 wording sweep
```
