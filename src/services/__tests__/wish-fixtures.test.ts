/**
 * Fixture-driven regression suite for wish-parser + wish-lint.
 *
 * Every fixture under `src/services/__tests__/fixtures/wishes/<slug>/` carries:
 *   - `input.md`              — the markdown under test
 *   - `fixture.json`          — metadata: category, declared rules, fix expectations
 *   - `expected-violations.json` — canonical violations payload
 *   - `expected-fixed.md`     — only when `fixture.json.expectFixChanges === true`
 *
 * These tests enforce three invariants:
 *   1. Running `lintMarkdown` on `input.md` produces violations that match
 *      `expected-violations.json` (byte-equivalent at the rule/line/column/fixable
 *      subset — full report shape is covered elsewhere).
 *   2. Every fixture category behaves as declared:
 *        - `clean` → zero violations.
 *        - `fixable` / `parse-error-fixable` → at least one fixable violation and
 *          `applyFixes` produces `expected-fixed.md` byte-for-byte.
 *        - `non-fixable` / `parse-error` (with expectFixChanges=false) → applyFixes is a no-op.
 *   3. Rule-to-fixture coverage: every `ViolationRule` literal must be declared
 *      in some fixture's `fixture.json.rules` OR appear in the inline coverage
 *      allowlist (rules covered by dedicated parser-test cases instead of a
 *      fixture).
 *
 * Plus one snapshot test locking the structural shape of the canonical positive
 * in-tree wish `wish-command-group-restructure`. If this snapshot breaks, the
 * author must deliberately update it — drift detection for the parser itself.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { applyFixes, lintMarkdown } from '../wish-lint.js';
import { parseWishFile } from '../wish-parser.js';
import { VIOLATION_RULES, type ViolationRule } from '../wish-schema.js';

// ============================================================================
// Paths + types
// ============================================================================

const FIXTURES_ROOT = new URL('./fixtures/wishes/', import.meta.url).pathname;
const WORKTREE_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const SNAPSHOT_SLUG = 'wish-command-group-restructure';

type FixtureCategory = 'clean' | 'fixable' | 'non-fixable' | 'parse-error' | 'parse-error-fixable';

interface FixtureMetadata {
  category: FixtureCategory;
  rules: string[];
  description: string;
  expectFixChanges: boolean;
}

interface ExpectedViolation {
  rule: ViolationRule;
  severity: 'error' | 'warning';
  line: number;
  column: number;
  fixable: boolean;
}

interface ExpectedViolations {
  summary: { total: number; fixable: number; unfixable: number };
  violations: ExpectedViolation[];
}

/**
 * Rules whose coverage is provided by inline tests in wish-parser.test.ts
 * (parse-error path) rather than by a fixture. Each maps to the test block
 * that asserts the rule fires.
 *
 * These three rules all throw during parse before the linter runs, and all
 * three have dedicated test cases in wish-parser.test.ts. The fixture corpus
 * doesn't duplicate them because the wish's fixture enumeration only lists the
 * 15 rules from Groups 3 and 4 of wish-command-group-restructure.
 */
const INLINE_COVERED_RULES: ReadonlyArray<ViolationRule> = [
  'missing-title',
  'missing-summary',
  'missing-execution-group',
];

// ============================================================================
// Fixture discovery
// ============================================================================

interface LoadedFixture {
  slug: string;
  dir: string;
  input: string;
  meta: FixtureMetadata;
  expected: ExpectedViolations;
  expectedFixed?: string;
}

