# Wish 26: Worker-Addressed Commands (Pane Orchestration v2)

**Status:** COMPLETE
**Slug:** `wish-26-worker-addressed-commands`
**Created:** 2026-02-08
**Priority:** HIGH
**repo:** `code/genie-cli`

---

## Summary

Eliminate `--pane` flags from the orchestration workflow by letting all term commands accept worker IDs (e.g., `bd-42`) as their primary target. A shared target resolver translates worker IDs to pane IDs using the existing worker registry, reducing cognitive overhead for orchestrator agents to zero.

---

## Council Review

Two council sessions were held. Key outcomes:

**Session 1 (10 members):** 7 MODIFY / 3 APPROVE / 0 REJECT — approved direction, recommended collapsing 5 groups → 2 and adding error specs.

**Session 2 (6 members, evaluating operator pushback):** 6-0 APPROVE on all 3 operator overrides:
1. SubPanes in v1 (not YAGNI — commit history proves daily use)
2. Keep 4 resolution levels (session:window already exists in exec.ts, dropping = regression)
3. Add cache-bust guarantee (prevents silent stale-read race condition)

---

## Scope

### IN
- Shared target resolver module (`src/lib/target-resolver.ts`)
- `term resolve <target>` diagnostic command (dry-run resolution)
- Worker registry expansion: `subPanes` array for split panes
- Refactor `send`, `exec`, `read`, `split` to use target resolver
- Refactor orchestrate commands (`start`, `send`, `status`, `watch`, `approve`) to use target resolver
- Sub-pane numeric indexing: `bd-42:1` resolves to the first split pane
- Prescriptive error messages for dead panes, unknown targets, ambiguous matches
- Resolution confirmation in command output
- Debug logging in resolver (behind `--debug` / `DEBUG` env)
- Fresh-read guarantee on registry (no in-process caching, with documentation)
- Dead subpane auto-cleanup in resolver
- Backwards compatibility: session names, session:window, and raw `%N` pane IDs still work
- CLI help text updates in `src/term.ts`

### OUT
- Named pane roles (e.g., `bd-42:tests`) — future wish if needed
- Auto-layout / declarative pane topology
- Changes to `term work`, `term workers`, `term kill`, `term close` (already worker-addressed)
- Changes to `term spawn-parallel` or batch management
- JSONL-aware mode for Claude Code sessions (orthogonal)
- Claudio/LLM swapping integration (orthogonal)
- Concurrent registry write locking (existing issue, file separately)
- UI/dashboard changes

---

## Decisions

- **DEC-1:** Auto-detect target type from first argument (not a separate flag). Resolution priority:
  1. Raw pane ID (starts with `%`) → passthrough
  2. Worker ID with sub-pane index (contains `:`, left side is registered worker) → registry lookup + index
  3. Worker ID (exact match in registry) → registry lookup, primary pane
  4. Session:window (contains `:`, left side is tmux session) → tmux lookup
  5. Session name (fallback) → legacy behavior

  Rationale: zero extra flags means zero cognitive overhead for agents. Colon disambiguation: `:` after a registered worker = sub-pane index; `:` after a non-worker = window name.

- **DEC-2:** Sub-panes use numeric indexing only (`bd-42:0`, `bd-42:1`), not named roles. Rationale: names require an extra parameter when splitting; numeric is zero-config since agents just count their splits.

- **DEC-3:** Worker registry stores sub-panes as an ordered `subPanes: string[]` array alongside existing `paneId` field. `bd-42:0` maps to `paneId`, `bd-42:1` maps to `subPanes[0]`, etc. Rationale: backwards compatible — existing code reading `paneId` continues to work.

- **DEC-4:** `term split` auto-registers new panes in the worker registry when the target is a worker. Output includes the new sub-pane address (e.g., `"Pane split. Address: bd-42:1"`).

