import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  inspectRuntimeIntegrationEvidence,
  persistIntegrationConsent,
  readIntegrationConsent,
  removeRuntimeIntegrations as removeRuntimeIntegrationsWithTrustedResolution,
  runBoundedIntegrationCommand,
} from './runtime-integrations.js';
import { VERSION } from './version.js';

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

describe('bounded integration subprocess', () => {
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
          `const child = spawn(process.execPath, ["-e", ${JSON.stringify('process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)')}], { stdio: ["ignore", "pipe", "ignore"] });`,
          'child.stdout.once("data", () => process.stdout.write(String(child.pid)));',
          'process.on("SIGTERM",()=>{});',
          'setInterval(()=>{},1000);',
        ].join(''),
      ],
      // Allow both processes to start; stdout acknowledges the descendant's TERM handler.
      { timeoutMs: 1_000, maxOutputBytes: 1_024, killGraceMs: 30 },
    );
    expect(result.timedOut).toBe(true);
    // Empty output must never become PID 0 (our entire process group).
    expect(result.stdout).toMatch(/^[1-9][0-9]*$/);
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
});

describe('durable integration consent', () => {
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
