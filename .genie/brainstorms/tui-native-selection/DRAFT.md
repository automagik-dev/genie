---
slug: tui-native-selection
title: TUI native terminal selection (drag captures terminal, not OpenTUI; remove OSC 52 plumbing)
status: DRAFT
created: 2026-05-09
seed-conversation: genie-configure agent · 2026-05-09 (Felipe + Genie)
target-release: v5
supersedes-brainstorms:
  - tui-click-only-mouse (folded into IN scope)
  - tui-split-footer-host (architectural rewrite NOT pursued — sidebar+content UX preserved)
---

# Brainstorm: TUI native terminal selection — one mega wish

## Problem (one sentence)

`genie tui` captures drag events in the OpenTUI Nav and routes copy
through OSC 52 escape sequences, so users on terminals that don't
implement OSC 52 (notably Warp on macOS) can't drag-select text in the
TUI even though they love the sidebar+content layout otherwise.

## Felipe's three explicit signals (mid-brainstorm, 2026-05-09)

> "people love current behavior, it's just buggy"
> "i want all of it in one mega wish"
> "terminal natively drags and drop. i dont mind about tmux auto
>  clipboard on releasing, i actually prefer the classic select and
>  cmd + c"

Synthesized requirements:

1. **Preserve the v4 sidebar+content layout.** No architectural
   rewrite to split-footer or to a single-pane host model. The
   "Chrome with left bar instead of top tabs" UX stays.
2. **One mega wish, not split.** Click-only mouse fix + cleanup of
   the OSC 52 machinery + upstream contribution all in one.
3. **Classic terminal selection: drag highlights, user hits Cmd+C.**
   No automatic copy-on-release. No OSC 52 emission triggered by
   drag-end. The terminal owns the entire selection lifecycle from
   first press to user-initiated copy.

## Root cause (verified against `anomalyco/opentui@v0.2.6`)

Cloned at `/home/genie/workspace/repos/opentui-investigate/`, HEAD `e663959 prepare release v0.2.6`.

### What OpenTUI 0.2.6 emits

`packages/core/src/zig/terminal.zig:574-602` — `setMouseMode(enable: bool, enable_movement: bool)`:

```zig
try tty.writeAll(ansi.ANSI.enableMouseTracking);       // ?1000h — press/release
try tty.writeAll(ansi.ANSI.enableButtonEventTracking); // ?1002h — drag (HARDCODED)
if (enable_movement) {
    try tty.writeAll(ansi.ANSI.enableAnyEventTracking); // ?1003h — motion (gated)
}
try tty.writeAll(ansi.ANSI.enableSGRMouseMode);        // ?1006h — SGR encoding
```

`?1002h` is unconditional whenever mouse is on. Drag events become
escape sequences delivered to OpenTUI; the terminal never sees them
as text-selection input.

### What's interesting in 0.2.6

`packages/core/src/zig/terminal.zig:33-39` declares an unused enum:

```zig
pub const MouseLevel = enum {
    none,
    basic,    // click only          ← THIS IS WHAT WE WANT
    drag,     // click + drag        ← what OpenTUI hardcodes today
    motion,   // all motion
    pixels,   // pixel coordinates
};
```

The enum is declared but `setMouseMode` does not consume it. The author
named the right concept and stopped short of wiring it through. The
TS layer (`packages/core/src/renderer.ts:2702-2712`) just calls
`lib.enableMouse(rendererPtr, enableMouseMovement)` — boolean for motion,
nothing for level.

### Why genie's Nav doesn't actually need drag

Audit of `src/tui/components/**`: zero registrations of `onMouseDrag` or
`onMouseDragEnd`. The Nav and every modal use clicks only. Drag tracking
is being subscribed for nothing.

## Approach — three jaws of the mega wish

### Jaw A — Local override (ships immediately)
After `createCliRenderer()` returns, genie's TUI bootstrap writes
`\e[?1002l` directly to stdout to disable drag tracking, leaving
`?1000h` (clicks) intact. Per xterm "last sequence wins" semantics
(confirmed by `terminal.zig:588` comment), the terminal then reports
only press/release events to OpenTUI; drags belong to the terminal.

