# `@xterm/headless` attribute coverage — Group 1 spike

| Field | Value |
|-------|-------|
| Wish | [`.genie/wishes/tui-opentui-host/WISH.md`](../../../.genie/wishes/tui-opentui-host/WISH.md) |
| Group | 1 (Wave 1) |
| Date | 2026-05-10 |
| `@xterm/headless` | `^5.5.0` (locked); license MIT |
| OpenTUI | `@opentui/core` `0.2.6` |
| Spike script | [`scripts/tui-spike/xterm-headless-attrs.ts`](../../../scripts/tui-spike/xterm-headless-attrs.ts) |
| Raw spike output | reproducible via `bun run scripts/tui-spike/xterm-headless-attrs.ts` |

## Purpose

Group 3's `<TerminalPane>` will walk `xterm.buffer.active.getLine(y).getCell(x)`
once per OpenTUI render frame and blit each cell into an `OptimizedBuffer` via
`setCell(x, y, char, fg: RGBA, bg: RGBA, attributes: number)`. The runtime
contract therefore hinges on:

1. Every visual attribute we need being **first-class** on the public
   `IBufferCell` accessor (so the per-frame walk is allocation-free), or
2. The gap surfacing on a **named fallback path** (`OptimizedBuffer.drawText`
   ANSI passthrough or a parser hook on the xterm `Terminal`) so we can fan
   work out of the hot loop at a single call site.

This doc enumerates every attribute Group 3 will rely on with a
`PASS` / `FALLBACK` / `OUT OF SCOPE` verdict.

## Verdict legend

- **PASS** — `IBufferCell` exposes the attribute publicly; the value maps 1:1
  onto an `OptimizedBuffer.setCell` parameter (an `RGBA` channel or an
  `attributes` bit from `TextAttributes`).
- **FALLBACK** — public surface does not expose the data, OR OpenTUI has no
  equivalent slot. The doc names the workaround (extra parser hook, alternative
  call site, or accepted downgrade) and the file/line where Group 3 will wire
  it up.
- **OUT OF SCOPE** — not required by the embed contract in v5. Captured so
  future scope creep is explicit, not silent.

## Attribute matrix

### Text style attributes

| Attribute | `@xterm/headless` accessor | OpenTUI mapping | Verdict | Notes |
|-----------|----------------------------|-----------------|---------|-------|
| Bold | `cell.isBold()` (non-zero = on) | `TextAttributes.BOLD` | **PASS** | Confirmed by row 2 of spike (`bold: 134217728`). |
| Italic | `cell.isItalic()` | `TextAttributes.ITALIC` | **PASS** | Confirmed by row 2 (`italic: 67108864`). |
| Dim | `cell.isDim()` | `TextAttributes.DIM` | **PASS** | Confirmed by row 3. |
| Underline (single) | `cell.isUnderline()` | `TextAttributes.UNDERLINE` | **PASS** | Confirmed by row 3. |
| Blink | `cell.isBlink()` | `TextAttributes.BLINK` | **PASS** | Confirmed by row 4 (`blink: 536870912`). |
| Inverse | `cell.isInverse()` | `TextAttributes.INVERSE` | **PASS** | Confirmed by row 4. |
| Invisible / hidden | `cell.isInvisible()` | `TextAttributes.HIDDEN` | **PASS** | Confirmed by row 4. |
| Strikethrough | `cell.isStrikethrough()` | `TextAttributes.STRIKETHROUGH` | **PASS** | Confirmed by row 4. |
| Overline | `cell.isOverline()` | _(no OpenTUI bit)_ | **FALLBACK** | OpenTUI 0.2.6's `TextAttributes` has no `OVERLINE` slot. **Strategy:** when `cell.isOverline()` is truthy, route that cell through `OptimizedBuffer.drawText(...)` with the literal `\x1b[53m...\x1b[55m` sequence wrapping the cell glyph. **Call site:** `TerminalPane.renderCell()` will branch on `cell.isOverline()` and call `drawText` instead of `setCell` for overlined cells. Cost is one extra glyph-sized `drawText` per overlined cell; acceptable because overline usage in agent output is rare. |
| Curly / dotted / dashed underline (CSI `4:3` m, `4:4` m, `4:5` m) | _(not exposed)_ | _(no OpenTUI bit)_ | **FALLBACK (DOWNGRADE)** | The public `IBufferCell` API only exposes `isUnderline(): number`; the underline _style_ (single / double / curly / dotted / dashed) is parsed internally but is not surfaced on the public surface as of `@xterm/headless@5.5.0`. **Strategy:** downgrade silently to single-underline rendering. **Call site:** `TerminalPane.renderCell()` treats any underline subparam as single underline — no extra branch. Documented as a known visual fidelity downgrade in `docs/v5-launch/tui-host/embed-flag.md` (deliverable of Group 4). |
| Colored underline (CSI `58 ; 2 ; r ; g ; b m`) | _(not exposed)_ | _(no OpenTUI bit)_ | **FALLBACK (DOWNGRADE)** | Same root cause as curly underline — underline _color_ is internal-only on the public surface. **Strategy:** render as single underline in the cell's foreground colour. **Call site:** as above (no branch); the loss-of-fidelity is identical and is captured in the same release-notes line. |

