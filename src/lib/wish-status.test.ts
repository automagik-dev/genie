import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WISH_SLUG_PATTERN,
  extractLegacyStatusValue,
  extractStatusCell,
  readBoundedWishFile,
  readBoundedWishHead,
} from './wish-status.js';

const MAX_WISH_BYTES = 256 * 1_024;
/**
 * The wish-status corpus. Every row pins the board's `row-end` reading of a
 * status cell: what `readWishStatus` returns raw, with no display vocabulary.
 *
 * The delicate distinction is between "this consumer cannot read this row",
 * which skips and keeps scanning, and "it read the row and disliked the value",
 * which stops and blocks the legacy fallback. A zero-width `||` is the former
 * and a blank `|   |` is the latter — which is why `accept` gets the UNTRIMMED
 * span, the only place those two differ.
 *
 * PROVENANCE: every expectation below was captured by running the pre-refactor
 * board regex over these exact bodies. Not one was derived from the new module.
 * That is what makes this corpus a parity proof rather than a change detector.
 *
 * The second reading this corpus used to pin — the shipped SessionStart hook's
 * `first-pipe` cell through its own charset + vocabulary — left with the hook
 * runtime, so the rows no longer carry a `session` expectation.
 */
interface CorpusRow {
  slug: string;
  body: string;
  /** What `readWishStatus` returns in src/term-commands/v5-board.ts — raw, no vocabulary. */
  board: string | null;
  why: string;
}

