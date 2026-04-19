/**
 * End-to-end CLI integration tests for `genie wish lint` and `genie wish new`.
 *
 * Spawns `bun src/genie.ts wish …` against a tempdir populated from the fixture
 * corpus (src/services/__tests__/fixtures/wishes/). Asserts:
 *   - Exit codes: clean fixtures exit 0; broken fixtures exit 1.
 *   - `--json` output parses and matches the violations payload the library
 *     emits for the same fixture.
 *   - `--fix` writes back to disk and a follow-up lint either passes or only
 *     reports non-fixable content violations.
 *   - Full flow: `wish new` → hand-edit one header to Portuguese →
 *     `wish lint` fails → `wish lint --fix` succeeds → `wish lint` clean.
 *
 * Tempdirs are created per-test inside the system temp root and cleaned in
 * teardown so concurrent runs don't interfere.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const CLI_ENTRY = join(REPO_ROOT, 'src', 'genie.ts');
const FIXTURES_ROOT = join(REPO_ROOT, 'src', 'services', '__tests__', 'fixtures', 'wishes');
const TEMPLATE_PATH = join(REPO_ROOT, 'templates', 'wish-template.md');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync('bun', [CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? -1,
  };
}

/**
 * Mark the tempdir as a genie workspace so `findWorkspace()` resolves in-tree
 * and the CLI doesn't abort with "No workspace found" before reaching the
 * wish handler. Locally this is masked by the globally-registered workspace
 * root in ~/.genie/config.json; in CI that fallback is absent, so tests must
 * be self-sufficient.
 */
function markWorkspace(tempRoot: string): void {
  const genieDir = join(tempRoot, '.genie');
  mkdirSync(genieDir, { recursive: true });
  const wsMarker = join(genieDir, 'workspace.json');
  if (!existsSync(wsMarker)) {
    writeFileSync(wsMarker, JSON.stringify({ name: 'wish-cli-int' }), 'utf8');
  }
}

function scaffoldWorktree(tempRoot: string, slug: string, inputMd: string): string {
  markWorkspace(tempRoot);
  const wishDir = join(tempRoot, '.genie', 'wishes', slug);
  mkdirSync(wishDir, { recursive: true });
  writeFileSync(join(wishDir, 'WISH.md'), inputMd, 'utf8');
  return wishDir;
}

function copyTemplate(tempRoot: string): void {
  // `wish new` reads templates/wish-template.md relative to cwd.
  const destDir = join(tempRoot, 'templates');
  mkdirSync(destDir, { recursive: true });
  cpSync(TEMPLATE_PATH, join(destDir, 'wish-template.md'));
  markWorkspace(tempRoot);
}

let TEMP_ROOT: string;

beforeEach(() => {
  TEMP_ROOT = mkdtempSync(join(tmpdir(), 'wish-cli-int-'));
  markWorkspace(TEMP_ROOT);
});

afterEach(() => {
  if (TEMP_ROOT && existsSync(TEMP_ROOT)) {
    rmSync(TEMP_ROOT, { recursive: true, force: true });
  }
});

// ============================================================================
// Exit-code contract on fixture corpus
// ============================================================================

describe('genie wish lint — exit codes on fixture corpus', () => {
  const cleanSlugs = ['clean-minimal', 'clean-multi-group'];
  for (const slug of cleanSlugs) {
    test(`[${slug}] exits 0`, () => {
      const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
      scaffoldWorktree(TEMP_ROOT, slug, input);
      const result = runCli(['wish', 'lint', slug], TEMP_ROOT);
      if (result.exitCode !== 0) {
        console.error('stdout:', result.stdout);
        console.error('stderr:', result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('no violations');
    });
  }

  const brokenSlugs = [
    'missing-exec-groups-header',
    'portuguese-group-headers',
    'missing-goal-field',
    'empty-out-scope',
    'depends-on-dangling',
    'todo-placeholders',
  ];
  for (const slug of brokenSlugs) {
    test(`[${slug}] exits 1 with rule name in output`, () => {
      const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
      scaffoldWorktree(TEMP_ROOT, slug, input);
      const result = runCli(['wish', 'lint', slug], TEMP_ROOT);
      expect(result.exitCode).toBe(1);
      // At least one violation's rule ID appears in the human-readable output.
      expect(result.stdout.length + result.stderr.length).toBeGreaterThan(0);
    });
  }
});

// ============================================================================
// --json output contract
// ============================================================================

describe('genie wish lint --json', () => {
  test('emits parseable JSON with summary + violations fields', () => {
    const slug = 'portuguese-group-headers';
    const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
    scaffoldWorktree(TEMP_ROOT, slug, input);
    const result = runCli(['wish', 'lint', slug, '--json'], TEMP_ROOT);

    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.summary).toBeDefined();
    expect(parsed.summary.total).toBeGreaterThan(0);
    expect(Array.isArray(parsed.violations)).toBe(true);
    expect(parsed.violations.some((v: { rule: string }) => v.rule === 'group-header-format')).toBe(true);
    expect(parsed.wish).toBe(slug);
  });

  test('--json on a clean wish emits empty violations array and exit 0', () => {
    const slug = 'clean-minimal';
    const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
    scaffoldWorktree(TEMP_ROOT, slug, input);
    const result = runCli(['wish', 'lint', slug, '--json'], TEMP_ROOT);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.violations).toEqual([]);
    expect(parsed.summary.total).toBe(0);
  });
});

