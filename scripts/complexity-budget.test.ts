import { describe, expect, test } from 'bun:test';
import { BUDGET, type BudgetReport, buildReport, evaluateBudget, parseBiomeOutput } from './complexity-budget';

const FIXTURE_TWO_HOTSPOTS = `
Some unrelated header text
./src/term-commands/db-migrate-v1.ts:105:16 lint/complexity/noExcessiveCognitiveComplexity ━━━━━━━━━━

  ! Excessive complexity of 42 detected (max: 25).

    103 │ }
    104 │
  > 105 │ async function dbMigrateV1Command(options: MigrateOptions): Promise<void> {
        │                ^^^^^^^^^^^^^^^^^^
    106 │   const { from, to } = options;

  i Please refactor this function to reduce its complexity score from 42 to the max allowed complexity 25.


./src/genie-commands/doctor.ts:76:16 lint/complexity/noExcessiveCognitiveComplexity ━━━━━━━━━━━━━━━━━

  ! Excessive complexity of 29 detected (max: 25).

    74 │ }
    75 │
  > 76 │ async function checkPrerequisites(): Promise<CheckResult[]> {
       │                ^^^^^^^^^^^^^^^^^^
    77 │   const results: CheckResult[] = [];


Checked 778 files in 402ms. No fixes applied.
Found 7 warnings.
`;

describe('parseBiomeOutput', () => {
  test('extracts file, line, column, score, and function name from each diagnostic', () => {
    const warnings = parseBiomeOutput(FIXTURE_TWO_HOTSPOTS);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toEqual({
      file: 'src/term-commands/db-migrate-v1.ts',
      line: 105,
      column: 16,
      score: 42,
      function: 'dbMigrateV1Command',
    });
    expect(warnings[1]).toEqual({
      file: 'src/genie-commands/doctor.ts',
      line: 76,
      column: 16,
      score: 29,
      function: 'checkPrerequisites',
    });
  });

  test('returns empty list when biome output has no complexity diagnostics', () => {
    const out = `
./src/foo.ts:1:1 lint/correctness/noUnusedImports ━━━━━

  ! 'bar' is unused.

Checked 1 file in 1ms. No fixes applied.
Found 1 warning.
`;
    expect(parseBiomeOutput(out)).toEqual([]);
  });

  test('skips diagnostics that have no score line', () => {
    const malformed = `
./src/x.ts:10:5 lint/complexity/noExcessiveCognitiveComplexity ━━━━━━━━━

  ! Some other variant without the score sentence.

  > 10 │ function broken() {

`;
    expect(parseBiomeOutput(malformed)).toEqual([]);
  });

  test('handles function name being absent from the pointer line', () => {
    const out = `
./src/y.ts:5:3 lint/complexity/noExcessiveCognitiveComplexity ━━━━━━━━━

  ! Excessive complexity of 27 detected (max: 25).

  > 5 │   .action(async (name) => {

`;
    const warnings = parseBiomeOutput(out);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].score).toBe(27);
    expect(warnings[0].function).toBeUndefined();
  });
});

describe('buildReport', () => {
  test('aggregates warnings, max score, and suppression count', () => {
    const suppressions = [
      'src/a.ts:1:// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reason a',
      'src/b.ts:2:// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reason b',
    ];
    const report = buildReport(FIXTURE_TWO_HOTSPOTS, suppressions);
    expect(report.warnings).toHaveLength(2);
    expect(report.maxScore).toBe(42);
    expect(report.suppressionCount).toBe(2);
    expect(report.suppressions).toEqual(suppressions);
  });

  test('maxScore is 0 when there are no warnings', () => {
    const report = buildReport('Checked 1 file. Found 0 warnings.\n', []);
    expect(report.maxScore).toBe(0);
    expect(report.warnings).toHaveLength(0);
  });
});

describe('evaluateBudget', () => {
  function fakeReport(over: Partial<BudgetReport>): BudgetReport {
    return {
      warnings: [],
      maxScore: 0,
      suppressionCount: 0,
      suppressions: [],
      ...over,
    };
  }

  test('passes when every metric is within budget', () => {
    const report = fakeReport({
      warnings: new Array(BUDGET.maxWarningCount).fill(0).map((_, i) => ({
        file: 'src/x.ts',
        line: i,
        column: 1,
        score: 26,
      })),
      maxScore: BUDGET.maxScore,
      suppressionCount: BUDGET.maxSuppressionCount,
    });
    const verdict = evaluateBudget(report);
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  test('fails when warning count regresses', () => {
    const report = fakeReport({
      warnings: new Array(BUDGET.maxWarningCount + 1).fill(0).map((_, i) => ({
        file: 'src/x.ts',
        line: i,
        column: 1,
        score: 26,
      })),
    });
    const verdict = evaluateBudget(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/retained warning count/);
  });

  test('fails when max score regresses', () => {
    const report = fakeReport({ maxScore: BUDGET.maxScore + 1 });
    const verdict = evaluateBudget(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/max score/);
  });

  test('fails when suppression count regresses', () => {
    const report = fakeReport({ suppressionCount: BUDGET.maxSuppressionCount + 1 });
    const verdict = evaluateBudget(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.join('\n')).toMatch(/suppression count/);
  });

  test('reports every regressing metric, not just the first', () => {
    const report = fakeReport({
      warnings: new Array(BUDGET.maxWarningCount + 2).fill(0).map((_, i) => ({
        file: 'src/x.ts',
        line: i,
        column: 1,
        score: BUDGET.maxScore + 5,
      })),
      maxScore: BUDGET.maxScore + 5,
      suppressionCount: BUDGET.maxSuppressionCount + 3,
    });
    const verdict = evaluateBudget(report);
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toHaveLength(3);
  });

  test('uses a custom budget when provided', () => {
    const report = fakeReport({ maxScore: 10 });
    expect(evaluateBudget(report, { maxWarningCount: 0, maxScore: 9, maxSuppressionCount: 0 }).ok).toBe(false);
    expect(evaluateBudget(report, { maxWarningCount: 0, maxScore: 10, maxSuppressionCount: 0 }).ok).toBe(true);
  });
});
