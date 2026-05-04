/**
 * ASCII art assets for the install/startup splash.
 *
 * One canonical figure (the solid `█` form). The dithered/sparse variant
 * from ascii.md is treated as an A/B alternate — kept in the source file
 * but not loaded into the splash.
 *
 * The animation builds the genie up in scenes (eyes → smile → body),
 * not by morphing between art frames. Per-cell categories drive what's
 * visible at each progress point — see `categorizeCell`.
 */

/** Solid `█` form — the canonical genie figure. 46 rows × 100 cols. */
export const GENIE_ART: readonly string[] = [
  '                                                                            ████                    ',
  '                                                                          ██  ████                  ',
  '                                             ██████████████               █     █ █                 ',
  '                                          ██               ███                   █ █                ',
  '                                        █                     ██                 █ █                ',
  '                                      ██          ████████      ██              ██ █                ',
  '                                     █         ██          ██    ██             █  █                ',
  '                                    █        ██              ██    █          ██  ██                ',
  '                                    █       █                 ██    ████   ███   ██                 ',
  '                                    █       █                  ██       ███     ██                  ',
  '                                    █       █                    ██           ██                    ',
  '                                     █       █                     ████   ████                      ',
  '                                      ██       █                       ███                          ',
  '                                        ███     ██                                                  ',
  '                                           ███    ██                                                ',
  '                                              ██   █                                                ',
  '                                               ██  ██                                               ',
  '                                                █  █                                                ',
  '                                              ███  ███                                              ',
  '                                              ██ ██ ██                                              ',
  '                                              █  ██  █                                              ',
  '                                         █████        █████                                         ',
  '                                      ███                  ██                                       ',
  '                                    ██                        ██                                    ',
  '                                   █                           ██                                   ',
  '                       ███        █                              █       ██ █                       ',
  '                        █  █    ██     █████            █████     █    ██  █                        ',
  '                        ██  █   █    █████████        █████████    █  ██  █                         ',
  '                         █   █ ██   ███       █      █       ███   █ ██  ██                         ',
  '                         █    ██    ██                        ██   ███   █                          ',
  '                         █  █ ██    ██                        ██    █  █ █                          ',
  '                         █   █                                      █ █  █                          ',
  '                         █    █                                      █   █                          ',
  '                         ██   █     █████████         ██████████    █    █                          ',
  '                          █   ██   ██        ██      ██        ██   █   ██                          ',
  '                           █                                            █                           ',
  '                          ███  █                                   █  ████                          ',
  '                         ██   ██      █                      █     ███   ██                         ',
  '                         ██    ██     ██                   ██      ██    ██                         ',
  '                          █████ ██     ████             ████      █  ████                           ',
  '                                 ██      █████████████████       █                                  ',
  '                                  ██        ███████████        ██                                   ',
  '                                    ██                        ██                                    ',
  '                                      ███                  ███                                      ',
  '                                         ████          ████                                         ',
  '                                             ██████████                                             ',
];

/**
 * Eye region — rows 33-34. Each eye is a wide curved smily shape:
 *
 *   row 33  (eyelid):                  █████████        ██████████
 *   row 34  (corners):              ██       ██      ██        ██
 *
 * Combined, each eye reads like a closed/smily curve — a thick eyelid
 * with corners flaring out below. Above (rows 26-27) sit the eyebrows;
 * the wisp/smoke at the top is the genie's hair. Earlier revisions of
 * this file kept moving the "eye" tag onto the eyebrows or the hair —
 * those mistakes are recorded here so future-me doesn't repeat them:
 *
 *   wrong #1: rows 28-30 (cheekbone shading)
 *   wrong #2: rows 26-27 (eyebrows)
 *   wrong #3: rows 17-18 (hair / wisp face)
 *   right:    rows 33-34 (this file)
 *
 * The col-ranges enclose the full eye including the corners on row 34,
 * so the smily shape reads as a single eye in scene 0.
 */
