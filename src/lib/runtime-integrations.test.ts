import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CODEX_FALLBACK_RETIREMENT_ROOT, computeDirDigest } from './agent-sync.js';
import { REQUIRED_GENIE_MCP_TOOLS } from './codex-mcp-health-session.js';
import type { CodexPluginProbe } from './codex-project-mcp.js';
import {
  CANONICAL_GENIE_SKILL_NAMES,
  type CodexHealthProof,
  type CodexPluginOnlyDeps,
  type InstallIntegrationsOptions,
  type IntegrationResult,
  type ProveCodexPluginHealthOptions,
  beginIntegrationConsentTransition,
  claudePluginState,
  clearIntegrationConsentTransition,
  codexPluginState,
  commitIntegrationConsentTransition,
  convergeClaudePlugin,
  convergeCodexPlugin,
  convergeCodexPluginOnly,
  inspectCodexAgentOwnership,
  inspectCodexFallbackTier,
  inspectRuntimeIntegrationEvidence,
  installCodexAgents,
  installRuntimeIntegrations as installRuntimeIntegrationsWithPhysicalVerification,
  parseClaudePluginState,
  parseCodexPluginState,
  persistIntegrationConsent,
  proveCodexPluginHealth,
  readIntegrationConsent,
  readIntegrationConsentState,
  recoverCodexAgentTransactions,
  removeCodexAgents,
  removeRuntimeIntegrations as removeRuntimeIntegrationsWithTrustedResolution,
  resolveBundleRoot,
  runBoundedIntegrationCommand,
  setCodexPluginEnabled,
  translateRetirementConflicts,
  verifyClaudePhysicalPayload,
} from './runtime-integrations.js';
import { VERSION } from './version.js';

/** A healthy enabled target-version Codex snapshot for plugin-only convergence seams. */
function healthyCodexProbe(activePluginRoot = '/fixture/plugin/root'): CodexPluginProbe {
  return {
    cliAvailable: true,
    status: 'ok',
    installed: true,
    enabled: true,
    version: VERSION,
    activePluginRoot,
    usable: true,
    usabilityDetail: 'fixture plugin is usable',
    detail: 'fixture healthy codex plugin',
  };
}

/** A frozen healthy proof with an empty payload; retirement is exercised against the isolated fallback dir. */
function healthyCodexProof(activePluginRoot = '/fixture/plugin/root'): CodexHealthProof {
  return Object.freeze({
    version: 1,
    snapshot: healthyCodexProbe(activePluginRoot),
    activePluginRoot,
    expectedVersion: VERSION,
    skillInventory: CANONICAL_GENIE_SKILL_NAMES,
    payload: [],
    mcp: { initialized: true, tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true },
  }) as CodexHealthProof;
}

/** Default plugin-only seams: healthy probe/proof/session against a fresh isolated fallback tier. */
function healthyCodexPluginOnly(overrides: CodexPluginOnlyDeps = {}): CodexPluginOnlyDeps {
  return {
    probe: () => healthyCodexProbe(),
    prove: () => healthyCodexProof(),
    runSession: () => ({
      ok: true,
      detail: 'fixture session',
      tools: [...REQUIRED_GENIE_MCP_TOOLS],
      wishStatusReadOnly: true,
    }),
    fallbackSkillsDir: mkdtempSync(join(tmpdir(), 'genie-fallback-skills-')),
    ...overrides,
  };
}

const MANAGED_TOML = '# Managed by Genie. Remove with `genie uninstall`.\nname = "genie_reviewer"\n';

function installRuntimeIntegrations(options: InstallIntegrationsOptions) {
  return installRuntimeIntegrationsWithPhysicalVerification({
    ...options,
    genieHome: options.genieHome ?? options.stateDir ?? options.codexHome ?? options.claudeHome,
    resolveExecutable: options.resolveExecutable ?? ((name) => name),
    verifyCodexPayload: options.verifyCodexPayload ?? (() => undefined),
    verifyClaudePayload: options.verifyClaudePayload ?? (() => undefined),
    codexPluginOnly: healthyCodexPluginOnly(options.codexPluginOnly),
  });
}

function removeRuntimeIntegrations(
  options: Exclude<Parameters<typeof removeRuntimeIntegrationsWithTrustedResolution>[0], undefined>,
) {
  if (typeof options === 'boolean') return removeRuntimeIntegrationsWithTrustedResolution(options);
  return removeRuntimeIntegrationsWithTrustedResolution({
    ...options,
    resolveExecutable: options.resolveExecutable ?? ((name) => name),
  });
}

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
  test('the default subprocess primitive bounds output and escalates TERM-resistant timeouts to KILL', () => {
    const overflow = runBoundedIntegrationCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      killGraceMs: 20,
    });
    expect(overflow.outputOverflow).toBe(true);
    expect(Buffer.byteLength(overflow.stdout)).toBe(1_024);

    const started = Date.now();
    const timeout = runBoundedIntegrationCommand(
      process.execPath,
      ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
      { timeoutMs: 50, maxOutputBytes: 1_024, killGraceMs: 30 },
    );
    expect(timeout.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test('the bounded subprocess primitive kills TERM-resistant POSIX descendants', () => {
    if (process.platform === 'win32') return;
    const result = runBoundedIntegrationCommand(
      process.execPath,
      [
        '-e',
        [
          'const { spawn } = require("node:child_process");',
          'const child = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });',
          'process.stdout.write(String(child.pid));',
          'process.on("SIGTERM",()=>{});',
          'setInterval(()=>{},1000);',
        ].join(''),
      ],
      { timeoutMs: 50, maxOutputBytes: 1_024, killGraceMs: 30 },
    );
    expect(result.timedOut).toBe(true);
    const descendantPid = Number(result.stdout);
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    let alive = true;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          process.kill(descendantPid, 0);
        } catch {
          alive = false;
          break;
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    } finally {
      if (alive) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          alive = false;
        }
      }
    }
    expect(alive).toBe(false);
  });

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

