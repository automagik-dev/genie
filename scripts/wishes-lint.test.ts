import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { designReviewDigest, stampDesignReview } from '../skills/brainstorm/references/design-review-evidence.mjs';
import { WISH_LINT_USAGE, resolveWishLintTarget } from './wishes-lint.js';

const LINT_SCRIPT = join(import.meta.dir, 'wishes-lint.ts');
const DESIGN_TEMPLATE = readFileSync(
  join(import.meta.dir, '..', 'skills', 'brainstorm', 'references', 'design-template.md'),
  'utf8',
);

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

function runLint(args?: string[]): { code: number; stderr: string } {
  const result = Bun.spawnSync(['bun', LINT_SCRIPT, ...(args ?? ['--wishes-dir', wishesDir])], {
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

function reviewedWish(designField: string): string {
  return `${wish(
    '2026-07-11',
    `| Group | Agent | Complexity | Model | Description |
|-------|-------|------------|-------|-------------|
| 1 | engineer | 3 | engineer-standard | fixture |`,
  )}
| **Design** | ${designField} |
`;
}

function writeDesign(verdict: 'SHIP' | 'FIX-FIRST' = 'SHIP'): string {
  const path = join(wishesDir, 'brainstorms', 'fixture', 'DESIGN.md');
  mkdirSync(join(wishesDir, 'brainstorms', 'fixture'), { recursive: true });
  writeFileSync(
    path,
    stampDesignReview(DESIGN_TEMPLATE, {
      verdict,
      reviewedSha256: designReviewDigest(DESIGN_TEMPLATE),
      reviewer: 'reviewer/thread-42',
      reviewedAt: '2026-07-11T12:00:00.000Z',
    }),
  );
  return path;
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

  test('new linked wishes require current digest-bound design SHIP evidence', () => {
    const design = writeDesign();
    writeWish(reviewedWish('[DESIGN.md](../brainstorms/fixture/DESIGN.md)'));
    expect(runLint().code).toBe(0);

    writeFileSync(design, `${readFileSync(design, 'utf8')}\nChanged after review.\n`);
    const changed = runLint();
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain('design changed after review');
  });

  test('new wishes reject non-SHIP evidence but retain the explicit direct-wish path', () => {
    writeDesign('FIX-FIRST');
    writeWish(reviewedWish('[DESIGN.md](../brainstorms/fixture/DESIGN.md)'));
    let result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('design review verdict must be SHIP');

    rmSync(join(wishesDir, 'fixture'), { recursive: true, force: true });
    writeWish(reviewedWish('[DESIGN.md](../brainstorms/fixture/DESIGN.md)').replace('2026-07-11', '2026-07-10'));
    result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('design review verdict must be SHIP');

    rmSync(join(wishesDir, 'fixture'), { recursive: true, force: true });
    writeWish(reviewedWish('_No brainstorm — direct wish_'));
    result = runLint();
    expect(result.code).toBe(0);
  });

  test('invalid or placeholder dates cannot bypass current lifecycle contracts', () => {
    writeWish(reviewedWish('_No brainstorm — direct wish_').replace('2026-07-11', '{{date}}'));
    const result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wish Date field must use a valid YYYY-MM-DD value');
  });

  test('accepts SUPERSEDED as a canonical terminal status, with the explanation after the dash', () => {
    writeWish(
      wish('2026-07-08', 'No table required.').replace(
        'DRAFT',
        'SUPERSEDED — shipped first, then removed or replaced (2026-09-19 triage)',
      ),
    );
    const result = runLint();
    expect(result.stderr).not.toContain('unsupported wish status');
    expect(result.code).toBe(0);
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

  test('the template validator gate rejects post-contract docs missing template sections', () => {
    const broken = wish('2026-08-13', 'No table required.').replace('## Summary', '');
    writeWish(broken);
    const result = runLint();
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('wish template violation');
    expect(result.stderr).toContain('## Summary');
  });

  test('the template validator gate accepts historical legacy formats', () => {
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

/**
 * `resolveWishLintTarget` is the whole argv surface of both `bun run wishes:lint`
 * and `genie wish lint`, and the one place a typo can turn into a clean bill of
 * health. Every refusal here is a case that previously walked an empty directory
 * and printed `OK (0 files scanned)`.
 */
describe('resolveWishLintTarget', () => {
  test('with no flags the root is <git toplevel of cwd>/.genie/wishes', () => {
    const repo = mkdtempSync(join(tmpdir(), 'genie-wish-target-'));
    try {
      Bun.spawnSync(['git', '-C', repo, 'init', '-q', '-b', 'main']);
      mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
      const target = resolveWishLintTarget([], join(repo, 'src', 'deep'));
      // macOS resolves the tmpdir through /private; compare on the suffix.
      expect(target.wishesDir.endsWith('/.genie/wishes')).toBe(true);
      expect(target.wishesDir).toBe(join(target.reportRoot, '.genie/wishes'));
      expect(target.reportRoot.endsWith(repo.replace(/^\/private/, ''))).toBe(true);
      expect(target.help).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('-h and --help return early without touching the filesystem', () => {
    for (const flag of ['-h', '--help']) {
      const target = resolveWishLintTarget([flag, '--dir', '/definitely/not/here'], '/tmp');
      expect(target.help).toBe(true);
      expect(target.wishesDir).toBe('');
    }
  });

  test('--dir resolves against cwd and keeps the repo as the report root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'genie-wish-target-'));
    try {
      mkdirSync(join(repo, '.genie', 'wishes'), { recursive: true });
      const target = resolveWishLintTarget(['--dir', repo], '/tmp');
      expect(target.wishesDir).toBe(join(repo, '.genie/wishes'));
      expect(target.reportRoot).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a root the operator typed is refused rather than silently scanned as empty', () => {
    const repo = mkdtempSync(join(tmpdir(), 'genie-wish-target-'));
    try {
      writeFileSync(join(repo, 'a-file.md'), 'not a directory\n');
      const cases: Array<[string[], string]> = [
        [['--dir', join(repo, 'nope')], '--dir is not a directory'],
        [['--dir', join(repo, 'a-file.md')], '--dir is not a directory'],
        // The repo exists but carries no wishes tree at all.
        [['--dir', repo], '--dir names no .genie/wishes'],
        [['--wishes-dir', join(repo, 'nope')], '--wishes-dir is not a directory'],
        [['--wishes-dir', join(repo, 'a-file.md')], '--wishes-dir is not a directory'],
        // An unset shell variable: `--dir "$REPO"` with REPO unset.
        [['--dir', ''], '--dir needs a path'],
        [['--dir'], '--dir needs a path'],
        [['--wishes-dir', '--dir'], '--wishes-dir needs a path'],
        [['--nope'], 'unknown argument "--nope"'],
        [['/some/positional'], 'unknown argument "/some/positional"'],
      ];
      for (const [argv, message] of cases) {
        expect(() => resolveWishLintTarget(argv, repo)).toThrow(message);
      }
      // Every refusal carries the usage line an operator needs next.
      expect(() => resolveWishLintTarget(['--nope'], repo)).toThrow(WISH_LINT_USAGE);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('--dir and --wishes-dir together name the same thing twice and are refused', () => {
    mkdirSync(join(wishesDir, 'nested'), { recursive: true });
    expect(() => resolveWishLintTarget(['--dir', wishesDir, '--wishes-dir', wishesDir], wishesDir)).toThrow(
      'name the same thing twice',
    );
  });

  test('the script surface turns a refusal into exit 2, having linted nothing', () => {
    const result = runLint(['--wishes-dir', join(wishesDir, 'not-here')]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--wishes-dir is not a directory');
    expect(result.stderr).toContain(WISH_LINT_USAGE);
    expect(result.stderr).not.toContain('files scanned');
  });

  test('a wishes root that exists but is empty is a clean 0, not a refusal', () => {
    const result = runLint();
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('wishes-lint: OK (0 files scanned');
  });
});