const CORPUS: CorpusRow[] = [
  {
    slug: 'row-1-parenthetical',
    body: '| **Status** | SHIP-READY (wave 2) |\n',
    board: 'SHIP-READY (wave 2)',
    why: 'board keeps the raw cell (its ladder reads SHIP- as Wish); the hook charset rejects parentheses',
  },
  {
    slug: 'row-2-trailing-comment',
    body: '| **Status** | DRAFT |   <!-- x -->\n',
    board: null,
    why: 'the board anchors the closing pipe at end-of-row, so trailing content kills the match; the hook stops at the first pipe',
  },
  {
    slug: 'row-3-three-column',
    body: '| **Status** | DRAFT | note |\n',
    board: 'DRAFT | note',
    why: 'a row-end cell spans internal pipes; a first-pipe cell does not',
  },
  {
    slug: 'row-4-charset-violation',
    body: '| **Status** | DRAFT extra |\n',
    board: 'DRAFT extra',
    why: 'the hook charset is a FULL-CELL test — a conforming DRAFT prefix is not enough',
  },
  {
    slug: 'row-5-legacy-form',
    body: '**Status:** DRAFT\n',
    board: null,
    why: 'the legacy form is opt-in and only the hook opts in',
  },
  {
    slug: 'row-6-legacy-with-note',
    body: '**Status:** DRAFT (2026-07-09) — shipped later\n',
    board: null,
    why: 'the legacy line keeps PREFIX semantics, unlike the cell — a note after the status does not void it',
  },
  {
    slug: 'row-7-board-falls-through',
    body: '| **Status** | DRAFT |   <!-- x -->\n| **Status** | APPROVED |\n',
    board: 'APPROVED',
    why: 'a row the board cannot match is skipped, not fatal — it reads the next Status row',
  },
  {
    slug: 'row-8-hook-falls-through',
    body: '| **Status** | DRAFT extra |\n| **Status** | APPROVED |\n',
    board: 'DRAFT extra',
    why: 'the hook charset is applied DURING the scan, so a rejected row hands off to the next one',
  },
  {
    slug: 'zerowidth-with-legacy',
    body: '| **Status** ||\n**Status:** DRAFT\n',
    board: null,
    why: 'ZERO-WIDTH cell: never a match at all, so the scan continues and the legacy fallback is REACHABLE',
  },
  {
    slug: 'blank-cell-with-legacy',
    body: '| **Status** |   |\n**Status:** BLOCKED\n',
    board: null,
    why: 'BLANK cell: a match whose value the vocabulary rejects, which STOPS the scan and BLOCKS the fallback',
  },
  {
    slug: 'zerowidth-with-later-row',
    body: '| **Status** ||\n| **Status** | APPROVED |\n',
    board: null,
    why: 'the zero-width row is skipped; the next Status row supplies the value',
  },
  {
    slug: 'blank-cell-with-later-row',
    body: '| **Status** |   |\n| **Status** | APPROVED |\n',
    board: null,
    why: 'the blank row matches, so the later Status row is never reached',
  },
  {
    slug: 'zerowidth-alone',
    body: '| **Status** ||\n',
    board: null,
    why: 'nothing admissible anywhere',
  },
  {
    slug: 'blank-cell-alone',
    body: '| **Status** |   |\n',
    board: null,
    why: 'matches, but an empty value is not a status',
  },
  {
    slug: 'tab-cell-with-legacy',
    body: '| **Status** |\t|\n**Status:** DRAFT\n',
    board: null,
    why: 'a tab is whitespace but not a status character, so the row is not a match and the fallback is reached',
  },
  {
    slug: 'tab-led-cell',
    body: '| **Status** |\tDRAFT |\n',
    board: 'DRAFT',
    why: 'leading whitespace is stripped by the surrounding runs, so a tab-led cell still reads',
  },
  {
    slug: 'legacy-bare-then-value',
    body: '**Status:**\n**Status:** DRAFT\n',
    board: null,
    why: 'a bare legacy line is not a match; scanning continues to the next legacy line',
  },
  {
    slug: 'legacy-lowercase-then-value',
    body: '**Status:** draft\n**Status:** APPROVED\n',
    board: null,
    why: 'a lowercase legacy line still MATCHES (a space satisfies the charset), so the scan stops and yields nothing',
  },
  {
    slug: 'legacy-bare-only',
    body: '**Status:**\n',
    board: null,
    why: 'no admissible legacy line',
  },
  {
    slug: 'legacy-value-on-next-line',
    body: '**Status:**\nDRAFT\n',
    board: null,
    why: 'the whitespace run crosses the newline, so the value on the following line still reads',
  },
  {
    slug: 'unterminated-then-row',
    body: '| **Status** | draft\n| **Status** | APPROVED |\n',
    board: 'APPROVED',
    why: 'the rejected first row must not swallow the second — the scan retries from one character past its START',
  },
  {
    slug: 'unterminated-valid-then-row',
    body: '| **Status** | DRAFT\n| **Status** | APPROVED |\n',
    board: 'APPROVED',
    why: 'the whitespace run reaches the next rows opening pipe, so the hook reads DRAFT while the board reads the closed row',
  },
  {
    slug: 'vocab-invalid-then-valid',
    body: '| **Status** | SHIPPED |\n| **Status** | DRAFT |\n',
    board: 'SHIPPED',
    // hooks-v2 display vocabulary: SHIPPED is now a first-class display token
    // (it was outside the old active-only vocabulary, which pinned these two
    // rows to null); the stop-on-rejection mechanics stay pinned by row-4.
    why: 'the board takes the first row; the hook matches it and displays it under the extended vocabulary',
  },
  {
    slug: 'vocab-invalid-blocks-legacy',
    body: '| **Status** | SHIPPED |\n**Status:** DRAFT\n',
    board: 'SHIPPED',
    why: 'a matched displayable row blocks the legacy fallback, exactly as a vocabulary failure did pre-hooks-v2',
  },
  {
    slug: 'em-dash-note',
    body: '| **Status** | DONE — all 3 groups SHIP-reviewed |\n',
    board: 'DONE — all 3 groups SHIP-reviewed',
    why: 'an em-dash note is outside the hook charset entirely',
  },
  {
    slug: 'hyphen-uppercase-note',
    body: '| **Status** | DRAFT - WAVE TWO |\n',
    board: 'DRAFT - WAVE TWO',
    why: 'an all-uppercase hyphen note passes the charset, then normalization splits it',
  },
  {
    slug: 'realistic-metadata-table',
    body: '# Wish\n\n| Field | Value |\n|---|---|\n| **Date** | 2026-08-10 |\n| **Status** | IN_PROGRESS |\n',
    board: 'IN_PROGRESS',
    why: 'the ordinary shape every real wish uses',
  },
  {
    slug: 'no-status-at-all',
    body: '# Wish\n\nnothing here\n',
    board: null,
    why: 'no Status row and no legacy line',
  },
  {
    slug: 'crlf-row',
    body: '| **Status** | DRAFT |\r\n',
    board: 'DRAFT',
    why: 'a CRLF row reads identically to LF',
  },
];