describe('durable integration consent and Claude payload provenance', () => {
  test('integration consent round-trips explicit selections and rejects non-files', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-integration-consent-'));
    for (const selection of ['none', 'codex', 'claude', 'all', 'auto'] as const) {
      persistIntegrationConsent(selection, home);
      expect(readIntegrationConsent(home)).toBe(selection);
    }
    const path = join(home, '.integration-consent.json');
    rmSync(path);
    mkdirSync(path);
    expect(() => readIntegrationConsent(home)).toThrow('not a physical file');
  });

  test('pending consent can be resumed, committed, or explicitly cleared to the prior scope', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-integration-consent-transition-'));
    persistIntegrationConsent('claude', home);
    const first = beginIntegrationConsentTransition('all', home);
    expect(first).toMatchObject({
      selection: 'all',
      state: 'pending',
      previousSelection: 'claude',
      revision: 2,
    });
    expect(first.transitionToken).toMatch(/^[a-f0-9]{32}$/);
    expect(readIntegrationConsent(home)).toBe('all');
    expect(clearIntegrationConsentTransition(first, home)).toBe('claude');
    expect(readIntegrationConsentState(home)).toEqual({ selection: 'claude', state: 'committed', revision: 3 });

    const second = beginIntegrationConsentTransition('all', home);
    expect(commitIntegrationConsentTransition(second, home)).toBe('all');
    expect(readIntegrationConsentState(home)).toEqual({ selection: 'all', state: 'committed', revision: 5 });
  });

  test('stale setup invocations cannot commit or clear a newer consent transition', () => {
    const home = mkdtempSync(join(tmpdir(), 'genie-integration-consent-cas-'));
    persistIntegrationConsent('claude', home);
    const stale = beginIntegrationConsentTransition('all', home);
    clearIntegrationConsentTransition(stale, home);
    const current = beginIntegrationConsentTransition('codex', home);

    expect(() => commitIntegrationConsentTransition(stale, home)).toThrow('CAS failed');
    expect(() => clearIntegrationConsentTransition(stale, home)).toThrow('CAS failed');
    expect(readIntegrationConsentState(home)).toEqual(current);
  });

  test('Claude verification binds both directory marketplace source and installed bytes', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-claude-bundle-'));
    const claudeHome = mkdtempSync(join(tmpdir(), 'genie-claude-home-'));
    const source = join(bundleRoot, 'plugins', 'genie');
    const installed = join(claudeHome, 'plugins', 'cache', 'automagik', 'genie', VERSION);
    write(join(source, 'package.json'), '{"name":"genie"}\n');
    write(join(installed, 'package.json'), '{"name":"genie"}\n');
    write(
      join(claudeHome, 'plugins', 'known_marketplaces.json'),
      JSON.stringify({
        automagik: { source: { source: 'directory', path: bundleRoot }, installLocation: bundleRoot },
      }),
    );
    const input = { bundleRoot, claudeHome, expectedVersion: VERSION };
    expect(() => verifyClaudePhysicalPayload(input)).not.toThrow();
    writeFileSync(join(installed, 'package.json'), '{"name":"substituted"}\n');
    expect(() => verifyClaudePhysicalPayload(input)).toThrow('payload identity mismatch');
  });

  test('a failed refresh that leaves the plugin installed clears authority before a later manual removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-intent-'));
    const statePath = join(root, 'refresh.json');
    const current = JSON.stringify([{ id: 'genie@automagik', enabled: true, version: VERSION }]);
    const calls: string[] = [];
    const first = convergeClaudePlugin({
      command: 'claude',
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        if (args.join(' ') === 'plugin list --json') return { exitCode: 0, stdout: current, stderr: '' };
        if (args.join(' ') === `plugin marketplace add ${root}`) return { exitCode: 0, stdout: '', stderr: '' };
        return { exitCode: 7, stdout: '', stderr: 'permission denied' };
      },
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
    });
    expect(first?.ok).toBe(false);
    expect(existsSync(statePath)).toBe(false);

    calls.length = 0;
    const afterManualRemoval = convergeClaudePlugin({
      command: 'claude',
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
    });
    expect(afterManualRemoval).toBeNull();
    expect(calls).toEqual(['claude plugin list --json']);
    expect(existsSync(statePath)).toBe(false);
  });

  test('Codex failure settlement restores and verifies captured disabled consent before clearing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-disabled-settlement-'));
    const statePath = join(root, 'refresh.json');
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = false\n');
    let commandFailed = false;
    let lists = 0;
    const list = () =>
      JSON.stringify({
        installed: [
          {
            pluginId: 'genie@automagik',
            enabled: !/enabled\s*=\s*false/.test(readFileSync(configPath, 'utf8')),
            version: lists++ === 0 ? '5.260710.9' : VERSION,
          },
        ],
      });
    const result = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      configPath,
      verifyCodexPayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') return { exitCode: 0, stdout: list(), stderr: '' };
        if (args.join(' ') === 'plugin add genie@automagik --json') {
          commandFailed = true;
          writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
          return { exitCode: 9, stdout: '', stderr: 'partial refresh enabled plugin' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(commandFailed).toBe(true);
    expect(result?.ok).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('enabled = false');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'planned', enabled: false });
  });

  test('Claude failure settlement restores and verifies captured disabled consent before clearing it', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-disabled-settlement-'));
    const statePath = join(root, 'refresh.json');
    let enabled = false;
    const list = () => JSON.stringify([{ id: 'genie@automagik', enabled, version: VERSION }]);
    const result = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') return { exitCode: 0, stdout: list(), stderr: '' };
        if (args.join(' ') === 'plugin update genie@automagik') {
          enabled = true;
          return { exitCode: 9, stdout: '', stderr: 'partial refresh enabled plugin' };
        }
        if (args.join(' ') === 'plugin disable genie@automagik') {
          enabled = false;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(result?.ok).toBe(false);
    expect(enabled).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'planned', enabled: false });
  });

  test('Codex captures durable disabled intent before a failing first probe and consumes reinstall authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-disabled-first-probe-'));
    const statePath = join(root, 'refresh.json');
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 4,
        runtime: 'codex',
        installed: true,
        enabled: false,
        createdAt: new Date().toISOString(),
        phase: 'removal-observed',
      })}\n`,
    );
    let lists = 0;
    const first = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      configPath,
      verifyCodexPayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') !== 'plugin list --json') return { exitCode: 0, stdout: '{}', stderr: '' };
        lists += 1;
        if (lists < 3) return { exitCode: 9, stdout: '', stderr: 'probe unavailable' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: 'genie@automagik', enabled: false, version: VERSION }],
          }),
          stderr: '',
        };
      },
    });

    expect(first?.ok).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('enabled = false');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'planned', enabled: false });

    const retryCalls: string[] = [];
    const retry = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      configPath,
      verifyCodexPayload: () => undefined,
      runner(command, args) {
        retryCalls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: '{"installed":[]}', stderr: '' };
      },
    });
    expect(retry).toBeNull();
    expect(retryCalls).toEqual(['codex plugin list --json']);
  });

  test('Claude captures durable disabled intent before a failing first probe and consumes reinstall authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-disabled-first-probe-'));
    const statePath = join(root, 'refresh.json');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 4,
        runtime: 'claude',
        installed: true,
        enabled: false,
        createdAt: new Date().toISOString(),
        phase: 'removal-observed',
      })}\n`,
    );
    let lists = 0;
    let enabled = true;
    const first = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(_command, args) {
        const call = args.join(' ');
        if (call === 'plugin disable genie@automagik') {
          enabled = false;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (call !== 'plugin list --json') return { exitCode: 0, stdout: '{}', stderr: '' };
        lists += 1;
        if (lists < 3) return { exitCode: 9, stdout: '', stderr: 'probe unavailable' };
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ id: 'genie@automagik', enabled, version: VERSION }]),
          stderr: '',
        };
      },
    });

    expect(first?.ok).toBe(false);
    expect(enabled).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ phase: 'planned', enabled: false });

    const retryCalls: string[] = [];
    const retry = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(command, args) {
        retryCalls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
    });
    expect(retry).toBeNull();
    expect(retryCalls).toEqual(['claude plugin list --json']);
  });

  test('Claude disabled-state restore tolerates an already-disabled plugin', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-already-disabled-'));
    const statePath = join(root, 'refresh.json');
    const result = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(_command, args) {
        const call = args.join(' ');
        if (call === 'plugin list --json') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ id: 'genie@automagik', enabled: false, version: VERSION }]),
            stderr: '',
          };
        }
        if (call === 'plugin disable genie@automagik') {
          return {
            exitCode: 1,
            stdout: '',
            stderr: '✘ Failed to disable plugin "genie@automagik": Plugin "genie@automagik" is already disabled',
          };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(result?.ok).toBe(true);
    expect(result?.preservedDisabled).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  test('Claude stale planned intent defers to a live enabled plugin instead of re-disabling it', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-stale-planned-intent-'));
    const statePath = join(root, 'refresh.json');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 4,
        runtime: 'claude',
        installed: true,
        enabled: false,
        createdAt: new Date().toISOString(),
        phase: 'planned',
      })}\n`,
    );
    const calls: string[] = [];
    const result = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(_command, args) {
        const call = args.join(' ');
        calls.push(call);
        if (call === 'plugin list --json') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ id: 'genie@automagik', enabled: true, version: VERSION }]),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(result?.ok).toBe(true);
    expect(result?.preservedDisabled).toBe(false);
    expect(calls).not.toContain('plugin disable genie@automagik');
    expect(existsSync(statePath)).toBe(false);
  });

  test('Codex stale planned intent defers to a live enabled plugin instead of re-disabling it', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-stale-planned-intent-'));
    const statePath = join(root, 'refresh.json');
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = true\n');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 4,
        runtime: 'codex',
        installed: true,
        enabled: false,
        createdAt: new Date().toISOString(),
        phase: 'planned',
      })}\n`,
    );
    const result = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      configPath,
      codexHome: root,
      verifyCodexPayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ installed: [{ pluginId: 'genie@automagik', enabled: true, version: VERSION }] }),
            stderr: '',
          };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(result?.ok).toBe(true);
    expect(result?.preservedDisabled).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('enabled = true');
    expect(existsSync(statePath)).toBe(false);
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

  test('a failed command with an ambiguous absent post-state never authorizes a later update reinstall', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-refresh-ambiguous-'));
    const statePath = join(root, 'refresh.json');
    let lists = 0;
    const first = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyCodexPayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return { exitCode: 0, stdout: lists === 1 ? staleList : '{"installed":[]}', stderr: '' };
        }
        if (args.join(' ') === 'plugin add genie@automagik --json') {
          return { exitCode: 9, stdout: '', stderr: 'ambiguous plugin failure' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(first).toMatchObject({ runtime: 'codex', ok: false });
    expect(first?.detail).toContain('run `genie setup --codex`');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).phase).toBe('ambiguous-absent');

    const retryCalls: string[] = [];
    const retry = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyCodexPayload: () => undefined,
      runner(command, args) {
        retryCalls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: '{"installed":[]}', stderr: '' };
      },
    });
    expect(retry).toBeNull();
    expect(retryCalls).toEqual(['codex plugin list --json']);
    expect(existsSync(statePath)).toBe(false);
  });

  test('a legacy removal-observed intent remains the only automatic absent-registration repair authority', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-refresh-authorized-'));
    const statePath = join(root, 'refresh.json');
    writeFileSync(
      statePath,
      `${JSON.stringify({
        schemaVersion: 4,
        runtime: 'codex',
        installed: true,
        enabled: true,
        createdAt: new Date().toISOString(),
        phase: 'removal-observed',
      })}\n`,
    );
    let lists = 0;
    const retryCalls: string[] = [];
    const retry = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyCodexPayload: () => undefined,
      runner(command, args) {
        retryCalls.push([command, ...args].join(' '));
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return { exitCode: 0, stdout: lists === 1 ? '{"installed":[]}' : currentList, stderr: '' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(retry?.ok).toBe(true);
    expect(retryCalls).toContain('codex plugin add genie@automagik --json');
    expect(retryCalls).not.toContain('codex plugin remove genie@automagik --json');
    expect(existsSync(statePath)).toBe(false);
  });

  test('Codex refuses an old-to-expected payload mismatch without repairing the expected generation', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-version-generation-'));
    const statePath = join(root, 'refresh.json');
    let verifies = 0;
    let lists = 0;
    let callsAtVerification = -1;
    const calls: string[] = [];
    const first = convergeCodexPlugin({
      command: 'codex',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      codexHome: root,
      verifyCodexPayload() {
        verifies += 1;
        callsAtVerification = calls.length;
        throw new Error('payload mismatch after version transition');
      },
      runner(command, args) {
        const call = [command, ...args].join(' ');
        calls.push(call);
        if (args.join(' ') === 'plugin list --json') {
          lists += 1;
          return { exitCode: 0, stdout: lists === 1 ? staleList : currentList, stderr: '' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(first?.ok).toBe(false);
    expect(first?.detail).toContain('[same-version-payload-mismatch]');
    expect(verifies).toBe(1);
    expect(calls.filter((call) => call === 'codex plugin add genie@automagik --json')).toHaveLength(1);
    expect(calls).not.toContain('codex plugin remove genie@automagik --json');
    expect(calls).not.toContain('codex plugin marketplace remove automagik --json');
    expect(calls.slice(callsAtVerification)).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).phase).toBe('planned');
  });

  test('Claude consumes removal authority when reinstall is observed before final payload verification fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-consume-removal-'));
    const statePath = join(root, 'refresh.json');
    let installed = true;
    let verifies = 0;
    const list = () =>
      installed ? JSON.stringify([{ id: 'genie@automagik', enabled: true, version: VERSION }]) : '[]';
    const first = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload() {
        verifies += 1;
        throw new Error(`payload mismatch ${verifies}`);
      },
      runner(_command, args) {
        const call = args.join(' ');
        if (call === 'plugin list --json') return { exitCode: 0, stdout: list(), stderr: '' };
        if (call === 'plugin uninstall genie@automagik') installed = false;
        if (call === 'plugin install genie@automagik') installed = true;
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(first?.ok).toBe(false);
    expect(verifies).toBe(2);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).phase).toBe('planned');

    installed = false;
    const retryCalls: string[] = [];
    const retry = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(command, args) {
        retryCalls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: '[]', stderr: '' };
      },
    });
    expect(retry).toBeNull();
    expect(retryCalls).toEqual(['claude plugin list --json']);
  });

  test('Claude records command-started before update but clears it when the failed command leaves the plugin installed', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-claude-refresh-authorized-'));
    const statePath = join(root, 'refresh.json');
    let commandStartedBeforeUpdate = false;
    const current = JSON.stringify([{ id: 'genie@automagik', enabled: true, version: VERSION }]);
    const result = convergeClaudePlugin({
      command: 'claude',
      bundleRoot: root,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath,
      verifyClaudePayload: () => undefined,
      runner(_command, args) {
        if (args.join(' ') === 'plugin list --json') return { exitCode: 0, stdout: current, stderr: '' };
        if (args.join(' ') === 'plugin update genie@automagik') {
          commandStartedBeforeUpdate = JSON.parse(readFileSync(statePath, 'utf8')).phase === 'command-started';
          return { exitCode: 9, stdout: '', stderr: 'interrupted update' };
        }
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });

    expect(result?.ok).toBe(false);
    expect(commandStartedBeforeUpdate).toBe(true);
    expect(existsSync(statePath)).toBe(false);
  });

  test('same-version payload mismatch refuses cache mutation and requires a new plugin version', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-canonical-bundle-'));
    const codexHome = makeCodexHome();
    write(join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), MANAGED_TOML);
    write(join(bundleRoot, 'plugins', 'genie', 'package.json'), '{"name":"canonical"}\n');
    const cacheRoot = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', VERSION);
    write(join(cacheRoot, 'package.json'), '{"name":"wrong-source"}\n');
    const calls: string[] = [];
    const result = installRuntimeIntegrationsWithPhysicalVerification({
      selection: 'codex',
      bundleRoot,
      codexHome,
      genieHome: codexHome,
      stateDir: codexHome,
      detected: { codex: true },
      resolveExecutable: (name) => name,
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: args.join(' ') === 'plugin list --json' ? currentList : '{}', stderr: '' };
      },
    })[0];

    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain('[same-version-payload-mismatch]');
    expect(result?.detail).toContain('Refusing to mutate or reinstall an active plugin version in place');
    expect(result?.detail).toContain('Publish the changed payload under a new plugin version');
    expect(result?.detail).toContain('genie setup --codex');
    expect(calls).toEqual(['codex plugin list --json']);
    expect(readFileSync(join(cacheRoot, 'package.json'), 'utf8')).toBe('{"name":"wrong-source"}\n');
    expect(existsSync(join(codexHome, '.integration-refresh-codex.json'))).toBe(false);
  });

  test('a corrupt pre-existing target generation blocks an old-to-current transition before mutation', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-target-preflight-bundle-'));
    const codexHome = makeCodexHome();
    write(join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), MANAGED_TOML);
    write(join(bundleRoot, 'plugins', 'genie', 'package.json'), '{"name":"canonical"}\n');
    const target = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', VERSION, 'package.json');
    write(target, '{"name":"corrupt-preexisting-target"}\n');
    const calls: string[] = [];

    const result = installRuntimeIntegrationsWithPhysicalVerification({
      selection: 'codex',
      bundleRoot,
      codexHome,
      genieHome: codexHome,
      stateDir: codexHome,
      detected: { codex: true },
      resolveExecutable: (name) => name,
      runner(command, args) {
        calls.push([command, ...args].join(' '));
        return { exitCode: 0, stdout: args.join(' ') === 'plugin list --json' ? staleList : '{}', stderr: '' };
      },
    })[0];

    expect(result?.ok).toBe(false);
    expect(result?.detail).toContain('[same-version-payload-mismatch]');
    expect(calls).toEqual(['codex plugin list --json']);
    expect(readFileSync(target, 'utf8')).toBe('{"name":"corrupt-preexisting-target"}\n');
  });

  for (const fixture of [
    { label: 'identical hook definitions', oldHook: '{"hooks":{"SessionStart":[]}}\n', changed: false },
    { label: 'changed hook definitions', oldHook: '{"hooks":{"PreToolUse":[]}}\n', changed: true },
  ]) {
    test(`version transition reports review only for ${fixture.label}`, () => {
      const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-hook-identity-bundle-'));
      const codexHome = makeCodexHome();
      const statePath = join(codexHome, 'refresh.json');
      const canonicalHook = '{"hooks":{"SessionStart":[]}}\n';
      write(join(bundleRoot, 'plugins', 'genie', 'hooks', 'codex-hooks.json'), canonicalHook);
      write(
        join(codexHome, 'plugins', 'cache', 'automagik', 'genie', '5.260710.9', 'hooks', 'codex-hooks.json'),
        fixture.oldHook,
      );
      let lists = 0;
      const result = convergeCodexPlugin({
        command: 'codex',
        bundleRoot,
        expectedVersion: VERSION,
        installIfAbsent: false,
        statePath,
        codexHome,
        verifyCodexPayload: () => undefined,
        runner(_command, args) {
          if (args.join(' ') === 'plugin list --json') {
            lists += 1;
            return { exitCode: 0, stdout: lists === 1 ? staleList : currentList, stderr: '' };
          }
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      });

      expect(result).toMatchObject({ runtime: 'codex', ok: true, hookReviewRequired: fixture.changed });
    });
  }

  test('initial explicit Codex install reports hook review while update keeps an absent plugin absent', () => {
    const bundleRoot = mkdtempSync(join(tmpdir(), 'genie-hook-initial-bundle-'));
    const codexHome = makeCodexHome();
    write(join(bundleRoot, 'plugins', 'genie', 'hooks', 'codex-hooks.json'), '{"hooks":{"SessionStart":[]}}\n');
    let installed = false;
    const runner = (_command: string, args: string[]) => {
      if (args.join(' ') === 'plugin list --json') {
        return { exitCode: 0, stdout: installed ? currentList : '{"installed":[]}', stderr: '' };
      }
      if (args.join(' ') === 'plugin add genie@automagik --json') installed = true;
      return { exitCode: 0, stdout: '{}', stderr: '' };
    };

    const absentUpdate = convergeCodexPlugin({
      command: 'codex',
      bundleRoot,
      expectedVersion: VERSION,
      installIfAbsent: false,
      statePath: join(codexHome, 'update-refresh.json'),
      codexHome,
      verifyCodexPayload: () => undefined,
      runner,
    });
    expect(absentUpdate).toBeNull();

    const install = convergeCodexPlugin({
      command: 'codex',
      bundleRoot,
      expectedVersion: VERSION,
      installIfAbsent: true,
      statePath: join(codexHome, 'install-refresh.json'),
      codexHome,
      verifyCodexPayload: () => undefined,
      runner,
    });
    expect(install).toMatchObject({ runtime: 'codex', ok: true, hookReviewRequired: true });
  });

  test('matching-current disabled Codex setup is idempotent without plugin cache mutation or residual intent', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-disabled-current-'));
    const statePath = join(root, 'refresh.json');
    const configPath = join(root, 'config.toml');
    writeFileSync(configPath, '[plugins."genie@automagik"]\nenabled = false\n');
    const disabledList = JSON.stringify({
      installed: [{ pluginId: 'genie@automagik', enabled: false, version: VERSION }],
    });
    const calls: string[] = [];
    const setup = () =>
      convergeCodexPlugin({
        command: 'codex',
        bundleRoot: root,
        expectedVersion: VERSION,
        installIfAbsent: true,
        statePath,
        configPath,
        verifyCodexPayload: () => undefined,
        runner(command, args) {
          calls.push([command, ...args].join(' '));
          return {
            exitCode: 0,
            stdout: args.join(' ') === 'plugin list --json' ? disabledList : '{}',
            stderr: '',
          };
        },
      });

    expect(setup()).toMatchObject({ runtime: 'codex', ok: true, preservedDisabled: true });
    expect(existsSync(statePath)).toBe(false);
    expect(setup()).toMatchObject({ runtime: 'codex', ok: true, preservedDisabled: true });
    expect(existsSync(statePath)).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toContain('enabled = false');
    expect(calls.filter((call) => call === 'codex plugin list --json')).toHaveLength(4);
    expect(calls.filter((call) => call.includes('plugin marketplace add'))).toHaveLength(2);
    expect(calls).not.toContain('codex plugin add genie@automagik --json');
    expect(calls).not.toContain('codex plugin remove genie@automagik --json');
  });

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
    expect(calls).not.toContain('codex plugin add genie@automagik --json');
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

  test('installed stale Codex plugin fails closed without remove/re-add or cache mutation', () => {
    const bundleRoot = join(import.meta.dir, '..', '..');
    const codexHome = makeCodexHome();
    const oldCacheFile = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', '5.260710.9', 'payload.txt');
    write(oldCacheFile, 'old-cache-bytes\n');
    const calls: string[] = [];
    const timeouts: Array<number | undefined> = [];
    const results = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot,
      codexHome,
      detected: { codex: true },
      timeoutMs: 888,
      runner(command, args, options) {
        calls.push([command, ...args].join(' '));
        timeouts.push(options?.timeoutMs);
        if (args.join(' ') === 'plugin list --json') return { exitCode: 0, stdout: staleList, stderr: '' };
        return { exitCode: 0, stdout: '{}', stderr: '' };
      },
    });
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.detail).toContain('after one non-destructive add attempt');
    expect(results[0]?.detail).toContain('Close all Codex tasks first');
    expect(results[0]?.detail).toContain('external terminal');
    expect(calls.filter((call) => call === 'codex plugin add genie@automagik --json')).toHaveLength(1);
    expect(calls).not.toContain('codex plugin remove genie@automagik --json');
    expect(readFileSync(oldCacheFile, 'utf8')).toBe('old-cache-bytes\n');
    expect(existsSync(join(codexHome, '.integration-refresh-codex.json'))).toBe(false);
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
    expect(results[0]?.detail).toMatch(/remained at v5\.260710\.9/);
    expect(results[0]?.detail).toContain('Refusing automatic plugin removal/reinstall');
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

  interface CommittedRoleAgentCrash {
    agentsDir: string;
    codexHome: string;
    incoming: string;
    transactionDir: string;
  }

  function makeCommittedRoleAgentCrash(): CommittedRoleAgentCrash {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-committed-crash-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, incoming);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        afterCommit() {
          throw new Error('injected crash after durable commit');
        },
      }),
    ).toThrow('injected crash after durable commit');

    const agentsDir = join(codexHome, 'agents');
    const transactionName = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.txn-'));
    expect(transactionName).toBeDefined();
    return {
      agentsDir,
      codexHome,
      incoming,
      transactionDir: join(agentsDir, transactionName as string),
    };
  }

  test('fresh install copies the managed file', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const result = installCodexAgents(bundleRoot, codexHome);
    expect(() => recoverCodexAgentTransactions(codexHome)).not.toThrow();
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

  test('a byte-identical known Genie copy without inventory remains user-owned', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-'));
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    write(target, MANAGED_TOML);

    const result = installCodexAgents(bundleRoot, codexHome);

    expect(result.installed).toBe(0);
    expect(result.skippedUserOwned).toEqual(['genie-reviewer.toml']);
    expect(result.adoptedLegacy).toBeUndefined();
    expect(readFileSync(target, 'utf8')).toBe(MANAGED_TOML);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('user-owned');
    expect(removeCodexAgents(codexHome).removed).toEqual([]);
    expect(existsSync(target)).toBe(true);
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

  test('chmod-only role-agent edits revoke refresh and removal authority', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-mode-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const installedMode = lstatSync(target).mode & 0o7777;
    const changedMode = installedMode === 0o600 ? 0o644 : 0o600;
    chmodSync(target, changedMode);

    expect(installCodexAgents(bundleRoot, codexHome).keptModified).toEqual(['genie-reviewer.toml']);
    expect(lstatSync(target).mode & 0o7777).toBe(changedMode);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-modified');

    const removal = removeCodexAgents(codexHome);
    expect(removal.removed).toEqual([]);
    expect(removal.keptModified).toEqual(['genie-reviewer.toml']);
    expect(readFileSync(target, 'utf8')).toBe(MANAGED_TOML);
    expect(lstatSync(target).mode & 0o7777).toBe(changedMode);
  });

  test('v1 digest authority upgrades only with a source-authenticated mode and otherwise refuses', () => {
    const bundleRoot = makeBundle();
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const sourceMode = lstatSync(source).mode & 0o7777;
    const digest = createHash('sha256').update(MANAGED_TOML).digest('hex');
    const legacyInventory = {
      version: 1,
      managedBy: 'genie-codex-role-agents',
      files: { 'genie-reviewer.toml': { digest } },
    };

    const upgradeHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-v1-upgrade-'));
    const upgradeTarget = join(upgradeHome, 'agents', 'genie-reviewer.toml');
    write(upgradeTarget, MANAGED_TOML);
    chmodSync(upgradeTarget, sourceMode);
    write(join(upgradeHome, 'agents', '.genie-role-agents.json'), `${JSON.stringify(legacyInventory)}\n`);
    expect(installCodexAgents(bundleRoot, upgradeHome).installed).toBe(1);
    expect(JSON.parse(readFileSync(join(upgradeHome, 'agents', '.genie-role-agents.json'), 'utf8'))).toMatchObject({
      version: 2,
      files: { 'genie-reviewer.toml': { identity: { kind: 'regular', mode: sourceMode, digest } } },
    });

    const refusedHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-v1-refuse-'));
    const refusedTarget = join(refusedHome, 'agents', 'genie-reviewer.toml');
    const refusedInventory = join(refusedHome, 'agents', '.genie-role-agents.json');
    write(refusedTarget, MANAGED_TOML);
    const changedMode = sourceMode === 0o600 ? 0o644 : 0o600;
    chmodSync(refusedTarget, changedMode);
    write(refusedInventory, `${JSON.stringify(legacyInventory)}\n`);

    expect(() => installCodexAgents(bundleRoot, refusedHome)).toThrow('refused the inventory upgrade');
    expect(JSON.parse(readFileSync(refusedInventory, 'utf8')).version).toBe(1);
    const removal = removeCodexAgents(refusedHome);
    expect(removal.removed).toEqual([]);
    expect(removal.keptModified).toEqual(['genie-reviewer.toml']);
    expect(lstatSync(refusedTarget).mode & 0o7777).toBe(changedMode);
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

  test('an identity-matched planned role agent is removed under the batch allowlist', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-planned-match-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const identity = {
      digest: createHash('sha256').update(readFileSync(target)).digest('hex'),
      mode: lstatSync(target).mode & 0o7777,
    };

    const result = removeCodexAgents(codexHome, {}, new Map([['genie-reviewer.toml', identity]]));

    expect(result.removed).toEqual(['genie-reviewer.toml']);
    expect(result.keptIdentityMismatch).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  test('a planned role agent swapped for a different clean file is preserved (identity mismatch)', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-swap-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    // The batch recorded the ORIGINAL identity.
    const recorded = {
      digest: createHash('sha256').update(readFileSync(target)).digest('hex'),
      mode: lstatSync(target).mode & 0o7777,
    };
    // A different clean payload lands and the inventory is updated to match, so it
    // classifies managed-clean by live inventory yet has a different digest.
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    writeFileSync(source, `${MANAGED_TOML}model = "swapped-but-clean"\n`);
    installCodexAgents(bundleRoot, codexHome);
    const swapped = readFileSync(target, 'utf8');
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-clean');

    const result = removeCodexAgents(codexHome, {}, new Map([['genie-reviewer.toml', recorded]]));

    expect(result.removed).toEqual([]);
    expect(result.keptIdentityMismatch).toEqual(['genie-reviewer.toml']);
    expect(readFileSync(target, 'utf8')).toBe(swapped);
    expect(existsSync(target)).toBe(true);
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

  test('payload and inventory promotion roll back together and retry cleanly', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-transaction-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const inventory = join(codexHome, 'agents', '.genie-role-agents.json');
    const beforeTarget = readFileSync(target, 'utf8');
    const beforeInventory = readFileSync(inventory, 'utf8');
    writeFileSync(source, `${MANAGED_TOML}model_reasoning_effort = "high"\n`);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        beforePromotion(stage) {
          if (stage === 'inventory') throw new Error('injected inventory failure');
        },
      }),
    ).toThrow('injected inventory failure');
    expect(readFileSync(target, 'utf8')).toBe(beforeTarget);
    expect(readFileSync(inventory, 'utf8')).toBe(beforeInventory);

    expect(installCodexAgents(bundleRoot, codexHome).installed).toBe(1);
    expect(readFileSync(target, 'utf8')).toContain('model_reasoning_effort = "high"');
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-clean');
  });

  test('a post-classification role-agent edit wins the CAS and preserves the incoming payload', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-cas-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    const personal = `${MANAGED_TOML}model = "personal-race"\n`;
    writeFileSync(source, incoming);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        beforePromotion(stage) {
          if (stage === 'payload:genie-reviewer.toml') writeFileSync(target, personal);
        },
      }),
    ).toThrow('changed before promotion');

    expect(readFileSync(target, 'utf8')).toBe(personal);
    const conflict = readdirSync(join(codexHome, 'agents')).find((name) =>
      name.startsWith('.genie-role-agents.conflict-'),
    );
    expect(conflict).toBeDefined();
    expect(readFileSync(join(codexHome, 'agents', conflict as string, 'staged', 'genie-reviewer.toml'), 'utf8')).toBe(
      incoming,
    );
  });

  test('a role-agent edit after the final pathname check is restored live and incoming bytes are quarantined', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-after-check-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const personal = `${MANAGED_TOML}model = "after-check-race"\n`;
    writeFileSync(source, `${MANAGED_TOML}model_reasoning_effort = "high"\n`);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        afterAuthorization(stage) {
          if (stage === 'payload:genie-reviewer.toml') writeFileSync(target, personal);
        },
      }),
    ).toThrow('changed before promotion');
    expect(readFileSync(target, 'utf8')).toBe(personal);
    expect(readdirSync(join(codexHome, 'agents')).some((name) => name.startsWith('.genie-role-agents.conflict-'))).toBe(
      true,
    );
  });

  test('a parked role recreated immediately before publish is preserved with the incoming payload', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-final-publish-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const target = join(agentsDir, 'genie-reviewer.toml');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    const personal = `${MANAGED_TOML}model = "personal-after-park"\n`;
    writeFileSync(source, incoming);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        // Inventory authorization runs after every payload has been parked;
        // this is the exact last-check/pre-publish interleaving from replay.
        afterAuthorization(stage) {
          if (stage === 'inventory') writeFileSync(target, personal);
        },
      }),
    ).toThrow('exclusive role-agent genie-reviewer.toml publish failed');
    expect(readFileSync(target, 'utf8')).toBe(personal);
    const transaction = readdirSync(agentsDir).find(
      (name) => name.startsWith('.genie-role-agents.txn-') || name.startsWith('.genie-role-agents.conflict-'),
    );
    expect(transaction).toBeDefined();
    expect(readFileSync(join(agentsDir, transaction as string, 'staged', 'genie-reviewer.toml'), 'utf8')).toBe(
      incoming,
    );
  });

  test('a byte-identical reviewer race is never mistaken for a recorded publication during rollback', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-identical-race-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const target = join(agentsDir, 'genie-reviewer.toml');
    const prior = readFileSync(target, 'utf8');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, incoming);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        beforePublish(stage) {
          if (stage === 'payload:genie-reviewer.toml') writeFileSync(target, incoming);
        },
      }),
    ).toThrow('live target is not an exact recorded publication');

    expect(readFileSync(target, 'utf8')).toBe(incoming);
    const conflict = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
    expect(conflict).toBeDefined();
    expect(readFileSync(join(agentsDir, conflict as string, 'before', 'genie-reviewer.toml'), 'utf8')).toBe(prior);
    expect(readFileSync(join(agentsDir, conflict as string, 'staged', 'genie-reviewer.toml'), 'utf8')).toBe(incoming);
  });

  test('a role inventory created at the final publish boundary is never overwritten', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-inventory-final-publish-'));
    const agentsDir = join(codexHome, 'agents');
    const inventory = join(agentsDir, '.genie-role-agents.json');
    const personal = '{"personal":"inventory"}\n';

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        beforePublish(stage) {
          if (stage === 'inventory') writeFileSync(inventory, personal);
        },
      }),
    ).toThrow('exclusive role-agent inventory publish failed');
    expect(readFileSync(inventory, 'utf8')).toBe(personal);
    const transaction = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
    expect(transaction).toBeDefined();
    expect(readFileSync(join(agentsDir, transaction as string, 'staged', '.genie-role-agents.json'), 'utf8')).toContain(
      'genie-reviewer.toml',
    );
  });

  test('expected-absent role-agent creation rejects directory and symlink races after authorization', () => {
    const bundleRoot = makeBundle();
    for (const kind of ['directory', 'symlink'] as const) {
      const codexHome = mkdtempSync(join(tmpdir(), `genie-codex-role-absent-${kind}-`));
      const target = join(codexHome, 'agents', 'genie-reviewer.toml');
      expect(() =>
        installCodexAgents(bundleRoot, codexHome, {
          afterAuthorization(stage) {
            if (stage !== 'payload:genie-reviewer.toml') return;
            if (kind === 'directory') mkdirSync(target);
            else symlinkSync('personal-target', target);
          },
        }),
      ).toThrow('appeared before promotion');
      const stat = lstatSync(target);
      expect(kind === 'directory' ? stat.isDirectory() : stat.isSymbolicLink()).toBe(true);
    }
  });

  test('uninstall parks and revalidates a clean role agent before deletion', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-role-remove-race-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const personal = `${MANAGED_TOML}model = "remove-race"\n`;

    const result = removeCodexAgents(codexHome, {
      afterAuthorization(stage) {
        if (stage === 'payload:genie-reviewer.toml') writeFileSync(target, personal);
      },
    });

    expect(result.removed).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(readFileSync(target, 'utf8')).toBe(personal);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-modified');
  });

  test('a disjoint concurrent role-agent inventory edit is preserved and aborts the whole batch', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-inventory-cas-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const inventoryPath = join(agentsDir, '.genie-role-agents.json');
    const reviewerPath = join(agentsDir, 'genie-reviewer.toml');
    const reviewerBefore = readFileSync(reviewerPath, 'utf8');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    const disjointName = 'genie-disjoint.toml';
    const disjointContent = `${MANAGED_TOML}name = "disjoint"\n`;
    writeFileSync(source, incoming);

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        beforePromotion(stage) {
          if (stage !== 'inventory') return;
          writeFileSync(join(agentsDir, disjointName), disjointContent);
          const inventory = JSON.parse(readFileSync(inventoryPath, 'utf8')) as {
            files: Record<string, { digest: string }>;
          };
          inventory.files[disjointName] = {
            digest: createHash('sha256').update(disjointContent).digest('hex'),
          };
          writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
        },
      }),
    ).toThrow('target changed before promotion');

    expect(readFileSync(reviewerPath, 'utf8')).toBe(reviewerBefore);
    expect(readFileSync(join(agentsDir, disjointName), 'utf8')).toBe(disjointContent);
    expect(JSON.parse(readFileSync(inventoryPath, 'utf8')).files[disjointName]).toBeDefined();
    const conflict = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
    expect(readFileSync(join(agentsDir, conflict as string, 'staged', 'genie-reviewer.toml'), 'utf8')).toBe(incoming);
  });

  test('pre-journal preparation debris is inert and cannot poison a retry', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-prepare-debris-'));
    const debris = join(codexHome, 'agents', '.genie-role-agents.prepare-crashed', 'staged');
    mkdirSync(debris, { recursive: true });
    writeFileSync(join(debris, 'partial.toml'), 'partial');

    expect(installCodexAgents(bundleRoot, codexHome).installed).toBe(1);
    expect(readFileSync(join(codexHome, 'agents', 'genie-reviewer.toml'), 'utf8')).toBe(MANAGED_TOML);
  });

  test('a crash after COMMITTED authenticates the next state and performs roll-forward cleanup', () => {
    const crash = makeCommittedRoleAgentCrash();
    const target = join(crash.agentsDir, 'genie-reviewer.toml');
    expect(readFileSync(target, 'utf8')).toBe(crash.incoming);
    expect(existsSync(join(crash.transactionDir, 'COMMITTED'))).toBe(true);

    expect(() => recoverCodexAgentTransactions(crash.codexHome)).not.toThrow();

    expect(existsSync(crash.transactionDir)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(crash.incoming);
    expect(inspectCodexAgentOwnership(crash.codexHome).entries[0]?.ownership).toBe('managed-clean');
  });

  test('an interruption after the committed-cleanup rename retries without rolling back live state', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-cleanup-interruption-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, incoming);
    let cleanupDir = '';

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        afterCleanupRename(path) {
          cleanupDir = path;
          throw new Error('injected interruption during committed cleanup');
        },
      }),
    ).toThrow('injected interruption during committed cleanup');

    expect(cleanupDir).toContain('.genie-role-agents.committed-cleanup-');
    expect(existsSync(cleanupDir)).toBe(true);
    expect(readdirSync(agentsDir).some((name) => name.startsWith('.genie-role-agents.txn-'))).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(incoming);

    expect(() => recoverCodexAgentTransactions(codexHome)).not.toThrow();

    expect(existsSync(cleanupDir)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe(incoming);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-clean');
  });

  test('cleanup interruption after COMMITTED removal is quarantined and never gains rollback authority', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-cleanup-marker-kill-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const target = join(agentsDir, 'genie-reviewer.toml');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, incoming);
    let cleanupDir = '';

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        afterCleanupRename(path) {
          cleanupDir = path;
          rmSync(join(path, 'COMMITTED'));
          throw new Error('injected kill after cleanup removed COMMITTED');
        },
      }),
    ).toThrow('injected kill after cleanup removed COMMITTED');

    expect(readFileSync(target, 'utf8')).toBe(incoming);
    expect(() => recoverCodexAgentTransactions(codexHome)).toThrow('invalid commit marker');
    expect(readFileSync(target, 'utf8')).toBe(incoming);
    expect(existsSync(cleanupDir)).toBe(false);
    const conflictName = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
    expect(conflictName).toBeDefined();
    const conflict = join(agentsDir, conflictName as string);
    expect(existsSync(join(conflict, 'journal.json'))).toBe(true);
    expect(existsSync(join(conflict, 'staged'))).toBe(true);
    expect(existsSync(join(conflict, 'before'))).toBe(true);

    expect(() => recoverCodexAgentTransactions(codexHome)).not.toThrow();
    expect(readFileSync(target, 'utf8')).toBe(incoming);
    expect(inspectCodexAgentOwnership(codexHome).entries[0]?.ownership).toBe('managed-clean');
  });

  test('committed-cleanup recovery preserves tampered evidence fail-closed without rollback', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-cleanup-tamper-'));
    installCodexAgents(bundleRoot, codexHome);
    const source = join(bundleRoot, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml');
    const agentsDir = join(codexHome, 'agents');
    const target = join(agentsDir, 'genie-reviewer.toml');
    const incoming = `${MANAGED_TOML}model_reasoning_effort = "high"\n`;
    writeFileSync(source, incoming);
    let cleanupDir = '';

    expect(() =>
      installCodexAgents(bundleRoot, codexHome, {
        afterCleanupRename(path) {
          cleanupDir = path;
          throw new Error('injected interruption before cleanup tamper');
        },
      }),
    ).toThrow('injected interruption before cleanup tamper');
    writeFileSync(join(cleanupDir, 'staged', 'genie-reviewer.toml'), 'tampered cleanup evidence\n');

    expect(() => recoverCodexAgentTransactions(codexHome)).toThrow('committed staged evidence changed');

    expect(readFileSync(target, 'utf8')).toBe(incoming);
    expect(existsSync(cleanupDir)).toBe(false);
    const conflictName = readdirSync(agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
    expect(conflictName).toBeDefined();
    const conflict = join(agentsDir, conflictName as string);
    expect(readFileSync(join(conflict, 'staged', 'genie-reviewer.toml'), 'utf8')).toBe('tampered cleanup evidence\n');
    expect(existsSync(join(conflict, 'before', 'genie-reviewer.toml'))).toBe(true);
  });

  for (const [label, tamper, expectedError] of [
    [
      'staged bytes',
      (crash: CommittedRoleAgentCrash) =>
        writeFileSync(join(crash.transactionDir, 'staged', 'genie-reviewer.toml'), 'tampered staged bytes\n'),
      'committed staged evidence changed',
    ],
    [
      'prior parked bytes',
      (crash: CommittedRoleAgentCrash) =>
        writeFileSync(join(crash.transactionDir, 'before', 'genie-reviewer.toml'), 'tampered prior bytes\n'),
      'committed prior parked evidence changed',
    ],
    [
      'publication authority',
      (crash: CommittedRoleAgentCrash) => {
        const path = join(crash.transactionDir, 'publications.json');
        const record = JSON.parse(readFileSync(path, 'utf8')) as {
          artifacts: Record<string, { digest: string }>;
        };
        const reviewer = record.artifacts['genie-reviewer.toml'];
        if (reviewer) reviewer.digest = '0'.repeat(64);
        writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      },
      'committed publication authority changed',
    ],
    [
      'physical published evidence',
      (crash: CommittedRoleAgentCrash) =>
        write(join(crash.transactionDir, 'published', 'genie-reviewer.toml'), 'tampered published bytes\n'),
      'committed published evidence changed',
    ],
  ] as const) {
    test(`COMMITTED recovery preserves the entire transaction when ${label} are tampered`, () => {
      const crash = makeCommittedRoleAgentCrash();
      tamper(crash);

      expect(() => recoverCodexAgentTransactions(crash.codexHome)).toThrow(expectedError);

      expect(readFileSync(join(crash.agentsDir, 'genie-reviewer.toml'), 'utf8')).toBe(crash.incoming);
      expect(existsSync(crash.transactionDir)).toBe(false);
      const conflictName = readdirSync(crash.agentsDir).find((name) => name.startsWith('.genie-role-agents.conflict-'));
      expect(conflictName).toBeDefined();
      const conflict = join(crash.agentsDir, conflictName as string);
      expect(readFileSync(join(conflict, 'COMMITTED'), 'utf8')).toBe('ok\n');
      expect(existsSync(join(conflict, 'journal.json'))).toBe(true);
      expect(existsSync(join(conflict, 'staged'))).toBe(true);
      expect(existsSync(join(conflict, 'before'))).toBe(true);
      expect(existsSync(join(conflict, 'publications.json'))).toBe(true);
    });
  }

  test('uninstall fails closed when a published role transaction cannot be recovered', () => {
    const bundleRoot = makeBundle();
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-broken-transaction-'));
    installCodexAgents(bundleRoot, codexHome);
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const before = readFileSync(target, 'utf8');
    mkdirSync(join(codexHome, 'agents', '.genie-role-agents.txn-crashed'), { recursive: true });

    const removal = removeCodexAgents(codexHome);
    expect(removal.removed).toEqual([]);
    expect(removal.failures[0]?.detail).toContain('pending role-agent transaction could not be recovered');
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
  test('unavailable Codex CLI fails closed when config state is non-physical', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-evidence-nonphysical-'));
    mkdirSync(join(codexHome, 'config.toml'), { recursive: true });
    const result = removeRuntimeIntegrations({
      codexHome,
      claudeHome: mkdtempSync(join(tmpdir(), 'genie-claude-remove-')),
      detected: { codex: false, claude: false },
      installedEvidence: { claude: false },
    });
    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({
        runtime: 'codex',
        ok: false,
        detail: expect.stringContaining('removal cannot be proven'),
      }),
    ]);
  });

  test('Claude settings evidence includes both enabled and explicitly disabled registrations', () => {
    for (const enabled of [true, false]) {
      const claudeHome = mkdtempSync(join(tmpdir(), 'genie-claude-evidence-'));
      write(join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'genie@automagik': enabled } }));
      const evidence = inspectRuntimeIntegrationEvidence({
        claudeHome,
        codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-evidence-')),
      });
      expect(evidence.claude).toBe(true);
      expect(evidence.errors.claude).toEqual([]);
    }
  });

  test('Claude installed registry evidence is detected without cache directories', () => {
    const claudeHome = mkdtempSync(join(tmpdir(), 'genie-claude-evidence-'));
    write(
      join(claudeHome, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: [{ id: 'genie@automagik', version: VERSION }] }),
    );
    expect(
      inspectRuntimeIntegrationEvidence({
        claudeHome,
        codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-evidence-')),
      }).claude,
    ).toBe(true);
  });

  test('unavailable Claude CLI fails closed when settings or registry state is malformed', () => {
    for (const relativePath of ['settings.json', join('plugins', 'installed_plugins.json')]) {
      const claudeHome = mkdtempSync(join(tmpdir(), 'genie-claude-evidence-corrupt-'));
      write(join(claudeHome, relativePath), '{broken');
      const result = removeRuntimeIntegrations({
        codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-remove-')),
        claudeHome,
        detected: { codex: false, claude: false },
        installedEvidence: { codex: false },
      });
      expect(result.ok).toBe(false);
      expect(result.steps).toEqual([
        expect.objectContaining({
          runtime: 'claude',
          ok: false,
          detail: expect.stringContaining('removal cannot be proven'),
        }),
      ]);
    }
  });

  test('unmanaged same-name role agents survive integration removal byte-identically', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'genie-codex-remove-'));
    const target = join(codexHome, 'agents', 'genie-reviewer.toml');
    const personal = `${MANAGED_TOML}model = "personal"\n`;
    write(target, personal);

    const result = removeRuntimeIntegrations({
      codexHome,
      detected: { codex: false, claude: false },
      installedEvidence: { codex: false, claude: false },
    });

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
      installedEvidence: { codex: false, claude: false },
      runner() {
        return { exitCode: 1, stdout: '', stderr: 'plugin is not installed' };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([{ runtime: 'codex', operation: 'plugin', ok: true, detail: 'already absent' }]);
  });

  test('an unavailable client with owned registration evidence is a retryable failure', () => {
    const result = removeRuntimeIntegrations({
      codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-remove-')),
      claudeHome: mkdtempSync(join(tmpdir(), 'genie-claude-remove-')),
      detected: { codex: false, claude: false },
      installedEvidence: { codex: true, claude: false },
    });

    expect(result.ok).toBe(false);
    expect(result.steps).toEqual([
      expect.objectContaining({ runtime: 'codex', ok: false, detail: expect.stringContaining('CLI unavailable') }),
    ]);
  });
});

