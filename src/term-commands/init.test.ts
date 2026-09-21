import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'genie.ts');
/**
 * Spelled out on purpose — the pin, not a re-derivation of the source list.
 * `.genie/roadmap-sync` and `.genie/genie.db-recovery-lock` are here because a
 * committed sync baseline silently overwrites a shared board (see the
 * fresh-clone test below), so dropping either rule must fail this file.
 */
const GITIGNORE_RULES = [
  '.genie/genie.db',
  '.genie/genie.db-wal',
  '.genie/genie.db-shm',
  '.genie/genie.db-recovery-lock',
  '.genie/roadmap-sync',
  '.genie/launch/',
  '.mcp.json.genie-backup-*',
  '.codex/config.toml.genie-backup-*',
];

let dir: string;

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...GIT_IDENTITY } });
}

/** Run any genie verb with an isolated GENIE_HOME (global state never leaks between repos). */
function genie(cwd: string, home: string, ...args: string[]): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...GIT_IDENTITY, GENIE_HOME: home, NO_COLOR: '1', GENIE_TEST_SKIP_PGSERVE: '1' },
  });
  return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
}

/** Run `genie init` in `cwd`. Returns { code, stdout, stderr }. */
function runInit(cwd: string, args: string[] = []): { code: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync([process.execPath, CLI, 'init', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // Keep unit tests isolated from any live Codex/plugin installation.
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  });
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
    const { code, stdout, stderr } = runInit(dir);

    // The child's stderr is the diagnosis; without it a CI-only failure of
    // this exit code is unreproducible (#3026).
    expect(code, `genie init failed\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`).toBe(0);
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
    expect(stdout).toContain('brainstorm');
    expect(stdout).toContain('$genie:brainstorm');
    expect(stdout).toContain('$genie:review');
    expect(stdout.indexOf('$genie:review')).toBeLessThan(stdout.indexOf('$genie:work'));
    expect(stdout).toContain('genie board');
  });

  test('legacy launch kickoff prompts under .genie/launch/ stay ignored (residue protection)', () => {
    initGitRepo(dir);
    expect(runInit(dir).code).toBe(0);

    mkdirSync(join(dir, '.genie', 'launch'), { recursive: true });
    writeFileSync(join(dir, '.genie', 'launch', 'group.prompt'), 'kickoff\n');

    expect(
      execFileSync('git', ['check-ignore', '.genie/launch/group.prompt'], { cwd: dir, encoding: 'utf-8' }).trim(),
    ).toBe('.genie/launch/group.prompt');
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' })).not.toContain(
      '.genie/launch',
    );
  });

  test('--help discloses every project MCP file class init may reconcile', () => {
    const { code, stdout } = runInit(dir, ['--help']);
    expect(code).toBe(0);
    for (const path of ['.mcp.json', '.codex/config.toml']) expect(stdout).toContain(path);
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

  /**
   * A `.gitignore` rule is only ever APPENDED, so every repo scaffolded before
   * a rule existed must pick it up on its next `genie init` — and only it.
   */
  test('an existing repo gains only the newly added rules, idempotently', () => {
    initGitRepo(dir);
    const gitignorePath = join(dir, '.gitignore');
    // Exactly what a pre-roadmap-sync build wrote.
    writeFileSync(
      gitignorePath,
      'node_modules\n.genie/genie.db\n.genie/genie.db-wal\n.genie/genie.db-shm\n.genie/launch/\n.mcp.json.genie-backup-*\n',
    );

    const first = JSON.parse(runInit(dir, ['--json']).stdout);
    expect(first.gitignore).toBe('updated');
    expect(first.rulesAdded).toEqual([
      '.genie/genie.db-recovery-lock',
      '.genie/roadmap-sync',
      '.codex/config.toml.genie-backup-*',
    ]);
    expect(readFileSync(gitignorePath, 'utf-8')).toContain('node_modules');

    const after = readFileSync(gitignorePath);
    const second = JSON.parse(runInit(dir, ['--json']).stdout);
    expect(second.gitignore).toBe('skipped');
    expect(second.rulesAdded).toEqual([]);
    expect(readFileSync(gitignorePath).equals(after)).toBe(true);

    // git, not just the file text, agrees the sync baseline is ignored now.
    mkdirSync(join(dir, '.genie'), { recursive: true });
    writeFileSync(join(dir, '.genie', 'roadmap-sync'), '{}\n');
    expect(execFileSync('git', ['check-ignore', '.genie/roadmap-sync'], { cwd: dir, encoding: 'utf-8' }).trim()).toBe(
      '.genie/roadmap-sync',
    );
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

  /**
   * The end-to-end defect the `.genie/roadmap-sync` rule exists to prevent.
   *
   * The baseline records THIS machine's (roadmap.json, genie.db) hash pair. Once
   * committed it travels to a fresh clone, where its file hash still matches the
   * committed snapshot but its db hash cannot match that clone's freshly created
   * EMPTY database — so the clone's first `task sync` reads "the db moved, the
   * file did not", exports, and publishes an empty board over the shared one.
   * Ignoring the baseline turns the same flow back into an import.
   */
  test('fresh clone: `git add -A .genie` never commits the sync baseline, so the first sync imports', () => {
    const origin = join(dir, 'origin');
    const clone = join(dir, 'clone');
    mkdirSync(origin, { recursive: true });
    initGitRepo(origin);
    expect(runInit(origin).code).toBe(0);

    const publisher = join(dir, 'home-publisher');
    expect(genie(origin, publisher, 'board', 'create', 'roadmap', '--lanes', 'Idea,Work,Done').code).toBe(0);
    expect(genie(origin, publisher, 'task', 'create', '--title', 'shared card', '--board', 'roadmap').code).toBe(0);
    expect(genie(origin, publisher, 'task', 'export', '--write').code).toBe(0);

    // The operator stages the whole directory — the only thing standing between
    // that and a committed baseline is the ignore rule.
    git(origin, 'add', '-A', '.genie', '.gitignore');
    git(origin, 'commit', '-q', '-m', 'publish the board');
    const tracked = execFileSync('git', ['ls-files'], { cwd: origin, encoding: 'utf-8' });
    expect(tracked).toContain('.genie/roadmap.json');
    expect(tracked).not.toContain('.genie/roadmap-sync');

    execFileSync('git', ['clone', '-q', origin, clone], { stdio: ['pipe', 'pipe', 'pipe'] });
    const cloner = join(dir, 'home-cloner');
    const sync = genie(clone, cloner, 'task', 'sync');
    expect(sync.code).toBe(0);
    expect(`${sync.stdout}${sync.stderr}`).toContain('Board refreshed from');
    expect(genie(clone, cloner, 'task', 'list').stdout).toContain('shared card');
    // The shared snapshot survived the clone's first sync byte-for-byte.
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: clone, encoding: 'utf-8' })).toBe('');
  }, 60_000);

  describe('MCP retirement', () => {
    const mcpPath = (root: string) => join(root, '.mcp.json');

    test('fresh repo creates no MCP registration', () => {
      initGitRepo(dir);
      expect(runInit(dir).code).toBe(0);
      expect(existsSync(mcpPath(dir))).toBe(false);
      expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(false);
    });

    test('preserves unrelated and unowned same-name registrations byte-for-byte', () => {
      initGitRepo(dir);
      // `/personal` is a user wrapper, not the Genie binary: the `genie` KEY is
      // not proof of ownership, so this entry is never eligible for retirement.
      const original = '{"mcpServers":{"other":{"command":"x"},"genie":{"command":"/personal","args":["mcp"]}}}';
      writeFileSync(mcpPath(dir), original);
      expect(runInit(dir).code).toBe(0);
      expect(readFileSync(mcpPath(dir), 'utf8')).toBe(original);
    });

    test('retires the dead `genie mcp` entry and preserves every other server byte-for-byte', () => {
      initGitRepo(dir);
      writeFileSync(
        mcpPath(dir),
        [
          '{',
          '  "mcpServers": {',
          '    "genie": { "command": "/home/u/.genie/bin/genie", "args": ["mcp"] },',
          '    "other": { "command": "node",  "args": ["srv.js"] }',
          '  }',
          '}',
          '',
        ].join('\n'),
      );

      const { code, stdout } = runInit(dir);
      expect(code).toBe(0);
      expect(readFileSync(mcpPath(dir), 'utf8')).toBe(
        ['{', '  "mcpServers": {', '    "other": { "command": "node",  "args": ["srv.js"] }', '  }', '}', ''].join(
          '\n',
        ),
      );
      // Backup-first: the pre-retirement bytes survive next to the file.
      const backups = readdirSync(dir).filter((n) => n.startsWith('.mcp.json.genie-backup-'));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0]), 'utf8')).toContain('"genie"');
      expect(stdout).toContain('retired the dead `genie mcp` registration');

      // Idempotent: a second run finds nothing and writes no second backup.
      expect(runInit(dir).code).toBe(0);
      expect(readdirSync(dir).filter((n) => n.startsWith('.mcp.json.genie-backup-'))).toHaveLength(1);
    });

    test('--json only claims retirement when it actually happened', () => {
      initGitRepo(dir);
      const fresh = JSON.parse(runInit(dir, ['--json']).stdout).mcp;
      expect(fresh[0]).toMatchObject({ action: 'skipped' });
      expect(fresh[1]).toMatchObject({ action: 'skipped', detail: 'no marker-owned project registration to retire' });

      writeFileSync(mcpPath(dir), '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]},"k":{"command":"k"}}}');
      const retired = JSON.parse(runInit(dir, ['--json']).stdout).mcp;
      expect(retired[0]).toMatchObject({ action: 'updated' });
      expect(retired[0].detail).toContain('retired the dead `genie mcp` registration');
    });

    test('a symlinked .mcp.json never aborts init: it is skipped with a warning and .genie/ is still scaffolded', () => {
      initGitRepo(dir);
      const real = join(dir, 'real-mcp.json');
      writeFileSync(real, '{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]}}}');
      symlinkSync('real-mcp.json', mcpPath(dir));

      const { code, stdout } = runInit(dir);
      expect(code).toBe(0);
      expect(stdout).toContain('symlink');
      // The link and its target are both untouched — Genie never follows it.
      expect(readFileSync(real, 'utf8')).toBe('{"mcpServers":{"genie":{"command":"/x/genie","args":["mcp"]}}}');
      expect(readdirSync(dir).filter((n) => n.includes('.genie-backup-'))).toHaveLength(0);
      expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
      expect(existsSync(join(dir, '.gitignore'))).toBe(true);
    });

    test('--json reports both registration classes skipped on a fresh repo', () => {
      initGitRepo(dir);
      const first = JSON.parse(runInit(dir, ['--json']).stdout);
      const actions = first.mcp.map((c: { path: string; action: string }) => c.action);
      expect(actions).toEqual(['skipped', 'skipped']);
    });

    test('malformed .mcp.json is ignored and preserved byte-for-byte', () => {
      initGitRepo(dir);
      writeFileSync(mcpPath(dir), 'not json {');
      const { code } = runInit(dir);
      expect(code).toBe(0);
      expect(readFileSync(mcpPath(dir), 'utf-8')).toBe('not json {');
      expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
    });

    test('valid but wrong-shaped server maps are preserved because .mcp.json is unmarked', () => {
      initGitRepo(dir);
      writeFileSync(mcpPath(dir), '{"mcpServers":[]}');
      const { code } = runInit(dir);
      expect(code).toBe(0);
      expect(readFileSync(mcpPath(dir), 'utf8')).toBe('{"mcpServers":[]}');
      expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(false);
      expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
    });
  });
});

