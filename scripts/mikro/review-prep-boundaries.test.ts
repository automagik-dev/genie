import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// review-prep names a trust-boundary hit by substring against the BOUNDARIES list in its SYSTEM.md. The
// list is prompt text, so nothing else pins it: #2976 changed the `curl | bash` installer and no entry
// matched (2026-09-18), and wish.js is the script that decides what a wish run may publish. The list is
// read from the prompt itself and matched the way the prompt's `boundary()` helper matches.
const SYSTEM = join(import.meta.dir, '..', '..', '.mikro', 'agents', 'review-prep', 'SYSTEM.md');

function boundaries(): string[] {
  const lines = readFileSync(SYSTEM, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('BOUNDARIES = '));
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0].slice('BOUNDARIES = '.length)) as string[];
}

const isBoundary = (path: string) => boundaries().some((entry) => path.includes(entry));

describe('review-prep BOUNDARIES list', () => {
  test('is one JSON-parseable line of unique, non-empty entries', () => {
    const list = boundaries();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((entry) => typeof entry === 'string' && entry.length > 0)).toBe(true);
    expect(new Set(list).size).toBe(list.length);
  });

  test('the prompt still matches by substring, which is what this test mirrors', () => {
    expect(readFileSync(SYSTEM, 'utf8')).toContain('hit = any(b in path for b in BOUNDARIES)');
  });

  for (const path of [
    'install.sh',
    '.claude/workflows/wish.js',
    'scripts/mikro/boundary.ts',
    'scripts/mikro/boundary.test.ts',
    '.github/workflows/version.yml',
    '.husky/pre-push',
    'scripts/release-guard.sh',
    'src/lib/delivery-evidence-verify.ts',
    'package.json',
  ]) {
    test(`${path} is a trust-boundary hit`, () => {
      expect(isBoundary(path)).toBe(true);
    });
  }

  for (const path of ['src/lib/wish-state.ts', '.claude/workflows/council.js', 'scripts/mikro/facts.ts', 'README.md']) {
    test(`${path} is not`, () => {
      expect(isBoundary(path)).toBe(false);
    });
  }
});