// ===========================================================================
// Group B: plugin-only convergence orchestration, health proof, and R8 conflict
// surfacing. Every test uses an isolated fallback tier — never real home state.
// ===========================================================================

const MANIFEST_NAME = '.genie-sync.json';

function stampFallbackSkill(dir: string, version = 'fixture-v1'): string {
  const digest = computeDirDigest(dir);
  writeFileSync(
    join(dir, MANIFEST_NAME),
    `${JSON.stringify({ managedBy: 'genie-agent-sync', version, digest, syncedAt: '2026-07-12T00:00:00.000Z', identityVersion: 2 })}\n`,
  );
  return digest;
}

function healthyPluginResult(): IntegrationResult {
  return { runtime: 'codex', ok: true, detail: `plugin/hooks refreshed to v${VERSION}`, preservedDisabled: false };
}

function baseConvergeOptions(fallbackSkillsDir: string, overrides: Partial<CodexPluginOnlyDeps> = {}) {
  return {
    runner: (() => ({ exitCode: 0, stdout: '{}', stderr: '' })) as never,
    command: '/fixture/codex',
    bundleRoot: '/fixture/bundle',
    expectedVersion: VERSION,
    installIfAbsent: true,
    statePath: join(mkdtempSync(join(tmpdir(), 'genie-state-')), '.integration-refresh-codex.json'),
    codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-home-')),
    deps: {
      converge: () => healthyPluginResult(),
      probe: () => healthyCodexProbe(),
      prove: () => healthyCodexProof(),
      runSession: () => ({ ok: true, detail: 'ok', tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true }),
      installAgents: () => ({ installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] }),
      fallbackSkillsDir,
      ...overrides,
    } as CodexPluginOnlyDeps,
  };
}

