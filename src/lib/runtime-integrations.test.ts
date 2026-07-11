import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  claudePluginState,
  codexPluginState,
  inspectCodexAgentOwnership,
  installCodexAgents,
  installRuntimeIntegrations,
  parseClaudePluginState,
  parseCodexPluginState,
  removeCodexAgents,
  removeRuntimeIntegrations,
  resolveBundleRoot,
  setCodexPluginEnabled,
} from './runtime-integrations.js';
import { VERSION } from './version.js';

const MANAGED_TOML = '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\n';

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Snapshot GENIE_HOME/GENIE_BUNDLE_ROOT (clearing the latter) and return the restore function. */
function snapshotEnv(): () => void {
  const home = process.env.GENIE_HOME;
  const bundle = process.env.GENIE_BUNDLE_ROOT;
  Reflect.deleteProperty(process.env, 'GENIE_BUNDLE_ROOT');
  return () => {
    if (home === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
    else process.env.GENIE_HOME = home;
    if (bundle === undefined) Reflect.deleteProperty(process.env, 'GENIE_BUNDLE_ROOT');
    else process.env.GENIE_BUNDLE_ROOT = bundle;
  };
}

/** GENIE_HOME as install.sh + normalizeAuxLayout leave it: binary in bin/, payload + manifests at the root. */
function makeInstalledHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'genie-installed-home-'));
  write(join(home, 'bin', 'genie'), '#!binary');
  write(join(home, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), MANAGED_TOML);
  write(join(home, '.agents', 'plugins', 'marketplace.json'), '{"name":"automagik"}');
  write(join(home, '.claude-plugin', 'marketplace.json'), '{"name":"automagik"}');
  write(join(home, 'VERSION'), '5.2.0\n');
  return home;
}

describe('runtime plugin state', () => {
  test('reads Codex and Claude enabled state', () => {
    expect(
      codexPluginState('{"installed":[{"pluginId":"genie@automagik","enabled":false,"version":"1.2.3"}]}'),
    ).toEqual({
      installed: true,
      enabled: false,
      version: '1.2.3',
    });
    expect(claudePluginState('[{"id":"genie@automagik","enabled":true,"version":"1.2.3"}]')).toEqual({
      installed: true,
      enabled: true,
      version: '1.2.3',
    });
    expect(parseCodexPluginState('{}')).toMatchObject({ ok: false });
    expect(parseClaudePluginState('{}')).toMatchObject({ ok: false });
  });

  for (const [label, entry] of [
    ['missing enabled', { pluginId: 'genie@automagik', version: VERSION }],
    ['string enabled', { pluginId: 'genie@automagik', enabled: 'false', version: VERSION }],
    ['missing version', { pluginId: 'genie@automagik', enabled: false }],
    ['non-string version', { pluginId: 'genie@automagik', enabled: false, version: 123 }],
    ['unsafe version', { pluginId: 'genie@automagik', enabled: false, version: '5.0.0\nforged' }],
  ] as const) {
    test(`rejects a Codex matching entry with ${label}`, () => {
      expect(parseCodexPluginState(JSON.stringify({ installed: [entry] }))).toMatchObject({ ok: false });
    });
  }

  test('rejects duplicate Codex matching entries instead of trusting the first', () => {
    const entry = { pluginId: 'genie@automagik', enabled: true, version: VERSION };
    expect(parseCodexPluginState(JSON.stringify({ installed: [entry, entry] }))).toMatchObject({ ok: false });
  });

  test('restores an explicit Codex disabled state without touching other plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-plugin-state-'));
    const path = join(root, 'config.toml');
    writeFileSync(path, '[plugins."genie@automagik"]\nenabled = true\n\n[plugins."other@market"]\nenabled = true\n');
    setCodexPluginEnabled(false, path);
    expect(readFileSync(path, 'utf8')).toBe(
      '[plugins."genie@automagik"]\nenabled = false\n\n[plugins."other@market"]\nenabled = true\n',
    );
  });

  test('fresh Codex home installs agents, migrates dead OTel, and runs idempotent marketplace/plugin commands', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-home-'));
    const configPath = join(codexHome, 'config.toml');
    writeFileSync(
      configPath,
      'disable_paste_burst = true\n[otel]\nexporter = { otlp-http = { endpoint = "http://127.0.0.1:14318/v1/traces", protocol = "binary" } }\n',
    );
    const calls: string[] = [];
    let lists = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot: join(import.meta.dir, '..', '..'),
      codexHome,
      detected: { codex: true },
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return {
            exitCode: 0,
            stdout:
              lists === 1
                ? '{"installed":[]}'
                : JSON.stringify({
                    installed: [{ pluginId: 'genie@automagik', enabled: true, version: VERSION }],
                  }),
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        };
      },
    });
    expect(results[0].ok).toBe(true);
    expect(readdirSync(join(codexHome, 'agents')).filter((name) => name.startsWith('genie-')).length).toBe(7);
    expect(readFileSync(configPath, 'utf8')).toContain('disable_paste_burst = true');
    expect(readFileSync(configPath, 'utf8')).not.toContain('127.0.0.1:14318');
    expect(calls).toContain(`codex plugin marketplace add ${join(import.meta.dir, '..', '..')} --json`);
    expect(calls).toContain('codex plugin add genie@automagik --json');
    expect(readdirSync(codexHome).some((name) => name.startsWith('config.toml.genie-backup-'))).toBe(true);
  });

  test('install subprocess timeout is bounded and returned as a structured runtime failure', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-timeout-'));
    const observedTimeouts: number[] = [];
    const result = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot: join(import.meta.dir, '..', '..'),
      codexHome,
      detected: { codex: true },
      timeoutMs: 432,
      runner(_command, _args, options) {
        observedTimeouts.push(options?.timeoutMs ?? -1);
        return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      },
    })[0];

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.detail).toContain('timed out after 432ms');
    expect(observedTimeouts).toEqual([432]);
  });
});