Re-emit `?1002l` on every lifecycle event where OpenTUI re-applies
mouse setup: `enableMouse()` direct call, `useMouse` setter,
suspend/resume cycle. ~30 LOC in `src/tui/render.tsx`.

### Jaw B — Strip the OSC 52 plumbing (ships with Jaw A)
Once drag-select belongs to the terminal, the existing OSC 52
machinery is dead weight and actively confusing for users who
expect classic select + Cmd+C semantics:

- `~/.genie/scripts/osc52-copy.sh` — delete (or keep purely as a
  `genie agent send-clipboard` helper for non-TUI scripts; out of
  scope to decide here, default keep)
- `set -g set-clipboard external` in `genie.tmux.conf` and
  `tui-tmux.conf` — change to `set -g set-clipboard off` (no auto
  clipboard at the tmux layer)
- `set -ga terminal-overrides ",*:Ms=\E]52;c;%p2%s\7"` — delete
  (the `Ms` capability is the OSC 52 emit hook; with `set-clipboard off`
  it's unused, and removing it eliminates a source of stale config drift)
- `copy-pipe-and-cancel "~/.genie/scripts/osc52-copy.sh"` bindings
  in tmux copy-mode — change to `copy-selection-and-cancel` (tmux
  buffer only, no clipboard side effect; user uses terminal-native
  selection for the actual copy)
- `allow-passthrough on` — keep (other tools may use DCS passthrough)
- The accompanying regression tests in `src/__tests__/tmux-config.test.ts`
  invert: assert `set-clipboard off`, assert `copy-pipe-and-cancel`
  is NOT used with `osc52-copy.sh`, assert no `Ms` override
- Document the philosophical change in CHANGELOG: "TUI clipboard
  uses terminal-native selection. Drag to highlight, Cmd+C to copy.
  No auto-emit of OSC 52 on selection release."

### Jaw C — Upstream PR to anomalyco/opentui (parallel; merges later)
File a PR that wires the existing `MouseLevel` enum through `setMouseMode`:

```zig
// proposed signature
pub fn setMouseMode(self: *Terminal, tty: anytype, level: MouseLevel) !void {
    // emit DECSET sequences appropriate to the level
    // .none   → disable all
    // .basic  → ?1000h + ?1006h (clicks + SGR encoding)         ← NEW
    // .drag   → + ?1002h                                        ← current "useMouse=true, movement=false"
    // .motion → + ?1002h + ?1003h                              ← current "useMouse=true, movement=true"
    // .pixels → reserved for future pixel-coord mode
}
```

Plus surface `mouseLevel?: MouseLevel | "none" | "basic" | "drag" | "motion"`
in `CliRendererConfig`. Keep `useMouse` and `enableMouseMovement` as
backward-compat aliases that map to MouseLevel internally:

| Legacy config | New MouseLevel |
|---|---|
| `useMouse: false` | `none` |
| `useMouse: true, enableMouseMovement: false` | `drag` (preserves current behavior) |
| `useMouse: true, enableMouseMovement: true` | `motion` (preserves current behavior) |
| `mouseLevel: 'basic'` | `basic` (NEW) |

Once the PR merges and 0.2.7 (or whichever) is published, genie
upgrades `@opentui/core`, sets `mouseLevel: 'basic'` natively, and
deletes the local `\e[?1002l` override (Jaw A becomes obsolete).

## Scope

### IN
- **Jaw A: local mouse override**
  - `src/tui/render.tsx`: emit `\e[?1002l` post-`createCliRenderer`
  - Hook into renderer lifecycle (suspend/resume, useMouse setter) to re-emit
  - `src/tui/components/Nav.tsx`: confirm zero drag-handler registrations (audit; commit a comment)
  - Tests: synthetic press+release+release-at-different-position confirms the click-handler resolves to the press position (or release, with hysteresis if preferred — TBD)
- **Jaw B: OSC 52 cleanup**
  - `~/.genie/tmux.conf` (and shipped `scripts/tmux/genie.tmux.conf`):
    `set-clipboard off`, remove `Ms` override
  - `~/.genie/tui-tmux.conf` (and shipped `scripts/tmux/tui-tmux.conf`):
    same
  - Tmux copy-mode bindings: `copy-selection-and-cancel`, drop the
    `~/.genie/scripts/osc52-copy.sh` pipe
  - `scripts/tmux/osc52-copy.sh`: keep on disk for ad-hoc operator use,
    not invoked by config (or delete — TBD; default keep)
  - `src/__tests__/tmux-config.test.ts`: invert assertions
- **Jaw C: upstream PR**
  - Issue + PR on `anomalyco/opentui` wiring `MouseLevel` through
    `setMouseMode`, surfacing `mouseLevel` in `CliRendererConfig`
  - Backward-compat shim mapping legacy `useMouse` + `enableMouseMovement`
    to `MouseLevel`
  - Tests in opentui covering each level
  - Once accepted: bump genie's `@opentui/core` dep, switch to
    `mouseLevel: 'basic'`, delete the Jaw A local override
- **Cross-terminal smoke matrix** (one-time validation gate)
- **CHANGELOG entry** describing the UX semantics change (no auto OSC 52)
- **Doc note in `docs/configuration.md`** (or wherever) that copy-paste
  in `genie tui` works via terminal-native drag-select + the user's
  normal copy hotkey (Cmd+C / Ctrl+Shift+C / etc.)

### OUT
- The split-footer architectural rewrite (formerly
  `tui-split-footer-host` brainstorm — superseded; v4 sidebar+content
  layout is preserved as-is)
- Any change to the agent server `-L genie` other than the tmux config
  cleanup
- Any change to OpenTUI's *render* path or non-mouse subsystems
- Replacement of OpenTUI as the renderer
- Browser/Tauri-based TUI (separate khal-os surface, already shipped)
- Any change to `genie agent send-clipboard` / programmatic clipboard
  helpers (out of scope; those use OSC 52 intentionally and that path
  is unaffected by user-driven drag-select)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | Ship as one mega wish targeting v5; v4 stays frozen on npm. | Felipe direct ask 2026-05-09. v5 cutover (`v5-major-cutover-handoff`) is the natural release boundary and aligns with the CDN/sovereignty story. |
| **D2** | Preserve the v4 sidebar+content layout. No split-footer rewrite. | Felipe: "people love current behavior, it's just buggy." The architectural rewrite was solving the wrong problem. |
| **D3** | Local `\e[?1002l` override (Jaw A) ships immediately, regardless of upstream PR status. | Decoupled from anomalyco's review cadence. Closes the user pain on day one of v5. |
| **D4** | Strip OSC 52 plumbing (Jaw B) ships in the same wish. | Felipe explicit: "classic select and cmd + c, no auto-clipboard-on-release." OSC 52 path is now dead weight; leaving it in produces user confusion (selection silently triggers a clipboard write when the user only wanted to highlight). |
| **D5** | Upstream PR (Jaw C) is part of the wish but not blocking. | The right long-term solution. We file it; if it merges before v5 ships, we use it natively and drop the local override; if not, the local override ships and is replaced in a follow-up minor when upstream lands. |
| **D6** | Use the existing `MouseLevel` enum, not a new `useMouseDrag` flag. | The enum already exists in 0.2.6 source. Author intent is clear. Wiring an existing enum is a smaller, more reviewable PR than introducing a new boolean. |
| **D7** | Keep `osc52-copy.sh` script on disk. Just stop invoking it from tmux config. | Some operator scripts may use it ad-hoc (e.g., `cat file.txt \| ~/.genie/scripts/osc52-copy.sh` from a non-TUI shell). Deletion is breaking; keeping is harmless. |

## Risks & assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| A target terminal interprets `?1002l` after `?1002h` differently than xterm spec (drag still captured, or clicks also disabled) | Medium | Cross-terminal smoke matrix as a launch gate. Document misbehaving terminals + provide `GENIE_TUI_MOUSE=0` env as a manual escape hatch. |
| OpenTUI 0.2.7+ changes mouse setup such that our local override stops working before upstream PR lands | Low | Pin `@opentui/core` version explicitly during the override window; bump deliberately and re-verify. |
| anomalyco rejects or sits on the upstream PR | Low | Wish ships fine without it (Jaw C is non-blocking). If rejection: maintain local override indefinitely as the long-term solution; document why. |
| Stripping OSC 52 plumbing breaks operator scripts that depended on `set-clipboard external` for non-interactive clipboard writes | Low | The script `osc52-copy.sh` stays on disk. Anyone using it explicitly continues to work. The change is only that *tmux's automatic* clipboard write is disabled. |
| Some user genuinely loved auto-clipboard-on-release | Low | Felipe explicitly chose the opposite. Document the tradeoff in CHANGELOG; if any user complains, add `GENIE_TUI_CLIPBOARD_AUTO=1` env to re-enable. Don't pre-build the toggle. |
| Test inversion in `tmux-config.test.ts` cherry-picks back wrong on a v4 hot fix branch | Low | The wish targets v5 only. v4 codebase doesn't see this change. |
| Visual conflict between terminal-native selection highlight and OpenTUI's render | Low | Acceptable. Terminal selection styles are universally readable. No need to redesign. |

## Success criteria

### Functional (smoke gate: Warp + Terminal.app on macOS only)
Felipe directive 2026-05-09: real users are on Warp or Terminal.app.
Don't over-engineer cross-terminal validation; trust the native xterm
mouse/selection protocols. If another terminal misbehaves, treat it
as a post-launch support ticket, not a launch gate.

- [ ] On Linux server attached from **Warp on macOS**, `genie tui`
      running under v5: drag-select inside the OpenTUI Nav, release
      (no copy fires automatically), Cmd+C → text in Mac clipboard
- [ ] Same flow on **Terminal.app**
- [ ] Click-to-spawn / click-to-focus / click-to-expand still works in Nav
      under both Warp and Terminal.app
- [ ] Right tmux mirror pane: drag-select + Cmd+C works (already works
      after the in-session tmux mouse-off change; this wish persists it)
- [ ] After `genie tui` is suspended (Ctrl+Z) and resumed, drag-select
      still works (re-override path verified)
- [ ] `bun test src/tui/` and `bun test src/__tests__/tmux-config.test.ts` green
- [ ] No "documented unsupported" tier maintained. Other terminals are
      best-effort; users on niche terminals fall back to `GENIE_TUI_MOUSE=0`
      + tmux copy-mode (prefix+[) if their terminal is hostile to the
      override. Documented in CHANGELOG, not as a feature.

### Architecture / code health
- [ ] No `?1002h` reaches the SSH PTY when `genie tui` is running (verified by
      `tmux capture-pane -p` snapshot grep)
- [ ] No OSC 52 escape (`\e]52;c;`) reaches the SSH PTY during normal use
- [ ] `tmux show-options -g set-clipboard` returns `off` after `genie tui` first launch
- [ ] `tmux show-options -g terminal-overrides` does NOT contain `Ms=`
- [ ] `src/__tests__/tmux-config.test.ts` asserts the inverted invariants

### Upstream
- [ ] PR opened on `anomalyco/opentui` proposing `MouseLevel`-through-`setMouseMode`
- [ ] PR has tests for each level + backward-compat shim
- [ ] PR linked from this wish's status report

## Cross-references

- `[v5-major-cutover-handoff](../v5-major-cutover-handoff/DESIGN.md)` — sister wish; same v4-final / v5-launch boundary; the TUI selection change is one of v5's launch deliverables
- `[aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md)` — umbrella roadmap
- `[tui-split-footer-host](./tui-split-footer-host/DRAFT.md)` — superseded; architectural rewrite NOT pursued in this wish; v4 sidebar+content UX preserved
- `[opentui-0.2-deep](../wishes/opentui-0.2-deep.md)` — earlier OpenTUI 0.2 native adoption wish; this wish builds on its work but does not depend on its completion

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

- **Problem** ✅ — root cause + Felipe's explicit semantics signals + 0.2.6 source verification
- **Scope** ✅ — three jaws clearly delineated, OUT explicit
- **Decisions** ✅ — 7 decisions with rationale
- **Risks** ✅ — 7 risks ranked + mitigations
- **Criteria** ✅ — smoke gate is Warp + Terminal.app on macOS. No over-engineered cross-terminal matrix. Other terminals are best-effort + documented escape hatch (`GENIE_TUI_MOUSE=0`).
