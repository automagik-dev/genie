/**
 * Shared WISH.md reading MECHANICS — one implementation of the primitives that
 * every wish-status consumer used to carry its own copy of: the slug shape, the
 * bounded untrusted-file read, and the raw Status-cell extraction.
 *
 * MECHANICS ONLY. The consumers' INTERPRETATIONS differ on purpose and stay
 * where they are: the board's lane prefix ladder, the SessionStart hook's
 * ACTIVE_STATUSES vocabulary / charset / em-dash normalization, and the linter's
 * canonical-status sets are all deliberately divergent policy. Nothing in this
 * module filters, normalizes, or ranks a status.
 *
 * THE CONTRACT IS BYTE-FOR-BYTE PARITY with the three pre-consolidation parsers
 * this module replaced. It is a de-risking refactor: no consumer's answer may
 * change for any input, well-formed or malformed. The regexes below are the
 * historical ones character for character, the scan reproduces the old engine's
 * retry rule, and `accept` exists so a consumer's filter still runs INSIDE the
 * search rather than after it. Parity is pinned by the corpus in
 * wish-status.test.ts, whose expectations were captured by running the
 * pre-consolidation code — not this module — over each fixture.
 *
 * Node-only by contract: this file is bundled into the Codex SessionStart hook
 * by esbuild, so it must never import `bun:*` or anything Bun-specific.
 */

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';

/** The unanchored wish-slug body, exported so composed patterns stay derived. */
export const WISH_SLUG_SOURCE = '[a-z0-9][a-z0-9-]{0,63}';

/** A bare wish slug: `lane-sync-followups`. */
export const WISH_SLUG_PATTERN = new RegExp(`^${WISH_SLUG_SOURCE}$`);

/**
 * Read an untrusted wish file under a byte budget, or null when it is missing,
 * unreadable, not a regular file, a symlink, or larger than the budget.
 *
 * The primitive is the union-strictest of the historical readers: an lstat
 * pre-check, `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, and an fstat re-validation of
 * type and size on the descriptor actually opened — so a path swapped between
 * the stat and the open cannot widen what is read.
 */
export function readBoundedWishFile(path: string, budget: number): string | null {
  let descriptor: number | null = null;
  try {
    const pathStats = lstatSync(path);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.size > budget) return null;

    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const fileStats = fstatSync(descriptor);
    if (!fileStats.isFile() || fileStats.size > budget) return null;

    const bytes = Buffer.alloc(fileStats.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    return bytes.subarray(0, offset).toString('utf8');
  } catch {
    // Missing/orphaned and unreadable wishes are hand-owned for this read.
    return null;
  } finally {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // The read remains best-effort even if descriptor cleanup reports I/O.
      }
    }
  }
}

/**
 * Where a `| **Status** | ... |` cell ends. The two modes are NOT
 * interchangeable and each consumer keeps the one it has always used:
 *
 * - `row-end` anchors the closing pipe at end-of-row, so a cell may span
 *   internal pipes (`DRAFT | note`) and a row with trailing content past the
 *   last pipe does not match at all.
 * - `first-pipe` stops at the first pipe, so a 3-column row yields only the
 *   first cell and trailing content past the row is ignored.
 */
export type StatusCellBoundary = 'row-end' | 'first-pipe';

/**
 * The capture is the RAW span between the delimiters — the surrounding `\s*`
 * runs live INSIDE the group. That is deliberate: an `accept` predicate has to
 * be able to tell `||` from `|   |`, which a trimmed cell cannot express. The
 * expressions are otherwise the historical ones character for character, so
 * only the group boundaries moved and matching is unchanged.
 */
const STATUS_CELL_PATTERNS: Record<StatusCellBoundary, RegExp> = {
  'row-end': /^\|\s*\*\*Status\*\*\s*\|(\s*.*?\s*)\|\s*$/m,
  'first-pipe': /^\|\s*\*\*Status\*\*\s*\|(\s*[^|\n]*?\s*)\|/m,
};

const LEGACY_STATUS_PATTERN = /^\*\*Status:\*\*(\s*.*)$/m;

/**
 * Find the first capture an `accept` predicate admits, RETRYING one character
 * past a rejected match's start rather than past its end.
 *
 * That resumption rule is the whole point. Both consumers historically encoded
 * their filter inside the regex, so a row they could not read was simply not a
 * match and the engine advanced the start position by one and tried again. A
 * rejected match must therefore never swallow a later row that begins inside
 * its span — which is reachable here, because the leading `\s*` can cross a
 * newline and end the match on the NEXT row's opening pipe.
 */
function firstAccepted(content: string, source: string, accept?: (raw: string) => boolean): string | null {
  const pattern = new RegExp(source, 'gm');
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    if (!accept || accept(match[1])) return match[1].trim();
    pattern.lastIndex = match.index + 1;
  }
  return null;
}

/**
 * The first admissible markdown-table Status cell, trimmed — no charset filter,
 * no vocabulary, no normalization. Returns null when no Status row matches under
 * the given boundary, and `''` when a row matched with a blank cell.
 *
 * `accept` receives the UNTRIMMED span between the delimiters, because the two
 * cases it must separate differ only in whitespace: a zero-width `||` (which
 * historically was not a match at all, so the scan continued) and a blank
 * `|   |` (which historically DID match, yielding a value the vocabulary then
 * rejected — stopping the scan and blocking any fallback).
 */
export function extractStatusCell(
  content: string,
  boundary: StatusCellBoundary,
  accept?: (rawCell: string) => boolean,
): string | null {
  return firstAccepted(content, STATUS_CELL_PATTERNS[boundary].source, accept);
}

/**
 * The first admissible legacy `**Status:** ...` value, trimmed. Strictly opt-in:
 * consumers that only recognise the table form must not call this. `accept`
 * receives the untrimmed span for the same reason as above, and a rejected line
 * hands off to the next `**Status:**` line rather than ending the search.
 */
export function extractLegacyStatusValue(content: string, accept?: (rawValue: string) => boolean): string | null {
  return firstAccepted(content, LEGACY_STATUS_PATTERN.source, accept);
}