describe('convergeCodexPluginOnly ordering and single-proof (R1)', () => {
  test('orders converge → single probe → prove → retire → role agents, with exactly one probe', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-order-'));
    const trace: string[] = [];
    let probes = 0;
    const options = baseConvergeOptions(fallback, {
      converge: () => {
        trace.push('converge');
        return healthyPluginResult();
      },
      probe: () => {
        probes += 1;
        trace.push('probe');
        return healthyCodexProbe();
      },
      prove: () => {
        trace.push('prove');
        return healthyCodexProof();
      },
      recover: () => {
        trace.push('recover');
        return [];
      },
      plan: (opts) => {
        trace.push('plan');
        return {
          version: 1,
          fallbackSkillsDir: opts.fallbackSkillsDir,
          transactionId: 'x',
          accepted: [],
          preserved: [],
        };
      },
      apply: () => {
        trace.push('apply');
        return { transactionId: 'x', transactionDir: 'd', status: 'committed', retired: [] };
      },
      installAgents: () => {
        trace.push('installAgents');
        return { installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] };
      },
    });
    convergeCodexPluginOnly(options);
    // A zero-accepted plan short-circuits apply (A11), so 'apply' is absent here.
    expect(trace).toEqual(['converge', 'probe', 'prove', 'recover', 'plan', 'installAgents']);
    expect(trace.indexOf('converge')).toBeLessThan(trace.indexOf('probe'));
    expect(trace.indexOf('probe')).toBeLessThan(trace.indexOf('prove'));
    expect(trace.indexOf('prove')).toBeLessThan(trace.indexOf('plan'));
    expect(trace.indexOf('plan')).toBeLessThan(trace.indexOf('installAgents'));
    expect(probes).toBe(1);
  });

  test('a deliberately disabled plugin skips health + retirement and is never enabled (R3)', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-disabled-'));
    let proved = false;
    let retired = false;
    const outcome = convergeCodexPluginOnly(
      baseConvergeOptions(fallback, {
        converge: () => ({ ...healthyPluginResult(), preservedDisabled: true }),
        probe: () => ({ ...healthyCodexProbe(), enabled: false, usable: false }),
        prove: () => {
          proved = true;
          return healthyCodexProof();
        },
        apply: () => {
          retired = true;
          return { transactionId: 'x', transactionDir: 'd', status: 'committed', retired: [] };
        },
      }),
    );
    expect(outcome).not.toBeNull();
    expect(outcome?.proof).toBeNull();
    expect(outcome?.result.preservedDisabled).toBe(true);
    expect(outcome?.result.snapshot?.enabled).toBe(false);
    expect(proved).toBe(false);
    expect(retired).toBe(false);
  });

  test('a failed convergence returns the failure without retiring any fallback (R9)', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-failed-'));
    let retired = false;
    const outcome = convergeCodexPluginOnly(
      baseConvergeOptions(fallback, {
        converge: () => ({ runtime: 'codex', ok: false, detail: 'plugin-incapable Codex' }),
        apply: () => {
          retired = true;
          return { transactionId: 'x', transactionDir: 'd', status: 'committed', retired: [] };
        },
      }),
    );
    expect(outcome?.result.ok).toBe(false);
    expect(outcome?.proof).toBeNull();
    expect(retired).toBe(false);
  });

  test('retires a proven-clean fallback then a second run is a no-op with no new transaction (R7/A11)', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-idem-'));
    // Target skill dir uses mkdirSync so its physical-tree digest (which includes
    // the root directory mode) matches the mkdirSync-created fallback skill dir.
    const targetParent = mkdtempSync(join(tmpdir(), 'genie-target-skill-'));
    const target = join(targetParent, 'wish');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), '# wish skill\n');
    const targetDigest = computeDirDigest(target);
    // A clean fallback whose content matches the verified target payload.
    const skillDir = join(fallback, 'wish');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# wish skill\n');
    stampFallbackSkill(skillDir);

    const proofWithTarget = () =>
      Object.freeze({
        version: 1,
        snapshot: healthyCodexProbe(),
        activePluginRoot: '/fixture/plugin/root',
        expectedVersion: VERSION,
        skillInventory: ['wish'],
        payload: [{ skillName: 'wish', path: target, physicalDigest: targetDigest, canonicalVerified: true as const }],
        mcp: { initialized: true, tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true },
      }) as CodexHealthProof;

    const first = convergeCodexPluginOnly(baseConvergeOptions(fallback, { prove: proofWithTarget }));
    expect(first?.retired).toEqual(['wish']);
    expect(existsSync(skillDir)).toBe(false);
    const txnRoot = join(fallback, CODEX_FALLBACK_RETIREMENT_ROOT);
    const txnsAfterFirst = readdirSync(txnRoot).filter((name) => name.startsWith('txn-'));
    expect(txnsAfterFirst).toHaveLength(1);

    const second = convergeCodexPluginOnly(baseConvergeOptions(fallback, { prove: proofWithTarget }));
    expect(second?.retired).toEqual([]);
    const txnsAfterSecond = readdirSync(txnRoot).filter((name) => name.startsWith('txn-'));
    expect(txnsAfterSecond).toEqual(txnsAfterFirst);
  });
});