### Color attributes

| Attribute | `@xterm/headless` accessor | OpenTUI mapping | Verdict | Notes |
|-----------|----------------------------|-----------------|---------|-------|
| Default FG / BG | `cell.isFgDefault()` / `cell.isBgDefault()` | OpenTUI theme defaults from `src/tui/theme.ts` | **PASS** | Confirmed by row 1 (`fgKind: 'default'`, `bgKind: 'default'`). |
| 16-color palette FG / BG (CSI `3x;4x` m) | `cell.isFgPalette()` + `cell.getFgColor()` ∈ 0..15 | `RGBA` via palette lookup table | **PASS** | Confirmed by row 5 (`fg.value:1` = ANSI red, `bg.value:4` = ANSI blue). The 16-colour table is fixed; Group 3 ships it inline. |
| 256-color palette FG / BG (CSI `38;5;n` / `48;5;n` m) | `cell.isFgPalette()` + `cell.getFgColor()` ∈ 0..255 | `RGBA` via xterm-256 lookup table | **PASS** | Confirmed by row 6 (`fg.value:200`, `bg.value:17`). The xterm-256 LUT is well-known and small (256 × 3 bytes). |
| 24-bit RGB FG / BG (CSI `38;2;r;g;b` / `48;2;r;g;b` m) | `cell.isFgRGB()` + `cell.getFgColor()` returning `0xRRGGBB` | `RGBA` by decomposing the 24-bit int | **PASS** | Confirmed by row 7 (`fg.value:16744448` == `0xFF8000` = (255,128,0); `bg.value:660510` == `0x0A141E` = (10,20,30)). |

### Glyph / width attributes

| Attribute | `@xterm/headless` accessor | OpenTUI mapping | Verdict | Notes |
|-----------|----------------------------|-----------------|---------|-------|
| Single-width ASCII | `cell.getChars()` + `cell.getWidth() == 1` | `setCell(x, y, char, ...)` | **PASS** | Plain rows in spike. |
| Wide CJK / emoji (width 2) | `cell.getChars()` + `cell.getWidth() == 2` | Two adjacent `setCell` slots — wide char at `x`, blank at `x+1` | **PASS** | Confirmed by row 8: `日` reports `width:2` at x=0, then x=1 is empty (`chars: ''`, width=0), `本` at x=2, etc. Group 3's render loop skips the trailing zero-width cell. |
| Wide-char tail (the slot immediately after a width-2 cell) | `cell.getWidth() == 0` and `cell.getChars() === ''` | _(no draw)_ | **PASS** | Confirmed by row 8 — the wide-char tail is recognisable and stable. |
| Combining glyph clusters / emoji ZWJ sequences | `cell.getChars()` returns the full grapheme string | `setCell(x, y, char, ...)` accepts string-valued `char` | **PASS** | Confirmed: `🚀` (single emoji) lands in one width-2 cell with `chars: '🚀'`. ZWJ sequences (e.g. flags, family emoji) land as the grapheme in one cell — same code path. |

### Hyperlinks / OSC sequences