describe('resolveBundleRoot', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
  });
  afterEach(() => restoreEnv());

  test('resolves the INSTALLED layout: GENIE_HOME with plugins/ at the root and the binary in bin/', () => {
    const home = makeInstalledHome();
    process.env.GENIE_HOME = home;
    expect(resolveBundleRoot()).toBe(home);
  });

  test('a GENIE_HOME without the plugin payload falls through to the source checkout', () => {
    process.env.GENIE_HOME = mkdtempSync(join(tmpdir(), 'genie-empty-home-'));
    // Under bun test the import.meta fallback is the repo checkout, which carries plugins/genie/codex-agents.
    expect(resolveBundleRoot()).toBe(resolve(import.meta.dir, '..', '..'));
  });

  test('explicit argument and GENIE_BUNDLE_ROOT are caller assertions, returned unvalidated', () => {
    process.env.GENIE_HOME = makeInstalledHome();
    expect(resolveBundleRoot('/nonexistent/explicit')).toBe('/nonexistent/explicit');
    process.env.GENIE_BUNDLE_ROOT = '/nonexistent/env';
    expect(resolveBundleRoot()).toBe('/nonexistent/env');
  });
});

describe('codex repair convergence (stale marketplace root / stale installed plugin)', () => {
  const staleList = JSON.stringify({
    installed: [{ pluginId: 'genie@automagik', enabled: true, version: '5.260710.9' }],
  });
  const currentList = JSON.stringify({
    installed: [{ pluginId: 'genie@automagik', enabled: true, version: VERSION }],
  });

  function makeCodexHome(): string {
    return mkdtempSync(join(tmpdir(), 'genie-codex-home-'));
  }

  test('marketplace registered from a different source is repointed with bounded subprocesses', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const calls: string[] = [];
    const timeouts: Array<number | undefined> = [];
    let marketplaceAdds = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      timeoutMs: 777,
      runner(command, args, options) {
        const call = [command, ...args].join(' ');
        calls.push(call);
        timeouts.push(options?.timeoutMs);
        if (args.join(' ') === `plugin marketplace add ${bundleRoot} --json`) {
          marketplaceAdds += 1;
          if (marketplaceAdds === 1) {
            return {
              exitCode: 1,
              stdout: '',
              stderr:
                "Error: marketplace 'automagik' is already added from a different source; remove it before adding this source",
            };
          }
        }
        return { exitCode: 0, stdout: args.join(' ') === 'plugin list --json' ? currentList : '{}', stderr: '' };
      },
    });
    expect(results[0]?.ok).toBe(true);
    expect(calls).toContain('codex plugin marketplace remove automagik --json');
    expect(marketplaceAdds).toBe(2);
    expect(timeouts.every((timeout) => timeout === 777)).toBe(true);
  });

  test('a marketplace repoint timeout is returned as a structured bounded failure', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const result = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      timeoutMs: 654,
      runner(_command, args, options) {
        expect(options?.timeoutMs).toBe(654);
        if (args.join(' ') === 'plugin list --json') {
          return { exitCode: 0, stdout: currentList, stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
      },
    })[0];

    expect(result?.ok).toBe(false);
    expect(result?.timedOut).toBe(true);
    expect(result?.detail).toContain('timed out after 654ms');
  });

  test('installed plugin pinned to a stale root is reinstalled until version-matched', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const calls: string[] = [];
    const timeouts: Array<number | undefined> = [];
    let lists = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      timeoutMs: 888,
      runner(command, args, options) {
        calls.push([command, ...args].join(' '));
        timeouts.push(options?.timeoutMs);
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return { exitCode: 0, stdout: lists <= 2 ? staleList : currentList, stderr: '' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(results[0]?.ok).toBe(true);
    expect(calls).toContain('codex plugin remove genie@automagik --json');
    expect(calls.filter((call) => call === 'codex plugin add genie@automagik --json')).toHaveLength(2);
    expect(timeouts.every((timeout) => timeout === 888)).toBe(true);
  });

  test('a repair that cannot converge fails loudly instead of reporting refreshed', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      runner(_command, args) {
        return { exitCode: 0, stdout: args.join(' ') === 'plugin list --json' ? staleList : '{}', stderr: '' };
      },
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toMatch(/stuck at v5\.260710\.9/);
  });

  for (const [label, postState, expected] of [
    ['missing', '{"installed":[]}', /missing after plugin add/],
    ['malformed', '{"unexpected":[]}', /malformed JSON.*after plugin add/],
  ] as const) {
    test(`${label} post-add state is a failure, never a false refreshed result`, () => {
      const bundleRoot = join(import.meta.dir, '..', '..');
      let lists = 0;
      const result = installRuntimeIntegrations({
        selection: 'codex',
        bundleRoot,
        codexHome: makeCodexHome(),
        detected: { codex: true },
        runner(_command, args) {
          if (args.join(' ') === 'plugin list --json') {
            lists += 1;
            return { exitCode: 0, stdout: lists === 1 ? '{"installed":[]}' : postState, stderr: '' };
          }
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      })[0];

      expect(result?.ok).toBe(false);
      expect(result?.detail).toMatch(expected);
    });
  }

  for (const [label, repairedState, expected] of [
    ['missing', '{"installed":[]}', /missing after plugin reinstall/],
    ['malformed', '{"unexpected":[]}', /malformed JSON.*after plugin reinstall/],
  ] as const) {
    test(`${label} post-reinstall state is a failure`, () => {
      const bundleRoot = join(import.meta.dir, '..', '..');
      let lists = 0;
      const result = installRuntimeIntegrations({
        selection: 'codex',
        bundleRoot,
        codexHome: makeCodexHome(),
        detected: { codex: true },
        runner(_command, args) {
          if (args.join(' ') === 'plugin list --json') {
            lists += 1;
            return {
              exitCode: 0,
              stdout: lists === 1 ? currentList : lists === 2 ? staleList : repairedState,
              stderr: '',
            };
          }
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      })[0];

      expect(result?.ok).toBe(false);
      expect(result?.detail).toMatch(expected);
    });
  }
});

