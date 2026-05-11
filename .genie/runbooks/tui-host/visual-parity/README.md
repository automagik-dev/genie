# Visual-parity screenshot artifacts

This directory holds the before/after capture pairs that back Group 5 of
the [`tui-opentui-host`](../../../wishes/tui-opentui-host/WISH.md) wish.
One subdirectory per terminal in the launch matrix; each contains two
PNG screenshots that the reviewer compares to confirm visual parity
between the legacy dual-tmux path and the new OpenTUI-host embed path.

## Layout

```
visual-parity/
├── warp/         { before.png, after.png }
├── iterm2/       { before.png, after.png }
├── ghostty/      { before.png, after.png }
├── terminal-app/ { before.png, after.png }
├── wezterm/      { before.png, after.png }
├── alacritty/    { before.png, after.png }
├── kitty/        { before.png, after.png }
└── foot/         { before.png, after.png }
```

The empty subdirectories ship as `.gitkeep` placeholders. Drop the
captures in and re-commit; the [smoke matrix](../smoke-matrix.md)
already links each row to the right path.

## Capture protocol

| Step | Command / action |
|------|------------------|
| Set window size | Maximize the host terminal; record the geometry (`stty size`) into the smoke-matrix row notes so reviewers can re-create the capture. |
| Legacy / `before.png` | `GENIE_TUI_HOST=legacy genie tui` → focus an idle agent in the right pane → host-terminal "Save Screenshot" (Cmd-Shift-3 on macOS, `grim` / `flameshot` on Linux). Save as `<terminal>/before.png`. |
| Embed / `after.png` | `GENIE_TUI_HOST=embed genie tui` → focus the same idle agent → repeat the screenshot. Save as `<terminal>/after.png`. |
| Sanity diff | The Nav column width, theme, split ratio, and the top-row labels should be byte-for-byte identical. Body content can differ (agent emits differ run-to-run); structure cannot. |

## Naming + size discipline

- `before.png` always = legacy dual-tmux. `after.png` always = embed.
- PNG only (avoid lossy formats — the reviewer is doing pixel-level
  comparisons in the split-ratio gutters).
- Aim for ≤2 MB per file. If the terminal's native screenshot exceeds
  that, downscale with `magick … -resize 75 % …` before committing.

## Why this lives in-repo

`docs/` is a symlink into the `.docs-vendor` submodule; landing
screenshots there would force a separate docs-submodule PR with a
separate lifecycle. The wish text in
[`tui-opentui-host`](../../../wishes/tui-opentui-host/WISH.md) explicitly
calls out this trap. Keep the parity artifacts here, in
`.genie/runbooks/tui-host/`.
