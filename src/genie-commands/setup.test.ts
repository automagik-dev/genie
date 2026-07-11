import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';
import { type SetupDeps, resolveDefaultAgentAfterCodex, setupCommand } from './setup.js';

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
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (priorGenieHome === undefined) Reflect.deleteProperty(process.env, 'GENIE_HOME');
    else process.env.GENIE_HOME = priorGenieHome;
    if (priorCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
    else process.env.CODEX_HOME = priorCodexHome;
    process.exitCode = 0;
    rmSync(root, { recursive: true, force: true });
  });

  function deps(ok = true, preservedDisabled = false): SetupDeps {
    return {
      cwd: join(root, 'repo'),
      checkCommand: async () => ({ exists: true, version: 'fixture' }),
      inspectPluginUsability: () => ({ usable: true, detail: 'fixture launcher usable' }),
      installRuntimeIntegrations: (() => [
        {
          runtime: 'codex',
          ok,
          detail: ok ? 'fixture integration installed' : 'fixture integration failed',
          preservedDisabled,
        },
      ]) as SetupDeps['installRuntimeIntegrations'],
    };
  }

  test('sectional setup preserves an explicit Claude choice', async () => {
    const config = await loadGenieConfig();
    config.runtime.defaultAgent = 'claude';
    await saveGenieConfig(config);
    await setupCommand({ codex: true, quick: true }, deps());
    expect((await loadGenieConfig()).runtime.defaultAgent).toBe('claude');
    expect(process.exitCode).not.toBe(1);
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
    expect(fallback).toContain('[mcp_servers.genie]');
  });

  test('explicit integration failure is actionable, nonzero, and does not save false success', async () => {
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
    unavailable.inspectPluginUsability = () => ({
      usable: false,
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
});
