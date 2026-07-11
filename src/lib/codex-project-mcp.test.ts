import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type CodexPluginProbe,
  genieMcpEntry,
  inspectCodexPluginMcpUsability,
  inspectCodexProjectMcp,
  preflightCodexPluginMutation,
  probeCodexGeniePlugin,
  reconcileCodexProjectMcp,
  registerProjectMcpConfigs,
  resolveGitProjectRoots,
  resolveGitWorktreeRoot,
} from './codex-project-mcp.js';

let root: string;

const enabled: CodexPluginProbe = {
  cliAvailable: true,
  status: 'ok',
  installed: true,
  enabled: true,
  usable: true,
  detail: 'enabled',
};
const disabled: CodexPluginProbe = {
  cliAvailable: true,
  status: 'ok',
  installed: true,
  enabled: false,
  usable: false,
  detail: 'disabled',
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-project-mcp-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function seedActivePlugin(version = '1.2.3'): {
  codexHome: string;
  pluginRoot: string;
  genieHome: string;
  nodePath: string;
  version: string;
} {
  const codexHome = join(root, 'codex-home');
  const pluginRoot = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', version);
  mkdirSync(dirname(pluginRoot), { recursive: true });
  cpSync(join(import.meta.dir, '..', '..', 'plugins', 'genie'), pluginRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const genieHome = join(root, 'genie-home');
  const binary = join(genieHome, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
  const nodePath = join(root, 'controlled-bin', 'node');
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(nodePath), { recursive: true });
  writeFileSync(binary, 'fixture binary');
  writeFileSync(nodePath, 'fixture node');
  chmodSync(binary, 0o755);
  chmodSync(nodePath, 0o755);
  return { codexHome, pluginRoot, genieHome, nodePath, version };
}

describe('project MCP executable entry', () => {
  test('records absolute executable plus script args for interpreted source and dist runs', () => {
    const repoRoot = join(import.meta.dir, '..', '..');
    const sourceEntry = join(repoRoot, 'src', 'genie.ts');
    const distRoot = join(root, 'dist');
    const build = Bun.spawnSync([process.execPath, 'build', sourceEntry, '--outdir', distRoot, '--target', 'bun'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(build.exitCode).toBe(0);

    for (const script of [sourceEntry, join(distRoot, 'genie.js')]) {
      const entry = genieMcpEntry(undefined, [process.execPath, script]);
      expect(entry.command).toBe(realpathSync(process.execPath));
      expect(entry.args).toEqual([realpathSync(script), 'mcp']);
      const invocation = Bun.spawnSync([entry.command, ...entry.args, '--help'], {
        cwd: root,
        env: { ...process.env, HOME: root, GENIE_HOME: join(root, '.genie') },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(invocation.exitCode).toBe(0);
      expect(invocation.stdout.toString()).toContain('Usage: genie mcp');
    }

    expect(genieMcpEntry('/absolute/compiled-genie')).toEqual({
      command: '/absolute/compiled-genie',
      args: ['mcp'],
    });
  });
});

describe('resolveGitWorktreeRoot', () => {
  test('resolves root, nested directory, and linked worktree to their own working-tree roots', () => {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'src', 'nested'), { recursive: true });
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    git(repo, ['commit', '--allow-empty', '-q', '-m', 'root']);
    const linked = join(root, 'linked');
    git(repo, ['worktree', 'add', '-q', '-b', 'linked-fixture', linked]);

    expect(resolveGitWorktreeRoot(repo)).toBe(repo);
    expect(resolveGitWorktreeRoot(join(repo, 'src', 'nested'))).toBe(repo);
    expect(resolveGitWorktreeRoot(linked)).toBe(linked);
    expect(resolveGitProjectRoots(linked)).toEqual({ worktreeRoot: linked, commonRoot: repo });
  });

  test('nested init binds the resolved host git and rejects a repo-root PATH decoy', () => {
    const repo = join(root, 'nested-init');
    const nested = join(repo, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    git(repo, ['init', '-q']);

    const trustedGit = Bun.which('git');
    if (!trustedGit) throw new Error('git is required');
    let invoked = '';
    const fakeExec = ((command: string) => {
      invoked = command;
      return `${repo}\n${join(repo, '.git')}\n`;
    }) as typeof execFileSync;
    expect(resolveGitProjectRoots(nested, fakeExec, 1_000, () => trustedGit)).toEqual({
      worktreeRoot: repo,
      commonRoot: repo,
    });
    expect(invoked).toBe(realpathSync(trustedGit));

    const decoy = join(repo, 'bin', process.platform === 'win32' ? 'git.exe' : 'git');
    mkdirSync(dirname(decoy), { recursive: true });
    writeFileSync(decoy, 'repo-controlled decoy');
    chmodSync(decoy, 0o755);
    invoked = '';
    expect(resolveGitProjectRoots(nested, fakeExec, 1_000, () => decoy)).toBeNull();
    expect(invoked).toBe('');
  });
});

describe('probeCodexGeniePlugin', () => {
  test('nested init rejects a Codex executable selected from the enclosing repository root', () => {
    const repo = join(root, 'codex-decoy-repo');
    const nested = join(repo, 'packages', 'app');
    const decoy = join(repo, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    mkdirSync(dirname(decoy), { recursive: true });
    writeFileSync(decoy, 'repo-controlled decoy');
    chmodSync(decoy, 0o755);
    let calls = 0;
    const probe = probeCodexGeniePlugin({
      cwd: nested,
      which: () => decoy,
      run: () => {
        calls += 1;
        return { exitCode: 0, stdout: '{"installed":[]}', stderr: '' };
      },
    });
    expect(calls).toBe(0);
    expect(probe.status).toBe('error');
    expect(probe.detail).toContain('repository-local');
  });

  test('queries once with a deadline and reports a timeout actionably', () => {
    let calls = 0;
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      timeoutMs: 17,
      run: (_command, _args, timeoutMs) => {
        calls += 1;
        expect(timeoutMs).toBe(17);
        return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      },
    });
    expect(calls).toBe(1);
    expect(probe).toMatchObject({ status: 'error', timedOut: true });
    expect(probe.detail).toContain('17ms');
    expect(probe.detail).toContain('retaining the project fallback');
  });

  test('wrong-shaped valid JSON becomes a structured error, not a throw', () => {
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      run: () => ({ exitCode: 0, stdout: '{"installed":{}}', stderr: '' }),
    });
    expect(probe.status).toBe('error');
    expect(probe.detail).toContain('invalid Codex plugin response');
  });

  test('duplicate Genie plugin snapshots fail closed and retain the fallback', () => {
    let command = '';
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      run: (resolved) => {
        command = resolved;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              { pluginId: 'genie@automagik', enabled: true, version: '1' },
              { pluginId: 'genie@automagik', enabled: false, version: '1' },
            ],
          }),
          stderr: '',
        };
      },
    });
    expect(command).toBe(realpathSync(process.execPath));
    expect(probe).toMatchObject({ status: 'error', installed: false });
    expect(probe.detail).toContain('expected exactly one');
    expect(reconcileCodexProjectMcp(root, probe, { command: '/absolute/genie', args: ['mcp'] }).route).toBe('fallback');
  });

  test('enabled metadata is usable only when the launcher and canonical binary inspection passes', () => {
    const fixture = seedActivePlugin('1');
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      codexHome: fixture.codexHome,
      run: () => ({
        exitCode: 0,
        stdout:
          '{"installed":[{"pluginId":"genie@automagik","name":"genie","marketplaceName":"automagik","enabled":true,"version":"1"}]}',
        stderr: '',
      }),
      inspectUsability: (options) => {
        expect(options.pluginRoot).toBe(fixture.pluginRoot);
        return { usable: true, detail: 'fixture launcher usable', pluginRoot: options.pluginRoot ?? undefined };
      },
    });
    expect(probe).toMatchObject({
      status: 'ok',
      installed: true,
      enabled: true,
      usable: true,
      activePluginRoot: fixture.pluginRoot,
    });
    expect(probe.detail).toContain('fixture launcher usable');
  });

  test('missing active cache is unproven even when an enabled source plugin is healthy', () => {
    const sourceRoot = join(root, 'source');
    mkdirSync(join(sourceRoot, 'plugins'), { recursive: true });
    cpSync(join(import.meta.dir, '..', '..', 'plugins', 'genie'), join(sourceRoot, 'plugins', 'genie'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    expect(existsSync(join(sourceRoot, 'plugins', 'genie', 'scripts', 'mcp-launcher.cjs'))).toBe(true);
    let inspected = false;
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      codexHome: join(root, 'codex-home'),
      run: () => ({
        exitCode: 0,
        stdout: '{"installed":[{"pluginId":"genie@automagik","enabled":true,"version":"9.9.9"}]}',
        stderr: '',
      }),
      inspectUsability: () => {
        inspected = true;
        return { usable: true, detail: 'must not inspect source' };
      },
    });
    expect(inspected).toBe(false);
    expect(probe).toMatchObject({ status: 'ok', installed: true, enabled: true, usable: false });
    expect(probe.activePluginRoot).toBeUndefined();
    expect(probe.usabilityDetail).toContain('active plugin root is unavailable or incomplete');
  });

  test('unsafe snapshot version and escaped installedPath both fail closed before inspection', () => {
    const fixture = seedActivePlugin('1.2.3');
    mkdirSync(join(root, 'source', 'plugins', 'genie'), { recursive: true });
    for (const entry of [
      { pluginId: 'genie@automagik', enabled: true, version: '../../source' },
      {
        pluginId: 'genie@automagik',
        enabled: true,
        version: '1.2.3',
        installedPath: `${root}/source/../source/plugins/genie`,
      },
    ]) {
      let inspected = false;
      const probe = probeCodexGeniePlugin({
        which: () => process.execPath,
        codexHome: fixture.codexHome,
        run: () => ({ exitCode: 0, stdout: JSON.stringify({ installed: [entry] }), stderr: '' }),
        inspectUsability: () => {
          inspected = true;
          return { usable: true, detail: 'unexpected' };
        },
      });
      expect(inspected).toBe(false);
      expect(probe.usable).toBe(false);
      expect(probe.activePluginRoot).toBeUndefined();
      expect(probe.usabilityDetail).toMatch(/no safe version|traversal/);
    }
  });

  test('a physical absolute installedPath is accepted, but manifest mismatch and symlink roots fail closed', () => {
    const fixture = seedActivePlugin('7.8.9');
    const installedPath = join(root, 'reported-plugin');
    cpSync(fixture.pluginRoot, installedPath, { recursive: true, dereference: false, verbatimSymlinks: true });
    const snapshot = (path: string) =>
      JSON.stringify({
        installed: [
          { pluginId: 'genie@automagik', name: 'genie', enabled: true, version: fixture.version, installedPath: path },
        ],
      });
    const probe = (path: string) =>
      probeCodexGeniePlugin({
        which: () => process.execPath,
        codexHome: fixture.codexHome,
        run: () => ({ exitCode: 0, stdout: snapshot(path), stderr: '' }),
        inspectUsability: (options) =>
          inspectCodexPluginMcpUsability({
            ...options,
            genieHome: fixture.genieHome,
            resolveCommand: () => fixture.nodePath,
          }),
      });
    expect(probe(installedPath)).toMatchObject({ usable: true, activePluginRoot: installedPath });

    const manifestPath = join(installedPath, '.codex-plugin', 'plugin.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.version = 'wrong';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(probe(installedPath).usabilityDetail).toContain('identity/version mismatch');

    const symlinkPath = join(root, 'reported-link');
    symlinkSync(installedPath, symlinkPath, 'dir');
    expect(probe(symlinkPath).usabilityDetail).toContain('not a physical directory');
  });
});