- **DEC-5:** Resolver validates pane liveness via tmux before returning. Dead panes are auto-cleaned from registry and return prescriptive errors. Rationale: stale registry is the #1 operational risk; silent wrong-pane delivery is worse than an error.

- **DEC-6:** Registry always read fresh from disk (no in-process caching). Comment `// INTENTIONAL: always fresh-read, never cache` in `loadRegistry()`. Rationale: prevents stale-read race condition when write→read happens within milliseconds.

- **DEC-7:** All commands output resolution confirmation: `"✅ Keys sent to bd-42 (pane %17, session genie)"`. Rationale: agents need confidence the right pane was hit without follow-up `term read`.

---

## Success Criteria

- [x] `term send bd-42 "message"` sends to the worker's primary pane (no `--pane` needed)
- [x] `term read bd-42` reads from the worker's primary pane
- [x] `term exec bd-42 "npm test"` executes in the worker's primary pane
- [x] `term split bd-42 h` splits the worker's primary pane, registers new pane, outputs address
- [x] `term exec bd-42:1 "npm test"` executes in the first sub-pane
- [x] `term read bd-42:1` reads from the first sub-pane
- [x] `term resolve bd-42` shows resolution without side effects (diagnostic)
- [x] `term send genie "message"` still works (session name fallback)
- [x] `term send %17 "message"` still works (raw pane ID fallback)
- [x] `term send genie:OMNI "message"` still works (session:window fallback)
- [x] Dead pane returns prescriptive error: `"❌ Worker bd-42: pane %17 is dead. Run 'term kill bd-42' to clean up."`
- [x] Unknown target returns prescriptive error with suggestions
- [x] Resolution confirmation in output (e.g., `"✅ Keys sent to bd-42 (pane %17, session genie)"`)
- [x] All existing tests pass after refactor
- [x] New tests cover target resolver with all input types and error paths

---

## Assumptions

- **ASM-1:** Worker IDs (e.g., `bd-42`, `wish-21`) won't collide with tmux session names (e.g., `genie`, `main`). Both follow distinct naming patterns.
- **ASM-2:** The worker registry file is always accessible from the process running term commands (same machine, same filesystem).
- **ASM-3:** Agents typically split at most 2-3 panes per worker, so numeric indexing scales fine.

## Risks

- **RISK-1:** Stale registry entries (dead panes) → silent wrong-pane delivery. Mitigation: resolver validates pane liveness, auto-cleans dead entries, returns prescriptive error.
- **RISK-2:** Sub-pane killed mid-session → stale `subPanes[]` entry. Mitigation: resolver checks liveness per-pane; dead sub-panes removed from array on detection.
- **RISK-3:** Colon ambiguity (`bd-42:1` vs `genie:OMNI`). Mitigation: resolver checks worker registry first. If left side is a registered worker, `:N` is sub-pane. Otherwise, falls through to session:window.
- **RISK-4:** Concurrent registry writes from parallel workers. Mitigation: out of scope (existing issue), file separately. Current risk is low (writes are infrequent, file is small).

---

## Execution Groups

### Group 1: Target Resolver + Registry Expansion

**Goal:** Create the shared `resolveTarget()` function and expand the worker registry with sub-pane tracking.

**Deliverables:**
- `src/lib/target-resolver.ts` — new module with `resolveTarget(target: string)` function
  - 4-level resolution: `%pane → worker[:index] → session:window → session`
  - Validates pane liveness via tmux, auto-cleans dead entries
  - Returns `{ paneId, session, workerId?, paneIndex?, resolvedVia }` (resolvedVia for debug/confirmation)
  - Prescriptive error messages for all failure modes
  - Debug logging: `[target-resolver] "bd-42" → worker lookup → found: pane %17, session genie`
