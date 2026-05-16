/**
 * Cell painter — walks an `@xterm/headless` `IBuffer` and blits each cell into
 * an OpenTUI `OptimizedBuffer` via `setCell`. Pure (no Renderable surface,
 * easy to fuzz). Group 3 deliverable per the Group 1 attr-coverage doc.
 *
 * Color resolution follows the verdict matrix:
 *  - Default fg / bg  → host theme defaults (DEFAULT_FG / DEFAULT_BG).
 *  - 16-color palette → ANSI_16 LUT.
 *  - 256-color palette → XTERM_256 LUT (16 ANSI + 216 RGB cube + 24 greyscale).
 *  - 24-bit RGB → decompose 0xRRGGBB.
 *
 * Attributes mapped 1:1: bold, italic, dim, underline, blink, inverse, hidden,
 * strikethrough. Overline + OSC 8 hyperlinks are flagged FALLBACK in the
 * coverage doc; this module ignores them (downgrade to no-op / single-style).
 */
import { type OptimizedBuffer, RGBA, TextAttributes } from '@opentui/core';
import type { IBuffer, IBufferCell } from '@xterm/headless';

/** Host-side default foreground. Mirrors `palette.text` (`#c9cfd4`). */
export const DEFAULT_FG = RGBA.fromInts(201, 207, 212, 255);
/** Host-side default background. Mirrors `palette.bg` (`#0a1d2a`). */
export const DEFAULT_BG = RGBA.fromInts(10, 29, 42, 255);

/**
 * Canonical xterm 16-color ANSI palette. Order matches `cell.getFgColor()`
 * for `isFgPalette()` cells with index 0..15.
 */
const ANSI_16: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], // 0: black
  [205, 49, 49], // 1: red
  [13, 188, 121], // 2: green
  [229, 229, 16], // 3: yellow
  [36, 114, 200], // 4: blue
  [188, 63, 188], // 5: magenta
  [17, 168, 205], // 6: cyan
  [229, 229, 229], // 7: white
  [102, 102, 102], // 8: bright black (grey)
  [241, 76, 76], // 9: bright red
  [35, 209, 139], // 10: bright green
  [245, 245, 67], // 11: bright yellow
  [59, 142, 234], // 12: bright blue
  [214, 112, 214], // 13: bright magenta
  [41, 184, 219], // 14: bright cyan
  [255, 255, 255], // 15: bright white
];

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/**
 * Resolve a 256-color palette index to (r,g,b). Standard xterm-256 table:
 * - 0..15 → 16-color ANSI.
 * - 16..231 → 6×6×6 RGB cube.
 * - 232..255 → 24-step greyscale ramp from 8 to 238 (step 10).
 */
function xterm256(index: number): readonly [number, number, number] {
  if (index < 16) {
    const triple = ANSI_16[index];
    if (triple) return triple;
    return [0, 0, 0];
  }
  if (index < 232) {
    const offset = index - 16;
    const r = CUBE_STEPS[Math.floor(offset / 36) % 6];
    const g = CUBE_STEPS[Math.floor(offset / 6) % 6];
    const b = CUBE_STEPS[offset % 6];
    return [r ?? 0, g ?? 0, b ?? 0];
  }
  if (index < 256) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }
  return [0, 0, 0];
}

/** Decompose a 24-bit `0xRRGGBB` int into a triple. */
function rgbFromInt(packed: number): readonly [number, number, number] {
  return [(packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff];
}

export interface PaintTheme {
  fg: RGBA;
  bg: RGBA;
}

const DEFAULT_THEME: PaintTheme = { fg: DEFAULT_FG, bg: DEFAULT_BG };

/** Resolve a cell's foreground or background to an `RGBA`. */
export function cellColor(cell: IBufferCell, channel: 'fg' | 'bg', theme: PaintTheme = DEFAULT_THEME): RGBA {
  const isDefault = channel === 'fg' ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) return channel === 'fg' ? theme.fg : theme.bg;
  const value = channel === 'fg' ? cell.getFgColor() : cell.getBgColor();
  const isRgb = channel === 'fg' ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    const [r, g, b] = rgbFromInt(value);
    return RGBA.fromInts(r, g, b, 255);
  }
  // Default → palette branch (Group 1 attr-coverage confirmed isFgPalette/isBgPalette).
  const [r, g, b] = xterm256(value);
  return RGBA.fromInts(r, g, b, 255);
}

/** OR the cell's style flags into the OpenTUI attribute bitfield. */
export function cellAttributes(cell: IBufferCell): number {
  let attrs = TextAttributes.NONE;
  if (cell.isBold()) attrs |= TextAttributes.BOLD;
  if (cell.isDim()) attrs |= TextAttributes.DIM;
  if (cell.isItalic()) attrs |= TextAttributes.ITALIC;
  if (cell.isUnderline()) attrs |= TextAttributes.UNDERLINE;
  if (cell.isBlink()) attrs |= TextAttributes.BLINK;
  if (cell.isInverse()) attrs |= TextAttributes.INVERSE;
  if (cell.isInvisible()) attrs |= TextAttributes.HIDDEN;
  if (cell.isStrikethrough()) attrs |= TextAttributes.STRIKETHROUGH;
  // overline + colored/curly underline land in FALLBACK per
  // .genie/runbooks/tui-host/xterm-attr-coverage.md — Group 3 ships the
  // downgrade (no overline bit, single-style underline only).
  return attrs;
}

export interface PaintOptions {
  /** Max columns to paint (clamps the inner loop to the viewport width). */
  cols: number;
  /** Max rows to paint. */
  rows: number;
  /** Host theme overrides (default ≈ Lumon-MDR palette). */
  theme?: PaintTheme;
}

/**
 * Walk `xtermBuffer.getLine(y).getCell(x)` for the viewport and paint into
 * `out` starting at `(originX, originY)`. Width-2 cells emit at `x` and skip
 * the zero-width tail at `x+1` (the xterm buffer already places `''` there).
 *
 * Returns the number of cells painted (useful for benches).
 */
export function paintXtermBufferToFrame(
  xtermBuffer: IBuffer,
  out: OptimizedBuffer,
  originX: number,
  originY: number,
  opts: PaintOptions,
): number {
  const theme = opts.theme ?? DEFAULT_THEME;
  const rows = Math.max(0, opts.rows);
  const cols = Math.max(0, opts.cols);
  let painted = 0;
  // `IBuffer.getLine(y)` indexes the WHOLE buffer (scrollback included), so
  // `y = 0` is the OLDEST scrollback line. The live viewport starts at
  // `viewportY` (== `baseY` for a follow terminal, honours user scrollback
  // otherwise). Offset every source line by it so we paint the live screen,
  // not frozen ancient scrollback. Read once before the loop.
  const base = xtermBuffer.viewportY;
  for (let y = 0; y < rows; y++) {
    const line = xtermBuffer.getLine(base + y);
    if (!line) continue;
    let x = 0;
    while (x < cols) {
      const cell = line.getCell(x);
      if (!cell) {
        x++;
        continue;
      }
      const width = cell.getWidth();
      if (width === 0) {
        // Wide-char tail. Skip without painting (already painted by the
        // wide-char at x-1).
        x++;
        continue;
      }
      const chars = cell.getChars() || ' ';
      const fg = cellColor(cell, 'fg', theme);
      const bg = cellColor(cell, 'bg', theme);
      const attrs = cellAttributes(cell);
      out.setCell(originX + x, originY + y, chars, fg, bg, attrs);
      painted++;
      x += width; // 1 for ASCII, 2 for CJK / emoji
    }
  }
  return painted;
}
