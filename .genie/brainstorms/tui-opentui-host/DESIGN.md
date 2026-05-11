# Design: TUI OpenTUI host (embedded terminal panes)

| Field | Value |
|-------|-------|
| **Slug** | `tui-opentui-host` |
| **Date** | 2026-05-10 |
| **WRS** | 100/100 |
| **Target release** | v5 |
| **Supersedes** | `tui-split-footer-host` brainstorm (layout target was wrong; architectural collapse is correct — re-opened with the visual-UX constraint clarified) |
| **Sister** | `tui-native-selection` (v4 carry-over override; permanent home moves into this host); `v5-major-cutover-handoff`; `aegis-distribution-sovereignty` |

## Problem

The current TUI architecture (OpenTUI rendered inside a `-L genie-tui`
tmux server, beside a passthrough mirror pane piping `-L genie` agent
output) has two glued tmux servers, two render paths, two mouse layers,
and two startup lifecycles — producing recurring UX bugs and blocking
the v5 launch posture of a single predictable display surface.

## Scope

### IN
- New `TerminalPane` Renderable widget (`src/tui/components/TerminalPane.tsx`)
  built on `OpenTUI.OptimizedBuffer.setCell` + a headless VT emulator.
- New `src/tui/tmux-control/` module porting khal-os's tmux-control client
  (control connection, octal-escape decoder, `%output`→bytes pipeline,
  `send-keys -H` input, `refresh-client -C` resize).
- Headless VT emulator dependency: `@xterm/headless`.
- `<App>` layout swap: `<Nav>` (left) + `<TerminalPane>` (right) replacing
  the existing right-side tmux mirror pane. Visual parity with v4.
- End-to-end removal of `-L genie-tui` display tmux server:
  `ensureTuiSession`/`isTuiSessionReady`/`attachTuiSession`/`_genie_*`
  pane creator/`tmux-theme-sync.ts`/`tui-tmux.conf` all deleted.
- `genie app --tui` collapses to a thin wrapper over `renderNav()`.
- Drag-select override (`?1002l + ?1003l`) re-homed inside the new host
  as TerminalPane's documented mouse contract.
- Cross-terminal smoke matrix as v5 launch gate.
- v5-only cutover. v4 stays frozen on the dual-tmux architecture forever.

### OUT
- Agent execution substrate (`-L genie` agent tmux server) — untouched.
- Replacing tmux as the agent multiplexer.
- Replacing OpenTUI as the renderer.
- khal-os browser-side `genie-workspace-canvas` (separate surface).
- Long-running `embed=off` escape hatch inside v5.
- Cross-major flag gating (v4 ↔ v5). v5 ships embed-only.
- Switching to OpenTUI's `screenMode: "split-footer"` (incompatible with
  the sidebar+content layout the operator requires).

## Approach

**OpenTUI hosts the whole TUI process; tmux is retained only as the
agent execution substrate.**

The display layer collapses from two tmux servers + one OpenTUI process
to one OpenTUI process. Inside OpenTUI, the existing `<Nav>` React tree
stays on the left. The right pane becomes `<TerminalPane>`, a new
`Renderable` subclass that:

1. Owns one `tmux -CC attach -t <agent-session>` control connection
   pointing at the focused agent's pane on `-L genie`.
2. Feeds the octal-decoded `%output` byte stream into an `@xterm/headless`
   instance, which maintains a parsed cell buffer + cursor + scrollback
   in memory.
3. On each OpenTUI render frame, walks the headless cell buffer and
   `setCell`s each cell into OpenTUI's `OptimizedBuffer` at the
   TerminalPane's position. Cursor blink, attributes (fg/bg, bold,
   underline, dim), and basic hyperlink support carried through.
4. Forwards keystrokes via `tmux send-keys -H <hex>` when the TerminalPane
   has focus; falls through to Nav otherwise.
5. Forwards resizes via `tmux refresh-client -C <cols>x<rows>` whenever
   the TerminalPane's bounding box changes.