- `src/lib/target-resolver.test.ts` — unit tests for all target types and error paths
- Worker registry expansion in `src/lib/worker-registry.ts`:
  - Add `subPanes?: string[]` field to `Worker` interface
  - Add `addSubPane(workerId, paneId)` helper
  - Add `getPane(workerId, index)` helper (index 0 = primary, 1+ = subPanes)
  - Add `// INTENTIONAL: always fresh-read, never cache` comment in `loadRegistry()`
- `term resolve <target>` diagnostic command in CLI

**Acceptance Criteria:**
- [ ] `resolveTarget("%17")` returns `{ paneId: "%17", resolvedVia: "raw" }` (passthrough)
- [ ] `resolveTarget("bd-42")` returns `{ paneId: worker.paneId, workerId: "bd-42", resolvedVia: "worker" }`
- [ ] `resolveTarget("bd-42:1")` returns the first sub-pane
- [ ] `resolveTarget("genie:OMNI")` resolves via session:window
- [ ] `resolveTarget("nonexistent")` falls back to session lookup
- [ ] Dead pane → prescriptive error + auto-cleanup from registry
- [ ] `Worker` type includes optional `subPanes` field
- [ ] `addSubPane("bd-42", "%22")` appends to worker's `subPanes` array
- [ ] `getPane("bd-42", 0)` returns primary `paneId`; `getPane("bd-42", 1)` returns `subPanes[0]`
- [ ] `term resolve bd-42` prints resolution details without side effects
- [ ] Unit tests pass: `bun test target-resolver` and `bun test worker-registry`

**Validation:** `bun test src/lib/target-resolver.test.ts && bun test src/lib/worker-registry.test.ts`

---

### Group 2: Wire All Commands

**Goal:** Refactor all term commands to use the target resolver. First arg becomes generic "target".

**Deliverables:**
- Refactor `src/term-commands/send.ts`: first arg → target, use `resolveTarget()`, output resolution confirmation
- Refactor `src/term-commands/exec.ts`: first arg → target, use `resolveTarget()`, output resolution confirmation
- Refactor `src/term-commands/read.ts`: first arg → target, use `resolveTarget()`
- Refactor `src/term-commands/split.ts`: first arg → target, use `resolveTarget()`, auto-register new pane via `addSubPane()`, output new address
- Refactor `src/term-commands/orchestrate.ts`: all sub-commands use `resolveTarget()` instead of `getSessionPane()`. Preserve session-creation behavior from `getSessionPane()` where needed.
- Deprecate `--pane` flag (keep as hidden escape hatch, warn if used)
- Update CLI definitions and help text in `src/term.ts`

**Acceptance Criteria:**
- [ ] `term send bd-42 "msg"` resolves worker, sends to correct pane, outputs `"✅ Keys sent to bd-42 (pane %17)"`
- [ ] `term exec bd-42 "cmd"` resolves worker, executes in correct pane
- [ ] `term read bd-42` resolves worker, reads from correct pane
- [ ] `term split bd-42 h` splits, registers sub-pane, outputs `"Pane split. Address: bd-42:1"`
- [ ] `term exec bd-42:1 "npm test"` works end-to-end after split
- [ ] `term orc status bd-42` shows worker status
- [ ] `term orc approve bd-42` approves permission on worker's pane
- [ ] `term send genie "msg"` still works (backwards compat)
- [ ] `term send %17 "msg"` still works (raw pane fallback)
- [ ] `term send genie:OMNI "msg"` still works (session:window)
- [ ] `--pane` flag shows deprecation warning but still works
- [ ] Existing tests pass after refactor
- [ ] `getSessionPane()` session-creation behavior preserved in orchestrate commands

**Validation:** `bun test && term send genie "backwards compat test"`

**Blocked by:** Group 1

---

## Review Results

**Verdict:** SHIP
**Date:** 2026-02-08

### Task Completion
| Group | Status | Criteria |
|-------|--------|----------|
| Group 1: Target Resolver + Registry | COMPLETE | 11/11 |
| Group 2: Wire All Commands | COMPLETE | 13/13 |

