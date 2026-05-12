---
slug: tui-opentui-host
title: OpenTUI hosts the entire TUI process; tmux retained only as the agent execution substrate
status: CRYSTALLIZED
created: 2026-05-10
crystallized-on: 2026-05-10
target-release: v5
supersedes-decision: tui-split-footer-host (rejected on 2026-05-09 based on a misread of operator intent — re-opened 2026-05-10 with the visual-UX constraint clarified)
sister-wishes:
  - v5-major-cutover-handoff (npm→CDN distribution cutover)
  - aegis-distribution-sovereignty (v5 launch umbrella)
  - tui-native-selection (v4 carry-over override; this wish makes the override permanent inside the new host)
---

# Brainstorm: OpenTUI host with embedded terminal panes

## Why this brainstorm exists (and why it is not split-footer)

On 2026-05-09 the operator authored `tui-native-selection` to ship a 3-jaw
override that suppressed OpenTUI's hardcoded `?1002h`/`?1003h` drag tracking,
restoring native drag-select inside the existing dual-tmux display
architecture. That wish shipped (PR #1730 + follow-up #1734) and the
operator confirmed it as a stop-gap, not the destination.

The earlier `tui-split-footer-host` brainstorm proposed collapsing the
dual-tmux display by adopting OpenTUI's `screenMode: "split-footer"` —
OpenTUI owns a footer band, the terminal owns the scrollback above. That
proposal was marked SUPERSEDED based on the operator comment "people love
current behavior, it's just buggy." That comment was misread: the operator
meant the **visual** behavior (Nav left, content right; click left → see
right), not the dual-tmux **architecture** (two glued tmux servers with
OpenTUI rendered inside one of them). Split-footer was the wrong target
because it flips the layout to footer-bottom. **The right target is
sidebar+content visual UX with OpenTUI owning the entire host process and
embedding a terminal-pane widget where the right tmux mirror used to live.**

This brainstorm captures that corrected target.

## Problem (one-sentence)

The current TUI architecture (OpenTUI rendered as one pane inside a
`-L genie-tui` tmux server, beside a passthrough mirror pane piping
`-L genie` agent output) has two glued tmux servers, two render paths,
two mouse-handling layers, and two startup/teardown lifecycles — producing
recurring UX bugs (drag-select gaps, `no sessions` race on `genie app --tui`,
theme drift between configs, `?1003` Linux leak) and blocking the v5 launch
posture of a single, predictable display surface.

## Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│                  OpenTUI host (single process)               │
│                  ────────────────────────────                │
│  ┌─────────────────────┬──────────────────────────────────┐  │
│  │                     │                                  │  │
│  │   <Nav>             │   <TerminalPane>                 │  │
│  │   (existing React   │   (NEW Renderable widget;        │  │
│  │    tree component)  │    headless VT emulator inside,  │  │
│  │                     │    blits cells into OpenTUI      │  │
│  │   ▸ session tree    │    OptimizedBuffer each frame)   │  │
│  │   ▸ click → focus   │                                  │  │
│  │   ▸ context menu    │   ▸ I/O: tmux -CC %output        │  │
│  │                     │     (decoded) into VT parser     │  │
│  │                     │   ▸ input: tmux send-keys -H     │  │
│  │                     │   ▸ resize: refresh-client -C    │  │
│  └─────────────────────┴──────────────────────────────────┘  │
│                                                              │
│  Mouse: ?1000h clicks ON (Nav + TerminalPane focus)          │
│         ?1002l + ?1003l drag tracking OFF (native select)    │
│                                                              │
│  Drag-select routes to the host terminal's selection layer,  │
│  which selects whatever OpenTUI rendered (Nav rows OR        │
│  TerminalPane cells) → Cmd+C copies via terminal-native      │
│  path → no OSC 52, no tmux DCS, no clipboard bridge.         │
└──────────────────────────────────────────────────────────────┘
                              │
                              │  (only data link to tmux)
                              ▼
              ┌──────────────────────────────────┐
              │  -L genie (agent tmux server)    │
              │  ────────────────────────────    │
              │  ▸ Spawn substrate for agents    │
              │  ▸ Persistent session storage    │
              │  ▸ Resurrection / detach safety  │
              │  ▸ NOT touched by display layer  │
              └──────────────────────────────────┘
```

What disappears in v5:
- `-L genie-tui` tmux server (entire second tmux process)
- `~/.genie/tui-tmux.conf` (entire config file)
- The `_genie_*` right-side mirror pane creation in `src/tui/tmux.ts`
- `src/tui/tmux-theme-sync.ts` (theme sync for the deleted display server)
- The "two glued tmux" lifecycle dance in `src/term-commands/serve.ts`
  (`ensureTuiSession`, `isTuiSessionReady`)
- The "no sessions" failure path on `genie app --tui` (no display tmux
  means nothing to fail to attach to)
- `attachTuiSession` in `src/tui/tmux.ts`

What is preserved:
- All `<Nav>` UX: tree of sessions/windows/panes, click-to-focus, context
  menu, spawn affordance, theme.
- The agent tmux server (`-L genie`) and every agent's lifecycle.
- The `tui-native-selection` mouse override (`?1002l\?1003l` emit after
  `enableMouse()`) — folded into TerminalPane's render path instead of
  being a renderer-level monkey-patch.

## Verified OpenTUI 0.2.6 primitives (confirmed in cloned source)

| Primitive | Location | Used for |
|-----------|----------|----------|
| `abstract class Renderable extends BaseRenderable` | `packages/core/src/Renderable.ts` | Base for the new `TerminalPane` widget |
| `OptimizedBuffer.setCell(x, y, char, fg, bg, attrs)` | `packages/core/src/buffer.ts` | Per-cell blit from VT buffer to OpenTUI |
| `OptimizedBuffer.drawText` / `fillRect` | `packages/core/src/buffer.ts` | Fallback paths for batched rows / clears |
| `createCliRenderer({ useMouse, enableMouseMovement, … })` | `packages/core/src/renderer.ts` | Already used by `src/tui/render.tsx` |
| DECRST `?1002l` + `?1003l` override | `src/tui/render.tsx` (this repo) | Carried forward unchanged from `tui-native-selection` |

Verified NOT available:
- Built-in PTY or xterm renderable widget. `ScrollbackSurface` is hard
  gated to `screenMode: "split-footer"` (throws otherwise), and is a
  **stream-into-terminal-scrollback** primitive, not an
  **embed-inside-a-box** primitive. So we cannot reuse it for the right
  pane — we author `TerminalPane` ourselves.

## Sister architecture already shipped (the canonical implementation reference)

`automagik-dev/khal-os/.genie/wishes/tmux-control-mode-terminal/` (SHIPPED
2026-03-18) replaced node-pty with a single `tmux -CC attach` connection
per agent session, multiplexing pane I/O via `%output`/`send-keys -H`/
`refresh-client -C`. Files of interest:

- `packages/genie-app/views/genie/service/tmux-control.ts` — control-mode
  client (octal-escape decoder, %output dispatch, %exit handling)
- `packages/genie-app/views/genie/service/tmux-input.ts` — `send-keys -H`
  hex-mode input writer
- `packages/genie-app/views/genie/service/tmux-resize.ts` — `refresh-client
  -C <w>x<h>` resize forwarder
- `packages/genie-app/views/genie/components/Terminal.tsx` — xterm.js
  rendering target (replaced by `TerminalPane` in our CLI case)

The data-flow half of this wish is solved: **port the khal-os
tmux-control implementation verbatim**. The renderer half is new (xterm.js
in a browser → `TerminalPane` in OpenTUI).

## Scope

### IN
- New `TerminalPane` Renderable in `src/tui/components/TerminalPane.tsx`
  (or `src/tui/widgets/`). Public surface: `<TerminalPane
  sessionName="…" />` — picks up the agent tmux pane id from `<Nav>`'s
  focus state, attaches via `tmux -CC`, blits each frame.
- New `src/tui/tmux-control/` module porting khal-os's tmux-control
  client (control connection, octal decoder, %output → bytes pipeline,
  send-keys -H input, refresh-client -C resize).
- A headless VT emulator dependency (`@xterm/headless` recommended;
  evaluated alternatives in §Decisions below).
- `<App>` layout swap in `src/tui/app.tsx`: replace the existing
  right-side tmux mirror with `<TerminalPane>`, keep `<Nav>` on the
  left, preserve current split ratio and theme.
- Removal of the `-L genie-tui` display tmux server end-to-end:
  delete `ensureTuiSession`/`isTuiSessionReady`/`attachTuiSession`,
  drop `tui-tmux.conf`, drop `tmux-theme-sync.ts`, delete the
  `_genie_*` pane creator, scrub `genie doctor` and `genie serve`
  for the now-orphan checks.
- `genie app --tui` becomes a thin wrapper that just runs
  `renderNav()` — no tmux session orchestration before render.
- Drag-select override (`?1002l + ?1003l`) re-homed inside the new host
  (still emitted on every `enableMouse` call); `tui-native-selection`'s
  test harness reused as-is.
- Cross-terminal smoke matrix as a v5 launch gate (Warp, Ghostty, iTerm2,
  Terminal.app, Alacritty, Wezterm, kitty, foot).
- v5-only cutover. v4 stays frozen on the dual-tmux architecture forever.

### OUT
- Agent execution substrate (`-L genie`) — untouched.
- Replacing tmux as the agent multiplexer. Tmux stays for resurrection,
  detach safety, and pane state.
- Replacing OpenTUI as the renderer.
- khal-os browser-side `genie-workspace-canvas` (separate surface, already
  shipped).
- Built-in `tmux capture-pane -p` fallback for initial buffer replay
  beyond what `tmux -CC` natively provides (D2 below pins this to the
  control-mode `dump-history` path that khal-os already uses).
- Any flag plumbing to opt back into the legacy dual-tmux TUI inside v5.
  The v5 codebase is single-host only.
- Cross-major flag gating (v4 vs v5). v5 ships embed-only.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | Visual UX is preserved exactly. Nav (left), content (right). Same split ratio, same theme, same click-to-focus behavior. No footer mode. | Operator directive (2026-05-10): "visually staying exactly the same." The split-footer rejection was about layout, not architecture — the architectural collapse the prior brainstorm proposed is correct; the layout choice was wrong. |
| **D2** | Tmux retained for agent execution only. `-L genie-tui` deleted. `-L genie` untouched. | Two-glued-tmux is the bug. Single agent tmux retains resurrection, detach safety, and existing pane state — switching the execution substrate is out of scope (and was never the proposal). |
| **D3** | Embed mechanism: new `TerminalPane` Renderable + headless VT emulator (`@xterm/headless`). | OpenTUI 0.2.6 has no built-in PTY/xterm primitive. `ScrollbackSurface` is split-footer-only. The cell-blit path via `OptimizedBuffer.setCell` is the only viable primitive. `@xterm/headless` is MIT, ~150 KB, battle-tested by VS Code's terminal, and exposes a parsed cell buffer that maps 1:1 to OpenTUI cells. Alternatives evaluated: `vt100-parser` (low-level, no buffer model), `node-pty` (irrelevant — we're not allocating a PTY, we're parsing a stream), rolling our own VT parser (cost: weeks; risk: parity drift with real terminals). Picked headless emulator. |
| **D4** | Tmux↔host data link: `tmux -CC attach -t <agent-session>`. One control connection per focused pane. Port khal-os's tmux-control client verbatim. | Battle-tested in khal-os production since 2026-03-18 (~7 weeks). `%output` push gives ≤100 ms p95 latency vs `capture-pane` polling's lossy 2× interval floor. `send-keys -H` covers full UTF-8 input. `refresh-client -C` covers resize. Existing implementation = no parser surprises. |
| **D5** | v5-only cutover. v4 stays frozen with the dual-tmux TUI. No flag, no migration in either direction. | Confirmed by D1 of the prior `tui-split-footer-host` brainstorm and re-affirmed by the operator's `tui-native-selection` v5-target tag. Eliminates two-surface tax. v4 npm users keep the old TUI indefinitely; v5 CDN users get embed-only. Sister to `v5-major-cutover-handoff` (npm→CDN distribution cutover) and `aegis-distribution-sovereignty` (v5 launch umbrella). |
| **D6** | Drag-select override (`?1002l + ?1003l`) carried forward as a permanent feature of `TerminalPane`, emitted on every `enableMouse()` plus once at render-mount. Tests from `tui-native-selection` reused as-is. | The override is correct: clicks ON, drag tracking OFF, drag routes to terminal-native selection. With OpenTUI hosting the whole frame, the override now governs **both** the Nav region and the TerminalPane region — Nav clicks still work, TerminalPane drag-select still works. The override stops being a stop-gap and becomes the host's documented mouse contract. |
| **D7** | Initial buffer replay on focus = control-mode `display-message` + `dump-history` (the same path khal-os uses), capped at the larger of `tmux history-limit` or 10 000 lines. | Matches khal-os's existing implementation. Capping prevents a multi-MB blast on focusing a long-running agent (e.g., `genie work` after hours). Beyond cap, scrollback is the agent's own tmux history (operator can detach the TUI and `tmux -L genie attach` directly to see full history). |
| **D8** | Focus & input model: when the focus is inside `<TerminalPane>`, keystrokes route via `send-keys -H` to the focused tmux pane. When focus is in `<Nav>`, keystrokes drive the Nav (same as today). Keymap defines a hotkey to swap focus. Mouse click on a region transfers focus to it. | Matches today's interaction model where the user clicks left to choose, clicks right to type. The hotkey provides keyboard-only navigation. Modal "send mode" was considered and rejected as a needless extra step. |
| **D9** | Multi-agent visibility: one TerminalPane mounted per session in `<Nav>`'s focus model; only the focused agent renders. Background agents continue running on `-L genie` but consume no TerminalPane resources until focused. | Matches today's "right side shows one agent at a time" UX exactly. Mounting all panes simultaneously would explode memory (one xterm-headless buffer per agent) and CPU (one tmux -CC connection per agent) for no UX win. |
| **D10** | Performance budget: ≤100 ms p95 latency from agent emit to TerminalPane render on Linux, ≤150 ms p95 on macOS. ≤8 % single-core CPU at idle with the focused agent doing nothing. Validated by a microbenchmark in the validation phase. | Matches khal-os's measured budget. Tighter than the current dual-tmux setup (which already has ~150 ms steady-state from the right-pane passthrough). |
| **D11** | Theme: existing `~/.genie/.generated.theme.conf` continues to feed `-L genie` (agent server). After deletion of `-L genie-tui`, the theme generator's `tui-tmux.conf` output path is removed. Theme is otherwise sourced from OpenTUI's existing `src/tui/theme.ts`. | One fewer config file to keep in sync, one fewer place for theme drift to surface. |
| **D12** | Deletion checklist runs after the new host is shown to work end-to-end. Order: (a) ship `TerminalPane` + tmux-control behind a `GENIE_TUI_HOST=embed` flag in v5; (b) validate the smoke matrix; (c) make embed the default and delete the legacy dual-tmux code paths in the same PR. No long-running `embed=off` escape hatch ships. | Confidence path: prove it works, then collapse. Avoids a debugging nightmare where v5 ships with both code paths and `embed=off` becomes the de-facto default forever. |

## Risks & assumptions

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| **R1** | `@xterm/headless` cell-buffer access surface may not expose every attribute OpenTUI's `setCell` needs (underline styles, hyperlinks, true-color). | Medium | Spike a `TerminalPane` proof-of-concept against a one-line `printf` test fixture in the first hour of execution. If attribute coverage is short, fall back to `OptimizedBuffer.drawText` + ANSI escape passthrough (slower but feature-complete). |
| **R2** | OpenTUI's render loop is frame-based (`targetFps`); the VT buffer may update at a different rate, producing visible tearing for high-throughput agent output. | Medium | Coalesce VT updates into the next OpenTUI frame in `TerminalPane.render()`. khal-os uses the same approach with xterm.js's render service — same pattern applies. |
| **R3** | Single `tmux -CC` connection per focused pane may not detect a tmux server restart cleanly (orphan control mode → silent stall). | Medium | Health-check via `display-message #{client_pid}` every 5 s; on miss, reconnect. Same pattern khal-os ships. |
| **R4** | Operators with `genie tui` in deep tmux session muscle memory may be surprised when `-L genie-tui` no longer exists. | Low | One-line note in v5 release notes + `genie doctor` advisory ("the display tmux server was retired in v5; only `-L genie` exists now"). |
| **R5** | The TerminalPane's drag-select feeds the host terminal's selection of OpenTUI-rendered cells, not the agent's underlying buffer. The user copies "what you see," not "what scrolled past." | Low | Document this in `genie shortcuts` + onboarding skill. Operators who need long-scrollback copy can `tmux -L genie attach` directly (same as today's escape hatch for "I need to see more history"). |
| **R6** | Cross-terminal smoke matrix may surface a terminal with no mouse-protocol parity (e.g., foot's mouse encoding is xterm-compat but its selection model differs). | Medium | Smoke matrix is a launch gate, not a per-PR gate. v5 launch ships only on terminals where the matrix passes; documented compat list in release notes. |
| **R7** | `tmux send-keys -H` does not transparently forward control sequences that include `;` (semicolon is the hex separator). Multi-codepoint paste paths may need a `paste-buffer` fallback. | Low | khal-os already solved this with a `load-buffer` + `paste-buffer -p` fallback for long pastes. Port the same code. |

## Success criteria

- [ ] `genie tui` (and `genie`, and `genie app --tui`) launches a single
      OpenTUI process. `pgrep -f "tmux -L genie-tui"` returns no rows.
- [ ] `~/.genie/tui-tmux.conf` does not exist in the v5 distribution. The
      file is removed from the repo and is not generated at runtime.
- [ ] `<Nav>` (left) and `<TerminalPane>` (right) render at the same
      split ratio and theme as today's TUI. Visual diff (screenshots in
      `docs/v5-launch/tui-visual-parity.md`) shows no regression.