export const EYE_ROWS: readonly number[] = [33, 34];
export const EYE_COL_RANGES: readonly { start: number; end: number }[] = [
  { start: 35, end: 47 }, // left eye: cluster at row 33 + corners at row 34
  { start: 53, end: 65 }, // right eye: cluster at row 33 + corners at row 34
];

/**
 * Mouth region — the smile arch (cheek arches + lip bars), cyan-coloured.
 * Each row maps to per-row col-ranges so head-outline cells at the cheek
 * level don't bleed into the smile.
 *
 *   row 37:    smile arch dots                        cols 38, 61
 *   row 38:    smile arch                             cols 38..40, 60..62
 *   row 39:    upper smile corners                    cols 35..63
 *   row 40:    top lip bar                            cols 41..58
 *   row 41:    bottom lip bar                         cols 44..55
 *
 * Earrings live in their own EARRING_REGIONS map below — cyan-coloured
 * like the smile, but they appear during the BODY fade (scene 4) rather
 * than during the smile reveal (scene 3).
 */
export const MOUTH_REGIONS: ReadonlyMap<number, readonly { start: number; end: number }[]> = new Map([
  [
    37,
    [
      { start: 38, end: 39 }, // left smile arch dot
      { start: 61, end: 62 }, // right smile arch dot
    ],
  ],
  [
    38,
    [
      { start: 38, end: 40 }, // left smile arch
      { start: 60, end: 62 }, // right smile arch
    ],
  ],
  [39, [{ start: 35, end: 63 }]], // upper smile corners
  [40, [{ start: 41, end: 58 }]], // top lip bar
  [41, [{ start: 44, end: 55 }]], // bottom lip bar
]);

/**
 * Earring region — outer `██` clusters at rows 37-38 cols 25-26 and 73-74.
 * Cyan-coloured (face accent) but timed with the BODY fade so they
 * appear together with the head outline rather than with the smile.
 */
export const EARRING_REGIONS: ReadonlyMap<number, readonly { start: number; end: number }[]> = new Map([
  [
    37,
    [
      { start: 25, end: 27 }, // left earring
      { start: 73, end: 75 }, // right earring
    ],
  ],
  [
    38,
    [
      { start: 25, end: 27 }, // left earring
      { start: 73, end: 75 }, // right earring
    ],
  ],
]);

export const MOUTH_ROWS: readonly number[] = Array.from(MOUTH_REGIONS.keys());

/** Flat list of every mouth col-range across all rows — for invariant tests. */
export const MOUTH_COL_RANGES: readonly { start: number; end: number }[] = Array.from(MOUTH_REGIONS.values()).flat();

/** Which eye(s) to close. */
export type EyeClose = 'left' | 'right' | 'both';

/**
 * Apply closed-eye overlay. The eyelid bar (row 33) clears, and row 34
 * collapses to a smily curve — placing the curve at the eye's visual
 * centre rather than the top.
 *
 *   open                              left-closed (wink)
 *   █████████   ██████████             ·········  ██████████
 *  ██       ██  ██       ██           \_______/  ██       ██
 *
 *   open                              both-closed (intro / scene 1)
 *   █████████   ██████████             ·········   ··········
 *  ██       ██  ██       ██           \_______/   \________/
 */
export function withClosedEyes(art: readonly string[], which: EyeClose): string[] {
  const eyesToClose: { start: number; end: number }[] = [];
  if (which === 'left' || which === 'both') {
    const r = EYE_COL_RANGES[0];
    if (r) eyesToClose.push(r);
  }
  if (which === 'right' || which === 'both') {
    const r = EYE_COL_RANGES[1];
    if (r) eyesToClose.push(r);
  }
  if (eyesToClose.length === 0) return [...art];

  return art.map((row, i) => {
    if (i === 33) {
      let next = row;
      for (const range of eyesToClose) {
        next = clearBlocksInRange(next, range);
      }
      return next;
    }
    if (i === 34) {
      let next = row;
      for (const range of eyesToClose) {
        next = collapseBlocksToCurve(next, range);
      }
      return next;
    }
    return row;
  });
}

