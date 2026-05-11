# `GENIE_TUI_HOST` — embed-mode flag

| Field | Value |
|-------|-------|
| Wish | [tui-opentui-host](../../wishes/tui-opentui-host/WISH.md) |
| Owning group | Group 4 (introduces flag) → Group 6 (flips default, deletes legacy) |
| Status | TRANSITIONAL — exists only inside the v5 cutover window |

## Purpose

The `tui-opentui-host` wish collapses the genie display layer from "two glued
tmux servers + one OpenTUI process" down to "one OpenTUI process." During the
transition we keep both code paths running so the smoke matrix (Group 5) can
compare visual + behavioural parity side-by-side. `GENIE_TUI_HOST` is the
single env-var lever that picks between them.

## Values

| Value | Effect | Owner |
|-------|--------|-------|
| `embed` | OpenTUI hosts the right side via `<TerminalPane>` (xterm-headless + `tmux -CC` against the `-L genie` agent server). No `-L genie-tui` server is created. | Group 4–6 |
| `legacy`, unset, anything else | Dual-tmux path: OpenTUI in the left pane of a `-L genie-tui` session, agent tmux mirrored into the right pane via `respawn-pane … attach -t <session>`. Unchanged from v4. | Pre-existing |

The match is **case-insensitive** and **trimmed** (`isEmbedHostMode()` in
`src/tui/render.tsx`). Any value other than `embed` falls through to legacy
so existing operator muscle memory keeps working.

## Where the flag is read

| Site | What it controls |
|------|------------------|
| `src/tui/render.tsx` (`renderNav`) | Registers the `<terminal-pane>` Renderable via `extend({ … })` and skips the renderer-level `installNativeSelectionOverride` wrap. The mouse contract moves into `TerminalPane.onMount` per decision #6. |
| `src/tui/app.tsx` (`App`) | Swaps the right side from the legacy tmux mirror to a flexbox row: `<Nav width=30>` + `<terminal-pane key={activeSession}>`. Also flips `Ctrl-Q` from `tmux kill-server` to `renderer.destroy()` because there is no display tmux to kill. |
| `src/term-commands/app.ts` (`handleTuiMode`) | Short-circuits to `launchTui()` and skips `isServeRunning() / ensureTuiSession() / attachTuiSession()`. The agent server (`-L genie`) is still started elsewhere — we only skip the display server. |

The flag is **not** consumed by `src/term-commands/serve.ts` yet. Group 6
collapses the `-L genie-tui` lifecycle there along with the rest of the
deletions; until then `genie serve` still creates the display server for
operators on legacy mode, and embed-mode operators simply ignore the empty
display server (no client ever attaches to it).

## Usage during the transition

```bash
# Group 4–5: explicit opt-in for embed-mode validation.
GENIE_TUI_HOST=embed genie tui

# Anything else (including no flag) keeps the v4 dual-tmux behaviour.
genie tui

# Legacy can be forced explicitly for A/B comparisons during Group 5 smoke.
GENIE_TUI_HOST=legacy genie tui
```

## Lifecycle

```
Group 4 (this wish)
  └── Flag introduced. Default = legacy. embed = opt-in for validation.
Group 5
  └── Smoke matrix + microbenchmark run with GENIE_TUI_HOST=embed.
      Visual-parity screenshots compare legacy vs. embed side-by-side.
Group 6
  └── Default flips: embed becomes unconditional in v5. All `legacy`
      branches and `-L genie-tui` plumbing are deleted in the same PR.
      Setting GENIE_TUI_HOST=legacy after Group 6 no longer reactivates
      the dual-tmux path — the code is gone.
```

## Operator escape hatch (Group 4 only)

If embed mode surfaces a regression during Group 5 validation, operators
can revert to legacy without a release bump:

```bash
# Stop the embed-mode TUI.
pkill -f 'genie .* tui'
# Re-launch on the legacy code path.
GENIE_TUI_HOST=legacy genie tui
```

After Group 6 this escape hatch is gone. The release-notes draft in
`.genie/runbooks/tui-host/release-notes.md` (added in Group 6) carries the
operator-facing notice.

## Related references

- `src/tui/widgets/TerminalPane.tsx` — the embed-mode right-side widget.
- `src/tui/tmux-control/` — the `tmux -CC` client behind `TerminalPane`.
- `.genie/runbooks/tui-host/xterm-attr-coverage.md` — Group 1 attr verdict.
- `.genie/wishes/tui-opentui-host/WISH.md` — full wish + decision table.
