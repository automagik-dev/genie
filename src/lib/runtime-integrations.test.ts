import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  claudePluginState,
  codexPluginState,
  installCodexAgents,
  installRuntimeIntegrations,
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
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot: join(import.meta.dir, '..', '..'),
      codexHome,
      detected: { codex: true },
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        return {
          exitCode: 0,
          stdout: args.join(' ') === 'plugin list --json' ? '{"installed":[]}' : '{}',
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

  test('marketplace registered from a different source is repointed at the bundle root', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const calls: string[] = [];
    let marketplaceAdds = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      runner(command, args) {
        const call = [command, ...args].join(' ');
        calls.push(call);
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
    expect(results[0].ok).toBe(true);
    expect(calls).toContain('codex plugin marketplace remove automagik --json');
    expect(marketplaceAdds).toBe(2);
  });

  test('installed plugin pinned to a stale root is reinstalled until version-matched', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const calls: string[] = [];
    let lists = 0;
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome: makeCodexHome(),
      detected: { codex: true },
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          // before-state and first verify see the stale install; after the
          // reinstall the registry reports the version-matched plugin.
          return { exitCode: 0, stdout: lists <= 2 ? staleList : currentList, stderr: '' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(results[0].ok).toBe(true);
    expect(calls).toContain('codex plugin remove genie@automagik --json');
    expect(calls.filter((call) => call === 'codex plugin add genie@automagik --json').length).toBe(2);
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
    expect(results[0].ok).toBe(false);
    expect(results[0].detail).toMatch(/stuck at v5\.260710\.9/);
  });
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
    const results = installRuntimeIntegrations({
      selection: 'codex',
      codexHome,
      detected: { codex: true },
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        return {
          exitCode: 0,
          stdout: args.join(' ') === 'plugin list --json' ? '{"installed":[]}' : '{}',
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
    expect(result).toEqual({ installed: 1, skippedUserOwned: [], backedUp: [] });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(MANAGED_TOML);
  });

  test('an identical managed file is refreshed with no backup', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    installCodexAgents(bundleRoot, codexHome);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({ installed: 1, skippedUserOwned: [], backedUp: [] });
    expect(existsSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'))).toBe(false);
  });

  test('a differing file WITHOUT the sentinel is user-owned: skipped, never overwritten', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const userToml = 'name = "genie_reviewer"\n# hand-written, no sentinel\n';
    write(join(codexHome, 'agents', 'genie-reviewer.toml'), userToml);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({ installed: 0, skippedUserOwned: ['genie-reviewer.toml'], backedUp: [] });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(userToml);
    expect(existsSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'))).toBe(false);
  });

  test('a differing file WITH the sentinel is backed up beside itself, then overwritten', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const tuned =
      '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\nsandbox_mode = "danger"\n';
    write(join(codexHome, 'agents', 'genie-reviewer.toml'), tuned);
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(result).toEqual({ installed: 1, skippedUserOwned: [], backedUp: ['genie-reviewer.toml'] });
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(MANAGED_TOML);
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml.genie-backup'), 'utf8')).toBe(tuned);
  });
});