/** Replace every `█` inside `range` with a space; preserve the rest. */
function clearBlocksInRange(row: string, range: { start: number; end: number }): string {
  const middle = row.slice(range.start, range.end);
  const cleared = middle.replace(/█/g, ' ');
  return row.slice(0, range.start) + cleared + row.slice(range.end);
}

/**
 * Find the contiguous `█` extent inside `range` and replace exactly that
 * extent with a `closedEyeShape` of the same width. Surrounding
 * whitespace inside the range is left untouched so the curve doesn't
 * "drift" out beyond the original block bar.
 */
function collapseBlocksToCurve(row: string, range: { start: number; end: number }): string {
  const middle = row.slice(range.start, range.end);
  const firstBlock = middle.indexOf('█');
  if (firstBlock < 0) return row;
  const lastBlock = middle.lastIndexOf('█');
  const blockSpan = lastBlock - firstBlock + 1;
  return row.slice(0, range.start + firstBlock) + closedEyeShape(blockSpan) + row.slice(range.start + lastBlock + 1);
}

/**
 * Build a thick closed-eye curve `╰▄▄▄▄▄▄▄╯` of exactly `span` chars
 * wide. The curved corners (`╰`/`╯` — light arcs that bend up at the
 * ends) lift each end of the line into a smily shape; `▄` (lower half
 * block) gives the belly real visual weight without going as thick as
 * the full `█` of the open eyelid bar. Earlier revisions used `\_____/`
 * — that read as too thin / too "ASCII line" against the neon body.
 *
 * Falls back to plain `▄` for very short spans so we never produce a
 * shape that misses its corners.
 */
function closedEyeShape(span: number): string {
  if (span <= 0) return '';
  if (span === 1) return '▄';
  if (span === 2) return '╰╯';
  return `╰${'▄'.repeat(span - 2)}╯`;
}

export type CellCategory = 'eye' | 'mouth' | 'earring' | 'body' | 'space';

/**
 * Classify a single (row, col) cell of the rendered art so the splash can
 * decide what's visible at any point in the animation.
 *
 *   'eye'     — inside an EYE_COL_RANGE on an EYE_ROW
 *   'mouth'   — inside a MOUTH_REGIONS span (smile arch / lip bars)
 *   'earring' — inside an EARRING_REGIONS span (cyan, body-timed)
 *   'body'    — any other non-space character
 *   'space'   — whitespace
 */
export function categorizeCell(row: number, col: number, char: string): CellCategory {
  if (char === ' ') return 'space';
  if (EYE_ROWS.includes(row)) {
    for (const r of EYE_COL_RANGES) {
      if (col >= r.start && col < r.end) return 'eye';
    }
  }
  const mouthRanges = MOUTH_REGIONS.get(row);
  if (mouthRanges) {
    for (const range of mouthRanges) {
      if (col >= range.start && col < range.end) return 'mouth';
    }
  }
  const earringRanges = EARRING_REGIONS.get(row);
  if (earringRanges) {
    for (const range of earringRanges) {
      if (col >= range.start && col < range.end) return 'earring';
    }
  }
  return 'body';
}

/**
 * Deterministic per-cell delay in [0, 1] for the body-fade scene. Cells
 * with smaller delays manifest first; larger delays drift in last. Hash
 * is intentionally cheap — we just need it spatially un-correlated so
 * the appearance feels star-like rather than top-down.
 */
export function bodyCellDelay(row: number, col: number): number {
  const h = Math.imul(row + 1, 2654435761) ^ Math.imul(col + 1, 40503);
  return ((h >>> 0) % 1000) / 1000;
}

/** Number of rows in the genie figure. */
export const GENIE_ART_HEIGHT = GENIE_ART.length;
