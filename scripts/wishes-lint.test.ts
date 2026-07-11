import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LINT_SCRIPT = join(import.meta.dir, 'wishes-lint.ts');

let wishesDir: string;

function wish(date: string, executionStrategy: string): string {
  return `# Wish: Fixture

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Date** | ${date} |

## Dependencies

**depends-on:** none
**blocks:** none

## Execution Strategy

${executionStrategy}
`;
}

function runLint(): { code: number; stderr: string } {
  const result = Bun.spawnSync(['bun', LINT_SCRIPT, '--wishes-dir', wishesDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

function writeWish(contents: string, slug = 'fixture'): void {
  const wishDir = join(wishesDir, slug);
  mkdirSync(wishDir, { recursive: true });
  writeFileSync(join(wishDir, 'WISH.md'), contents);
}

beforeEach(() => {
  wishesDir = mkdtempSync(join(tmpdir(), 'genie-wishes-lint-'));
});

afterEach(() => {
  rmSync(wishesDir, { recursive: true, force: true });
});

describe('wishes-lint Execution Strategy routing fields', () => {
  test('post-threshold table missing Complexity fails', () => {
    writeWish(
      wish(
        '2026-07-09',
        `| Group | Agent | Model | Description |
|-------|-------|-------|-------------|
| 1 | engineer | opus-high | fixture |`,
      ),
    );

    const result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Execution Strategy table is missing required column(s): Complexity');
  });

  test('post-threshold table with Complexity and Model passes', () => {
    writeWish(
      wish(
        '2026-07-09',
        `| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 | opus-high | fixture |`,
      ),
    );

    const result = runLint();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('wishes-lint: OK');
  });

  test('pre-threshold table without routing columns passes', () => {
    writeWish(
      wish(
        '2026-07-08',
        `| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | fixture |`,
      ),
    );

    expect(runLint().code).toBe(0);
  });

  test('post-threshold wish without an Execution Strategy table fails', () => {
    writeWish(wish('2026-07-09', 'Use one engineer sequentially.'));

    const result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('must contain an Execution Strategy markdown table');
  });

  test('broken brainstorm link diagnostics remain enforced', () => {
    writeWish(`${wish('2026-07-08', 'No table required.')}\n[Design](../../brainstorms/missing/DRAFT.md)\n`);

    const result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Design → ../../brainstorms/missing/DRAFT.md');
    expect(result.stderr).toContain('1 broken brainstorm link(s) across 1 wish file(s)');
  });

  test('rejects unsupported lifecycle status and missing mandatory dependency keys', () => {
    const invalidStatus = wish('2026-07-08', 'No table required.').replace('DRAFT', 'SUPERSEDED IN PART');
    writeWish(invalidStatus);
    let result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unsupported wish status "SUPERSEDED IN PART"');

    rmSync(join(wishesDir, 'fixture'), { recursive: true, force: true });
    writeWish(wish('2026-07-08', 'No table required.').replace('**blocks:** none', ''));
    result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('exactly one **blocks:** key');
  });

  test('accepts historical terminal status without retrofitting dependency metadata', () => {
    writeWish('| **Status** | DONE — historical |\n| **Date** | 2026-07-01 |\n');
    expect(runLint().code).toBe(0);
  });

  test('rejects missing local references and dependency cycles', () => {
    writeWish(wish('2026-07-08', 'No table required.').replace('**depends-on:** none', '**depends-on:** missing'));
    let result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('references missing wish slug "missing"');

    rmSync(join(wishesDir, 'fixture'), { recursive: true, force: true });
    writeWish(
      wish('2026-07-08', 'No table required.').replace('**depends-on:** none', '**depends-on:** beta'),
      'alpha',
    );
    writeWish(
      wish('2026-07-08', 'No table required.').replace('**depends-on:** none', '**depends-on:** alpha'),
      'beta',
    );
    result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wish dependency cycle:');
  });
});