// ============================================================================
// Marker-owned Codex route — plugin- and delivery-independent (Group A)
// ============================================================================

/** Run `genie init` with an isolated GENIE_HOME and no Codex CLI on PATH. */
function runInitWithHome(cwd: string, genieHome: string): { code: number; stderr: string } {
  const res = Bun.spawnSync([process.execPath, CLI, 'init'], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    // No Codex CLI on PATH: init must STILL write the marker (plugin-independent).
    env: { ...process.env, PATH: '/usr/bin:/bin', GENIE_HOME: genieHome },
  });
  return { code: res.exitCode, stderr: res.stderr.toString() };
}

describe('init marker-owned Codex retirement', () => {
  test('removes an owned marker and preserves unrelated TOML', () => {
    initGitRepo(dir);
    const codexPath = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      codexPath,
      '# BEGIN GENIE MCP FALLBACK\nmcp_servers.genie.command = "/g"\nmcp_servers.genie.args = ["mcp"]\n# END GENIE MCP FALLBACK\n\nmodel = "x"\n',
    );
    expect(runInitWithHome(dir, join(dir, 'home')).code).toBe(0);
    expect(readFileSync(codexPath, 'utf8')).toBe('model = "x"\n');
  });

  test('an unowned same-key Codex route is preserved byte-for-byte and reported, never overwritten', () => {
    initGitRepo(dir);
    const codexPath = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const personal = '[mcp_servers.genie]\ncommand = "/my/own/genie"\nargs = ["mcp"]\n';
    writeFileSync(codexPath, personal);
    const { code } = runInitWithHome(dir, join(dir, 'home-a'));
    expect(code).toBe(0);
    expect(readFileSync(codexPath, 'utf8')).toBe(personal);
    expect(existsSync(join(dir, '.genie', 'INDEX.md'))).toBe(true);
  });

  /**
   * A marker-only `.codex/config.toml` is removed backup-first, and the backup it leaves beside it
   * is an operational artifact of genie's, not project content. Without the ignore rule (which the
   * contract docs already promised) `genie init` dirtied an otherwise clean worktree with an
   * untracked `config.toml.genie-backup-<stamp>` — the same class of trash the removal exists to
   * clear, moved one filename over.
   */
  test('the backup a removal leaves behind is ignored, so init leaves the worktree clean', () => {
    initGitRepo(dir);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'root'], {
      cwd: dir,
      env: { ...process.env, ...GIT_IDENTITY },
    });
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      join(dir, '.codex', 'config.toml'),
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/g"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n',
    );

    expect(runInitWithHome(dir, join(dir, 'home')).code).toBe(0);
    expect(existsSync(join(dir, '.codex', 'config.toml'))).toBe(false);
    const backups = readdirSync(join(dir, '.codex')).filter((name) => name.startsWith('config.toml.genie-backup-'));
    expect(backups).toHaveLength(1);

    const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: dir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));
    expect(untracked).not.toContain(join('.codex', backups[0] as string));
  });

  test('init.ts never mints an assertion/permit and never touches the lifecycle lease or delivery', () => {
    const source = readFileSync(join(import.meta.dir, 'init.ts'), 'utf8');
    for (const forbidden of [
      'acquireLifecycleLease',
      'requestRetirementAssertion',
      'authorizeCodexActivation',
      'executeCodexActivation',
      'observeCodexActivation',
      'beginActivation',
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });
});
