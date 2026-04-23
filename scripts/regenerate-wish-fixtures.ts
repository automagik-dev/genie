#!/usr/bin/env bun
/**
 * Regenerate the wish-linter test corpus's `expected-violations.json` and
 * `expected-fixed.md` files from the current parser + linter output.
 *
 * Usage:
 *   bun run scripts/regenerate-wish-fixtures.ts
 *
 * Every fixture directory under `src/services/__tests__/fixtures/wishes/` must
 * contain an `input.md` and a `fixture.json`. The script walks each one, runs
 * the linter, and writes:
 *   - `expected-violations.json` — the canonical violations payload.
 *   - `expected-fixed.md` — only when `fixture.json.expectFixChanges === true`.
 *
 * Safe to run whenever linter behavior changes. Diff the result before
 * committing so regressions are caught in review.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyFixes, lintMarkdown } from '../src/services/wish-lint.js';

interface FixtureMetadata {
  category: 'clean' | 'fixable' | 'non-fixable' | 'parse-error' | 'parse-error-fixable';
  rules: string[];
  description: string;
  expectFixChanges: boolean;
}

interface ExpectedViolation {
  rule: string;
  severity: 'error' | 'warning';
  line: number;
  column: number;
  fixable: boolean;
}

interface ExpectedViolations {
  summary: { total: number; fixable: number; unfixable: number };
  violations: ExpectedViolation[];
}

const FIXTURES_ROOT = new URL('../src/services/__tests__/fixtures/wishes/', import.meta.url).pathname;

function main(): void {
  const entries = readdirSync(FIXTURES_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const dir = join(FIXTURES_ROOT, entry.name);
    const inputPath = join(dir, 'input.md');
    const fixturePath = join(dir, 'fixture.json');
    const violationsPath = join(dir, 'expected-violations.json');
    const fixedPath = join(dir, 'expected-fixed.md');

    const input = readFileSync(inputPath, 'utf8');
    const meta = JSON.parse(readFileSync(fixturePath, 'utf8')) as FixtureMetadata;

    const report = lintMarkdown(input);
    const violations: ExpectedViolation[] = report.violations.map((v) => ({
      rule: v.rule,
      severity: v.severity,
      line: v.line,
      column: v.column,
      fixable: v.fixable,
    }));
    const expected: ExpectedViolations = {
      summary: report.summary,
      violations,
    };
    writeFileSync(violationsPath, `${JSON.stringify(expected, null, 2)}\n`);

    if (meta.expectFixChanges) {
      const fixed = applyFixes(input, report);
      writeFileSync(fixedPath, fixed.endsWith('\n') ? fixed : `${fixed}\n`);
    }

    const fixable = violations.filter((v) => v.fixable).length;
    const unfixable = violations.filter((v) => !v.fixable).length;
    console.log(`${entry.name}: ${violations.length} violations (${fixable} fixable, ${unfixable} unfixable)`);
  }
}

main();
