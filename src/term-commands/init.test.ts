import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeCodexMcpFallback, removeCodexMcpFallback } from './init.js';

const CLI = join(import.meta.dir, '..', 'genie.ts');
const GITIGNORE_RULES = ['.genie/genie.db', '.genie/genie.db-wal', '.genie/genie.db-shm', '.genie/launch/'];

let dir: string;

function initGitRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
      const original = '{"mcpServers":{"other":{"command":"x"},"genie":{"command":"/personal","args":["mcp"]}}}';
      writeFileSync(mcpPath(dir), original);
      expect(runInit(dir).code).toBe(0);
      expect(readFileSync(mcpPath(dir), 'utf8')).toBe(original);
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

describe('Codex MCP fallback merge', () => {
  test('does not duplicate an existing unowned genie server', () => {
    const path = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    const original = '[mcp_servers.genie]\ncommand = "/existing/genie"\nargs = ["mcp"]\n';
    writeFileSync(path, original);
    expect(mergeCodexMcpFallback(path, { command: '/new/genie', args: ['mcp'] })).toBe('skipped');
    expect(readFileSync(path, 'utf8')).toBe(original);
  });

  test('removes only the marker-owned fallback', () => {
    const path = join(dir, '.codex', 'config.toml');
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(
      path,
      'model = "x"\n\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/g"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    expect(removeCodexMcpFallback(path)).toBe('updated');
    const updated = readFileSync(path, 'utf8');
    expect(updated).not.toContain('GENIE MCP FALLBACK');
    expect(updated).toContain('[mcp_servers.other]');
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
