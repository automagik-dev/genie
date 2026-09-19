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
const CALLER_PINNED = ['workfly.js', 'docs-audit.js', 'research-sweep.js', 'skill-audit-sweep.js', 'skill-intake.js'];
const SPREAD = '...(MODEL ? { model: MODEL } : {})';
// wish.js goes further than one caller-pinned model: its two MECHANICAL stages (the gate, which
// runs the repository check and reads an exit code, and the publisher, which runs an allowlisted
// push/PR sequence) take their own optional key, so a run can put them on a cheaper runtime than
// the reasoning stages. Each key is still caller-supplied and still reaches agent() only through a
// conditional spread; unset falls back to `model`, so an unpinned run is unchanged.
const STAGE_PINNED: Record<string, string[]> = {
  'wish.js': ['MODEL', 'GATE_MODEL', 'PUBLISH_MODEL'],
};

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

describe('the stage-pinned scripts keep one caller key per stage group', () => {
  for (const [name, variables] of Object.entries(STAGE_PINNED)) {
    const code = read(name);

    test(`${name} is in the catalog and every stage model spreads conditionally`, () => {
      expect(SCRIPTS).toContain(name);
      for (const variable of variables) {
        expect(code).toContain(`...(${variable} ? { model: ${variable} } : {})`);
      }
      // Nothing outside those spreads may set `model:` on an options object; a bare key would pin
      // the empty string on an unpinned run and stop the session model from being inherited.
      let stripped = code;
      for (const variable of variables)
        stripped = stripped.replaceAll(`...(${variable} ? { model: ${variable} } : {})`, '');
      for (const variable of variables) expect(stripped).not.toMatch(new RegExp(`\\bmodel: ${variable}\\b`));
      expect(code).not.toMatch(/\bmodel: '[^']+'/);
    });

    test(`${name} takes every stage model from the caller and inherits when one is unset`, () => {
      expect(code).toMatch(/model: text\(input\.model\),/);
      for (const variable of variables.slice(1)) {
        const key = variable.toLowerCase().replace(/_(.)/g, (_m, c: string) => c.toUpperCase());
        expect(code).toMatch(new RegExp(`${key}: text\\(input\\.${key}\\),`));
        expect(code).toMatch(new RegExp(`^const ${variable} = job\\.${key} \\|\\| job\\.model$`, 'm'));
      }
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