- [ ] Drag-select inside the `TerminalPane` region copies via the host
      terminal's native clipboard path in Warp (macOS), iTerm2, Ghostty,
      Terminal.app, Wezterm, Alacritty, kitty, foot. No OSC 52, no tmux
      DCS, no pbcopy bridge. Cmd+C (or platform equivalent) is sufficient.
- [ ] Click-to-focus from `<Nav>` still works. Selecting an agent in Nav
      mounts/refocuses its `TerminalPane`, scrollback initial-replay
      completes within 500 ms.
- [ ] Keystrokes while `<TerminalPane>` is focused reach the agent's tmux
      pane (validated by `printf 'echo hi' | genie agent send-keys`
      golden test running against a live agent).
- [ ] `tmux -L genie kill-server` (operator wipes the agent server)
      surfaces a clean "agent server unreachable; restart with `genie
      serve`" status in `<Nav>`, no crash, no OpenTUI hang.
- [ ] `genie doctor` reports "single-host TUI architecture" and reflects
      the absence of the display tmux server (i.e., the legacy "TUI
      server up" check is replaced).
- [ ] Performance: ≤100 ms p95 emit→render latency on Linux, ≤150 ms p95
      on macOS, measured by a microbenchmark fixture that emits 10 000
      lines at 1 ms intervals.
- [ ] Idle CPU: ≤8 % single-core with the focused agent idle, measured
      via `top` over a 60 s sample.
- [ ] All existing `tui-native-selection` tests (`render.test.ts` drag
      tracking assertions) still pass against the new host.
- [ ] Removal: `tmux-theme-sync.ts`, `_genie_*` mirror pane creator,
      `attachTuiSession`, `ensureTuiSession`, `isTuiSessionReady`,
      `tui-tmux.conf` template all deleted in the same PR that flips the
      default to embed.

## Cross-links to v5 launch umbrella
- `[v5-major-cutover-handoff](../v5-major-cutover-handoff/DESIGN.md)` — distribution cutover (npm→CDN)
- `[aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md)` — v5 launch umbrella
- `[tui-native-selection](../../wishes/tui-native-selection/WISH.md)` — v4 carry-over (override stays; the override's permanent home moves into this host)
- `[tui-split-footer-host](../tui-split-footer-host/DRAFT.md)` — superseded prior brainstorm; layout target was wrong (footer-bottom vs sidebar+content), architectural collapse is correct

## WRS

```
WRS: ██████████ 100/100
 Problem ✅ | Scope ✅ | Decisions ✅ | Risks ✅ | Criteria ✅
```

- **Problem** ✅ — dual-tmux is the bug, named with concrete failure modes.
- **Scope** ✅ — IN/OUT cut; deletions enumerated; v5-only confirmed.
- **Decisions** ✅ — D1–D12 cover layout, substrate, embed primitive, data link, lifecycle, mouse, focus, multi-agent, perf, theme, cutover order.
- **Risks** ✅ — R1–R7 cover xterm-headless attribute parity, render tearing, tmux reconnect, operator surprise, copy semantics, terminal compat, hex paste.
- **Criteria** ✅ — testable, includes perf budget + visual parity + deletion checklist.