describe('official plugin MCP usability', () => {
  test('requires the active cached launcher plus an executable canonical GENIE_HOME binary', () => {
    const fixture = seedActivePlugin();
    const binary = join(fixture.genieHome, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
    const options = {
      pluginRoot: fixture.pluginRoot,
      expectedPluginName: 'genie',
      expectedVersion: fixture.version,
      genieHome: fixture.genieHome,
      resolveCommand: () => fixture.nodePath,
    };
    expect(inspectCodexPluginMcpUsability(options).usable).toBe(true);
    rmSync(binary);
    const missing = inspectCodexPluginMcpUsability(options);
    expect(missing.usable).toBe(false);
    expect(missing.detail).toContain('no such file');
  });

  test('missing configured Node command keeps the absolute project fallback', () => {
    const fixture = seedActivePlugin();
    const usability = inspectCodexPluginMcpUsability({
      pluginRoot: fixture.pluginRoot,
      expectedPluginName: 'genie',
      expectedVersion: fixture.version,
      genieHome: fixture.genieHome,
      resolveCommand: () => null,
    });
    expect(usability.usable).toBe(false);
    expect(usability.detail).toContain('"node" is not available on PATH');

    const plugin: CodexPluginProbe = {
      cliAvailable: true,
      status: 'ok',
      installed: true,
      enabled: true,
      usable: usability.usable,
      usabilityDetail: usability.detail,
      detail: usability.detail,
    };
    const result = reconcileCodexProjectMcp(root, plugin, { command: '/absolute/genie', args: ['mcp'] });
    expect(result.route).toBe('fallback');
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toContain('/absolute/genie');
  });

  test('rejects configured Node from the active project or linked-worktree common checkout', () => {
    const fixture = seedActivePlugin();
    const inspect = (cwd: string, nodePath: string) =>
      inspectCodexPluginMcpUsability({
        pluginRoot: fixture.pluginRoot,
        expectedPluginName: 'genie',
        expectedVersion: fixture.version,
        genieHome: fixture.genieHome,
        cwd,
        resolveCommand: () => nodePath,
      });

    const project = join(root, 'active-project');
    mkdirSync(join(project, '.git'), { recursive: true });
    const projectNode = join(project, 'bin', 'node');
    mkdirSync(dirname(projectNode), { recursive: true });
    writeFileSync(projectNode, 'decoy');
    chmodSync(projectNode, 0o755);
    expect(inspect(project, projectNode).detail).toContain('repository-local');

    const main = join(root, 'main');
    const linked = join(root, 'linked');
    const linkedGitDir = join(main, '.git', 'worktrees', 'linked');
    mkdirSync(linkedGitDir, { recursive: true });
    mkdirSync(linked, { recursive: true });
    writeFileSync(join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
    writeFileSync(join(linkedGitDir, 'commondir'), '../..\n');
    const commonNode = join(main, 'bin', 'node');
    mkdirSync(dirname(commonNode), { recursive: true });
    writeFileSync(commonNode, 'decoy');
    chmodSync(commonNode, 0o755);
    expect(inspect(linked, commonNode).detail).toContain('repository-local');
  });

  test('unsupported camelCase plugin MCP config fails closed', () => {
    const fixture = seedActivePlugin();
    writeFileSync(
      join(fixture.pluginRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          genie: { command: 'node', args: ['./scripts/mcp-launcher.cjs'], cwd: '.' },
        },
      }),
    );
    const result = inspectCodexPluginMcpUsability({
      pluginRoot: fixture.pluginRoot,
      expectedPluginName: 'genie',
      expectedVersion: fixture.version,
      genieHome: fixture.genieHome,
      resolveCommand: () => fixture.nodePath,
    });
    expect(result.usable).toBe(false);
    expect(result.detail).toContain('unsupported camelCase mcpServers');
  });

  test('healthy source does not mask a missing launcher in the active cached payload', () => {
    const fixture = seedActivePlugin();
    const sourceLauncher = join(import.meta.dir, '..', '..', 'plugins', 'genie', 'scripts', 'mcp-launcher.cjs');
    expect(existsSync(sourceLauncher)).toBe(true);
    rmSync(join(fixture.pluginRoot, 'scripts', 'mcp-launcher.cjs'));
    const result = inspectCodexPluginMcpUsability({
      pluginRoot: fixture.pluginRoot,
      expectedPluginName: 'genie',
      expectedVersion: fixture.version,
      genieHome: fixture.genieHome,
      resolveCommand: () => fixture.nodePath,
    });
    expect(result.usable).toBe(false);
    expect(result.pluginRoot).toBe(fixture.pluginRoot);
    expect(result.detail).toMatch(/no such file|ENOENT/);
  });
});

