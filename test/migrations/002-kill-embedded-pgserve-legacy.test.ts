import { expect, test } from 'bun:test';

import { selectLegacyEmbedded } from '../../src/migrations/steps/002-kill-embedded-pgserve-legacy.js';

// Regression guard for the canonical-port-discovery fix: the legacy selector
// must compare against the DISCOVERED canonical port, never a hardcoded 8432,
// and must return EVERY stray (not just the first) so apply stops them all.

test('never selects the canonical postmaster (5432-only healthy host)', () => {
  expect(selectLegacyEmbedded(5432, [{ pid: 100, port: 5432 }])).toEqual([]);
});

test('selects the stray 8432, NOT the canonical 5432 (mixed migration window)', () => {
  expect(
    selectLegacyEmbedded(5432, [
      { pid: 100, port: 5432 },
      { pid: 200, port: 8432 },
    ]),
  ).toEqual([{ pid: 200, port: 8432 }]);
});

test('selects ALL strays, not just the first (multiple legacy postmasters)', () => {
  expect(
    selectLegacyEmbedded(5432, [
      { pid: 100, port: 5432 },
      { pid: 200, port: 8432 },
      { pid: 300, port: 9432 },
    ]),
  ).toEqual([
    { pid: 200, port: 8432 },
    { pid: 300, port: 9432 },
  ]);
});

test('legacy-era host: canonical on 8432, nothing stray → no-op', () => {
  expect(selectLegacyEmbedded(8432, [{ pid: 100, port: 8432 }])).toEqual([]);
});

test('canonical port unidentifiable (null) → never selects anything', () => {
  expect(selectLegacyEmbedded(null, [{ pid: 100, port: 5432 }])).toEqual([]);
  expect(selectLegacyEmbedded(null, [])).toEqual([]);
});