The drag-select override stays (clicks ON, drag tracking OFF). With
OpenTUI as the sole renderer, drag-select on either Nav or TerminalPane
routes to terminal-native selection, copying whatever cells the host
terminal rendered — no OSC 52, no tmux DCS, no clipboard bridge.

The `-L genie-tui` tmux server is entirely deleted. Agents continue to
run on `-L genie` exactly as today; only the display layer changes.

### Alternatives considered

| Option | Why not |
|--------|---------|
| OpenTUI `screenMode: "split-footer"` (Nav as bottom footer, scrollback above) | Flips the layout to footer-bottom. Operator directive: visual UX stays exactly the same (sidebar left + content right). |
| Keep dual-tmux, just polish the override | The override fixed v4 drag-select but the underlying lifecycle bugs (`no sessions` race, Linux `?1003` leak, theme drift across two configs, race on `genie app --tui`) keep recurring. Architectural collapse is the only durable answer. |
| Replace tmux entirely with raw PTYs (`node-pty`) inside OpenTUI | Loses resurrection/detach safety. Existing operator muscle memory (`tmux -L genie attach` for direct debug) breaks. Out of scope. |
| Roll our own VT parser instead of `@xterm/headless` | Cost: weeks. Risk: parity drift with real terminals (xterm-headless is what VS Code Terminal uses in production). |
| Mount one TerminalPane per agent simultaneously | One xterm-headless buffer + one tmux -CC connection per agent = unbounded memory + CPU. UX win is zero (only one pane is visible at a time anyway). |

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | Visual UX preserved exactly. Sidebar left + content right. No footer mode. | Operator directive 2026-05-10. The split-footer rejection was layout, not architecture. |
| **D2** | Tmux retained for agent execution only. `-L genie-tui` deleted; `-L genie` untouched. | Two-glued-tmux is the bug; the agent substrate is correct. |
| **D3** | Embed mechanism: new `TerminalPane` Renderable + `@xterm/headless`. | OpenTUI 0.2.6 has no built-in PTY widget; `ScrollbackSurface` is split-footer-locked. `@xterm/headless` is MIT, ~150 KB, used by VS Code Terminal. |
| **D4** | Tmux↔host data link: `tmux -CC` control mode. Port khal-os's tmux-control client verbatim. | Battle-tested since 2026-03-18; ≤100 ms p95 emit→render. |
| **D5** | v5-only cutover. v4 stays frozen on dual-tmux. No flag, no migration. | Sister to `v5-major-cutover-handoff`. Eliminates two-surface tax. |
| **D6** | Drag-select override (`?1002l + ?1003l`) carried forward as TerminalPane's permanent mouse contract; `tui-native-selection` tests reused. | The override is correct: clicks ON, drag OFF, drag → native selection. |
| **D7** | Initial buffer replay = control-mode `dump-history`, capped at max(`tmux history-limit`, 10 000) lines. | Matches khal-os; prevents multi-MB blast on focusing a long-running agent. |
| **D8** | Focus & input: TerminalPane focused → keys via `send-keys -H`; Nav focused → keys drive Nav. Mouse click transfers focus. Hotkey toggles. | Matches today's click-left-to-choose / click-right-to-type flow. |
| **D9** | One TerminalPane mounted at a time (the focused agent). Background agents keep running on `-L genie` but consume no TerminalPane resources. | Matches today's "right side shows one agent at a time" UX exactly. |
| **D10** | Performance: ≤100 ms p95 emit→render on Linux, ≤150 ms on macOS. ≤8 % idle CPU with focused agent idle. Microbenchmark fixture validates. | Matches khal-os; tighter than today's dual-tmux passthrough (~150 ms steady). |
| **D11** | Theme: `-L genie` continues to consume `.generated.theme.conf`. `tui-tmux.conf` generation path is removed. OpenTUI side uses existing `src/tui/theme.ts`. | One fewer place for theme drift. |
| **D12** | Deletion order: (a) ship TerminalPane + tmux-control behind `GENIE_TUI_HOST=embed` in v5; (b) validate smoke matrix; (c) flip default + delete legacy code in the same PR. No long-running `embed=off`. | Prove-then-collapse; avoid two-codepath debt. |

