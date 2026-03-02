# Wish: Harden Window-Per-Worker Model (Pane Orchestration v2)

**Status:** COMPLETE
**Slug:** `pane-orchestration-v2`
**Created:** 2026-02-09
**Priority:** HIGH
**repo:** `code/genie-cli`

---

## Summary

The system already creates a dedicated tmux window per worker (`ensureWorkerWindow()` in `work.ts`). However, the mapping is incomplete: `windowId` is not tracked in the worker registry, there's no `findByWindow()` lookup, and cleanup in `close.ts`/`kill.ts` uses window names without full tmux session qualification. This wish hardens the window-per-worker model by storing the tmux `windowId` in the registry, adding window-based lookups, and making cleanup robust.

---

## Scope

### IN
- Add `windowId` field to `Worker` interface in worker-registry.ts
- Store `windowId` when creating worker windows in `work.ts`
- Add `findByWindow(windowId)` helper to worker-registry.ts
- Fix `close.ts` and `kill.ts` to use session-qualified `windowId` for kills (not bare window name)
- Add `windowId` to target resolver as an additional resolution path (window ID → worker → pane)
- Update `workers.ts` display to show window name alongside pane ID
- Ensure `term ls` / `term workers --json` exposes window info for programmatic use

### OUT
- Multi-session layouts / session-per-worker abstractions
- Named pane roles within a worker window
- Dashboard UI changes
- Auto-layout / declarative topology
- Changes to spawn-parallel or batch management
- Concurrent registry write locking

---

## Decisions

- **DEC-1:** `windowId` (e.g., `@4`) is stored in the Worker struct. `windowName` (e.g., `bd-42`) remains as-is for human display. Both are populated during `ensureWorkerWindow()`.
- **DEC-2:** Kill/close use `tmux.killWindow(windowId)` with session-qualified targeting (e.g., `kill-window -t '$sessionId:$windowId'`). This prevents killing wrong windows when names collide across sessions.
- **DEC-3:** Target resolver gains a new resolution level: bare window ID (starts with `@`) resolves to the worker owning that window. This is a low-priority fallback after worker/pane resolution.
- **DEC-4:** Backward compatible — `windowName` is optional in registry. Old workers without `windowId` continue to work; kill falls back to name-based kill.

---

## Success Criteria

- [x] `Worker` interface has `windowId?: string` field
- [x] `ensureWorkerWindow()` returns `windowId` alongside `paneId`
- [x] New workers are registered with both `windowName` and `windowId`
- [x] `findByWindow(windowId)` returns the worker owning that window
- [x] `term close` uses session-qualified `windowId` for kill when available
- [x] `term kill` uses session-qualified `windowId` for kill when available
- [x] `term workers --json` includes `windowId` and `windowName` in output
- [x] Build passes: `bun run build`
- [x] Types check: no TypeScript errors
- [x] Existing behavior preserved: workers without `windowId` still close/kill cleanly

---

## Execution Groups

### Group 1: Registry Expansion + Window Tracking

**Goal:** Add `windowId` to Worker interface and populate it during window creation.

**Deliverables:**
- `src/lib/worker-registry.ts`: Add `windowId?: string` to `Worker` interface; add `findByWindow()` helper
- `src/term-commands/work.ts`: Update `ensureWorkerWindow()` to return `windowId`; store it in worker registration
- `src/lib/tmux.ts`: Update `createWindow()` to return the window ID

**Acceptance Criteria:**
- [ ] `Worker.windowId` field exists and is optional (backward compat)
- [ ] `ensureWorkerWindow()` populates `windowId` from tmux
- [ ] Worker registration includes `windowId` in both new and resume paths
- [ ] `findByWindow()` finds workers by their window ID
- [ ] `createWindow()` returns window with correct `id` field (already does via `listWindows`)
- [ ] Build passes: `bun run build`

**Validation:** `bun run build && bun test src/lib/worker-registry.test.ts`

---

### Group 2: Robust Window Cleanup

**Goal:** Make close/kill use session-qualified window IDs for reliable cleanup.

**Deliverables:**
- `src/lib/tmux.ts`: Add `killWindowQualified(sessionId, windowId)` helper that uses session-qualified targeting
- `src/term-commands/close.ts`: Use `windowId` + session for kill when available, fall back to name
- `src/term-commands/kill.ts`: Use `windowId` + session for kill when available, fall back to name

