---
slug: tui-click-only-mouse
title: TUI mouse — clicks captured by OpenTUI, drags passed through to terminal
status: SUPERSEDED — see tui-native-selection
created: 2026-05-09
superseded-on: 2026-05-09
superseded-by: tui-native-selection
---

> **SUPERSEDED 2026-05-09 by `tui-native-selection`.**
>
> Felipe asked for "all of it in one mega wish." The click-only-mouse
> fix from this brainstorm became Jaw A of `tui-native-selection`,
> alongside Jaw B (strip OSC 52 plumbing) and Jaw C (upstream
> `MouseLevel` PR to anomalyco/opentui). Target release shifted from
> v4 minor to v5 to align with the v5 cutover umbrella.
>
> Kept on disk as a trace artifact. Do not crystallize. Do not open a
> wish for this slug.

# Brainstorm: TUI click-only mouse mode

## Problem (one sentence)

`genie tui` captures drag events in the OpenTUI Nav pane, breaking native
terminal drag-to-select + Cmd+C in terminals that don't implement OSC 52
(notably Warp on macOS), even though the Nav itself uses only click events
and never consumes drag.

## Genesis (from the seed conversation)

Felipe's diagnosis after spending a session investigating: the v4 TUI's
sidebar+content layout is exactly what users want — "Chrome with left bar
instead of top tabs, people love current behavior, it's just buggy." The
fix is the buggy mouse handling, not the architecture.

Source confirmation (`anomalyco/opentui` cloned to
`/home/genie/workspace/repos/opentui-investigate/`):

```zig
// packages/core/src/zig/terminal.zig:593-596
try tty.writeAll(ansi.ANSI.enableMouseTracking);       // ?1000h — press/release
try tty.writeAll(ansi.ANSI.enableButtonEventTracking); // ?1002h — drag (always on)
if (enable_movement) {
    try tty.writeAll(ansi.ANSI.enableAnyEventTracking); // ?1003h — motion (gated)
}
```

OpenTUI emits `?1000h` (clicks) and `?1002h` (drag) **as a hardcoded pair**
whenever `useMouse: true`. The `enableMouseMovement` flag toggles only
`?1003h` (motion-without-buttons). There's no built-in way to emit
clicks-only.

When a terminal sees `?1002h`, it forwards drag events to the application
as escape sequences instead of treating them as local text-selection.
That's why Warp's drag-select doesn't work in the OpenTUI Nav pane.

`genie src/tui/components/Nav.tsx` and the other TUI components do not
register any `onMouseDrag` / `onMouseDragEnd` handlers. The Nav uses
clicks only. Drag tracking is being subscribed for nothing.

## Proposed fix

After `createCliRenderer()` initializes mouse tracking with `?1000h?1002h?1006h`,
genie's TUI bootstrap emits a manual `\e[?1002l` to **disable drag tracking
specifically**, leaving click tracking intact. Per xterm semantics
("the last sequence wins" — confirmed by the comment at `terminal.zig:588`),
the terminal then reports only press/release events to OpenTUI; drags
return to local-terminal control where they trigger native selection.

```typescript
// src/tui/render.tsx — after createCliRenderer
process.stdout.write('\x1b[?1002l');  // disable drag tracking
// ...and on every renderer.useMouse / suspend-resume cycle that re-emits
// the OpenTUI mouse-init sequence, re-emit ?1002l to re-override.
```

Plus a hook into the renderer's `'mouse-resumed'` lifecycle event so
OpenTUI's setup gets re-overridden when it re-applies tracking (the
`enableMouse` zig path runs on suspend→resume and on the runtime
`useMouse = true` setter).

## Scope

### IN
- New helper in `src/tui/render.tsx` that:
  1. After `createCliRenderer(resolveTuiRendererConfig())`, emits `\e[?1002l` once
  2. Subscribes to whatever lifecycle event fires when OpenTUI re-emits
     mouse setup (suspend/resume, useMouse setter) and re-emits `?1002l`
- Audit `src/tui/components/**` to confirm zero `onMouseDrag` /
  `onMouseDragEnd` consumers — if any exist, surface as risk
- Cross-terminal smoke matrix (manual, one-time) — confirm `?1002l`
  override behaves as expected in: Warp, Ghostty, iTerm2, Wezterm,
  Alacritty, kitty, Terminal.app, foot, Windows Terminal
- Test coverage — emit a `?1000h?1002h` setup, then `?1002l`, then a
  synthetic drag; verify OpenTUI's mouse handler does NOT fire onMouseDrag