## Risks & Assumptions

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@xterm/headless` cell attribute coverage gap (underline styles, hyperlinks, true-color) | Medium | Spike a one-line `printf` fixture in hour 1. Fall back to `OptimizedBuffer.drawText` + ANSI passthrough if short. |
| Render tearing under high-throughput agent output | Medium | Coalesce VT updates into next OpenTUI frame (`targetFps`-aligned). Same pattern as khal-os xterm.js render service. |
| `tmux -CC` orphan after agent server restart | Medium | 5 s health-check via `display-message #{client_pid}`; reconnect on miss. |
| Operator surprise: no `-L genie-tui` server anymore | Low | v5 release-note line + `genie doctor` advisory. |
| Copy semantics: drag-select copies rendered cells, not full agent scrollback | Low | Document in `genie shortcuts` + onboarding. Escape hatch: `tmux -L genie attach`. |
| Cross-terminal mouse-protocol parity (e.g., foot) | Medium | Smoke matrix is launch gate, not per-PR. Compat list in release notes. |
| `send-keys -H` semicolon edge cases on multi-codepoint paste | Low | Port khal-os's `load-buffer` + `paste-buffer -p` fallback. |

## Success Criteria

- [ ] `genie tui` / `genie` / `genie app --tui` launch one OpenTUI process; `pgrep -f "tmux -L genie-tui"` returns zero rows.
- [ ] `~/.genie/tui-tmux.conf` deleted from repo + not generated at runtime.
- [ ] Visual parity: split ratio, theme, click-to-focus identical to v4. Screenshot diff in `docs/v5-launch/tui-visual-parity.md` shows no regression.
- [ ] Drag-select in TerminalPane copies via host-terminal-native clipboard in Warp, iTerm2, Ghostty, Terminal.app, Wezterm, Alacritty, kitty, foot (no OSC 52, no tmux DCS).
- [ ] Click-to-focus from Nav mounts/refocuses TerminalPane; initial-replay completes ≤500 ms.
- [ ] Keystrokes routed to focused agent's tmux pane (golden test against live agent).
- [ ] `tmux -L genie kill-server` surfaces clean "agent server unreachable" status in Nav — no crash, no hang.
- [ ] `genie doctor` reports single-host TUI architecture; legacy "TUI server up" check replaced.
- [ ] Perf: ≤100 ms p95 emit→render on Linux, ≤150 ms on macOS; microbenchmark fixture emits 10 000 lines @ 1 ms.
- [ ] Idle: ≤8 % single-core CPU with focused agent idle (60 s sample).
- [ ] All existing `tui-native-selection` `render.test.ts` assertions pass unchanged.
- [ ] Deletion checklist complete in the same PR that flips embed default: `tmux-theme-sync.ts`, `_genie_*` creator, `attachTuiSession`, `ensureTuiSession`, `isTuiSessionReady`, `tui-tmux.conf` all removed.

## Self-review (4-point checklist)

1. **Placeholder scan** — No TBD/TODO remaining. All decisions and risks have concrete content.
2. **Internal consistency** — Scope-OUT excludes split-footer; Approach commits to embedded-terminal; Decisions D1 (visual UX preserved) ↔ D3 (custom Renderable) ↔ D9 (one pane mounted) are consistent. No contradictions found.
3. **Scope check** — One coherent project: collapse the display layer. Touches `src/tui/`, `src/term-commands/{app,serve}.ts`, theme generator, and `genie doctor`. All in one subsystem (the TUI). Not multi-subsystem.
4. **Ambiguity check** — "Visual parity" is concrete (split ratio + theme + click-to-focus, with a screenshot diff gate). "Perf budget" is concrete (p95 ms targets + microbench fixture). "Embed mechanism" picks one library (`@xterm/headless`) with a fallback path named. No two-interpretation language left.

PASS.