describe('Codex plugin/fallback reconciliation', () => {
  const configPath = () => join(root, '.codex', 'config.toml');

  test('enabled plugin removes only the marker-owned fallback', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      configPath(),
      'model = "x"\n\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n\n[mcp_servers.other]\ncommand = "x"\n',
    );
    const result = reconcileCodexProjectMcp(root, enabled, { command: '/genie', args: ['mcp'] });
    expect(result).toMatchObject({ ok: true, route: 'plugin', action: 'updated' });
    const content = readFileSync(configPath(), 'utf8');
    expect(content).not.toContain('GENIE MCP FALLBACK');
    expect(content).toContain('[mcp_servers.other]');
  });

  test('disabled plugin preserves or creates the absolute fallback', () => {
    const result = reconcileCodexProjectMcp(root, disabled, { command: '/absolute/genie', args: ['mcp'] });
    expect(result).toMatchObject({ ok: true, route: 'fallback', action: 'created' });
    expect(readFileSync(configPath(), 'utf8')).toContain('command = "/absolute/genie"');
    expect(readFileSync(configPath(), 'utf8')).toContain('mcp_servers.genie.command = "/absolute/genie"');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('[mcp_servers.genie]');
    expect(inspectCodexProjectMcp(root, disabled).route).toBe('fallback');
  });

  test('marker-owned dotted TOML never captures following root keys and removal preserves semantics', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const original = 'model = "gpt-5"\nreasoning = "high"\n\n[features]\napps = true\n';
    writeFileSync(configPath(), original);

    expect(reconcileCodexProjectMcp(root, disabled, { command: '/absolute/genie', args: ['mcp'] }).action).toBe(
      'updated',
    );
    const withFallback = readFileSync(configPath(), 'utf8');
    const before = Bun.TOML.parse(withFallback) as Record<string, unknown>;
    expect(before.model).toBe('gpt-5');
    expect(before.reasoning).toBe('high');
    expect(before.features).toEqual({ apps: true });
    expect(reconcileCodexProjectMcp(root, disabled, { command: '/absolute/genie', args: ['mcp'] }).action).toBe(
      'skipped',
    );
    expect(readFileSync(configPath(), 'utf8')).toBe(withFallback);

    reconcileCodexProjectMcp(root, enabled, { command: '/absolute/genie', args: ['mcp'] });
    const removed = readFileSync(configPath(), 'utf8');
    const after = Bun.TOML.parse(removed) as Record<string, unknown>;
    expect(after).toEqual({ model: 'gpt-5', reasoning: 'high', features: { apps: true } });
    expect(removed).toBe(original);
  });

  test('refuses to remove an ambiguous legacy table block that captured a following key', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const ambiguous =
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\nmodel = "captured"\n';
    writeFileSync(configPath(), ambiguous);

    expect(() => reconcileCodexProjectMcp(root, enabled, { command: '/genie', args: ['mcp'] })).toThrow(
      /change non-Genie TOML semantics/,
    );
    expect(readFileSync(configPath(), 'utf8')).toBe(ambiguous);
  });

  test('query failure conservatively keeps one fallback', () => {
    const failed: CodexPluginProbe = {
      cliAvailable: true,
      status: 'error',
      installed: false,
      detail: 'query timed out',
      timedOut: true,
    };
    expect(reconcileCodexProjectMcp(root, failed, { command: '/g', args: ['mcp'] }).route).toBe('fallback');
    expect(reconcileCodexProjectMcp(root, failed, { command: '/g', args: ['mcp'] }).action).toBe('skipped');
  });

  test('enabled plugin with an incomplete active cache retains the marker-owned absolute fallback', () => {
    const fixture = seedActivePlugin('4.5.6');
    rmSync(join(fixture.pluginRoot, 'scripts', 'mcp-launcher.cjs'));
    const probe = probeCodexGeniePlugin({
      which: () => process.execPath,
      codexHome: fixture.codexHome,
      run: () => ({
        exitCode: 0,
        stdout: '{"installed":[{"pluginId":"genie@automagik","enabled":true,"version":"4.5.6"}]}',
        stderr: '',
      }),
      inspectUsability: (options) =>
        inspectCodexPluginMcpUsability({
          ...options,
          genieHome: fixture.genieHome,
          resolveCommand: () => fixture.nodePath,
        }),
    });
    expect(probe).toMatchObject({ installed: true, enabled: true, usable: false });
    expect(probe.usabilityDetail).toMatch(/no such file|ENOENT/);
    const result = reconcileCodexProjectMcp(root, probe, { command: '/absolute/genie', args: ['mcp'] });
    expect(result).toMatchObject({ ok: true, route: 'fallback', action: 'created' });
    expect(readFileSync(configPath(), 'utf8')).toContain('command = "/absolute/genie"');
  });

  test('marker-owned fallback updates its canonical absolute command without duplication', () => {
    expect(reconcileCodexProjectMcp(root, disabled, { command: '/old/genie', args: ['mcp'] }).action).toBe('created');
    expect(reconcileCodexProjectMcp(root, disabled, { command: '/new/genie', args: ['mcp'] }).action).toBe('updated');
    const content = readFileSync(configPath(), 'utf8');
    expect(content).toContain('command = "/new/genie"');
    expect(content).not.toContain('/old/genie');
    expect(content.match(/BEGIN GENIE MCP FALLBACK/g)).toHaveLength(1);
  });

  test('enabled plugin plus unmanaged fallback is reported as a conflict and preserved', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const original = '[mcp_servers.genie]\ncommand = "/personal"\nargs = ["mcp"]\n';
    writeFileSync(configPath(), original);
    const result = reconcileCodexProjectMcp(root, enabled, { command: '/g', args: ['mcp'] });
    expect(result).toMatchObject({ ok: false, route: 'conflict', action: 'skipped' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
    expect(preflightCodexPluginMutation(root)).toMatchObject({ ok: false, path: configPath() });
  });

  test('quoted TOML keys are recognized as the same unmanaged Genie fallback', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const original = '[mcp_servers."genie"]\ncommand = "/personal"\nargs = ["mcp"]\n';
    writeFileSync(configPath(), original);
    const result = reconcileCodexProjectMcp(root, enabled, { command: '/g', args: ['mcp'] });
    expect(result).toMatchObject({ ok: false, route: 'conflict', action: 'skipped' });
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
    expect(preflightCodexPluginMutation(root).ok).toBe(false);
  });

  test('an unmanaged fallback is preserved byte-for-byte but remains unverified when plugin health is unknown', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const original = '# personal route\n[mcp_servers.genie]\ncommand = "/personal"\nargs = ["mcp"]\n';
    writeFileSync(configPath(), original);
    const unproven: CodexPluginProbe = {
      cliAvailable: true,
      status: 'ok',
      installed: true,
      enabled: true,
      usable: false,
      detail: 'active plugin cache missing',
    };
    const result = reconcileCodexProjectMcp(root, unproven, { command: '/absolute/genie', args: ['mcp'] });
    expect(result).toMatchObject({ ok: false, route: 'unmanaged-fallback', action: 'skipped' });
    expect(result.detail).toContain('unverified');
    expect(readFileSync(configPath(), 'utf8')).toBe(original);
    expect(inspectCodexProjectMcp(root, unproven)).toMatchObject({ ok: false, route: 'unmanaged-fallback' });
  });
});

