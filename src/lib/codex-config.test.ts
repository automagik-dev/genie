import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEAD_GENIE_OTEL_EXPORTER, getCodexConfigPath, getCodexHome, migrateDeadGenieOtel } from './codex-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migrateDeadGenieOtel', () => {
  test('backs up and removes only the exact obsolete exporter', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-config-'));
    roots.push(root);
    const path = join(root, 'config.toml');
    const original = `disable_paste_burst = true\n[otel]\n${DEAD_GENIE_OTEL_EXPORTER}\nlog_user_prompt = true\n`;
    writeFileSync(path, original);
    const result = migrateDeadGenieOtel(path, new Date('2026-07-10T00:00:00Z'));
    expect(result.status).toBe('changed');
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
    expect(readFileSync(path, 'utf8')).toBe('disable_paste_burst = true\n[otel]\nlog_user_prompt = true\n');
  });

  test('preserves unrelated exporters and writes no backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-codex-config-'));
    roots.push(root);
    const path = join(root, 'config.toml');
    const content = '[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:4318/v1/traces" } }\n';
    writeFileSync(path, content);
    expect(migrateDeadGenieOtel(path).status).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(content);
  });
});

describe('Codex home resolution', () => {
  test('the compatibility helpers delegate empty CODEX_HOME to the canonical safe fallback', () => {
    const env = { CODEX_HOME: '' } as NodeJS.ProcessEnv;
    expect(getCodexHome(env)).not.toBe('');
    expect(getCodexHome(env)).toEndWith('/.codex');
    expect(getCodexConfigPath(env)).toBe(join(getCodexHome(env), 'config.toml'));
  });
});