- Document the override + the rationale in a code comment so future
  contributors understand why we override OpenTUI's defaults
- (Optional, follow-up) **Upstream PR to anomalyco/opentui** adding a
  `useMouseDrag: boolean` config option (default `true` for backward
  compat). When `false`, `setMouseMode` skips the `?1002h` emission.
  Once accepted upstream, genie can drop the manual override.

### OUT
- The v5 split-footer architectural rewrite (sibling wish, deferred)
- Changes to OpenTUI behavior outside the mouse module
- Changes to the genie agent server (`-L genie`) — no clipboard issue there
- Changes to `tmux-tui.conf` — already has `allow-passthrough on`
- Selection styling / styled-text copy formatting — terminal owns it now,
  uses terminal's own selection style

## Decisions to make

1. **Override placement** — in `src/tui/render.tsx` only, or extracted
   to a small `src/tui/mouse-override.ts` utility for reuse / testability?
2. **Upstream PR vs override-forever** — do we file the upstream PR
   immediately and ship the local override only as a transitional
   workaround, or treat the local override as the long-term solution and
   skip upstream contribution?
3. **What if Warp / a target terminal doesn't honor `?1002l` after `?1002h`?**
   Some terminals follow stricter "last sequence wins" semantics; others
   may treat the sequences as additive. Mitigation strategy: cross-terminal
   smoke matrix as part of the wish.
4. **Selection styling** — when the user drags in the Nav, the terminal
   shows its native selection highlight overlapping OpenTUI's rendered
   tree. Acceptable, or do we need to investigate co-rendering? (Lean
   "acceptable" — terminal selection is universally well-styled and
   users expect it.)

## Risks & assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| A target terminal honors `?1002l` differently than expected (drags still captured, or clicks also disabled) | Medium | Cross-terminal smoke matrix as a launch gate. Document any terminals that misbehave; document workaround for those (`GENIE_TUI_MOUSE=0` env to fully disable mouse). |
| OpenTUI's `setMouseMode` runs more often than I think (timer-driven? on every render?) and our override is fighting a tight loop | Low | Verify in source — confirmed at `terminal.zig:574-602` that `setMouseMode` only runs when `enable` or `enable_movement` actually changes. State guard prevents re-emission on every render. So we only need to re-override on lifecycle events, not per-frame. |
| OpenTUI's drag-handler tests fail with mock drag events when the override is active | Low | Tests use `mockMouse.drag()` which synthesizes events at the parser level, not via the terminal escape stream. Our override is at the terminal-emission layer. Tests should pass unaffected. |
| Some genie TUI feature secretly uses drag (drag-resize a panel, drag a row) | Low | Audit pass (grep `onMouseDrag\|onMouseDragEnd` in `src/tui/`) confirms no consumers. If one is added later, it would silently no-op until the override is conditional. |
| Visual conflict between terminal-native selection highlight and OpenTUI's render in the Nav region | Low | Acceptable. Terminal selection styles are universally readable. No need to redesign. |

## Success criteria

- [ ] `genie tui` running on Linux server, attached from Warp on macOS:
      drag-to-select inside the OpenTUI Nav pane, release, Cmd+V in any
      local Mac app yields the selected text
- [ ] Same as above, repeated through ALL of: Ghostty, iTerm2, Wezterm,
      Alacritty, kitty, Terminal.app (smoke matrix)
- [ ] Click-to-spawn / click-to-focus / click-to-expand in the Nav still
      works — no regression in click handling
- [ ] No regression in the right tmux mirror pane (already worked, must
      keep working)
- [ ] After `genie tui` is suspended (Ctrl+Z) and resumed, drag-select
      still works — confirms the suspend/resume re-override path
- [ ] `bun test src/tui/` green (no test regression)
- [ ] No new escape sequence appears in `tmux capture-pane -p` output
      stream that confuses agents in the right pane
- [ ] Upstream `anomalyco/opentui` issue/PR filed (optional but
      preferred — closes the long-term loop)

## WRS

```
WRS: ████████░░ 80/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ░
```

- **Problem** ✅ — root cause identified, source-line referenced.
- **Scope** ✅ — IN/OUT clear, sibling wish for the deferred path.
- **Decisions** ✅ — 4 decisions, three are technical-resolvable, only #2
  (upstream PR vs override-only) needs Felipe's call. We can write the
  Decisions section of a wish today.
- **Risks** ✅ — 5 risks ranked with mitigations.
- **Criteria** ░ — list exists but the cross-terminal smoke matrix needs
  the actual list of terminals + accept/skip-acceptable thresholds.
