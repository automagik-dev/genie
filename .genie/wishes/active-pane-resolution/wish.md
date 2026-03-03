# Wish: Active Pane Resolution

**Status:** COMPLETE
**Slug:** active-pane-resolution
**Created:** 2026-02-09

## Summary

When resolving tmux session targets without explicit window/pane identifiers, `defaultTmuxLookup()` in `target-resolver.ts` and `getSessionPaneForStart()`/`startSession()` in `orchestrate.ts` always pick `windows[0]` and `panes[0]` instead of the user's active window and pane. This means `term exec my-session ls` targets the wrong pane when the user is looking at a different window. The fix is to prefer `window_active`/`pane_active` flags with fallback to `[0]` for backward compatibility.

## Scope

### IN
- Fix `defaultTmuxLookup()` in `src/lib/target-resolver.ts` to prefer active window/pane
- Fix `getSessionPaneForStart()` in `src/term-commands/orchestrate.ts` to prefer active window/pane
- Fix `startSession()` in `src/term-commands/orchestrate.ts` to prefer active window/pane
- Add/update tests for the active-pane preference in `target-resolver.test.ts`
- Maintain backward compatibility: fallback to `[0]` when no active flag is found

### OUT
- NOT changing `runExperiment()` in orchestrate.ts (creates its own test session, `[0]` is correct)
- NOT changing `work.ts` pane lookups (these operate on specific/newly-created windows, `[0]` is correct)
- NOT changing already-correct patterns in `spawn.ts`, `log-reader.ts`, `event-monitor.ts`
- NOT adding a `--active` CLI flag (the correct behavior should always prefer active; automation uses explicit pane IDs)
- NOT modifying the tmux data model or `listWindows`/`listPanes` functions (they already parse `active` flags)

## Decisions

- DEC-1: Change default behavior rather than adding `--active` flag. The active pane IS what users expect. Automation scripts use explicit pane IDs (`%17`) or worker names (`bd-42`) which bypass this logic entirely. The `[0]` fallback preserves safety for edge cases where no pane is marked active.
- DEC-2: Follow the existing correct pattern from `spawn.ts` and `log-reader.ts`: `windows.find(w => w.active) || windows[0]` and `panes.find(p => p.active) || panes[0]`.
- DEC-3: ~~Add a helper function `findActiveOrFirst()` to avoid duplicating the pattern (DRY).~~ Decided against this - the inline pattern `arr.find(x => x.active) || arr[0]` is short enough and consistent with existing code in spawn.ts and log-reader.ts. A helper would add indirection without meaningful benefit.

## Success Criteria

- [x] `defaultTmuxLookup()` resolves to the active window's active pane when available
- [x] `getSessionPaneForStart()` resolves to the active window's active pane when available
- [x] `startSession()` resolves to the active window's active pane when available
- [x] All three functions fall back to `[0]` when no active window/pane exists
- [x] Existing tests pass (`bun test src/lib/target-resolver.test.ts`) - 37 pass, 0 fail
- [x] New tests cover active-pane preference behavior in `defaultTmuxLookup` - 3 new tests
- [x] `bun run build` succeeds - clean bundle of 3 entry points
- [x] `npx tsc --noEmit` succeeds (only pre-existing errors in unrelated files)

## Execution Groups

### Group A: Core Fix - target-resolver.ts
**Goal:** Make `defaultTmuxLookup()` prefer active window and active pane.
**Deliverables:**
- Modified `defaultTmuxLookup()` function using `find(w => w.active)` pattern with `[0]` fallback
**Acceptance Criteria:**
- [x] Active window is selected when multiple windows exist
- [x] Active pane is selected when multiple panes exist
- [x] Falls back to first window/pane when no active flag present
**Validation:** `npx tsc --noEmit`

### Group B: Fix - orchestrate.ts
**Goal:** Apply same active-preference pattern to `getSessionPaneForStart()` and `startSession()`.
**Deliverables:**
- Modified `getSessionPaneForStart()` function
- Modified `startSession()` function
**Acceptance Criteria:**
- [x] Both functions select active window/pane
- [x] Backward compatible fallback to `[0]`
**Validation:** `npx tsc --noEmit`

### Group C: Tests
**Goal:** Add test coverage for the active-pane resolution behavior.
**Deliverables:**
- New test cases in `target-resolver.test.ts` for tmuxLookup with active window/pane mock
**Acceptance Criteria:**
- [x] Test verifies active pane is preferred over first pane
- [x] Test verifies fallback to first when no active flag (source code pattern verified)
- [x] All existing tests still pass (495 pass, 0 fail across all 20 test files)
**Validation:** `bun test src/lib/target-resolver.test.ts`

### Group D: Build Verification
**Goal:** Ensure no regressions.
**Deliverables:** N/A (verification only)
**Acceptance Criteria:**
- [x] `bun run build` passes
- [x] `npx tsc --noEmit` passes (no new errors in changed files)
**Validation:** `bun run build && npx tsc --noEmit`
