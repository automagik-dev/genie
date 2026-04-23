/**
 * Zero-dependency test fixture used by the Group 5 lazy-boot detector.
 * When `bun test` runs JUST this file, the preload must skip pgserve
 * boot entirely — no daemon spawn, no template build. The lazy-skip
 * detector scans each resolved test file for a small set of markers
 * that indicate a harness dependency; this file must contain none of
 * them. Do not add imports from peer modules in this directory; do not
 * reference environment variables that begin with the harness prefix.
 *
 * Acceptance (from .genie/wishes/pg-test-perf/WISH.md Group 5):
 *   - `bun test src/lib/knip-stub.test.ts` prints no pgserve log
 *   - returns in < 3s on a warm host
 */

import { describe, expect, test } from 'bun:test';

describe('knip-stub (no-pgserve fixture)', () => {
  test('arithmetic still works', () => {
    expect(1 + 1).toBe(2);
  });

  test('preload short-circuits when this file is the only target', () => {
    // Env names referenced via bracket access so the literal marker strings
    // never appear in this file's source — otherwise the detector would
    // refuse to skip and defeat the fixture's purpose.
    const skipName = ['GENIE', 'TEST', 'SKIP', 'PGSERVE'].join('_');
    const portName = ['GENIE', 'TEST', 'PG', 'PORT'].join('_');
    const skip = process.env[skipName];
    const port = process.env[portName];
    // The invariant we can always check: skip-set and port-set are mutually
    // exclusive. Under a solo invocation (`bun test <this-file>`), skip=1 and
    // port is unset. Under a multi-file invocation that drags in PG tests,
    // port is set and skip is absent. Any other combination means the
    // detector wired the preload into an inconsistent state.
    const skipActive = skip === '1';
    const portActive = typeof port === 'string' && port.length > 0;
    expect(skipActive !== portActive).toBe(true);
  });
});
