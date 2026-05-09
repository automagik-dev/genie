---
slug: tui-split-footer-host
title: Migrate genie CLI TUI from "OpenTUI inside tmux" to OpenTUI split-footer host
status: SUPERSEDED — see tui-native-selection
created: 2026-05-09
superseded-on: 2026-05-09
superseded-by: tui-native-selection
---

> **SUPERSEDED 2026-05-09 by `tui-native-selection`.**
>
> Felipe's clarification mid-brainstorm — "people love current behavior,
> it's just buggy" — explicitly rejected the architectural rewrite this
> brainstorm proposed. The v4 sidebar+content layout stays. The actual
> fix lives in `tui-native-selection`, which addresses the bug at its
> root (OpenTUI's hardcoded `?1002h` drag tracking) and removes the
> obsolete OSC 52 plumbing in one mega wish targeting v5.
>
> Keeping this DRAFT.md on disk as a superseded artifact for two
> reasons: (1) the architectural exploration is useful background if
> anyone ever proposes a split-footer rewrite again, and (2) the
> link is referenced from `tui-native-selection`'s cross-references.
>
> **Do not crystallize this brainstorm.** Do not open a wish for it.
> The v5 TUI work all flows through `tui-native-selection`.

# Brainstorm: TUI split-footer host migration

## Genesis (raw context from the seed conversation)

### Symptom that started this
Felipe was unable to copy text via drag-select inside `genie tui` while connected
over SSH from Warp on macOS. After investigation:

1. **Warp does not implement OSC 52.** Confirmed by source-grep across
   `github.com/warpdotdev/warp/crates/`: zero hits for `OSC 52`, `osc52`,
   `]52;`, or any escape-driven `set_clipboard` path. Warp writes to the
   Mac clipboard only on its own UI events (Cmd+C in a Warp block, "Copy
   command" affordances). Bytes flowing through the terminal as OSC 52
   are dropped.
2. **The genie CLI TUI today layers two tmux servers.**
   - `-L genie` (agent server, `~/.genie/tmux.conf`) — spawns + hosts agents.
   - `-L genie-tui` (display server, `~/.genie/tui-tmux.conf`) — runs the
     OpenTUI Nav (left) + a tmux mirror pane (right) that pipes the active
     agent's pane into the user's view.
3. **OpenTUI itself enables xterm mouse tracking** (`DECSET 1000 / 1006`)
   so the Nav can dispatch click-to-focus / click-to-spawn events. Drag
   events become escape-sequence input to OpenTUI rather than terminal
   selection — so the Mac terminal never sees a "user selected text"
   event for the left pane.
4. **The right pane is a tmux passthrough mirror** of an agent's pane on
   the agent server. Drag-select there *can* go through tmux's copy-mode
   path, but only via OSC 52 — which Warp drops. Same dead end.
5. After narrowing tmux mouse to off on `-L genie`, **regular shell panes
   on the agent server now copy fine** (Warp owns the mouse drag layer).
   The TUI does not, because OpenTUI captures mouse for both panes.

### Mitigations attempted in-session (all kept)
- Disabled tmux mouse on `-L genie` (live + persisted via
  `GENIE_TMUX_MOUSE=off` in `~/.bashrc`) — fixed regular shell panes.
- Set `set -g mouse off` in `~/.tmux.conf` (the user's default-socket
  config) — fixed the default-socket case for symmetry.
- Tried `GENIE_TUI_MOUSE=0` to disable OpenTUI's mouse tracking inside
  the TUI — **reverted** because Felipe needs Nav click-to-navigate.

### Architectural observation that crystallized the wish
> "The TUI is INSIDE the tmux, not the other way around. OpenTUI
> supposedly has native integration with tmux, in a way we could embed
> it iframe-like inside the app."

That phrasing pointed at OpenTUI 0.2's `screenMode: "split-footer"` +
`ScrollbackSurface` primitives (documented in
`packages/web/src/content/docs/core-concepts/renderer.mdx` of the
`anomalyco/opentui` repo, cloned to
`/home/genie/workspace/repos/opentui-investigate/` for reference). It
isn't literally a tmux integration — it's a screen-region partition
where OpenTUI owns *only* a footer band on the main screen, and the
terminal owns the scrollback above. External output (sub-process
stdout via `externalOutputMode: "capture-stdout"`, or programmatic
styled rows via `ScrollbackSurface.commitRows()`) flows into the
scrollback area — which the *terminal* owns, so drag-select & Cmd+C
work natively in any terminal, including Warp.

Confirmed primitives in the cloned source:
- `packages/core/src/renderer.ts:196` — `ScreenMode = "alternate-screen" | "main-screen" | "split-footer"`
- `packages/core/src/renderer.ts:204` — `ExternalOutputMode = "capture-stdout" | "passthrough"`
- `packages/core/src/renderer.ts:247–260` — `ScrollbackSurface` interface
- `packages/examples/src/split-mode-demo.ts` — fullscreen ↔ split-footer toggle demo
- `packages/examples/src/split-footer-streaming-demo.ts` — sub-process-style streaming into scrollback

### Lost-wish search summary
Felipe recalled a wish proposing this rework. Searched every
`.genie/wishes/` and `.genie/brainstorms/` under
`/home/genie/workspace/**` (including all worktrees, agent
workspaces, and `~/.genie`/`~/.claude` plugin caches). Closest
existing artifact: `.genie/wishes/opentui-0.2-deep.md`, which
mentions screen modes only as a Phase-3 doc-list parenthetical and
did not actually attempt the migration in its status report. The
wish Felipe is remembering does not exist in any committed location
on this host — this brainstorm is the formal scaffold for it.

## Problem (one-sentence)

The genie CLI TUI architecture (OpenTUI rendered inside a tmux pane,
next to a tmux passthrough mirror pane on a second tmux server)
captures mouse and routes scrollback through nested tmux DCS
passthrough, making native terminal copy-paste impossible in
terminals without OSC 52 (e.g. Warp on macOS) and adding two layers
of indirection that have caused recurring UX & ops pain.

## Target architecture (proposed)

OpenTUI runs as the **only** display process. `screenMode:
"split-footer"`. OpenTUI owns just the footer (Nav, status,
status-bar). The agent's output streams into the terminal's main
scrollback above the footer — either via captured stdout or via
`ScrollbackSurface.commitRows()` driven by `tmux capture-pane` polls
or `tmux -CC` `%output` subscription. The user's local terminal owns
the scrollback area, so drag-select + Cmd+C work natively in every
terminal (Warp, Ghostty, iTerm2, kitty, Alacritty, Wezterm, Terminal.app).

```
┌──────────────────────────────────────────┐
│                                          │  ← terminal SCROLLBACK
│   agent stdout / tmux %output stream     │    (terminal owns it — native
│   styled rows via ScrollbackSurface      │     drag-select, Cmd+C, scroll-
│                                          │     wheel, all without OSC 52)
│                                          │
├──────────────────────────────────────────┤
│  OpenTUI Nav + status bar (footer only)  │  ← OpenTUI owns this region only
└──────────────────────────────────────────┘
```

The `-L genie` agent server stays as the *spawn substrate* for
agents (no change to agent lifecycle). Only the *display* layer
collapses: `-L genie-tui` server is deleted, `tui-tmux.conf` is
deleted, the `_genie_*` mirror panes go away.

### Sister architecture already shipped (cross-reference)

`automagik-dev/khal-os/.genie/wishes/tmux-control-mode-terminal/`
(SHIPPED 2026-03-18) replaced node-pty + linked sessions with one
`tmux -CC attach` connection per session multiplexing all pane I/O
via `%output`/`send-keys -H`/`refresh-client -C`. That pattern is
the canonical input source for this wish's scrollback writer —
re-applied to the CLI side instead of the browser xterm.js side.

`automagik-dev/khal-os/.genie/wishes/genie-workspace-canvas/`
(SHIPPED same day) is the desktop equivalent (xterm.js cards on a
canvas). Different surface (browser vs CLI), same architectural
direction (collapse the display tmux, host the terminal instead of
being hosted by it).

## Scope (initial cut — to be refined via brainstorm)

### IN (target — v5 only)
- New OpenTUI entry point in v5 that runs `screenMode: "split-footer"` +
  `externalOutputMode: "capture-stdout"`.
- `ScrollbackSurface` integration that streams the focused agent's
  output into the terminal scrollback in real time.
- Footer-only layout: Nav (left), status (right), no right mirror pane.
- Input forwarding: when an agent is "focused", keystrokes go to
  that agent's tmux pane via `send-keys -H` (mirroring khal-os
  pattern). When unfocused, keys drive Nav.
- Removal of `-L genie-tui` tmux server + `tui-tmux.conf` + the right-
  mirror-pane code path **from the v5 codebase** (v4 retains them
  unchanged on its npm-frozen branch).
- v5-side `genie doctor` / `genie serve` diagnostics that reflect the
  one-tmux-server topology.
- Cross-terminal smoke matrix as a launch gate.

### OUT (initial)
- Agent lifecycle / `-L genie` agent server (untouched).
- khal-os browser-app architecture (separate surface, already shipped).
- Replacing tmux as the agent execution substrate.
- Replacing OpenTUI as the renderer.
- iframe-like embedding of foreign processes inside an OpenTUI box
  (the architectural inversion is "terminal-owned scrollback above
  footer," not "OpenTUI-owned PTY widget inline").

## Decisions made

| # | Decision | Rationale |
|---|----------|-----------|
| **D1** | **Cutover lives in the v5 major release; v4 stays frozen on npm with the current OpenTUI-inside-tmux architecture.** v5 ships split-footer as the sole TUI on CDN. No flag plumbing inside either major. v4 never gets the new TUI; v5 never carries the legacy code. | Confirmed by Felipe 2026-05-09. Eliminates the "doubled surface area" tax of a flag-gated rollout, while protecting v4 users from any cross-terminal split-footer regression. Sister to `v5-major-cutover-handoff` (npm→CDN distribution cutover) — same v4-final / v5-launch boundary. Users move via `genie v4-upgrade`. |
| **D2** | **Stream source = hybrid: `tmux -CC` control mode for live `%output`, one-shot `tmux capture-pane -p -S -N` on focus for initial-buffer replay.** Port khal-os's already-shipped `tmux-control-mode-terminal` implementation (`tmux-control.ts`, octal-escape decoder, `send-keys -H` hex-mode input, `refresh-client -C` resize) instead of greenfielding. One control connection per agent tmux session. | Push-based real-time streaming with ~100 ms p95 latency observed in khal-os production. Capture-pane polling has lossy bursts + 2× interval latency floor. Direct PTY ownership crosses into agent-substrate scope (-L genie) which D1 keeps off-limits. Hybrid is strictly more correct than either pure path and the entire implementation already exists in `automagik-dev/khal-os/packages/genie-app/views/genie/service/`. |

### Cross-links to v5 launch umbrella
- `[v5-major-cutover-handoff](../v5-major-cutover-handoff/DESIGN.md)` — distribution cutover (npm→CDN)
- `[aegis-distribution-sovereignty](../aegis-distribution-sovereignty/DESIGN.md)` — umbrella roadmap
- This brainstorm — TUI cutover (legacy → split-footer host)

The three are the **launch deliverables** of v5: a new distribution channel, a new TUI surface, and a new sovereignty posture. v4 final release remains supported on npm with the current TUI, indefinitely.

## Open decisions (still pending)

1. **Scrollback content source** — `tmux capture-pane` poll loop vs
   `tmux -CC` control-mode subscription vs direct PTY ownership.
3. **Focus & input model** — how does the user "tab into" an agent
   pane when input lives in OpenTUI's footer? Hotkey-driven focus
   capture? Modal "send mode"? Always-attached follow-active-pane?
4. **Multi-agent visibility** — only one agent's output streams into
   scrollback at a time, or interleaved with attribution prefixes,
   or a tab/hotkey-switch model?
5. **Footer height & content** — what survives the move from a full
   half-screen Nav to a footer band? Tree depth, status, alarms,
   spawn affordance — all of those, or trim?
6. **Theme / generated-config interaction** — `tui-tmux.conf` is one
   of two consumers of `~/.genie/.generated.theme.conf`. After
   deletion, the theme generator only feeds `genie.tmux.conf` (the
   agent server) — verify no orphan format strings.
7. **Doctor & ops** — `genie doctor`, `genie serve`, status-bar
   strings, README screenshots, onboarding skill — all assume the
   two-server topology today. Inventory the touchpoints before
   committing to a cutover.

## Risks & assumptions (initial)

| Risk | Severity | Mitigation |
|------|----------|------------|
| Split-footer is shipped but not yet battle-tested in opentui 0.2.6 across Warp/iTerm2/Ghostty/kitty/Wezterm/Alacritty/Terminal.app/foot | Medium | Cross-terminal smoke matrix as part of QA. Reference `split-mode-demo.ts` runs as the baseline. |
| `tmux -CC` control mode adds parsing complexity (octal escapes, %output, %exit) — already solved by khal-os tmux-control-mode-terminal | Low | Port the proven implementation rather than greenfield. |
| Footer height squeezing Nav usability — current Nav is half the screen | Medium | Spike the layout in opentui example before committing scope; users may need a "raise footer" hotkey or a fullscreen toggle |
| Input routing UX — modal "send to agent" mode may feel awkward vs today's "just type into the right pane" | Medium | Prototype 2–3 input models, pick after hands-on |
| Agents started during the legacy era may hold tmux state that confuses the new attach path | Low | Migration playbook: kill `-L genie-tui` server before first launch of new TUI |
| Loss of mouse-driven Nav clicks if we disable OpenTUI mouse | Hard constraint | Mouse stays on for the footer region only; scrollback selection works because OpenTUI doesn't render scrollback rows |

## Success criteria (initial — to expand)

- [ ] `genie tui` runs as a single OpenTUI process, no `-L genie-tui` tmux server spawned
- [ ] Drag-select in scrollback + Cmd+C copies to host clipboard in Warp on macOS without modifiers, OSC 52, or pbcopy bridges
- [ ] Click-to-navigate still works in the footer Nav
- [ ] Focused agent's output streams into scrollback in real time (≤100 ms after the agent emits)
- [ ] Keystrokes typed while focused on an agent reach the agent's PTY (via `tmux send-keys -H` or equivalent)
- [ ] Deleting `~/.genie/tui-tmux.conf` does not regress any `genie doctor` check
- [ ] Theme generator's output is verified to not orphan unused format strings
- [ ] Cross-terminal smoke matrix passes: Warp / Ghostty / iTerm2 / Wezterm / Alacritty / kitty / Terminal.app / foot

## WRS

```
WRS: ████░░░░░░ 40/100
 Problem ✅ | Scope ✅ | Decisions ░ | Risks ░ | Criteria ░
```

- **Problem** ✅ — symptom + architectural root cause documented above.
- **Scope** ✅ — IN/OUT cut from the architectural target; refinement expected.
- **Decisions** ░ — 7 open questions pending; cutover strategy is the gating one.
- **Risks** ░ — surfaced but not yet ranked & mitigated to a usable level.
- **Criteria** ░ — initial list exists but needs cross-terminal matrix definition + perf budget.
