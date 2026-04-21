/**
 * Built-in aggregator wiring discipline (#1288).
 *
 * Every `pattern-N-<slug>.ts` source file in `src/detectors/` must have a
 * matching `import './pattern-N-<slug>.js';` line in `built-in.ts`. Without
 * that import, the module's `registerDetector(...)` side-effect never runs
 * and the detector silently no-ops in production despite passing its own
 * unit tests — the failure mode that shipped with #1283 and was fixed by
 * this PR.
 *
 * Static scan rather than runtime: importing `built-in.ts` in a test would
 * populate the shared detector registry with production detectors and leak
 * cross-test state (see the top-of-file comment in `built-in.ts`). The
 * source-text check catches the same regression class with zero registry
 * mutation.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DETECTORS_DIR = join(import.meta.dir, '..');
const PATTERN_FILE_RE = /^pattern-\d+-.+\.ts$/;

describe('built-in aggregator wiring (#1288)', () => {
  test('every pattern-N-<slug>.ts source has a matching import in built-in.ts', () => {
    const builtInSource = readFileSync(join(DETECTORS_DIR, 'built-in.ts'), 'utf8');
    const patternFiles = readdirSync(DETECTORS_DIR).filter((f) => PATTERN_FILE_RE.test(f) && !f.endsWith('.test.ts'));

    // Guard against a directory layout change that would silently pass the
    // loop below with zero iterations.
    expect(patternFiles.length).toBeGreaterThan(0);

    for (const file of patternFiles) {
      const expectedImport = `'./${file.replace(/\.ts$/, '.js')}'`;
      expect(builtInSource).toContain(expectedImport);
    }
  });

  test('pattern-9 specifically is wired (regression guard for #1288)', () => {
    const builtInSource = readFileSync(join(DETECTORS_DIR, 'built-in.ts'), 'utf8');
    expect(builtInSource).toContain("'./pattern-9-team-unpushed-orphaned-worktree.js'");
  });
});