describe('registerProjectMcpConfigs', () => {
  test('explicit init creates the marker-owned Codex fallback when the CLI is absent', () => {
    const unavailable: CodexPluginProbe = {
      cliAvailable: false,
      status: 'unavailable',
      installed: false,
      detail: 'Codex CLI not found',
    };
    const results = registerProjectMcpConfigs(root, {
      pluginProbe: unavailable,
      entry: { command: '/absolute/genie', args: ['mcp'] },
    });
    const codexPath = join(root, '.codex', 'config.toml');
    expect(results.some((result) => result.path === codexPath && result.action === 'created')).toBe(true);
    expect(readFileSync(codexPath, 'utf8')).toContain('# BEGIN GENIE MCP FALLBACK');
    expect(readFileSync(codexPath, 'utf8')).toContain('/absolute/genie');
  });

  test('preflights both JSON files and rejects wrong-shaped valid JSON before any sibling write', () => {
    mkdirSync(join(root, '.warp'), { recursive: true });
    writeFileSync(join(root, '.warp', '.mcp.json'), '{"mcpServers":[]}');
    expect(() =>
      registerProjectMcpConfigs(root, {
        pluginProbe: enabled,
        entry: { command: '/g', args: ['mcp'] },
      }),
    ).toThrow(/mcpServers.*must be an object/);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(readFileSync(join(root, '.warp', '.mcp.json'), 'utf8')).toBe('{"mcpServers":[]}');
  });

  test('an enabled plugin leaves exactly one Codex route; a disabled plugin leaves exactly one fallback', () => {
    registerProjectMcpConfigs(root, { pluginProbe: disabled, entry: { command: '/g', args: ['mcp'] } });
    expect(inspectCodexProjectMcp(root, disabled).route).toBe('fallback');
    registerProjectMcpConfigs(root, { pluginProbe: enabled, entry: { command: '/g', args: ['mcp'] } });
    expect(inspectCodexProjectMcp(root, enabled).route).toBe('plugin');
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).not.toContain('GENIE MCP FALLBACK');
  });

  test('unverified unmanaged fallback aborts planning before any sibling config is written', () => {
    mkdirSync(join(root, '.codex'), { recursive: true });
    const original = '[mcp_servers.genie]\ncommand = "/personal"\nargs = ["mcp"]\n';
    writeFileSync(join(root, '.codex', 'config.toml'), original);
    expect(() =>
      registerProjectMcpConfigs(root, {
        pluginProbe: disabled,
        entry: { command: '/absolute/genie', args: ['mcp'] },
      }),
    ).toThrow(/preserved.*unverified|unverified.*usable/i);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe(original);
    expect(existsSync(join(root, '.mcp.json'))).toBe(false);
    expect(existsSync(join(root, '.warp', '.mcp.json'))).toBe(false);
  });

  test('rejects file and parent-directory symlinks for every project MCP target', () => {
    if (process.platform === 'win32') return;
    const cases = [
      { target: '.mcp.json', parentLink: false },
      { target: join('.warp', '.mcp.json'), parentLink: false },
      { target: join('.warp', '.mcp.json'), parentLink: true },
      { target: join('.codex', 'config.toml'), parentLink: false },
      { target: join('.codex', 'config.toml'), parentLink: true },
    ];
    for (const [index, fixture] of cases.entries()) {
      const project = join(root, `symlink-case-${index}`);
      const external = join(root, `external-${index}`);
      mkdirSync(project, { recursive: true });
      mkdirSync(external, { recursive: true });
      const target = join(project, fixture.target);
      if (fixture.parentLink) {
        symlinkSync(external, dirname(target), 'dir');
      } else {
        mkdirSync(dirname(target), { recursive: true });
        const externalFile = join(external, 'config');
        writeFileSync(externalFile, 'external-safe');
        symlinkSync(externalFile, target);
      }

      expect(() =>
        registerProjectMcpConfigs(project, {
          pluginProbe: disabled,
          entry: { command: '/g', args: ['mcp'] },
        }),
      ).toThrow(/physical|unsafe|symlink/i);
      expect(existsSync(join(project, '.mcp.json')) && !fixture.target.endsWith('.mcp.json')).toBe(false);
      if (!fixture.parentLink) expect(readFileSync(join(external, 'config'), 'utf8')).toBe('external-safe');
    }
  });
});
