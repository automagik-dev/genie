/**
 * `genie wish lint` as a user invokes it from a repository that is not genie.
 *
 * Every case spawns the CLI rather than calling the handler: the exit code, the
 * stream the findings land on, and the fact that the v4 workspace gate never
 * fires are the whole contract here. The last describe runs the BUILT bundle,
 * because the defect this verb exists to avoid — a wishes root resolved from
 * `import.meta.url`, which lands under `/$bunfs` in a compiled binary — cannot
 * be reproduced from source at all.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const ENTRY = join(ROOT, 'src', 'genie.ts');
const scratch: string[] = [];

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function wishDoc(status: string): string {
  return `# Wish: Fixture

| Field | Value |
|-------|-------|
| **Status** | ${status} |
| **Date** | 2026-07-08 |

## Dependencies

**depends-on:** none
**blocks:** none

## Execution Strategy

No table required.
`;
}

/**
 * A git repository that is NOT genie: no `.genie/workspace.json`, no genie
 * install record, nothing but the wishes a team would actually carry.
 */
function foreignRepo(wishes: Record<string, string>): string {
  const repo = tmp('genie-wish-lint-repo-');
  Bun.spawnSync(['git', '-C', repo, 'init', '-q', '-b', 'main']);
  for (const [slug, contents] of Object.entries(wishes)) {
    const dir = join(repo, '.genie', 'wishes', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'WISH.md'), contents);
  }
  return repo;
}

/** Every file under `dir` with its sha256 — the proof a lint wrote nothing. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

function runCli(argv: string[], options: { cwd?: string } = {}) {
  const proc = Bun.spawnSync([process.execPath, ENTRY, ...argv], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env },
  });
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe('genie wish lint', () => {
  test('--help names the flag and says which rules stay repository-gate concerns', () => {
    const { code, stdout } = runCli(['wish', 'lint', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('--dir <repo>');
    expect(stdout).toContain('design-review evidence');
    expect(stdout).toContain('cross-wish graph');
    expect(stdout).toContain('REPOSITORY-GATE');
    expect(stdout).toContain('writes nothing');
  });

  test('a foreign repository carrying one valid and one malformed wish exits 1 and names the malformed file', () => {
    const repo = foreignRepo({
      good: wishDoc('DRAFT'),
      broken: wishDoc('SUPERSEDED IN PART'),
    });
    const { code, stderr } = runCli(['wish', 'lint', '--dir', repo]);
    expect(code).toBe(1);
    expect(stderr).toContain('.genie/wishes/broken/WISH.md');
    expect(stderr).toContain('unsupported wish status "SUPERSEDED IN PART"');
    // The valid sibling is scanned and reported on by silence, never named.
    expect(stderr).not.toContain('.genie/wishes/good/WISH.md');
  });

  test('a foreign repository whose wishes are all valid exits 0 and writes nothing', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), other: wishDoc('SHIPPED') });
    const before = treeDigest(repo);
    const { code, stderr, stdout } = runCli(['wish', 'lint', '--dir', repo]);
    expect(code).toBe(0);
    expect(stderr).toContain('wishes-lint: OK (2 files scanned');
    expect(stdout).toBe('');
    expect(treeDigest(repo)).toEqual(before);
  });

  /**
   * The gate this verb would otherwise trip. `installWorkspaceCheck` refuses with
   * exit 2 and "No workspace found" on any non-TTY stdout — which a spawned
   * process always is — so this case fails the moment `'wish'` leaves
   * `WORKSPACE_EXEMPT`. `src/lib/interactivity.test.ts` pins the set directly;
   * this pins what the operator would actually see.
   */
  test('a directory that is not a genie workspace neither prompts for init nor exits 2', () => {
    const repo = foreignRepo({ broken: wishDoc('SUPERSEDED IN PART') });
    expect(existsSync(join(repo, '.genie', 'workspace.json'))).toBe(false);
    const { code, stderr } = runCli(['wish', 'lint'], { cwd: repo });
    expect(code).toBe(1);
    expect(stderr).not.toContain('No workspace found');
    expect(stderr).toContain('unsupported wish status');
  });

  /**
   * `--dir` is a DECLARED Commander option here, so an unknown flag is Commander's
   * own error through genie's global handler — exit 1, the same path
   * `genie mikro call` with no agent takes. The runtime's `--wishes-dir` usage
   * refusal (exit 2) belongs to `bun scripts/wishes-lint.ts`, which is the surface
   * that still parses argv itself.
   */
  test('a bad flag is refused by the parser and lints nothing', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT') });
    const { code, stderr } = runCli(['wish', 'lint', '--nope'], { cwd: repo });
    expect(code).toBe(1);
    expect(stderr).toContain("unknown option '--nope'");
    expect(stderr).not.toContain('wishes-lint: OK');
  });
});

describe('the built bundle', () => {
  /** `dist/genie.js` when the build already ran, else a throwaway build of the same entry point. */
  function bundle(): string {
    const built = join(ROOT, 'dist', 'genie.js');
    if (existsSync(built)) return built;
    const out = join(tmp('genie-wish-bundle-'), 'genie.js');
    const build = Bun.spawnSync(
      [process.execPath, 'build', ENTRY, '--target', 'bun', '--external', 'bun', '--outfile', out],
      { cwd: ROOT },
    );
    if (build.exitCode !== 0) throw new Error(`bundling failed: ${build.stderr.toString()}`);
    return out;
  }

  function runBundle(argv: string[], cwd: string) {
    const proc = Bun.spawnSync([process.execPath, bundle(), ...argv], { cwd, env: { ...process.env } });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test('--dir names the wishes root, from a cwd that has none of its own', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), broken: wishDoc('SUPERSEDED IN PART') });
    const elsewhere = tmp('genie-wish-cwd-');
    const { code, stderr } = runBundle(['wish', 'lint', '--dir', repo], elsewhere);
    expect(code).toBe(1);
    expect(stderr).toContain('.genie/wishes/broken/WISH.md');
  });

  /**
   * The `import.meta.url` proof. In the bundle that URL resolves under `/$bunfs`,
   * so a root derived from it would scan nothing — and a root derived from the
   * genie checkout would report genie's own ~90 wishes no matter where the binary
   * was run. Exactly two files scanned, in the cwd's OWN git toplevel, is neither.
   */
  test('with no flag the root is the git toplevel of the cwd, never the genie checkout', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT'), other: wishDoc('SHIPPED') });
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const fromSubdir = runBundle(['wish', 'lint'], join(repo, 'src', 'deep'));
    expect(fromSubdir.code).toBe(0);
    expect(fromSubdir.stderr).toContain('wishes-lint: OK (2 files scanned');
  });

  test('no imported module runs its own entry block', () => {
    const repo = foreignRepo({ good: wishDoc('DRAFT') });
    const version = runBundle(['--version'], ROOT);
    expect(version.code).toBe(0);
    expect(version.stderr).toBe('');

    const lint = runBundle(['wish', 'lint', '--dir', repo], ROOT);
    expect(lint.code).toBe(0);
    // `scripts/wishes-lint.ts` carries its own entry block; inside the bundle it
    // is an imported module, so its usage banner must never appear on a run that
    // succeeded.
    expect(lint.stderr).not.toContain('usage: wishes-lint');
  });
});