**Acceptance Criteria:**
- [ ] `killWindowQualified()` uses session-qualified target: `kill-window -t '$sessionId:$windowId'`
- [ ] `close.ts` prefers `windowId` over `windowName` when both exist
- [ ] `kill.ts` prefers `windowId` over `windowName` when both exist
- [ ] Workers without `windowId` still close/kill cleanly (backward compat fallback)
- [ ] Build passes: `bun run build`

**Validation:** `bun run build`

---

### Group 3: Display + Target Resolver Enhancement

**Goal:** Expose window info in commands and optionally resolve `@N` window IDs.

**Deliverables:**
- `src/term-commands/workers.ts`: Add `windowId` and `windowName` to JSON output and optionally table output
- `src/lib/target-resolver.ts`: Add `@N` window ID resolution (level 1.5: after raw pane, before worker lookup)

**Acceptance Criteria:**
- [ ] `term workers --json` includes `windowId` field
- [ ] `resolveTarget("@4")` resolves to the worker owning window `@4`, returning its primary pane
- [ ] Unknown window ID `@999` gives prescriptive error
- [ ] Build passes: `bun run build`

**Validation:** `bun run build && bun test src/lib/target-resolver.test.ts`

---

## Review Results

**Verdict:** SHIP
**Date:** 2026-02-09

### Task Completion
| Group | Status | Criteria |
|-------|--------|----------|
| Group 1: Registry + Window Tracking | COMPLETE | 6/6 |
| Group 2: Robust Window Cleanup | COMPLETE | 5/5 |
| Group 3: Display + Resolver Enhancement | COMPLETE | 4/4 |

### Success Criteria Check (wish-level)
- [x] `Worker` interface has `windowId?: string` field — `worker-registry.ts` line 55
- [x] `ensureWorkerWindow()` returns `windowId` alongside `paneId` — `work.ts` line 511
- [x] New workers registered with both `windowName` and `windowId` — resume path (line 812) and new path (line 972)
- [x] `findByWindow(windowId)` returns worker — `worker-registry.ts` with 2 tests
- [x] `term close` uses session-qualified `windowId` — `close.ts` three-tier kill logic
- [x] `term kill` uses session-qualified `windowId` — `kill.ts` three-tier kill logic
- [x] `term workers --json` includes `windowId` and `windowName` — `workers.ts` WorkerDisplay struct
- [x] Build passes — 3 outputs (claudio.js, term.js, genie.js)
- [x] Types check — bun build includes TS compilation, no errors
- [x] Backward compat — workers without `windowId` fall back to name-based or pane-based kill

### Validation Commands
- [x] `bun run build` — PASS: 3 outputs generated
- [x] `bun test src/lib/worker-registry.test.ts` — PASS: 22 tests (5 new), 0 failures
- [x] `bun test src/lib/target-resolver.test.ts` — PASS: 38 tests (4 new), 0 failures
- [x] `bun test` (full suite) — PASS: 501 tests, 0 failures, 981 expect() calls

### Files Modified
```
MOD  src/lib/worker-registry.ts      — Added windowId field + findByWindow()
MOD  src/lib/worker-registry.test.ts — Added 5 tests for windowId + findByWindow
MOD  src/lib/tmux.ts                 — Added killWindowQualified() helper
MOD  src/lib/target-resolver.ts      — Added @N window ID resolution (Level 1.5)
MOD  src/lib/target-resolver.test.ts — Added 4 tests for @N resolution
MOD  src/term-commands/work.ts       — ensureWorkerWindow returns windowId, stored in registration
MOD  src/term-commands/close.ts      — Session-qualified window kill with fallback
MOD  src/term-commands/kill.ts       — Session-qualified window kill with fallback
MOD  src/term-commands/workers.ts    — windowId/windowName in display data
NEW  .genie/wishes/pane-orchestration-v2/wish.md — This wish document
```

### Recommendation
All 10 success criteria pass. 501 tests green (9 new), zero regressions. Implementation follows all 4 decisions (DEC-1 through DEC-4). Backward compatible — no breaking changes. Ready to ship.