describe('convergeCodexPluginOnly preservedCollisions counts only real on-disk collisions (PR #2572)', () => {
  // planCodexFallbackRetirement records every absent canonical skill as a
  // {accepted:false, reason:'missing'} preserved entry. These runs use the REAL
  // plan (no `plan` override) so the 'missing' entries are actually produced and
  // the filter is exercised. describeCodexIntegration only appends the
  // "preserved N personal collision(s)" note when the count is > 0, so a count
  // of 0 keeps the phantom collision phrase out of the user-facing detail.
  test('post-migration second run: only the quarantine root remains, all canonical skills migrated → 0 collisions', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-postmigration-'));
    // Post-migration steady state: every canonical skill has left the top level
    // (moved under the retirement transaction root during the first run).
    mkdirSync(join(fallback, CODEX_FALLBACK_RETIREMENT_ROOT), { recursive: true });
    const outcome = convergeCodexPluginOnly(baseConvergeOptions(fallback));
    expect(outcome?.preservedCollisions).toBe(0);
    expect(outcome?.result.preservedCollisions).toBe(0);
    expect(outcome?.retired).toEqual([]);
  });

  test('fallback dir exists with no top-level canonical skills present → 0 collisions', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-noncanonical-'));
    // A non-canonical personal skill name never enters the plan (it is not in
    // skillNames), so it can neither be retired nor inflate the collision count.
    mkdirSync(join(fallback, 'my-personal-skill'), { recursive: true });
    writeFileSync(join(fallback, 'my-personal-skill', 'SKILL.md'), '# personal\n');
    const outcome = convergeCodexPluginOnly(baseConvergeOptions(fallback));
    expect(outcome?.preservedCollisions).toBe(0);
    expect(outcome?.result.preservedCollisions).toBe(0);
  });

  test('a real modified-managed collision still counts', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-realcollision-'));
    // A managed 'wish' skill whose on-disk tree diverges from its recorded
    // marker digest classifies as modified-tree: a genuine personal collision.
    const skillDir = join(fallback, 'wish');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# wish skill\n');
    stampFallbackSkill(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '# wish skill (locally modified)\n');
    const outcome = convergeCodexPluginOnly(baseConvergeOptions(fallback));
    expect(outcome?.preservedCollisions).toBe(1);
    expect(outcome?.result.preservedCollisions).toBe(1);
    expect(outcome?.retired).toEqual([]);
  });

  test('a well-formed but unrecognized marker is preserved distinctly, not counted as a personal collision', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-unrecognized-'));
    // A well-formed genie marker (managedBy/identityVersion/digest all
    // self-consistent, so the tree was never locally modified) whose
    // (skillName, digest) is not in the frozen historical allowlist and has
    // no verified target match. This is unrecognized managed content, not a
    // personal collision — the fix must not lump it into the collision count.
    const skillDir = join(fallback, 'wish');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# unrecognized wish content, never shipped by genie\n');
    stampFallbackSkill(skillDir, 'fixture-vNext');
    const outcome = convergeCodexPluginOnly(baseConvergeOptions(fallback));
    expect(outcome?.preservedCollisions).toBe(0);
    expect(outcome?.result.preservedCollisions).toBe(0);
    expect(outcome?.preservedUnrecognized).toBe(1);
    expect(outcome?.result.preservedUnrecognized).toBe(1);
    expect(outcome?.retired).toEqual([]);
  });
});