describe('shared wish-status mechanics', () => {
  test('the slug pattern admits real slugs and rejects traversal', () => {
    expect(WISH_SLUG_PATTERN.test('lane-sync-followups')).toBe(true);
    expect(WISH_SLUG_PATTERN.test('a')).toBe(true);
    expect(WISH_SLUG_PATTERN.test('-leading')).toBe(false);
    expect(WISH_SLUG_PATTERN.test('..')).toBe(false);
    expect(WISH_SLUG_PATTERN.test('nested/slug')).toBe(false);
    expect(WISH_SLUG_PATTERN.test('Upper')).toBe(false);
  });

  test('accept receives the untrimmed span, so a blank cell is distinguishable from a zero-width one', () => {
    const seen: string[] = [];
    const collect = (raw: string) => {
      seen.push(raw);
      return true;
    };
    extractStatusCell('| **Status** |   |\n', 'first-pipe', collect);
    extractStatusCell('| **Status** ||\n', 'first-pipe', collect);
    // Trimming here would collapse both to '' and silently merge two cases the
    // pre-consolidation regex told apart.
    expect(seen).toEqual(['   ', '']);
  });

  test('a rejected row resumes the scan past its START, not past its end', () => {
    // The leading whitespace run can cross a newline and end the match on the
    // NEXT row's opening pipe; resuming at the match end would swallow that row.
    const doc = '| **Status** | draft\n| **Status** | APPROVED |\n';
    expect(extractStatusCell(doc, 'first-pipe', (raw) => /^\s*[A-Z_ -]+\s*$/.test(raw))).toBe('APPROVED');
  });

  test('legacy extraction skips a line it cannot read and keeps scanning', () => {
    const admissible = (raw: string) => /^\s*[A-Z_ -]/.test(raw);
    expect(extractLegacyStatusValue('**Status:**\n**Status:** DRAFT\n', admissible)).toBe('DRAFT');
    expect(extractLegacyStatusValue('**Status:**\n', admissible)).toBeNull();
    expect(extractLegacyStatusValue('| **Status** | DRAFT |\n', admissible)).toBeNull();
  });

  test('a matched row with a blank cell reads as empty, not as no row at all', () => {
    expect(extractStatusCell('| **Status** |  |\n', 'row-end')).toBe('');
    expect(extractStatusCell('| **Status** |  |\n', 'first-pipe')).toBe('');
    expect(extractStatusCell('# no table here\n', 'row-end')).toBeNull();
    expect(extractStatusCell('# no table here\n', 'first-pipe')).toBeNull();
  });
});

describe('bounded wish read', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wish-status-read-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('reads a regular file whole and refuses anything outside the budget', () => {
    const file = join(dir, 'WISH.md');
    writeFileSync(file, '| **Status** | DRAFT |\n');
    expect(readBoundedWishFile(file, MAX_WISH_BYTES)).toBe('| **Status** | DRAFT |\n');
    expect(readBoundedWishFile(file, 4)).toBeNull();
    expect(readBoundedWishFile(join(dir, 'missing.md'), MAX_WISH_BYTES)).toBeNull();
  });

  test('refuses symlinks and non-regular files', () => {
    const target = join(dir, 'target.md');
    writeFileSync(target, '| **Status** | DRAFT |\n');
    const link = join(dir, 'link.md');
    symlinkSync(target, link);
    expect(readBoundedWishFile(link, MAX_WISH_BYTES)).toBeNull();

    const directory = join(dir, 'directory.md');
    mkdirSync(directory);
    expect(readBoundedWishFile(directory, MAX_WISH_BYTES)).toBeNull();
  });

  test('head reads cap at headBytes and refuse files over the max size, with the same guards', () => {
    const file = join(dir, 'head.md');
    writeFileSync(file, `| **Status** | DRAFT |\n${'x'.repeat(1_000)}`);
    expect(readBoundedWishHead(file, MAX_WISH_BYTES, 32)).toBe('| **Status** | DRAFT |\nxxxxxxxxx');
    expect(readBoundedWishHead(file, 64, 32)).toBeNull();
    expect(readBoundedWishHead(join(dir, 'missing.md'), MAX_WISH_BYTES, 32)).toBeNull();
    const link = join(dir, 'head-link.md');
    symlinkSync(file, link);
    expect(readBoundedWishHead(link, MAX_WISH_BYTES, 32)).toBeNull();
    const directory = join(dir, 'head-dir.md');
    mkdirSync(directory);
    expect(readBoundedWishHead(directory, MAX_WISH_BYTES, 32)).toBeNull();
  });
});

describe('corpus: board reading (v5-board readWishStatus)', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wish-status-board-'));
    for (const row of CORPUS) {
      mkdirSync(join(dir, row.slug), { recursive: true });
      writeFileSync(join(dir, row.slug, 'WISH.md'), row.body);
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const row of CORPUS) {
    test(`${row.slug}: ${row.why}`, () => {
      // Exactly readWishStatus's read + extract tail; its discovery guards and
      // lane ladder are covered by src/term-commands/v5-board.test.ts.
      const body = readBoundedWishFile(join(dir, row.slug, 'WISH.md'), MAX_WISH_BYTES);
      expect(body).not.toBeNull();
      expect((body !== null && extractStatusCell(body, 'row-end')) || null).toBe(row.board);
    });
  }
});
