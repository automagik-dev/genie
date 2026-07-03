import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'genie.ts');
const GITIGNORE_RULES = ['.genie/genie.db', '.genie/genie.db-wal', '.genie/genie.db-shm'];

let dir: string;

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Run `genie init` in `cwd`. Returns { code, stdout, stderr }. */
function runInit(cwd: string, args: string[] = []): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync(['bun', CLI, 'init', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr.toString(),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'genie-init-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('genie init', () => {
  test('fresh repo: scaffolds INDEX.md and appends all ignore rules', () => {
    initGitRepo(dir);
    const { code, stdout } = runInit(dir);

    expect(code).toBe(0);
    const indexPath = join(dir, '.genie', 'INDEX.md');
    expect(existsSync(indexPath)).toBe(true);
    const index = readFileSync(indexPath, 'utf-8');
    expect(index).toContain('# Plans Index');
    for (const section of ['## Raw', '## Simmering', '## Ready', '## Poured']) {
      expect(index).toContain(section);
    }

    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
    expect(stdout).toContain('/brainstorm');
    expect(stdout).toContain('genie board');
  });

  test('second run is a no-op: .gitignore and INDEX.md are byte-identical', () => {
    initGitRepo(dir);
    expect(runInit(dir).code).toBe(0);

    const indexPath = join(dir, '.genie', 'INDEX.md');
    const gitignorePath = join(dir, '.gitignore');
    const indexBefore = readFileSync(indexPath);
    const gitignoreBefore = readFileSync(gitignorePath);

    expect(runInit(dir).code).toBe(0);

    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    expect(readFileSync(gitignorePath).equals(gitignoreBefore)).toBe(true);
  });

  test('non-git directory: refuses with exit 1 and clear stderr', () => {
    const { code, stderr } = runInit(dir);
    expect(code).toBe(1);
    expect(stderr.toLowerCase()).toContain('git repository');
    expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(false);
    expect(existsSync(join(dir, '.gitignore'))).toBe(false);
  });

  test('partial state: INDEX exists, rules missing → only rules appended, INDEX untouched', () => {
    initGitRepo(dir);
    const indexPath = join(dir, '.genie', 'INDEX.md');
    mkdirSync(join(dir, '.genie'), { recursive: true });
    writeFileSync(indexPath, '# Plans Index\n\ncustom content\n');
    const indexBefore = readFileSync(indexPath);

    const { code } = runInit(dir);
    expect(code).toBe(0);

    // INDEX preserved (not overwritten with skeleton).
    expect(readFileSync(indexPath).equals(indexBefore)).toBe(true);
    const gitignore = readFileSync(join(dir, '.gitignore'), 'utf-8');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
  });

  test('partial state: rules exist, INDEX missing → only INDEX created, .gitignore untouched', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, `node_modules\n${GITIGNORE_RULES.join('\n')}\n`);
    const gitignoreBefore = readFileSync(gitignorePath);

    const { code } = runInit(dir);
    expect(code).toBe(0);

    expect(readFileSync(gitignorePath).equals(gitignoreBefore)).toBe(true);
    expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
  });

  test('existing .gitignore content is preserved and rules appended after it', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules\ndist\n');

    const { code } = runInit(dir);
    expect(code).toBe(0);

    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
    for (const rule of GITIGNORE_RULES) {
      expect(gitignore).toContain(rule);
    }
    // Rules appended after existing content.
    expect(gitignore.indexOf('node_modules')).toBeLessThan(gitignore.indexOf('.genie/genie.db'));
  });

  test('existing .gitignore without trailing newline still yields well-formed rules', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    writeFileSync(gitignorePath, 'dist'); // no trailing newline
    expect(runInit(dir).code).toBe(0);

    const gitignore = readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).toContain('dist\n.genie/genie.db\n');
    // Idempotent despite the awkward starting state.
    const after = readFileSync(gitignorePath);
    expect(runInit(dir).code).toBe(0);
    expect(readFileSync(gitignorePath).equals(after)).toBe(true);
  });

  test('--json emits per-artifact actions', () => {
    initGitRepo(dir);
    const { code, stdout } = runInit(dir, ['--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.index).toBe('created');
    expect(parsed.gitignore).toBe('created');
    expect(parsed.rulesAdded).toEqual(GITIGNORE_RULES);

    // Second run: everything skipped.
    const second = JSON.parse(runInit(dir, ['--json']).stdout);
    expect(second.index).toBe('skipped');
    expect(second.gitignore).toBe('skipped');
    expect(second.rulesAdded).toEqual([]);
  });
});