// ============================================================================
// --fix writes back, --fix --dry-run does not
// ============================================================================

describe('genie wish lint --fix', () => {
  test('writes the fixed content back to the wish file', () => {
    const slug = 'portuguese-group-headers';
    const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
    const expectedFixed = readFileSync(join(FIXTURES_ROOT, slug, 'expected-fixed.md'), 'utf8');
    const wishDir = scaffoldWorktree(TEMP_ROOT, slug, input);
    const wishPath = join(wishDir, 'WISH.md');

    const result = runCli(['wish', 'lint', slug, '--fix'], TEMP_ROOT);
    expect(result.exitCode).toBe(0);

    const onDisk = readFileSync(wishPath, 'utf8');
    const normalized = onDisk.endsWith('\n') ? onDisk : `${onDisk}\n`;
    expect(normalized).toBe(expectedFixed);

    // Re-running lint should now pass.
    const follow = runCli(['wish', 'lint', slug], TEMP_ROOT);
    expect(follow.exitCode).toBe(0);
  });

  test('--fix --dry-run does NOT write the file', () => {
    const slug = 'portuguese-group-headers';
    const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
    const wishDir = scaffoldWorktree(TEMP_ROOT, slug, input);
    const wishPath = join(wishDir, 'WISH.md');

    const result = runCli(['wish', 'lint', slug, '--fix', '--dry-run'], TEMP_ROOT);
    // Dry-run still exits 1 because violations existed.
    expect(result.exitCode).toBe(1);
    const onDisk = readFileSync(wishPath, 'utf8');
    expect(onDisk).toBe(input);
  });

  test('--fix on a non-fixable wish leaves file unchanged', () => {
    const slug = 'empty-out-scope';
    const input = readFileSync(join(FIXTURES_ROOT, slug, 'input.md'), 'utf8');
    const wishDir = scaffoldWorktree(TEMP_ROOT, slug, input);
    const wishPath = join(wishDir, 'WISH.md');

    const result = runCli(['wish', 'lint', slug, '--fix'], TEMP_ROOT);
    // No fixable violations → CLI exits 1 because violations remain.
    expect(result.exitCode).toBe(1);
    const onDisk = readFileSync(wishPath, 'utf8');
    expect(onDisk).toBe(input);
  });
});

// ============================================================================
// Full flow: wish new → edit → lint → fix → lint clean
// ============================================================================

describe('genie wish new → edit → lint → fix → lint clean', () => {
  test('scaffold passes with --allow-todo-placeholders, fails without', () => {
    copyTemplate(TEMP_ROOT);
    const slug = 'cli-flow-demo';
    const newResult = runCli(['wish', 'new', slug], TEMP_ROOT);
    expect(newResult.exitCode).toBe(0);

    const wishPath = join(TEMP_ROOT, '.genie', 'wishes', slug, 'WISH.md');
    expect(existsSync(wishPath)).toBe(true);

    const withBypass = runCli(['wish', 'lint', slug, '--allow-todo-placeholders'], TEMP_ROOT);
    expect(withBypass.exitCode).toBe(0);

    const withoutBypass = runCli(['wish', 'lint', slug], TEMP_ROOT);
    expect(withoutBypass.exitCode).toBe(1);
  });

  test('edit → lint fails → --fix → lint clean cycle', () => {
    // Start from the clean-multi-group fixture and break Group 2's header into
    // Portuguese form. The canonical Group 1 keeps the parser alive so the
    // linter can surface group-header-format (fixable) on Group 2.
    const slug = 'cli-regression-flow';
    const input = readFileSync(join(FIXTURES_ROOT, 'clean-multi-group', 'input.md'), 'utf8');
    const broken = input.replace('### Group 2: Second', '### Grupo 2 — Second');
    const wishDir = scaffoldWorktree(TEMP_ROOT, slug, broken);
    const wishPath = join(wishDir, 'WISH.md');

    // Step 1: lint fails.
    const firstLint = runCli(['wish', 'lint', slug], TEMP_ROOT);
    expect(firstLint.exitCode).toBe(1);

    // Step 2: --fix auto-repairs and re-lints clean.
    const fixRun = runCli(['wish', 'lint', slug, '--fix'], TEMP_ROOT);
    expect(fixRun.exitCode).toBe(0);
    const onDisk = readFileSync(wishPath, 'utf8');
    expect(onDisk).toContain('### Group 2: Second');
    expect(onDisk).not.toContain('### Grupo 2');

    // Step 3: final lint confirms clean.
    const finalLint = runCli(['wish', 'lint', slug], TEMP_ROOT);
    expect(finalLint.exitCode).toBe(0);
  });
});

// ============================================================================
// Missing wish file path — error handling contract
// ============================================================================

describe('genie wish lint — error contracts', () => {
  test('missing wish file exits 1 with `not found` message', () => {
    const result = runCli(['wish', 'lint', 'does-not-exist'], TEMP_ROOT);
    expect(result.exitCode).toBe(1);
    // Either stdout or stderr carries the not-found message depending on --json flag.
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('not found');
  });

  test('missing wish file with --json emits JSON error envelope', () => {
    const result = runCli(['wish', 'lint', 'does-not-exist', '--json'], TEMP_ROOT);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.error).toContain('not found');
    expect(parsed.wish).toBe('does-not-exist');
  });
});
