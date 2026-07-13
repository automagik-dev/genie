import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLifecycleLease, lifecycleLockPath } from '../lib/agent-sync.js';
import { loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';
import {
  beginIntegrationConsentTransition,
  clearIntegrationConsentTransition,
  installRuntimeIntegrations,
  persistIntegrationConsent,
  readIntegrationConsent,
  readIntegrationConsentState,
} from '../lib/runtime-integrations.js';
import { VERSION } from '../lib/version.js';
import { type SetupDeps, mergeCodexIntegrationConsent, resolveDefaultAgentAfterCodex, setupCommand } from './setup.js';

// resolveDefaultAgentAfterCodex is the single decision point `genie setup
// --codex` runs through before saving runtime.defaultAgent (setup.ts wires it
// directly into the --codex branch), so these tests pin the whole contract:
// codex configuring must never steal an explicit agent choice. The helper is
// pure aside from reading the config path for the hint text — it writes nothing.

describe('resolveDefaultAgentAfterCodex', () => {
  test("'auto' (never-chosen default) flips to codex with no hint", () => {
    expect(resolveDefaultAgentAfterCodex('auto')).toEqual({ agent: 'codex' });
  });

  test("an explicit 'claude' is preserved and the user gets a switch hint instead", () => {
    const decision = resolveDefaultAgentAfterCodex('claude');
    expect(decision.agent).toBe('claude');
    expect(decision.hint).toContain("stays 'claude'");
    expect(decision.hint).toContain('"defaultAgent": "codex"');
    // The hint points at the real config file location.
    expect(decision.hint).toContain('config.json');
  });

  test("an already-'codex' setting is idempotent with no hint", () => {
    expect(resolveDefaultAgentAfterCodex('codex')).toEqual({ agent: 'codex' });
  });
});

describe('mergeCodexIntegrationConsent', () => {
  test('adds Codex without dropping an existing explicit Claude scope', () => {
    expect(mergeCodexIntegrationConsent('none')).toBe('codex');
    expect(mergeCodexIntegrationConsent('claude')).toBe('all');
    expect(mergeCodexIntegrationConsent('codex')).toBe('codex');
    expect(mergeCodexIntegrationConsent('all')).toBe('all');
    expect(mergeCodexIntegrationConsent('auto')).toBe('auto');
  });
});

describe('setup runtime and failure semantics', () => {
  let root: string;
  let priorGenieHome: string | undefined;
  let priorCodexHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-setup-'));
    priorGenieHome = process.env.GENIE_HOME;
    priorCodexHome = process.env.CODEX_HOME;
    process.env.GENIE_HOME = join(root, 'genie-home');
    process.env.CODEX_HOME = join(root, 'codex-home');
    mkdirSync(join(root, 'repo'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(root, 'repo') });
    process.exitCode = 0;
  });

  afterEach(() => {
    if (priorGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
    else process.env.GENIE_HOME = priorGenieHome;
    if (priorCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
    else process.env.CODEX_HOME = priorCodexHome;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  function deps(ok = true, preservedDisabled = false, hookReviewRequired = false): SetupDeps {
    const d: SetupDeps = {
      cwd: join(root, 'repo'),
      resolveExecutable: () => '/fixture/bin/codex',
      validateExecutable: (_name, path) => path,
      checkCommand: async () => ({ exists: true, version: 'fixture' }),
      probeCodexGeniePlugin: () => ({
        cliAvailable: true,
        status: 'ok',
        installed: true,
        enabled: !preservedDisabled,
        version: VERSION,
        activePluginRoot: join(root, 'codex-home', 'plugins', 'cache', 'automagik', 'genie', VERSION),
        usable: !preservedDisabled,
        usabilityDetail: preservedDisabled ? 'installed plugin remains disabled' : 'fixture launcher usable',
        detail: preservedDisabled ? 'installed plugin remains disabled' : 'fixture launcher usable',
      }),
      // The real installRuntimeIntegrations converges + probes ONCE internally and
      // surfaces that single snapshot on the codex result (R1/A5). The mock mirrors
      // that: it invokes the (possibly test-overridden) probe once and threads the
      // snapshot so repairCodexIntegration never re-probes.
      installRuntimeIntegrations: (() => [
        {
          runtime: 'codex' as const,
          ok,
          detail: ok ? 'fixture integration installed' : 'fixture integration failed',
          preservedDisabled,
          hookReviewRequired,
          snapshot: ok ? d.probeCodexGeniePlugin?.() : undefined,
        },
      ]) as SetupDeps['installRuntimeIntegrations'],
    };
    return d;
  }

  test('sectional setup preserves an explicit Claude choice', async () => {
    const config = await loadGenieConfig();
    config.runtime.defaultAgent = 'claude';
    await saveGenieConfig(config);
    await setupCommand({ codex: true, quick: true }, deps());
    expect((await loadGenieConfig()).runtime.defaultAgent).toBe('claude');
    expect(process.exitCode).not.toBe(1);
  });

  test('successful setup --codex persists durable consent and merges a prior Claude-only scope', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    persistIntegrationConsent('claude', genieHome);

    await setupCommand({ codex: true, quick: true }, deps());

    expect(readIntegrationConsent(genieHome)).toBe('all');
    expect(process.exitCode).not.toBe(1);
  });

  test('setup prints hook review guidance only when hook definition bytes changed', async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      await setupCommand({ codex: true, quick: true }, deps(true, false, false));
      expect(lines.join('\n')).not.toContain('Review Genie hooks with /hooks');
      lines.length = 0;
      await setupCommand({ codex: true, quick: true }, deps(true, false, true));
      expect(lines.join('\n')).toContain('Review Genie hooks with /hooks, then start a new Codex task.');
    } finally {
      console.log = originalLog;
    }
  });

  test('full quick setup applies the never-chosen auto to Codex decision', async () => {
    await setupCommand({ quick: true }, deps());
    const saved = await loadGenieConfig();
    expect(saved.runtime.defaultAgent).toBe('codex');
    expect(saved.setupComplete).toBe(true);
    expect(process.exitCode).not.toBe(1);
  });

  test('a preserved disabled plugin keeps the project MCP fallback usable', async () => {
    await setupCommand({ codex: true, quick: true }, deps(true, true));
    const fallback = await Bun.file(join(root, 'repo', '.codex', 'config.toml')).text();
    expect(fallback).toContain('# BEGIN GENIE MCP FALLBACK');
    expect(fallback).toContain('mcp_servers.genie.command');
  });

  test('setup uses one complete post-install probe and a healthy active plugin removes the fallback', async () => {
    const fallbackPath = join(root, 'repo', '.codex', 'config.toml');
    mkdirSync(join(root, 'repo', '.codex'), { recursive: true });
    writeFileSync(
      fallbackPath,
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old/genie"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n',
    );
    let probes = 0;
    const healthy = deps();
    const postInstall = healthy.probeCodexGeniePlugin;
    healthy.probeCodexGeniePlugin = () => {
      probes += 1;
      return postInstall?.() ?? { cliAvailable: false, status: 'unavailable', installed: false, detail: 'missing' };
    };
    await setupCommand({ codex: true, quick: true }, healthy);
    expect(probes).toBe(1);
    expect(readFileSync(fallbackPath, 'utf8')).not.toContain('GENIE MCP FALLBACK');
  });

  test('explicit integration failure is actionable, nonzero, preserves fallback, and does not save false success', async () => {
    const fallbackPath = join(root, 'repo', '.codex', 'config.toml');
    const fallback =
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/fixture/genie"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n';
    mkdirSync(join(root, 'repo', '.codex'), { recursive: true });
    writeFileSync(fallbackPath, fallback);
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      await setupCommand({ codex: true, quick: true }, deps(false));
    } finally {
      console.error = original;
    }
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('fixture integration failed');
    expect((await loadGenieConfig()).codex?.configured).not.toBe(true);
    expect(readFileSync(fallbackPath, 'utf8')).toBe(fallback);
    expect(readIntegrationConsentState(process.env.GENIE_HOME as string).state).toBe('pending');
  });

  test('an interrupted setup persists pending Codex consent before mutation and a retry commits it', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    persistIntegrationConsent('none', genieHome);

    await setupCommand({ codex: true, quick: true }, deps(false));
    expect(process.exitCode).toBe(1);
    expect(readIntegrationConsentState(genieHome)).toMatchObject({
      selection: 'codex',
      state: 'pending',
      previousSelection: 'none',
    });
    const pending = readIntegrationConsentState(genieHome);
    expect(pending.state === 'pending' ? pending.transitionToken : '').toMatch(/^[a-f0-9]{32}$/);

    process.exitCode = 0;
    await setupCommand({ codex: true, quick: true }, deps(true));
    expect(process.exitCode).not.toBe(1);
    expect(readIntegrationConsentState(genieHome)).toMatchObject({ selection: 'codex', state: 'committed' });
  });

  test('interactive decline runs under the lifecycle lease and cannot clear a newer pending transition', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    persistIntegrationConsent('none', genieHome);
    const observed = beginIntegrationConsentTransition('codex', genieHome);
    let leaseHeld = false;
    let clearSawLease = false;
    const interactive = deps();
    interactive.acquireLifecycleLease = () => {
      leaseHeld = true;
      return {
        path: lifecycleLockPath(genieHome),
        release: () => {
          leaseHeld = false;
        },
      };
    };
    interactive.confirm = () => {
      clearIntegrationConsentTransition(observed, genieHome);
      beginIntegrationConsentTransition('codex', genieHome);
      return Object.assign(Promise.resolve(false), { cancel: () => {} });
    };
    interactive.clearIntegrationConsentTransition = (transition, home) => {
      clearSawLease = leaseHeld;
      return clearIntegrationConsentTransition(transition, home);
    };

    await setupCommand({ codex: true }, interactive);

    expect(clearSawLease).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(readIntegrationConsentState(genieHome)).toMatchObject({ selection: 'codex', state: 'pending' });
  });

  test('string enabled in exact-version Codex post-state fails full setup and preserves fallback', async () => {
    const fallbackPath = join(root, 'repo', '.codex', 'config.toml');
    const fallback =
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/fixture/genie"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n';
    mkdirSync(join(root, 'repo', '.codex'), { recursive: true });
    writeFileSync(fallbackPath, fallback);
    let lists = 0;
    const strict = deps();
    strict.installRuntimeIntegrations = (() =>
      installRuntimeIntegrations({
        selection: 'codex',
        bundleRoot: join(import.meta.dir, '..', '..'),
        codexHome: process.env.CODEX_HOME,
        detected: { codex: true },
        resolveExecutable: (name) => name,
        runner(_command, args) {
          if (args.join(' ') === 'plugin list --json') {
            lists += 1;
            return {
              exitCode: 0,
              stdout:
                lists === 1
                  ? '{"installed":[]}'
                  : JSON.stringify({
                      installed: [{ pluginId: 'genie@automagik', enabled: 'false', version: VERSION }],
                    }),
              stderr: '',
            };
          }
          return { exitCode: 0, stdout: '{}', stderr: '' };
        },
      })) as SetupDeps['installRuntimeIntegrations'];
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      await setupCommand({ codex: true, quick: true }, strict);
    } finally {
      console.error = original;
    }

    expect(lists).toBe(2);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('enabled must be boolean');
    expect((await loadGenieConfig()).codex?.configured).not.toBe(true);
    expect(readFileSync(fallbackPath, 'utf8')).toBe(fallback);
  });

  test('an unmanaged project fallback blocks integration mutation and stays byte-identical', async () => {
    const configPath = join(root, 'repo', '.codex', 'config.toml');
    mkdirSync(join(root, 'repo', '.codex'), { recursive: true });
    const original = '[mcp_servers.genie]\ncommand = "/personal/genie"\nargs = ["mcp"]\n';
    await Bun.write(configPath, original);
    let installCalls = 0;
    const blocked = deps();
    blocked.installRuntimeIntegrations = (() => {
      installCalls += 1;
      return [];
    }) as SetupDeps['installRuntimeIntegrations'];
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      await setupCommand({ codex: true, quick: true }, blocked);
    } finally {
      console.error = originalError;
    }
    expect(installCalls).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('user-owned [mcp_servers.genie]');
    expect(await Bun.file(configPath).text()).toBe(original);
  });

  test('a timed-out Codex detection probe aborts before integration mutation', async () => {
    let installCalls = 0;
    const timedOut = deps();
    timedOut.checkCommand = async () => ({
      exists: true,
      timedOut: true,
      error: 'codex --version timed out after 30ms',
    });
    timedOut.installRuntimeIntegrations = (() => {
      installCalls += 1;
      return [];
    }) as SetupDeps['installRuntimeIntegrations'];
    const originalError = console.error;
    console.error = () => {};
    try {
      await setupCommand({ codex: true, quick: true }, timedOut);
    } finally {
      console.error = originalError;
    }
    expect(process.exitCode).toBe(1);
    expect(installCalls).toBe(0);
  });

  test('missing configured Node keeps fallback and reports the actionable reason', async () => {
    const unavailable = deps();
    unavailable.probeCodexGeniePlugin = () => ({
      cliAvailable: true,
      status: 'ok',
      installed: true,
      enabled: true,
      version: VERSION,
      usable: false,
      usabilityDetail: 'configured plugin MCP command "node" is not available on PATH',
      detail: 'configured plugin MCP command "node" is not available on PATH',
    });
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    try {
      await setupCommand({ codex: true, quick: true }, unavailable);
    } finally {
      console.log = originalLog;
    }
    expect(await Bun.file(join(root, 'repo', '.codex', 'config.toml')).text()).toContain('# BEGIN GENIE MCP FALLBACK');
    expect(lines.join('\n')).toContain('"node" is not available on PATH');
  });

  test('source-checkout setup performs zero writes while another process owns the GENIE_HOME lease', () => {
    const genieHome = process.env.GENIE_HOME as string;
    const lease = acquireLifecycleLease(genieHome);
    expect('skipped' in lease).toBe(false);
    if ('skipped' in lease) throw new Error(lease.skipped);
    const lockPath = lifecycleLockPath(genieHome);
    const ownerRecord = readFileSync(lockPath, 'utf8');
    const runnerPath = join(root, 'setup-contender.ts');
    writeFileSync(
      runnerPath,
      [
        `import { setupCommand } from ${JSON.stringify(join(import.meta.dir, 'setup.ts'))};`,
        'await setupCommand({ reset: true });',
      ].join('\n'),
    );
    try {
      const child = Bun.spawnSync(['bun', runnerPath], {
        env: { ...process.env, GENIE_HOME: genieHome },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(child.exitCode).toBe(1);
      expect(child.stderr.toString()).toContain('holds the lock');
      expect(existsSync(genieHome)).toBe(false);
      expect(readFileSync(lockPath, 'utf8')).toBe(ownerRecord);
    } finally {
      lease.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });
});
