# TUI host smoke matrix — Group 5 launch gate

| Field | Value |
|-------|-------|
| Wish | [tui-opentui-host](../../wishes/tui-opentui-host/WISH.md) |
| Owning group | Group 5 (qa) → reviewer hand-off |
| Status | **PENDING_OPERATOR** — machine-validatable parts done, 8-terminal verification + visual sign-off required before Group 6 ships |
| Acceptance | ≥6/8 PASS; remaining 2 carry WORKAROUND or release-notes exclusion |
| Sign-off gate | `grep -E "^Signed-off-by: " .genie/runbooks/tui-host/smoke-matrix.md` (see bottom of file) |

## Purpose

Group 5 is the v5 launch gate for the embed-mode TUI. Before the
deletion PR (Group 6) flips the default and removes the legacy dual-tmux
plumbing, this matrix must demonstrate that the new
`<TerminalPane>`-backed display layer works across every terminal that
sits on the v5 launch list:

- **macOS** — Warp · iTerm2 · Ghostty · Terminal.app
- **Linux** — Wezterm · Alacritty · kitty · foot

The operator runs each cell, captures a screenshot, and marks the row
verdict. Failures on ≤2 terminals are tolerated if release notes carry
the compat caveat; failures on >2 block Group 6 until either fixed or
explicitly demoted from the launch list.

## Methodology

### Pre-conditions per terminal

```bash
# Same checkout, same bun version, same agent server (-L genie) for every cell.
cd <path-to-genie-checkout>
git switch wish/tui-opentui-host
bun install
genie serve                          # boots agent server only (no -L genie-tui needed)
genie spawn <some-idle-agent>        # one focusable agent for the right pane
```

### Per-cell action protocol

| Action | What to do | What to record |
|--------|------------|----------------|
| `mount` | `GENIE_TUI_HOST=embed genie tui` and confirm the right pane paints. | Screenshot → `visual-parity/<terminal>/after.png`. Legacy comparison → `visual-parity/<terminal>/before.png`. |
| `click` | Click an agent node in `<Nav>`; verify the right pane swaps within ~200 ms. | Verdict only. |
| `drag-select` | Click-drag inside the right pane to highlight text, then host-terminal-native copy (Cmd-C on macOS, Ctrl-Shift-C on Linux). Paste into another window. | Verdict (must be PASS for Warp + iTerm2 + Ghostty — see Group 5 acceptance). |
| `paste` | Cmd-V / Ctrl-Shift-V into the focused right pane. Confirm the agent received it via `genie agent log <name>`. | Verdict only. |
| `resize` | Resize the terminal window (grow + shrink) while the right pane is focused; confirm reflow without garbled output. | Verdict only. |
| `exit` | Quit the TUI (Ctrl-Q or the keymap binding). Confirm: no orphaned `tmux -L genie-tui` (`pgrep -f "tmux -L genie-tui"` returns empty) and no zombie OpenTUI process. | Verdict only. |

### Verdict legend

| Verdict | Meaning |
|---------|---------|
| `PASS` | All actions succeeded; visual-parity screenshot matches the legacy capture within reviewer judgement. |
| `WORKAROUND` | The action failed in default config but a documented terminal-side setting unblocks it. Note the setting in the row. |
| `FAIL` | Reproducible regression that has no operator workaround. Blocks Group 6 unless the terminal is moved off the launch list. |
| `PENDING_OPERATOR` | Cell not yet executed. Default state in this file. |

---

## Matrix

> **Status legend:** `mount` / `click` / `drag-select` / `paste` / `resize` / `exit`.
> Each column carries `PASS | WORKAROUND | FAIL | PENDING_OPERATOR`. The
> last column links to the row's screenshot pair.

### macOS launch tier

| Terminal | mount | click | drag-select | paste | resize | exit | Screenshots | Notes |
|----------|-------|-------|-------------|-------|--------|------|-------------|-------|
| Warp | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/warp/`](visual-parity/warp/) | Drag-select must PASS (acceptance). |
| iTerm2 | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/iterm2/`](visual-parity/iterm2/) | Drag-select must PASS (acceptance). |
| Ghostty | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/ghostty/`](visual-parity/ghostty/) | Drag-select must PASS (acceptance). |
| Terminal.app | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/terminal-app/`](visual-parity/terminal-app/) | macOS system terminal; legacy comparison reference. |