describe('installed-layout integration (no explicit bundleRoot)', () => {
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
  });
  afterEach(() => restoreEnv());

  test('codex integration resolves GENIE_HOME as the marketplace root and installs agents from it', () => {
    const home = makeInstalledHome();
    process.env.GENIE_HOME = home;
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-home-'));
    const calls: string[] = [];
    let lists = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      codexHome,
      detected: { codex: true },
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return {
            exitCode: 0,
            stdout:
              lists === 1
                ? '{"installed":[]}'
                : JSON.stringify({
                    installed: [{ pluginId: 'genie@automagik', enabled: true, version: VERSION }],
                  }),
            stderr: '',
          };
        }
        return {
          exitCode: 0,
          stdout: '{}',
          stderr: '',
        };
      },
    });
    expect(results[0].ok).toBe(true);
    expect(calls).toContain(`codex plugin marketplace add ${home} --json`);
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(MANAGED_TOML);
  });
});

describe('installCodexAgents overwrite discipline', () => {
  function makeBundle(): string {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-bundle-'));
    write(join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), MANAGED_TOML);
    return bundleRoot;
  }

  test('fresh install copies the managed file', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({
      installed: 1,
      skippedUserOwned: [],
      keptModified: [],
      removed: [],
      backedUp: [],
    });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(MANAGED_TOML);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-clean');
  });

  test('an identical managed file is refreshed with no backup', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({
      installed: 1,
      skippedUserOwned: [],
      keptModified: [],
      removed: [],
      backedUp: [],
    });
    expect(existsSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'))).toBe(false);
  });

  test('a byte-identical sentinel copy without inventory remains user-owned across update and removal', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    write(target, MANAGED_TOML);

    const result = installCodexAgents(bundleRoot, codexHome);

    expect(result.installed).toBe(0);
    expect(result.skippedUserOwned).toEqual(['genie-reviewer.toml']);
    expect(readFileSync(target, 'utf8')).toBe(MANAGED_TOML);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('user-owned');
    expect(removeCodexAgents(codexHome).removed).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(MANAGED_TOML);
  });

  test('a differing file WITHOUT the sentinel is user-owned: skipped, never overwritten', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const userToml = 'name = "genie_reviewer"\n# hand-written, no sentinel\n';
    write(join(codexHome, 'agents', 'genie-reviewer.toml'), userToml);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({
      installed: 0,
      skippedUserOwned: ['genie-reviewer.toml'],
      keptModified: [],
      removed: [],
      backedUp: [],
    });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(userToml);
    expect(existsSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'))).toBe(false);
  });

  test('a sentinel alone never grants ownership: a differing file is preserved byte-identically', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const tuned =
      '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\nsandbox_mode = "danger"\n';
    write(join(codexHome, 'agents', 'genie-reviewer.toml'), tuned);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({
      installed: 0,
      skippedUserOwned: ['genie-reviewer.toml'],
      keptModified: [],
      removed: [],
      backedUp: [],
    });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(tuned);
    expect(existsSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'))).toBe(false);
  });

  test('a broken same-name symlink is user-owned and never followed or replaced', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const outside = join(codexHome, 'outside-target.toml');
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(outside, target);

    const result = installCodexAgents(bundleRoot, codexHome);

    expect(result.skippedUserOwned).toEqual(['genie-reviewer.toml']);
    expect(existsSync(outside)).toBe(false);
  });

  test('a digest-owned file modified after install is preserved across refresh and uninstall', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const tuned = `${MANAGED_TOML}sandbox_mode = "read-only"\n`;
    writeFileSync(target, tuned);

    const refresh = installCodexAgents(bundleRoot, codexHome);
    expect(refresh.keptModified).toEqual(['genie-reviewer.toml']);
    expect(readFileSync(target, 'utf8')).toBe(tuned);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-modified');

    const removal = removeCodexAgents(codexHome);
    expect(removal.keptModified).toEqual(['genie-reviewer.toml']);
    expect(removal.removed).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(tuned);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('user-owned');
  });

  test('a digest-clean managed file updates and later removes normally', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const updated = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, updated);

    expect(installCodexAgents(bundleRoot, codexHome).installed).toBe(1);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    expect(readFileSync(target, 'utf8')).toBe(updated);
    expect(removeCodexAgents(codexHome).removed).toEqual(['genie-reviewer.toml']);
    expect(existsSync(target)).toBe(false);
  });

  test('role-agent removal I/O failure is structured and remains retryable', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const agentsDir = join(codexHome, 'agents');
    const target = join(agentsDir, 'genie-reviewer.toml');
    chmodSync(agentsDir, 0o500);
    try {
      const result = removeCodexAgents(codexHome);
      expect(result.removed).toEqual([]);
      expect(result.failures[0]?.name).toBe('genie-reviewer.toml');
      expect(readFileSync(target, 'utf8')).toBe(MANAGED_TOML);
    } finally {
      chmodSync(agentsDir, 0o700);
    }
    expect(removeCodexAgents(codexHome).removed).toEqual(['genie-reviewer.toml']);
  });

  test('a corrupt ownership inventory fails closed without touching an existing role agent', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const before = readFileSync(target, 'utf8');
    writeFileSync(join(codexHome, 'agents', '.genie-role-agents.json'), '{broken');

    expect(() => installCodexAgents(bundleRoot, codexHome)).toThrow('ownership inventory is corrupt');
    expect(readFileSync(target, 'utf8')).toBe(before);
    const removal = removeCodexAgents(codexHome);
    expect(removal.failures[0]?.detail).toContain('no role agents were removed');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  test('inventory filenames cannot escape the Codex agents directory', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const inventory = {
      version: 1,
      managedBy: 'genie-codex-role-agents',
      files: { 'genie-../../victim.toml': { digest: '0'.repeat(64) } },
    };
    write(join(codexHome, 'agents', '.genie-role-agents.json'), JSON.stringify(inventory));
    const victim = join(codexHome, 'victim.toml');
    writeFileSync(victim, 'mine\n');

    expect(() => installCodexAgents(bundleRoot, codexHome)).toThrow('invalid inventory schema');
    expect(readFileSync(victim, 'utf8')).toBe('mine\n');
  });
});

