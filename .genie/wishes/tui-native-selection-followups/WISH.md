# Wish: TUI native selection — follow-up fixes

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | `tui-native-selection-followups` |
| **Date** | 2026-05-09 |
| **Author** | Felipe Rosa <felipe@namastex.ai> |
| **Appetite** | small (~30 minutes; mechanical patches + 1 regression test) |
| **Branch** | `wish/tui-native-selection-followups` |
| **Repos touched** | `automagik-dev/genie` |
| **Design** | _No brainstorm — direct wish_ |
| **Parent wish** | [tui-native-selection](../tui-native-selection/WISH.md) — SHIPPED, PR #1730 merged 2026-05-09 |
| **Future-direction note** | The architectural rewrite Felipe actually wanted (OpenTUI as host process, tmux content embedded iframe-like — formerly `tui-split-footer-host` brainstorm) was incorrectly marked SUPERSEDED in the parent wish based on my misread of "people love current behavior, it's just buggy" as approval of the dual-tmux implementation. Felipe clarified 2026-05-09 post-merge: he wanted the *visual UX preserved* (sidebar+content like Chrome left-tabs) but with OpenTUI owning the TUI process. That brainstorm needs to be re-opened as a separate larger wish. **OUT of scope here** — this wish is the bug fix; the architectural rework is its own track. |

## Summary