describe('describeCodexIntegration reports unrecognized fallbacks distinctly from personal collisions', () => {
  test('install detail text separates "unrecognized managed fallback" from "personal collision"', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-unrecognized-detail-'));
    const skillDir = join(fallback, 'wish');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# unrecognized wish content, never shipped by genie\n');
    stampFallbackSkill(skillDir, 'fixture-vNext');

    const result = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot: '/fixture/bundle',
      codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-home-unrecognized-')),
      detected: { codex: true },
      codexPluginOnly: {
        converge: () => healthyPluginResult(),
        probe: () => healthyCodexProbe(),
        prove: () => healthyCodexProof(),
        runSession: () => ({
          ok: true,
          detail: 'ok',
          tools: [...REQUIRED_GENIE_MCP_TOOLS],
          wishStatusReadOnly: true,
        }),
        installAgents: () => ({ installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] }),
        fallbackSkillsDir: fallback,
      },
    })[0];

    expect(result?.ok).toBe(true);
    expect(result?.preservedUnrecognized).toBe(1);
    expect(result?.preservedCollisions).toBe(0);
    expect(result?.detail).toContain('preserved 1 unrecognized managed fallback');
    expect(result?.detail).not.toContain('personal collision');
  });

  test('install detail text still reports a genuine collision as "personal collision"', () => {
    const fallback = mkdtempSync(join(tmpdir(), 'genie-fallback-collision-detail-'));
    const skillDir = join(fallback, 'wish');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# wish skill\n');
    stampFallbackSkill(skillDir);
    writeFileSync(join(skillDir, 'SKILL.md'), '# wish skill (locally modified)\n');

    const result = installRuntimeIntegrations({
      selection: 'codex',
      bundleRoot: '/fixture/bundle',
      codexHome: mkdtempSync(join(tmpdir(), 'genie-codex-home-collision-')),
      detected: { codex: true },
      codexPluginOnly: {
        converge: () => healthyPluginResult(),
        probe: () => healthyCodexProbe(),
        prove: () => healthyCodexProof(),
        runSession: () => ({
          ok: true,
          detail: 'ok',
          tools: [...REQUIRED_GENIE_MCP_TOOLS],
          wishStatusReadOnly: true,
        }),
        installAgents: () => ({ installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] }),
        fallbackSkillsDir: fallback,
      },
    })[0];

    expect(result?.ok).toBe(true);
    expect(result?.preservedCollisions).toBe(1);
    expect(result?.preservedUnrecognized).toBe(0);
    expect(result?.detail).toContain('preserved 1 personal collision');
    expect(result?.detail).not.toContain('unrecognized managed fallback');
  });
});