describe('runtime integration removal reporting', () => {
  test('unmanaged same-name role agents survive integration removal byte-identically', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-remove-'));
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const personal = `${MANAGED_TOML}model = "personal"\n`;
    write(target, personal);

    const result = removeRuntimeIntegrations({ codexHome, detected: { codex: false, claude: false } });

    expect(result.ok).toBe(true);
    expect(result.agents.removed).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(personal);
  });

  test('every requested subprocess receives a deadline and failures remain structured and retryable', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-remove-'));
    const calls: Array<{ command: string; args: string[]; timeoutMs: number | undefined }> = [];
    const result = removeRuntimeIntegrations({
      removeMarketplace: true,
      codexHome,
      detected: { codex: true, claude: true },
      timeoutMs: 321,
      runner(command, args, options) {
        calls.push({ command, args, timeoutMs: options?.timeoutMs });
        if (command === 'codex') return { exitCode: 1, stdout: '', stderr: '', timedOut: true };
        return { exitCode: 7, stdout: '', stderr: 'permission denied' };
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.timeoutMs === 321)).toBe(true);
    expect(result.steps.filter((step) => step.timedOut)).toHaveLength(2);
    expect(result.steps.filter((step) => step.detail.includes('permission denied'))).toHaveLength(2);
    expect(result.steps.every((step) => step.detail.length > 0)).toBe(true);
  });

  test('already-absent plugins are an idempotent success', () => {
    const result = removeRuntimeIntegrations({
      codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-remove-')),
      detected: { codex: true, claude: false },
      runner() {
        return { exitCode: 1, stdout: '', stderr: 'plugin is not installed' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([{ runtime: 'codex', operation: 'plugin', ok: true, detail: 'already absent' }]);
  });
});