function loadFixtures(): LoadedFixture[] {
  const entries = readdirSync(FIXTURES_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  const out: LoadedFixture[] = [];
  for (const entry of entries) {
    const dir = join(FIXTURES_ROOT, entry.name);
    const meta = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8')) as FixtureMetadata;
    const input = readFileSync(join(dir, 'input.md'), 'utf8');
    const expected = JSON.parse(readFileSync(join(dir, 'expected-violations.json'), 'utf8')) as ExpectedViolations;
    const fixed = meta.expectFixChanges ? readFileSync(join(dir, 'expected-fixed.md'), 'utf8') : undefined;
    out.push({
      slug: entry.name,
      dir,
      input,
      meta,
      expected,
      ...(fixed !== undefined ? { expectedFixed: fixed } : {}),
    });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

const FIXTURES = loadFixtures();

// ============================================================================
// Structural invariants: directory count
// ============================================================================

describe('wish fixtures — directory layout', () => {
  test('exactly 17 fixture directories exist', () => {
    expect(FIXTURES).toHaveLength(17);
  });

  test('every fixture has input.md, fixture.json, and expected-violations.json', () => {
    for (const f of FIXTURES) {
      expect(f.input.length).toBeGreaterThan(0);
      expect(f.meta.category).toBeDefined();
      expect(Array.isArray(f.meta.rules)).toBe(true);
      expect(f.expected.violations).toBeDefined();
    }
  });

  test('fixtures declaring expectFixChanges=true have expected-fixed.md', () => {
    for (const f of FIXTURES) {
      if (f.meta.expectFixChanges) {
        expect(f.expectedFixed).toBeDefined();
        expect((f.expectedFixed ?? '').length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================================
// Linter output matches expected-violations.json
// ============================================================================

describe('wish fixtures — violations match expected', () => {
  for (const fixture of FIXTURES) {
    test(`[${fixture.slug}] lint output matches expected-violations.json`, () => {
      const report = lintMarkdown(fixture.input);
      expect(report.summary).toEqual(fixture.expected.summary);
      expect(report.violations).toHaveLength(fixture.expected.violations.length);
      for (let i = 0; i < fixture.expected.violations.length; i++) {
        const actual = report.violations[i];
        const expected = fixture.expected.violations[i];
        if (!actual || !expected) continue;
        expect({
          rule: actual.rule,
          severity: actual.severity,
          line: actual.line,
          column: actual.column,
          fixable: actual.fixable,
        }).toEqual(expected);
      }
    });
  }
});

// ============================================================================
// Category contract: clean / fixable / non-fixable behavior
// ============================================================================

describe('wish fixtures — category contract', () => {
  for (const fixture of FIXTURES) {
    test(`[${fixture.slug}] category "${fixture.meta.category}" matches observed behavior`, () => {
      const report = lintMarkdown(fixture.input);

      if (fixture.meta.category === 'clean') {
        expect(report.violations).toEqual([]);
        expect(report.summary.total).toBe(0);
        return;
      }

      expect(report.violations.length).toBeGreaterThan(0);

      // Every declared rule must actually fire on this fixture.
      for (const rule of fixture.meta.rules) {
        expect(report.violations.some((v) => v.rule === rule)).toBe(true);
      }

      if (fixture.meta.category === 'fixable' || fixture.meta.category === 'parse-error-fixable') {
        expect(report.summary.fixable).toBeGreaterThan(0);
      }
    });
  }
});

// ============================================================================
// Fix behavior: byte-for-byte equality with expected-fixed.md, and no-op for non-fixable
// ============================================================================

describe('wish fixtures — applyFixes', () => {
  for (const fixture of FIXTURES) {
    if (fixture.meta.expectFixChanges) {
      test(`[${fixture.slug}] applyFixes output matches expected-fixed.md byte-for-byte`, () => {
        const report = lintMarkdown(fixture.input);
        const produced = applyFixes(fixture.input, report);
        const normalized = produced.endsWith('\n') ? produced : `${produced}\n`;
        expect(normalized).toBe(fixture.expectedFixed ?? '');
      });

      test(`[${fixture.slug}] applyFixes is idempotent (twice === once)`, () => {
        const report1 = lintMarkdown(fixture.input);
        const once = applyFixes(fixture.input, report1);
        const report2 = lintMarkdown(once);
        const twice = applyFixes(once, report2);
        expect(twice).toBe(once);
      });
    } else {
      test(`[${fixture.slug}] applyFixes is a no-op when expectFixChanges=false`, () => {
        const report = lintMarkdown(fixture.input);
        const produced = applyFixes(fixture.input, report);
        // Non-fixable or parse-error fixtures may still have fixable:true violations
        // whose FixAction is null — applyFixes drops those, yielding input unchanged.
        expect(produced).toBe(fixture.input);
      });
    }
  }
});

// ============================================================================
// Rule-to-fixture coverage: every ViolationRule must be covered somewhere
// ============================================================================

describe('wish fixtures — rule coverage', () => {
  test('every ViolationRule literal is either declared in a fixture.json OR in INLINE_COVERED_RULES', () => {
    const declared = new Set<string>();
    for (const f of FIXTURES) {
      for (const rule of f.meta.rules) declared.add(rule);
    }
    for (const rule of INLINE_COVERED_RULES) declared.add(rule);

    const missing: string[] = [];
    for (const rule of VIOLATION_RULES) {
      if (!declared.has(rule)) missing.push(rule);
    }
    if (missing.length > 0) {
      console.error(`Uncovered rules (add a fixture or list them in INLINE_COVERED_RULES): ${missing.join(', ')}`);
    }
    expect(missing).toEqual([]);
  });

  test('every rule declared in a fixture.json is a valid ViolationRule literal', () => {
    const valid = new Set<string>(VIOLATION_RULES);
    for (const f of FIXTURES) {
      for (const rule of f.meta.rules) {
        expect(valid.has(rule)).toBe(true);
      }
    }
  });

  test('INLINE_COVERED_RULES entries are all valid ViolationRule literals', () => {
    const valid = new Set<string>(VIOLATION_RULES);
    for (const rule of INLINE_COVERED_RULES) {
      expect(valid.has(rule)).toBe(true);
    }
  });
});

// ============================================================================
// Snapshot: structural shape of the canonical in-tree wish
// ============================================================================

describe('wish snapshot — wish-command-group-restructure', () => {
  test('parses with the expected top-level structural shape', () => {
    const doc = parseWishFile(SNAPSHOT_SLUG, { repoRoot: WORKTREE_ROOT });

    // Stable, author-owned invariants. Update deliberately when the wish evolves.
    expect(doc.title).toContain('Wish Command Group Restructure');
    expect(doc.metadata.slug).toBe(SNAPSHOT_SLUG);
    expect(doc.executionGroups.length).toBe(5);

    const numbers = doc.executionGroups.map((g) => g.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);

    // Every group carries populated required content.
    for (const g of doc.executionGroups) {
      expect(g.title.length).toBeGreaterThan(0);
      expect(g.goal.length).toBeGreaterThan(0);
      expect(g.deliverables.length).toBeGreaterThan(0);
      expect(g.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(g.validation.length).toBeGreaterThan(0);
    }

    // Group 1 has no upstream deps; Group 5 depends on 1 and 3 per the wish.
    const g1 = doc.executionGroups.find((g) => g.number === 1);
    const g5 = doc.executionGroups.find((g) => g.number === 5);
    expect(g1?.dependsOn).toBe('none');
    expect(Array.isArray(g5?.dependsOn)).toBe(true);
  });
});

// ============================================================================
// Regression flow: lint → fix → lint clean (fixable fixtures)
// ============================================================================

describe('wish fixtures — lint/fix/lint regression flow', () => {
  for (const fixture of FIXTURES) {
    if (!fixture.meta.expectFixChanges) continue;
    test(`[${fixture.slug}] lint → fix → relint removes the fixed rule(s)`, () => {
      const first = lintMarkdown(fixture.input);
      const fixed = applyFixes(fixture.input, first);
      const second = lintMarkdown(fixed);

      // The specific fixable rules this fixture targets should NOT reappear
      // after --fix (per-rule idempotency). Non-fixable content rules may
      // remain; that's expected behavior, not a regression.
      for (const rule of fixture.meta.rules) {
        const firedAgain = second.violations.some((v) => v.rule === rule && v.fixable);
        expect(firedAgain).toBe(false);
      }
    });
  }
});