describe('proveCodexPluginHealth reject-before-retirement matrix (R4)', () => {
  // The active plugin root must resolve to the canonical Codex cache path, so
  // the fixture places the plugin skills tree under codexHome/plugins/cache/...
  const codexHome = mkdtempSync(join(tmpdir(), 'genie-prove-codex-home-'));
  const target = join(codexHome, 'plugins', 'cache', 'automagik', 'genie', VERSION);
  const skillsRoot = join(target, 'skills');
  for (const name of CANONICAL_GENIE_SKILL_NAMES) {
    mkdirSync(join(skillsRoot, name), { recursive: true });
    writeFileSync(join(skillsRoot, name, 'SKILL.md'), `# ${name}\n`);
  }
  const healthyOpts = (): ProveCodexPluginHealthOptions => ({
    snapshot: healthyCodexProbe(target),
    bundleRoot: '/fixture/bundle',
    codexHome,
    expectedVersion: VERSION,
    verifyCodexPayload: () => undefined,
    runSession: () => ({ ok: true, detail: 'ok', tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true }),
    skillInventory: [...CANONICAL_GENIE_SKILL_NAMES],
  });

  test('accepts a healthy snapshot and returns a frozen proof', () => {
    const proof = proveCodexPluginHealth(healthyOpts());
    expect(proof.version).toBe(1);
    expect(proof.payload).toHaveLength(CANONICAL_GENIE_SKILL_NAMES.length);
    expect(proof.mcp.wishStatusReadOnly).toBe(true);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof.payload)).toBe(true);
    expect(() => {
      (proof as { expectedVersion: string }).expectedVersion = 'tampered';
    }).toThrow();
  });

  const rejectCases: Array<[string, Partial<CodexPluginProbe>]> = [
    ['a disabled plugin', { enabled: false }],
    ['a wrong-version plugin', { version: '0.0.0' }],
    ['an unusable launcher', { usable: false }],
    ['an ambiguous active root', { activePluginRoot: undefined }],
    ['an errored snapshot', { status: 'error' }],
  ];
  for (const [label, snapshotOverride] of rejectCases) {
    test(`rejects ${label} before retirement`, () => {
      const opts = healthyOpts();
      opts.snapshot = { ...opts.snapshot, ...snapshotOverride };
      expect(() => proveCodexPluginHealth(opts)).toThrow('rejected before retirement');
    });
  }

  test('rejects payload identity drift (verifyCodexPayload throws)', () => {
    const opts = healthyOpts();
    opts.verifyCodexPayload = () => {
      throw new Error('installed Codex plugin payload identity mismatch');
    };
    expect(() => proveCodexPluginHealth(opts)).toThrow('payload identity mismatch');
  });

  test('rejects a skill-inventory drift (an expected plugin skill is missing)', () => {
    const opts = healthyOpts();
    opts.skillInventory = [...CANONICAL_GENIE_SKILL_NAMES, 'not-a-real-skill'];
    expect(() => proveCodexPluginHealth(opts)).toThrow('rejected before retirement');
  });

  test('rejects a bounded MCP session failure (missing tool)', () => {
    const opts = healthyOpts();
    opts.runSession = () => ({ ok: false, detail: 'missing required Genie tools: genie_wish_status' });
    expect(() => proveCodexPluginHealth(opts)).toThrow('rejected before retirement');
  });

  test('rejects a non-read-only wish_status even when the session reports ok', () => {
    const opts = healthyOpts();
    opts.runSession = () => ({
      ok: true,
      detail: 'ok',
      tools: [...REQUIRED_GENIE_MCP_TOOLS],
      wishStatusReadOnly: false,
    });
    expect(() => proveCodexPluginHealth(opts)).toThrow('rejected before retirement');
  });

  test('rejects an activePluginRoot diverging from the derived canonical cache path before any digest or MCP launch', () => {
    // Simulate a future Codex emitting an installedPath that is physically valid
    // but lives OUTSIDE codexHome/plugins/cache/automagik/genie/<version>.
    const divergent = mkdtempSync(join(tmpdir(), 'genie-divergent-plugin-root-'));
    const divergentSkills = join(divergent, 'skills');
    for (const name of CANONICAL_GENIE_SKILL_NAMES) {
      mkdirSync(join(divergentSkills, name), { recursive: true });
      writeFileSync(join(divergentSkills, name, 'SKILL.md'), `# ${name}\n`);
    }
    const opts = healthyOpts();
    opts.snapshot = healthyCodexProbe(divergent);
    let digested = false;
    let launched = false;
    opts.verifyCodexPayload = () => {
      digested = true;
    };
    opts.runSession = () => {
      launched = true;
      return { ok: true, detail: 'ok', tools: [...REQUIRED_GENIE_MCP_TOOLS], wishStatusReadOnly: true };
    };
    // Health must reject (no proof returned → no retirement is ever authorized)
    // and the actionable error must name the divergent root.
    expect(() => proveCodexPluginHealth(opts)).toThrow('rejected before retirement');
    expect(() => proveCodexPluginHealth(opts)).toThrow(divergent);
    // The rejection lands BEFORE the payload verifier, the skill digesting, and
    // the MCP session launch.
    expect(digested).toBe(false);
    expect(launched).toBe(false);
  });
});