| Attribute | `@xterm/headless` accessor | OpenTUI mapping | Verdict | Notes |
|-----------|----------------------------|-----------------|---------|-------|
| OSC 8 hyperlink URL on a cell | `IBufferCell.getHyperlink()` is **NOT** part of `@xterm/headless@5.5.0`'s public types (probe `typeof cell.getHyperlink === 'function'` → `false`; confirmed in the spike's `## hyperlink accessor probe` section) | `attributesWithLink(baseAttributes, linkId)` exists on `@opentui/core` 0.2.6 (`utils.d.ts:12`) | **FALLBACK** | **Strategy:** register an OSC 8 handler on the xterm parser (`terminal.parser.registerOscHandler(8, payload => { … return true })`) and maintain a `Map<linkId, url>` in `TerminalPane`'s state; track the active link id at the parser level and apply it via `attributesWithLink()` when each cell is blitted. **Call site:** `TerminalPane.attachLinkTracker()` (constructor; teardown on dispose). xterm DOES auto-underline links — confirmed by row 9 of the spike (`underline:1` on the link text), so even without the URL recovery the visual cue is preserved. |
| Other OSC sequences (title, current-dir, etc.) | Various `Terminal` events / `parser.registerOscHandler` | (not used by Group 3) | **OUT OF SCOPE** | The agent server already exposes session metadata; the embed widget does not need to surface OS-1/2/7 title changes in v5. Revisit if a sister wish later lights up tab titles inside the TUI. |
| Sixel / iTerm2 inline images | (not in headless build) | (not in OpenTUI) | **OUT OF SCOPE** | `@xterm/headless` ships no image addon; OpenTUI has no inline-image renderable. Agent output is text-only. |

### Mouse-mode passthrough

| Attribute | Probe | Verdict | Notes |
|-----------|-------|---------|-------|
| DECSET `?1000h`/`?1002h`/`?1003h`/`?1006h` followed by DECRST | Spike row 0 feeds a full enable/disable burst and then plain text "mouseOK" | **PASS** | The "mouseOK" string lands in the cell buffer unmodified — no escape residue, no spurious cells. `@xterm/headless` quietly absorbs the mode-set sequences. **Implication:** the host (`renderer.enableMouse()` and the drag-tracking override re-homed inside `TerminalPane`) owns mouse policy; the agent process can emit whatever mouse modes it likes without corrupting the cell buffer. |

## Summary

- **PASS:** 15 attributes / behaviours map 1:1 onto OpenTUI's `setCell` surface
  (every text style except overline, every color mode, every glyph-width
  behaviour, and mouse-mode passthrough).
- **FALLBACK:** 4 cases. Three have named workarounds at named call sites
  (overline → `drawText` ANSI passthrough at `TerminalPane.renderCell`; OSC 8
  hyperlink URL → OSC parser hook at `TerminalPane.attachLinkTracker`); two are
  accepted downgrades (curly + colored underline both render as single
  underline at `TerminalPane.renderCell`).
- **OUT OF SCOPE:** 2 cases (non-link OSC sequences; inline images). Both
  documented to prevent silent scope creep.

## Group 3 hand-off

Group 3 (`TerminalPane` widget) can proceed with the assumption that the
`xterm.buffer.active.getLine(y).getCell(x)` walk drives every cell paint with:

1. `getChars()` → `char` arg to `setCell`.
2. `getFgColor()` + `getFgColorMode()` → `RGBA` via the 16/256/RGB branch.
3. `getBgColor()` + `getBgColorMode()` → `RGBA` (mirror of above).
4. The 8 `is{Bold,Italic,Dim,Underline,Blink,Inverse,Invisible,Strikethrough}()`
   flags → OR'd into the `attributes` int.
5. `isOverline()` → branch to `drawText` ANSI passthrough.
6. Width-2 cells → emit at `x`, leave `x+1` untouched (the buffer iterator
   already places a zero-width tail there).
7. OSC 8 hyperlinks → an active-link tracker outside the per-cell hot loop
   feeds `attributesWithLink()` into the cell `attributes` field.

No raw `terminal.write` of ANSI back through OpenTUI is required for the
common-path cell paint; the fallback paths are bounded to overline and OSC 8,
both rare in agent output.

## Reproducing the spike

```bash
bun install
bun run scripts/tui-spike/xterm-headless-attrs.ts > /tmp/xterm-attrs.txt
grep -E "^## row " /tmp/xterm-attrs.txt
grep -E "^IBufferCell.getHyperlink available" /tmp/xterm-attrs.txt
```

The script is committed (the wish explicitly requires it under
`scripts/tui-spike/`) but is **not** part of the runtime build (verified —
`scripts/tui-spike/` is not in `package.json#files`, not imported by
`src/genie.ts`, and `bun build` does not touch it).
