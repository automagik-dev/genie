import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CodexPluginProbe,
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
});

describe('probeCodexGeniePlugin', () => {
  test('queries once with a deadline and reports a timeout actionably', () => {
    let calls = 0;
    const probe = probeCodexGeniePlugin({
      which: () => '/bin/codex',
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
      which: () => '/bin/codex',
      run: () => ({ exitCode: 0, stdout: '{"installed":{}}', stderr: '' }),
    });
    expect(probe.status).toBe('error');
    expect(probe.detail).toContain('invalid Codex plugin response');
  });

  test('enabled metadata is usable only when the launcher and canonical binary inspection passes', () => {
    const probe = probeCodexGeniePlugin({
      which: () => '/bin/codex',
      run: () => ({
        exitCode: 0,
        stdout: '{"installed":[{"pluginId":"genie@automagik","enabled":true,"version":"1"}]}',
        stderr: '',
      }),
      inspectUsability: () => ({ usable: true, detail: 'fixture launcher usable' }),
    });
    expect(probe).toMatchObject({ status: 'ok', installed: true, enabled: true, usable: true });
    expect(probe.detail).toContain('fixture launcher usable');
  });
});

describe('official plugin MCP usability', () => {
  test('requires the committed launcher plus an executable canonical GENIE_HOME binary', () => {
    const genieHome = join(root, 'genie-home');
    const binary = join(genieHome, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
    const nodePath = join(root, 'controlled-bin', 'node');
    mkdirSync(join(genieHome, 'bin'), { recursive: true });
    mkdirSync(join(root, 'controlled-bin'), { recursive: true });
    writeFileSync(binary, 'fixture binary');
    writeFileSync(nodePath, 'fixture node');
    chmodSync(binary, 0o755);
    chmodSync(nodePath, 0o755);
    const bundleRoot = join(import.meta.dir, '..', '..');
    const options = { bundleRoot, genieHome, resolveCommand: () => nodePath };
    expect(inspectCodexPluginMcpUsability(options).usable).toBe(true);
    rmSync(binary);
    const missing = inspectCodexPluginMcpUsability(options);
    expect(missing.usable).toBe(false);
    expect(missing.detail).toContain('no such file');
  });

  test('missing configured Node command keeps the absolute project fallback', () => {
    const genieHome = join(root, 'genie-home');
    const binary = join(genieHome, 'bin', process.platform === 'win32' ? 'genie.exe' : 'genie');
    mkdirSync(join(genieHome, 'bin'), { recursive: true });
    writeFileSync(binary, 'fixture binary');
    chmodSync(binary, 0o755);
    const usability = inspectCodexPluginMcpUsability({
      bundleRoot: join(import.meta.dir, '..', '..'),
      genieHome,
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

  test('unsupported camelCase plugin MCP config fails closed', () => {
    const bundleRoot = join(root, 'bundle');
    const pluginRoot = join(bundleRoot, 'plugins', 'genie');
    mkdirSync(join(bundleRoot, 'plugins'), { recursive: true });
    cpSync(join(import.meta.dir, '..', '..', 'plugins', 'genie'), pluginRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });
    writeFileSync(
      join(pluginRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          genie: { command: 'node', args: ['./scripts/mcp-launcher.cjs'], cwd: '.' },
        },
      }),
    );
    const result = inspectCodexPluginMcpUsability({ bundleRoot, genieHome: join(root, 'genie-home') });
    expect(result.usable).toBe(false);
    expect(result.detail).toContain('unsupported camelCase mcpServers');
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
    expect(inspectCodexProjectMcp(root, disabled).route).toBe('fallback');
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
});

describe('registerProjectMcpConfigs', () => {
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
});