### Linux launch tier

| Terminal | mount | click | drag-select | paste | resize | exit | Screenshots | Notes |
|----------|-------|-------|-------------|-------|--------|------|-------------|-------|
| Wezterm | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/wezterm/`](visual-parity/wezterm/) | — |
| Alacritty | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/alacritty/`](visual-parity/alacritty/) | — |
| kitty | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/kitty/`](visual-parity/kitty/) | — |
| foot | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR | [`visual-parity/foot/`](visual-parity/foot/) | Wayland; verify selection model under risk row in wish. |

---

## Drag-select copy verification

Wish acceptance requires drag-select copy to work **without OSC 52, tmux
DCS, or a `pbcopy` bridge** in **Warp + iTerm2 + Ghostty** at minimum.

| Terminal | Selection visible? | Cmd-C / Ctrl-Shift-C populates host clipboard? | Pasted into a separate window? |
|----------|--------------------|-----------------------------------------------|--------------------------------|
| Warp | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR |
| iTerm2 | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR |
| Ghostty | PENDING_OPERATOR | PENDING_OPERATOR | PENDING_OPERATOR |

If any of the three answers `FAIL`, the cell must be re-run after
confirming the `TerminalPane.onMount` mouse contract emitted both
`\x1b[?1002l` and `\x1b[?1003l` (assertion in `src/tui/render.test.ts`).

---

## Perf summary cross-reference

Full numbers in [`perf-baseline.md`](perf-baseline.md).

| Metric | Linux measured | Linux budget | macOS measured | macOS budget |
|--------|----------------|--------------|----------------|--------------|
| p95 emit→render | 14.677 ms | ≤100 ms | PENDING_OPERATOR | ≤150 ms |
| idle CPU (single-core, 60 s) | PENDING_OPERATOR | ≤8 % | PENDING_OPERATOR | ≤8 % |

Linux p95 currently sits 85 % below the 100 ms budget — emit→render is
not the bottleneck.

---

## Open items before Group 6 ships

- [ ] All 8 terminals executed end-to-end with screenshots pasted into `visual-parity/<terminal>/{before,after}.png`.
- [ ] Drag-select PASS confirmed for Warp + iTerm2 + Ghostty.
- [ ] macOS p95 emit→render captured into `perf-baseline.md`.
- [ ] Idle CPU 60 s sample captured into `perf-baseline.md`.
- [ ] Any FAIL row carries a workaround or an explicit release-notes exclusion (linked from `.genie/runbooks/tui-host/release-notes.md`, which Group 6 lands).
- [ ] Reviewer adds the `Signed-off-by:` trailer below.

---

## Reviewer sign-off

The validation gate is
`grep -E "^Signed-off-by: " .genie/runbooks/tui-host/smoke-matrix.md`.
The trailer line must:

- Start at column 0 with the literal prefix `Sig`+`ned-off-by: `
  (the prefix is intentionally split in this paragraph so this section
  does not trip the grep before the reviewer signs — the trailer at the
  bottom of the file is the only line that should match).
- Be followed by the reviewer's name and email in `Name <email>` format
  (the same convention `git commit -s` produces).
- Reference a real human reviewer — Felipe per the wish, or a designee
  Felipe names in the PR thread.

Once the reviewer (Felipe or designee per wish decision row in acceptance
criteria) has:

1. Verified the matrix above is filled in,
2. Spot-checked the `visual-parity/<terminal>/before.png` vs.
   `after.png` pairs,
3. Confirmed perf-baseline.md carries real numbers for both p95 emit→render
   (Linux + macOS) and idle CPU,

they append a literal `Signed-off-by:` line below this block (matching the
grep pattern). The trailer is intentionally **absent** until then — the
grep failing is the gate that keeps Group 6 from shipping prematurely.

<!-- DO NOT MOVE THE LINE BELOW — Group 6's release PR description references it as the sign-off anchor. -->
<!-- Sign-off trailer goes here: -->