Two real bugs surfaced after merging `tui-native-selection` (PR #1730): (1) the `?1002l` override misses Linux's `?1003h` (any-event motion) channel, so drag events still flow to OpenTUI even after the override fires — drag-select doesn't work and selection appears to fall into tmux's copy-mode instead; (2) `genie app --tui` calls `attachTuiSession()` directly without the `ensureTuiSession()` belt+suspenders defense that bare `genie` has, so the launcher returns `no sessions` whenever the TUI server is in any transient bad state. This wish ships both fixes plus a regression test for the override.

## Scope

### IN

- **Fix 1 — Linux drag-leak via ?1003**: amend `ESC_DISABLE_DRAG_TRACKING` in `src/tui/render.tsx` from `'\x1b[?1002l'` to `'\x1b[?1002l\x1b[?1003l'`. OpenTUI 0.2.6's `setMouseMode` emits `?1000h?1002h?1003h` on Linux/non-darwin (because `enableMouseMovement` defaults to `!isDarwin = true` per `resolveTuiRendererConfig` line 73). The `?1003` channel reports motion-with-button (= drag), so cancelling only `?1002` was a no-op for drag-select on Linux. Cancelling both keeps `?1000` (clicks) intact while returning all drag/motion to the local terminal.
- **Fix 2 — `genie app --tui` no-sessions defense**: lift the `ensureTuiSession()` belt+suspenders pattern from `src/genie.ts:863-865` into `handleTuiMode()` in `src/term-commands/app.ts:10`. Adds a 3-line idempotent check that creates the genie-tui session if it's missing, mirroring the bare `genie` invocation's existing defense. Eliminates the "no sessions" failure mode on `genie app --tui` after operator-driven `tmux -L genie-tui kill-server` cycles or post-update reaper races.
- **Regression test**: extend `src/tui/render.test.ts` with an explicit assertion that `ESC_DISABLE_DRAG_TRACKING` contains BOTH `\x1b[?1002l` AND `\x1b[?1003l`, so a future change can't drop either channel without failing the gate.
- **Comments**: in-code documentation explaining why both `?1002l` AND `?1003l` are required (the Linux gap), referencing this wish slug.

### OUT

- The architectural rewrite Felipe actually wanted (OpenTUI hosts the TUI process; tmux content embedded iframe-like). That belongs to a separate larger wish; tracked here only as a future-direction note in the metadata table above.
- Any change to OpenTUI itself (the upstream PR `anomalyco/opentui#1039` remains the long-term clean fix; this wish is a workaround on top of npm-released `0.2.6`).
- Any change to tmux configs, agent server, or the OSC 52 cleanup machinery — the parent wish is shipped; nothing to tweak there.
- Any v4 backport — v5 only, per the parent wish's D1.
- Smoke testing other terminals beyond Warp + Terminal.app on macOS — same gate as parent wish (D8).
- Refactoring `handleTuiMode` for full unit-testability — would require extracting `attachTuiSession` to a parameter; not worth the surface change for a 3-line defense addition.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Add `?1003l` to the override sequence rather than disabling `enableMouseMovement` via env. | Disabling `enableMouseMovement` is a possible workaround (`GENIE_TUI_MOUSE_MOVEMENT=0`), but it also turns off motion reporting in OpenTUI itself, which OpenTUI may use for hover effects in future renderables. Cancelling `?1003` at the wire-level after OpenTUI subscribes is more surgical: OpenTUI thinks motion is on, the terminal is told otherwise, and OpenTUI never receives motion events anyway because the terminal doesn't send them. Same observable behavior, less coupled. |
| D2 | Lift `ensureTuiSession()` into `handleTuiMode` rather than refactor `attachTuiSession` to be self-healing. | The existing `attachTuiSession` is a thin shim over `tmux attach-session`; folding session-creation logic into it would expand its responsibility and require importing serve.ts there. Mirroring the bare `genie` defense pattern (already proven in production) keeps the surface symmetric and the patch trivial (3 lines). |
| D3 | No new test for `handleTuiMode` — manual verification only. | The function is internal, not exported. Testing requires either exporting it (surface bloat) or mocking the entire serve module (fragile). The 3-line defense is straightforward enough that a regression would be caught by manual smoke (Felipe runs `genie app --tui` after operator-driven `tmux -L genie-tui kill-server`). |
| D4 | Treat the architectural rewrite as future-direction note, not in-scope. | Felipe's "OpenTUI hosts the TUI process, iframe-like" intent is a multi-week refactor (renderer mode change, scrollback contract, tmux integration redesign). Folding it into this hot-fix wish would block the bug fixes on architectural decisions that aren't ready. The note exists so the work isn't lost. |

## Success Criteria

- [ ] `ESC_DISABLE_DRAG_TRACKING` in `src/tui/render.tsx` contains both `\x1b[?1002l` and `\x1b[?1003l`.
- [ ] `bun test src/tui/render.test.ts` passes including the new regression assertion.
- [ ] `handleTuiMode()` in `src/term-commands/app.ts` calls `ensureTuiSession()` when `isTuiSessionReady()` returns false.
- [ ] After `tmux -L genie-tui kill-server`, running `genie app --tui` recreates the session and attaches successfully (no "no sessions" error).
- [ ] On Linux server attached from Warp on macOS, with the new bundle: drag-select inside the OpenTUI Nav, release (no auto-copy fires), Cmd+C → text in Mac clipboard.
- [ ] Same flow on Terminal.app on macOS.
- [ ] Click-to-spawn / click-to-focus / click-to-expand still works in Nav under both terminals.
- [ ] `bun run typecheck`, `bun run lint`, `bun run check` all green.

## Execution Strategy

### Wave 1 (sequential — single small wave)

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | Apply both source patches + regression test + verify gates |

### Wave 2 (validation)

| Group | Agent | Description |
|-------|-------|-------------|
| 2 | qa | Smoke gate on Warp + Terminal.app on macOS |
| review | reviewer | Review Group 1 + smoke results from Group 2 |

## Execution Groups

### Group 1: Apply both source patches + regression test

**Goal:** Ship the two-line fixes plus a regression test, all gates green.

**Deliverables:**

1. `src/tui/render.tsx` line ~19: change `const ESC_DISABLE_DRAG_TRACKING = '\x1b[?1002l';` to `const ESC_DISABLE_DRAG_TRACKING = '\x1b[?1002l\x1b[?1003l';`. Update the leading comment to explain why both are needed (the `?1003` Linux gap surfaced post-merge of `tui-native-selection`).
2. `src/term-commands/app.ts` `handleTuiMode()` (line ~10): import `isTuiSessionReady` and `ensureTuiSession` from `./serve.js`, add an `if (!isTuiSessionReady()) ensureTuiSession();` call after the `autoStartServe()` block and before the `attachTuiSession()` call. Mirror the existing pattern at `src/genie.ts:863-865`.
3. `src/tui/render.test.ts`:
   - Update the local `ESC_DISABLE_DRAG_TRACKING` constant at the top of the file to match (`'\x1b[?1002l\x1b[?1003l'`).
   - Add a regression test asserting that the constant contains BOTH `\x1b[?1002l` AND `\x1b[?1003l`. Comment block explains the Linux ?1003 leak history so a future contributor doesn't drop either channel.

**Acceptance Criteria:**
- [ ] `grep -F '\x1b[?1002l\x1b[?1003l' src/tui/render.tsx` returns the new constant definition.
- [ ] `grep -F 'ensureTuiSession' src/term-commands/app.ts` returns the new defense call.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run lint` exits 0.
- [ ] `bun test src/tui/render.test.ts` passes.

**Validation:**
```bash
cd /home/genie/workspace/repos/genie/.worktrees/tui-native-selection-followups && \
  grep -q '1002l.\{0,8\}1003l' src/tui/render.tsx && \
  grep -q 'ensureTuiSession()' src/term-commands/app.ts && \
  bun run typecheck && \
  bun run lint && \
  bun test src/tui/render.test.ts
```

**depends-on:** none

---

### Group 2: QA smoke gate on macOS

**Goal:** Verify the merged fixes restore drag-select + Cmd+C in Warp + Terminal.app, and that `genie app --tui` recovers from a kill-server cycle.

**Deliverables:**

1. From a Mac running Warp, attach via SSH to a host running v5 with these patches applied. Launch `genie app --tui`. Drag-select inside the OpenTUI Nav. Release. Verify no auto-copy fires. Cmd+C. Verify Mac clipboard contains the dragged text.
2. Repeat the entire flow on Terminal.app on the same Mac.
3. Click-to-spawn / click-to-focus / click-to-expand verified in Nav under both terminals.
4. From a separate shell on the Linux host, run `tmux -L genie-tui kill-server`. Then from the Mac shell run `genie app --tui` again. Verify it recreates the session and attaches successfully (no "no sessions" error).
5. Document results inline in this wish's Review Results section: PASS/FAIL per terminal, paste any anomalies for follow-up.

**Acceptance Criteria:**
- [ ] Drag-select + Cmd+C round-trip works in Warp on macOS.
- [ ] Same in Terminal.app on macOS.
- [ ] Click-to-nav still works in both terminals.
- [ ] `genie app --tui` after `tmux -L genie-tui kill-server` recovers cleanly.

**Validation:**
```bash
# Manual smoke; agent runs locally on macOS, not on the genie server.
echo "Manual smoke: see wish Review Results for PASS/FAIL per terminal"
```

**depends-on:** Group 1

---

## Dependencies

- **Internal**: Group 2 depends on Group 1.
- **Cross-wish**: parent wish `tui-native-selection` SHIPPED 2026-05-09 (PR #1730 merged); this wish is a hot-fix follow-up.
- **Upstream**: none. The upstream PR `anomalyco/opentui#1039` remains open and ready-for-review; this wish does not depend on its merge.

## QA Criteria

_What must be verified on dev after merge. The QA agent tests each criterion._

- [ ] On a fresh build (post-merge), Warp on macOS: drag-select in OpenTUI Nav + Cmd+C produces correct Mac clipboard content; no auto-copy fires.
- [ ] Same on Terminal.app on macOS.
- [ ] Click-to-nav still works in both terminals.
- [ ] `genie app --tui` after `tmux -L genie-tui kill-server` recovers without "no sessions".
- [ ] `bun test src/tui/` green (no regression).
- [ ] No new escape sequences other than the documented `?1002l`/`?1003l` reach the SSH PTY.

## Assumptions / Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| `?1003l` interferes with non-mouse subsystems that subscribe to motion events. | Low | OpenTUI's API surface for motion events is `enableMouseMovement` (boolean); no consumer in the genie TUI uses raw motion events for anything other than mouse handling. The override turns motion tracking off at the wire-level only — OpenTUI's internal state still has `enableMouseMovement: true` so any future feature that wires through that flag won't break. |
| Some terminals interpret `?1003l` differently than xterm spec (e.g., disable clicks too). | Low | Smoke gate (Warp + Terminal.app) covers both real-user cases. Other terminals fall back to `GENIE_TUI_MOUSE=0` (full mouse off) if the override misbehaves; documented in the parent wish's CHANGELOG. |
| `ensureTuiSession()` call in `handleTuiMode` blocks for an unbounded time (e.g., serve daemon stalls). | Low | The function is the same one bare `genie` calls and has been in production via that path; if it stalls, both call sites stall the same way. No new timeout surface introduced. |
| The architectural rewrite (Felipe's "OpenTUI as host, iframe-like") never gets opened. | Medium | Documented as a future-direction note in this wish's metadata table. Felipe and any future maintainer reading either this wish or the SUPERSEDED `tui-split-footer-host` brainstorm will see the trail. Re-opening is a separate brainstorm cycle when scheduled. |

---

## Review Results

_Populated by `/review` after execution completes._

- Plan review (this wish): _pending_
- Group 1 (engineer): _staged in branch `wish/tui-native-selection-followups`_
- Group 2 (qa smoke on macOS): _pending operator hardware_
- Final post-merge review: _pending_

---

## Files to Create/Modify

```
src/tui/render.tsx                  (MODIFY — Fix 1: ESC_DISABLE_DRAG_TRACKING gains \x1b[?1003l + comment update)
src/tui/render.test.ts              (MODIFY — update local constant + add regression test for both escape sequences)
src/term-commands/app.ts            (MODIFY — Fix 2: handleTuiMode gains ensureTuiSession defense, mirror src/genie.ts:863-865)
```
