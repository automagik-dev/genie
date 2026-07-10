import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudePluginState,
  codexPluginState,
  installRuntimeIntegrations,
  setCodexPluginEnabled,
} from './runtime-integrations.js';

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