### Success Criteria Check (wish-level)
- [x] `term send bd-42 "message"` — PASS: `send.ts:44` calls `resolveTarget(target)`, outputs confirmation at line 76
- [x] `term read bd-42` — PASS: `read.ts:43` calls `resolveTarget(target)`, passes paneId to logReader at line 65
- [x] `term exec bd-42 "npm test"` — PASS: `exec.ts:47` calls `resolveTarget(target)`, confirmation at line 85
- [x] `term split bd-42 h` splits + registers + outputs address — PASS: `split.ts:49` resolves, line 105 calls `addSubPane()`, line 113 outputs address
- [x] `term exec bd-42:1 "npm test"` — PASS: resolver handles `worker:index` at line 172-218 of `target-resolver.ts`
- [x] `term read bd-42:1` — PASS: same resolver path, `read.ts` passes resolved paneId
- [x] `term resolve bd-42` diagnostic — PASS: `resolve.ts` calls resolveTarget with checkLiveness, no side effects
- [x] `term send genie "message"` backwards compat — PASS: resolver falls through to session at line 274-294
- [x] `term send %17 "message"` raw pane — PASS: resolver passthrough at line 149-166
- [x] `term send genie:OMNI "message"` session:window — PASS: resolver at line 220-240
- [x] Dead pane prescriptive error — PASS: `target-resolver.ts:259-262` throws with exact format including `term kill` suggestion
- [x] Unknown target prescriptive error — PASS: `target-resolver.ts:297-300` throws with `term workers` and `term session ls` suggestions
- [x] Resolution confirmation in output — PASS: all commands output `(pane %N, session X)` labels
- [x] All existing tests pass — PASS: 483 tests, 0 failures
- [x] New tests cover resolver — PASS: 25 resolver tests + 17 registry tests + 23 wiring tests = 65 new tests

### Validation Commands
- [x] `bun test src/lib/target-resolver.test.ts` — PASS: 25 tests, 0 failures
- [x] `bun test src/lib/worker-registry.test.ts` — PASS: 17 tests, 0 failures
- [x] `bun test` (full suite) — PASS: 483 tests, 0 failures, 950 expect() calls

### Quality Spot-Check
Verdict: OK
- Security: No injection risks; same single-quote tmux pattern used throughout codebase
- Error handling: All commands catch resolver errors, prescriptive messages throughout
- Performance: Resolver reads registry once per call, short-circuits at first match
- Fresh-read guarantee: `loadRegistry()` has `// INTENTIONAL: always fresh-read, never cache` comment at line 100

### Browser Tests
Skipped: agent-browser not available (CLI tool, no browser UI)

### Gaps
| # | Severity | Description | Fix |
|---|----------|-------------|-----|
| 1 | LOW | Dead `registryPath` param in `getWorkers()` (unused) | Remove param or wire it through |
| 2 | LOW | Label-building pattern duplicated across send/exec/split/orchestrate | Extract shared `formatResolvedLabel()` helper |
| 3 | LOW | Command-level tests verify exports/types but don't mock resolveTarget call | Add integration tests that mock resolveTarget |

### Recommendation
All 15 success criteria pass with direct code evidence. 483 tests green, zero regressions. Three LOW advisory findings — none block shipping. The implementation faithfully follows all 7 decisions (DEC-1 through DEC-7) from the wish document. Ready to commit and ship.

---

## Files to Create/Modify

```
NEW  src/lib/target-resolver.ts
NEW  src/lib/target-resolver.test.ts
MOD  src/lib/worker-registry.ts
NEW  src/lib/worker-registry.test.ts  (if not exists)
MOD  src/term-commands/send.ts
MOD  src/term-commands/exec.ts
MOD  src/term-commands/read.ts
MOD  src/term-commands/split.ts
MOD  src/term-commands/orchestrate.ts
MOD  src/term.ts
```
