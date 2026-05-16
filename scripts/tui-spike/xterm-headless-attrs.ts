#!/usr/bin/env bun
/**
 * Group 1 spike: probe `@xterm/headless`'s cell-buffer surface and verify
 * the attributes Group 3's `TerminalPane` Renderable will rely on.
 *
 * Lives under `scripts/tui-spike/` (NOT in the runtime build). Invoked from
 * `bun run scripts/tui-spike/xterm-headless-attrs.ts`; emits a human-readable
 * dump to stdout that feeds `docs/v5-launch/tui-host/xterm-attr-coverage.md`.
 *
 * Wish reference: .genie/wishes/tui-opentui-host/WISH.md (Group 1).
 */
import { Terminal } from '@xterm/headless';

type FixtureRow = {
  label: string;
  payload: string;
};

/** Fixture payloads exercising each attribute the embed renderer needs. */
const FIXTURES: FixtureRow[] = [
  // Row 0: plain default
  { label: 'plain', payload: 'plain' },
  // Row 1: bold + italic
  { label: 'bold+italic', payload: '\x1b[1;3mboldital\x1b[0m' },
  // Row 2: dim + underline
  { label: 'dim+underline', payload: '\x1b[2;4mdimUL\x1b[0m' },
  // Row 3: blink + inverse + strike + invisible + overline
  { label: 'blink/inv/strike/inv8/over', payload: '\x1b[5;7;9;8;53mABCDE\x1b[0m' },
  // Row 4: 16-color palette FG (red) + BG (blue)
  { label: '16color', payload: '\x1b[31;44mPAL16\x1b[0m' },
  // Row 5: 256-color palette FG (200) + BG (17)
  { label: '256color', payload: '\x1b[38;5;200m\x1b[48;5;17mPAL256\x1b[0m' },
  // Row 6: true-color (RGB) FG + BG
  { label: 'truecolor', payload: '\x1b[38;2;255;128;0m\x1b[48;2;10;20;30mRGB123\x1b[0m' },
  // Row 7: CJK wide chars + emoji (combined)
  { label: 'wide+emoji', payload: '日本語🚀' },
  // Row 8: hyperlink (OSC 8) — payload text is "link", url is example.com
  { label: 'osc8-hyperlink', payload: '\x1b]8;;https://example.com\x07link\x1b]8;;\x07' },
  // Row 9: curly underline (CSI 4:3 m — subparam)
  { label: 'curly-underline', payload: '\x1b[4:3mcurly\x1b[0m' },
  // Row 10: colored underline (CSI 58 ; 2 ; r ; g ; b m)
  { label: 'colored-underline', payload: '\x1b[4m\x1b[58;2;255;0;255mcolorUL\x1b[0m' },
];

/** Mouse-mode passthrough probe: feed DECSET sequences and confirm the
 *  parser quietly absorbs them (we only need them to NOT corrupt cells). */
const MOUSE_PROBE = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006hmouseOK\x1b[?1003l\x1b[?1002l\x1b[?1000l';

function cellSnapshot(term: Terminal, row: number, colHint = 80): unknown[] {
  const line = term.buffer.active.getLine(row);
  if (!line) return [];
  const out: unknown[] = [];
  for (let x = 0; x < Math.min(line.length, colHint); x++) {
    const cell = line.getCell(x);
    if (!cell) continue;
    const chars = cell.getChars();
    if (chars === '' && cell.getWidth() === 0) continue; // wide-char tail
    if (chars === '' && cell.isAttributeDefault() && cell.isFgDefault() && cell.isBgDefault()) continue;
    out.push({
      x,
      chars,
      width: cell.getWidth(),
      code: cell.getCode(),
      bold: cell.isBold(),
      italic: cell.isItalic(),
      dim: cell.isDim(),
      underline: cell.isUnderline(),
      blink: cell.isBlink(),
      inverse: cell.isInverse(),
      invisible: cell.isInvisible(),
      strikethrough: cell.isStrikethrough(),
      overline: cell.isOverline(),
      fg: { mode: cell.getFgColorMode(), value: cell.getFgColor() },
      bg: { mode: cell.getBgColorMode(), value: cell.getBgColor() },
      fgKind: cell.isFgRGB() ? 'rgb' : cell.isFgPalette() ? 'palette' : 'default',
      bgKind: cell.isBgRGB() ? 'rgb' : cell.isBgPalette() ? 'palette' : 'default',
    });
  }
  return out;
}

async function main(): Promise<void> {
  const term = new Terminal({
    cols: 80,
    rows: FIXTURES.length + 4,
    scrollback: 0,
    allowProposedApi: true,
  });

  // Feed mouse probe FIRST so any DECSET artefacts surface on row 0 before
  // we lay down the styled fixtures below.
  const writeSync = (payload: string): Promise<void> =>
    new Promise((resolve) => {
      term.write(payload, () => resolve());
    });

  await writeSync(`${MOUSE_PROBE}\r\n`);
  for (const row of FIXTURES) {
    await writeSync(`${row.payload}\r\n`);
  }

  process.stdout.write('# @xterm/headless attribute spike\n');
  process.stdout.write(`cols=${term.cols} rows=${term.rows}\n\n`);

  process.stdout.write('## row 0 — mouse-mode passthrough probe\n');
  process.stdout.write('expectation: "mouseOK" lands intact, no \\x1b residue.\n');
  process.stdout.write(`${JSON.stringify(cellSnapshot(term, 0), null, 2)}\n\n`);

  for (let i = 0; i < FIXTURES.length; i++) {
    const row = i + 1;
    process.stdout.write(`## row ${row} — ${FIXTURES[i]?.label}\n`);
    process.stdout.write(`${JSON.stringify(cellSnapshot(term, row), null, 2)}\n\n`);
  }

  // OSC 8 hyperlink detection: confirm whether the public `IBufferCell` API
  // surfaces the URL. xterm.js's public surface does not expose getHyperlink()
  // at v5.5.0 — we expect this to surface as a FALLBACK row in the doc.
  type MaybeHyperlinkCell = { getHyperlink?: () => unknown };
  const oscRow = FIXTURES.findIndex((r) => r.label === 'osc8-hyperlink');
  const line = term.buffer.active.getLine(oscRow + 1);
  const cell = line?.getCell(0) as MaybeHyperlinkCell | undefined;
  const hasHyperlinkAccessor = typeof cell?.getHyperlink === 'function';
  process.stdout.write('## hyperlink accessor probe\n');
  process.stdout.write(`IBufferCell.getHyperlink available: ${hasHyperlinkAccessor}\n\n`);

  term.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
