import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type InstallIntegrationsOptions,
  convergeClaudePlugin,
  inspectRuntimeIntegrationEvidence,
  installRuntimeIntegrations as installRuntimeIntegrationsWithPhysicalVerification,
  parseClaudePluginState,
  persistIntegrationConsent,
  readIntegrationConsent,
  removeCodexPluginRegistration,
  removeRuntimeIntegrations as removeRuntimeIntegrationsWithTrustedResolution,
  runBoundedIntegrationCommand,
  setCodexPluginEnabled,
  verifyClaudePhysicalPayload,
} from './runtime-integrations.js';
import { VERSION } from './version.js';

function installRuntimeIntegrations(options: InstallIntegrationsOptions) {
  return installRuntimeIntegrationsWithPhysicalVerification({
    ...options,
    genieHome: options.genieHome ?? options.stateDir ?? options.claudeHome,
    resolveExecutable: options.resolveExecutable ?? ((name) => name),
    verifyClaudePayload: options.verifyClaudePayload ?? (() => undefined),
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

  for (const [label, entry] of [
    ['missing enabled', { id: 'genie@automagik', version: VERSION }],
    ['string enabled', { id: 'genie@automagik', enabled: 'false', version: VERSION }],
    ['missing version', { id: 'genie@automagik', enabled: false }],
    ['non-string version', { id: 'genie@automagik', enabled: false, version: 123 }],
    ['unsafe version', { id: 'genie@automagik', enabled: false, version: '5.0.0\nforged' }],
  ] as const) {
    test(`rejects a Claude matching entry with ${label}`, () => {
      expect(parseClaudePluginState(JSON.stringify([entry]))).toMatchObject({ ok: false });
    });
  }

  test('restores an explicit Codex disabled state without touching other plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-plugin-state-'));
    const path = join(root, 'config.toml');
    writeFileSync(path, '[plugins."genie@automagik"]\nenabled = true\n\n[plugins."other@market"]\nenabled = true\n');
    setCodexPluginEnabled(false, path);
    expect(readFileSync(path, 'utf8')).toBe(
      '[plugins."genie@automagik"]\nenabled = false\n\n[plugins."other@market"]\nenabled = true\n',
    );
  });

  test('install subprocess timeout is bounded and returned as a structured runtime failure', () => {
    const claudeHome = mkdtempSync(join(tmpdir(), 'genie-claude-timeout-'));
    const observedTimeouts: number[] = [];
    const result = installRuntimeIntegrations({
      selection: 'claude',
      bundleRoot: join(import.meta.dir, '..', '..'),
      claudeHome,
      detected: { claude: true },
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

describe('removeCodexPluginRegistration — plugin-era retirement preserves every unrelated byte', () => {
  function configWith(body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-retire-'));
    const path = join(root, 'config.toml');
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o600 });
    return path;
  }

  test('drops the plugin table and both hooks.state shapes, keeping unrelated tables byte-for-byte', () => {
    const path = configWith(
      [
        '# operator preamble',
        'disable_paste_burst = true',
        '',
        '[otel]',
        'exporter = { otlp-http = { endpoint = "http://127.0.0.1:14318/v1/traces", protocol = "binary" } }',
        '',
        '[plugins."genie@automagik"]',
        'enabled = true',
        'version = "5.260830.19"',
        '',
        '[plugins."other@market"]  # keep me',
        'enabled = true',
        '',
        '[hooks.state]',
        '"genie@automagik:session_start" = "approved"',
        '"other@market:pre_tool_use" = "approved"',
        '',
        '[hooks.state."genie@automagik:pre_tool_use"]',
        'decision = "allow"',
        '',
        '[profiles.work]',
        'model = "gpt-5"',
        '',
      ].join('\n'),
    );

    const result = removeCodexPluginRegistration(path);
    expect(result).toMatchObject({ ok: true, status: 'removed' });
    expect(result.removed).toEqual([
      '[plugins."genie@automagik"]',
      '"genie@automagik:session_start" = "approved"',
      '[hooks.state."genie@automagik:pre_tool_use"]',
    ]);
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '# operator preamble',
        'disable_paste_burst = true',
        '',
        '[otel]',
        'exporter = { otlp-http = { endpoint = "http://127.0.0.1:14318/v1/traces", protocol = "binary" } }',
        '',
        '[plugins."other@market"]  # keep me',
        'enabled = true',
        '',
        '[hooks.state]',
        '"other@market:pre_tool_use" = "approved"',
        '',
        '[profiles.work]',
        'model = "gpt-5"',
        '',
      ].join('\n'),
    );
  });

  test('a config without any genie registration round-trips byte-identically', () => {
    const body = '[otel]\nexporter = "keep"\n\n[plugins."other@market"]\nenabled = true\n';
    const path = configWith(body);
    expect(removeCodexPluginRegistration(path)).toMatchObject({ ok: true, status: 'unchanged', removed: [] });
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  test('a second run is a no-op: retirement is idempotent, and file mode survives', () => {
    const path = configWith('[plugins."genie@automagik"]\nenabled = true\n');
    expect(removeCodexPluginRegistration(path).status).toBe('removed');
    const after = readFileSync(path, 'utf8');
    expect(removeCodexPluginRegistration(path)).toMatchObject({ status: 'unchanged' });
    expect(readFileSync(path, 'utf8')).toBe(after);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  test('a multi-line string body that looks like the genie table never starts a drop', () => {
    // Shape 1: the fake header lives inside an unrelated operator's multi-line
    // value. A line-level scanner that ignores multi-line strings reads it as a
    // real table header, starts dropping, and eats the rest of that value plus
    // every line up to the next header — destroying a user-owned config.
    const body = [
      '[notes]',
      'text = """',
      '[plugins."genie@automagik"]',
      'enabled = true',
      '"""',
      '',
      '# a trailing comment',
      '[profiles.work]',
      'model = "gpt-5"',
      '',
    ].join('\n');
    const path = configWith(body);
    expect(removeCodexPluginRegistration(path)).toMatchObject({ ok: true, status: 'unchanged', removed: [] });
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  test('a multi-line string inside the genie table cannot end its drop early', () => {
    // Shape 2: the genie table's own value carries a line that looks like a
    // header. Ending the drop there would leave `enabled = true` and the closing
    // delimiter behind as orphaned top-level keys, and would mis-scope the
    // following real table.
    const path = configWith(
      [
        '[plugins."genie@automagik"]',
        "description = '''",
        '[profiles.decoy]',
        'model = "decoy"',
        "'''",
        'enabled = true',
        '',
        '[profiles.work]  # keep me',
        'model = "gpt-5"',
        '',
      ].join('\n'),
    );
    const result = removeCodexPluginRegistration(path);
    expect(result).toMatchObject({ ok: true, status: 'removed' });
    expect(result.removed).toEqual(['[plugins."genie@automagik"]']);
    expect(readFileSync(path, 'utf8')).toBe(['[profiles.work]  # keep me', 'model = "gpt-5"', ''].join('\n'));
  });

  test('a hooks.state row that only appears inside a multi-line string is not dropped', () => {
    const body = ['[hooks.state]', 'note = """', '"genie@automagik:session_start" = "approved"', '"""', ''].join('\n');
    const path = configWith(body);
    expect(removeCodexPluginRegistration(path)).toMatchObject({ ok: true, status: 'unchanged', removed: [] });
    expect(readFileSync(path, 'utf8')).toBe(body);
  });

  test('a triple quote inside a single-line string or a comment opens nothing', () => {
    const body = [
      '[notes]',
      'inline = "a \\"\\"\\" b"  # """ not an opener either',
      '',
      '[plugins."genie@automagik"]',
      'enabled = true',
      '',
      '[profiles.work]',
      'model = "gpt-5"',
      '',
    ].join('\n');
    const path = configWith(body);
    expect(removeCodexPluginRegistration(path)).toMatchObject({ ok: true, status: 'removed' });
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '[notes]',
        'inline = "a \\"\\"\\" b"  # """ not an opener either',
        '',
        '[profiles.work]',
        'model = "gpt-5"',
        '',
      ].join('\n'),
    );
  });

  test('an absent config succeeds (nothing to retire); a symlinked one is refused untouched', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-retire-edge-'));
    expect(removeCodexPluginRegistration(join(root, 'config.toml'))).toMatchObject({ ok: true, status: 'absent' });

    const real = join(root, 'real.toml');
    writeFileSync(real, '[plugins."genie@automagik"]\nenabled = true\n');
    const link = join(root, 'config.toml');
    symlinkSync(real, link);
    expect(removeCodexPluginRegistration(link)).toMatchObject({ ok: false, status: 'error' });
    expect(readFileSync(real, 'utf8')).toBe('[plugins."genie@automagik"]\nenabled = true\n');
  });
});