describe('translateRetirementConflicts surfaces R8 conflict classes as manual-recovery guidance', () => {
  for (const substring of [
    'source changed after planning',
    'source changed at move boundary',
    'changed evidence retained',
    'restored source changed during cleanup',
    'restored source changed during disposal',
    'kept live and incoming versions for review',
    'kept both versions for review',
    'kept live removal transaction for review',
  ]) {
    test(`translates "${substring}" into actionable manual-recovery text (not raw)`, () => {
      expect(() =>
        translateRetirementConflicts(() => {
          throw new Error(`fallback retirement ${substring} at /somewhere`);
        }),
      ).toThrow('needs manual recovery');
    });
  }

  test('passes through a non-conflict error unchanged', () => {
    expect(() =>
      translateRetirementConflicts(() => {
        throw new Error('some unrelated failure');
      }),
    ).toThrow('some unrelated failure');
  });

  test('returns the step result when it does not throw', () => {
    expect(translateRetirementConflicts(() => 42)).toBe(42);
  });
});

describe('inspectCodexFallbackTier (shared doctor/uninstall classifier — read-only)', () => {
  let tmp: string;
  let agentsSkillsDir: string;

  function seedManaged(name: string, mutate?: (dir: string) => void): string {
    const dir = join(agentsSkillsDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
    const digest = computeDirDigest(dir);
    writeFileSync(
      join(dir, '.genie-sync.json'),
      JSON.stringify({ managedBy: 'genie-agent-sync', version: '1', digest, syncedAt: 'now' }),
      'utf8',
    );
    mutate?.(dir);
    return dir;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fallback-tier-'));
    agentsSkillsDir = join(tmp, 'agents', 'skills');
    mkdirSync(agentsSkillsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('absent tier → all-zero report (no mutation, no throw)', () => {
    const report = inspectCodexFallbackTier(join(tmp, 'nonexistent'));
    expect(report).toEqual({
      cleanFallbacks: [],
      preservedCollisions: [],
      preservedCollisionClass: {},
      quarantinedTransactions: 0,
      retainedEvidence: [],
    });
  });

  test('classifies clean fallbacks, personal collisions, and unmanaged skills distinctly', () => {
    seedManaged('wish');
    seedManaged('work');
    // Personal edit after sync → managed-modified.
    seedManaged('review', (dir) => writeFileSync(join(dir, 'SKILL.md'), '# personal\n', 'utf8'));
    // Corrupt marker → corrupt-metadata (malformed-marker).
    seedManaged('trace', (dir) => writeFileSync(join(dir, '.genie-sync.json'), '{ broken', 'utf8'));
    // Unmanaged personal skill → never counted.
    const mine = join(agentsSkillsDir, 'my-own');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'SKILL.md'), '# mine\n', 'utf8');

    const report = inspectCodexFallbackTier(agentsSkillsDir);
    expect(report.cleanFallbacks).toEqual(['wish', 'work']);
    expect(report.preservedCollisions).toEqual(['review', 'trace']);
    // Decision 5: each preserved collision carries its classification for doctor.
    expect(report.preservedCollisionClass).toEqual({ review: 'modified-managed', trace: 'malformed-marker' });
    expect(report.quarantinedTransactions).toBe(0);
  });

  test('counts committed quarantine transactions and flags retained changed-evidence (R8) without recursing into them', () => {
    const root = join(agentsSkillsDir, CODEX_FALLBACK_RETIREMENT_ROOT);
    // One plain committed transaction, one with archived changed-tree evidence.
    mkdirSync(join(root, 'txn-aaaa', 'quarantine', 'wish'), { recursive: true });
    writeFileSync(join(root, 'txn-aaaa', 'quarantine', 'wish', '.genie-sync.json'), '{}', 'utf8');
    mkdirSync(join(root, 'txn-bbbb', 'evidence', 'work'), { recursive: true });
    writeFileSync(join(root, 'txn-bbbb', 'evidence', 'work', 'SKILL.md'), '# changed\n', 'utf8');
    // A lock file / temp is not a transaction.
    writeFileSync(join(root, '.retirement.lock'), '', 'utf8');

    const report = inspectCodexFallbackTier(agentsSkillsDir);
    expect(report.quarantinedTransactions).toBe(2);
    expect(report.retainedEvidence).toEqual(['txn-bbbb']);
    // The quarantine root is never mistaken for a managed fallback.
    expect(report.cleanFallbacks).toEqual([]);
    expect(report.preservedCollisions).toEqual([]);
  });
});
