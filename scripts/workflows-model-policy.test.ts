import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Model policy for the saved-workflow catalog (issue #2921, DESIGN.md decision 6): a
// script never pins a default model. `model` is whatever the caller passed — empty by
// default — and it reaches an agent() options object only through a conditional spread,
// so an unpinned run inherits the session model. This file also pins workfly's
// maxRepairs clamp, which the same issue tightened to an integer in [0, 3].

const ROOT = join(import.meta.dir, '..');
const CATALOG = join(ROOT, '.claude', 'workflows');
const SCRIPTS = readdirSync(CATALOG)
  .filter((name) => name.endsWith('.js'))
  .sort();
const CALLER_PINNED = ['workfly.js', 'docs-audit.js', 'research-sweep.js', 'skill-audit-sweep.js'];
const SPREAD = '...(MODEL ? { model: MODEL } : {})';

const read = (name: string): string => readFileSync(join(CATALOG, name), 'utf8');

describe('no catalog script pins a default model', () => {
  test('the catalog is non-empty and holds every caller-pinned script', () => {
    expect(SCRIPTS.length).toBeGreaterThan(0);
    for (const name of CALLER_PINNED) expect(SCRIPTS).toContain(name);
  });

  for (const name of SCRIPTS) {
    test(`${name} carries neither DEFAULT_MODEL nor a literal opus model`, () => {
      expect(read(name)).not.toMatch(/DEFAULT_MODEL|model: 'opus'/);
    });
  }
});

describe('the caller-pinned scripts spread the model only when one was pinned', () => {
  for (const name of CALLER_PINNED) {
    const code = read(name);

    test(`${name} defaults model to the caller input alone, with no literal fallback`, () => {
      expect(code).toMatch(/model: (?:pinnedModel|text\(input\.model\)),/);
      expect(code).not.toMatch(/model: [^\n]*\|\|/);
    });

    test(`${name} spreads the model conditionally and never as a bare key`, () => {
      expect(code).toContain(SPREAD);
      // A `model: MODEL` outside the spread would pin an empty string on an unpinned run.
      expect(code.replaceAll(SPREAD, '')).not.toMatch(/\bmodel: MODEL\b/);
      expect(code).not.toMatch(/\bmodel: '[^']+'/);
    });
  }
});

describe('workfly clamps maxRepairs to an integer in [0, 3]', () => {
  const code = read('workfly.js');

  test('the clamp call names the bounds 0 and MAX_REPAIRS, and MAX_REPAIRS is 3', () => {
    expect(code).toMatch(/^const MAX_REPAIRS = 3$/m);
    expect(code).toMatch(/maxRepairs: clampInt\(input\.maxRepairs, 0, MAX_REPAIRS, DEFAULT_MAX_REPAIRS\),/);
  });

  test('the clamp helper behaves: caps at max, floors at min, replaces a non-integer', () => {
    const line = /^const clampInt = .*$/m.exec(code);
    if (!line) throw new Error('workfly.js: clampInt helper not found');
    const clampInt = new Function(`${line[0]}; return clampInt`)() as (
      value: unknown,
      min: number,
      max: number,
      fallback: number,
    ) => number;
    expect(clampInt(10, 0, 3, 2)).toBe(3);
    expect(clampInt(-1, 0, 3, 2)).toBe(0);
    expect(clampInt(1.5, 0, 3, 2)).toBe(2);
    expect(clampInt('3', 0, 3, 2)).toBe(2);
    expect(clampInt(undefined, 0, 3, 2)).toBe(2);
    expect(clampInt(3, 0, 3, 2)).toBe(3);
    expect(clampInt(0, 0, 3, 2)).toBe(0);
  });
});
