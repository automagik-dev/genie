import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesConfigError, mergeMcpServersGenie, resolveGenieBinaryPath } from './hermes-mcp-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
  const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-'));
  roots.push(root);
  return root;
}

/** Absolute binary path good enough for the merge under test. */
function bin(root: string): string {
  return join(root, 'bin', 'genie');
}

describe('resolveGenieBinaryPath', () => {
  test('rejects an empty binary path with a typed error', () => {
    const root = tmp();
    expect(() => resolveGenieBinaryPath({ binaryPath: '', genieHome: root, fsExists: () => false })).toThrow(
      HermesConfigError,
    );
  });

  test('rejects a relative binary path with a typed error', () => {
    const root = tmp();
    expect(() => resolveGenieBinaryPath({ binaryPath: 'bin/genie', genieHome: root, fsExists: () => false })).toThrow(
      HermesConfigError,
    );
  });

  test('prefers the absolute $GENIE_HOME/bin/genie when present, over an explicit override', () => {
    const root = tmp();
    const preferred = join(root, 'bin', 'genie');
    const resolved = resolveGenieBinaryPath({
      binaryPath: '/some/other/abs/genie',
      genieHome: root,
      fsExists: (p) => p === preferred,
    });
    expect(resolved).toBe(preferred);
  });

  test('falls back to an explicit absolute override when $GENIE_HOME/bin/genie is absent', () => {
    const root = tmp();
    const resolved = resolveGenieBinaryPath({
      binaryPath: '/opt/genie/bin/genie',
      genieHome: root,
      fsExists: () => false,
    });
    expect(resolved).toBe('/opt/genie/bin/genie');
  });

  test('throws when nothing resolves to an absolute binary', () => {
    const root = tmp();
    expect(() => resolveGenieBinaryPath({ genieHome: root, fsExists: () => false })).toThrow(HermesConfigError);
  });
});

describe('mergeMcpServersGenie', () => {
  test('missing config.yaml → creates a minimal file with only mcp_servers.genie', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const result = mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false });

    expect(result.status).toBe('created');
    expect(result.backupPath).toBeUndefined();
    expect(existsSync(configPath)).toBe(true);

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: { genie: { command: string; args: string[] } };
    };
    expect(Object.keys(parsed)).toEqual(['mcp_servers']);
    expect(Object.keys(parsed.mcp_servers)).toEqual(['genie']);
    expect(parsed.mcp_servers.genie.command).toBe(bin(root));
    expect(parsed.mcp_servers.genie.args).toEqual(['mcp']);
  });

  test('empty binary path is rejected with a typed error and writes nothing', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    expect(() => mergeMcpServersGenie({ configPath, binaryPath: '', genieHome: root, fsExists: () => false })).toThrow(
      HermesConfigError,
    );
    expect(existsSync(configPath)).toBe(false);
  });

  test('preserves unrelated top-level keys byte-for-byte when appending mcp_servers', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original = 'version: 1\nproviders:\n  openai:\n    api_key: "sk-secret"   # do not touch\nlog_level: debug\n';
    writeFileSync(configPath, original);

    const result = mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false });
    expect(result.status).toBe('created');

    const after = readFileSync(configPath, 'utf8');
    // Every original byte survives verbatim as a prefix; only mcp_servers is appended.
    expect(after.startsWith(original)).toBe(true);

    const parsed = Bun.YAML.parse(after) as {
      version: number;
      providers: { openai: { api_key: string } };
      log_level: string;
      mcp_servers: { genie: { command: string } };
    };
    expect(parsed.version).toBe(1);
    expect(parsed.providers.openai.api_key).toBe('sk-secret');
    expect(parsed.log_level).toBe('debug');
    expect(parsed.mcp_servers.genie.command).toBe(bin(root));
  });

  test('existing mcp_servers.genie with the same command → no write, file unchanged, no backup', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    const original = `mcp_servers:\n  genie:\n    command: ${JSON.stringify(command)}\n    args:\n      - mcp\n`;
    writeFileSync(configPath, original);

    const result = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(result.status).toBe('unchanged');
    expect(result.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    // No backup files were created.
    expect(existsSync(`${configPath}`)).toBe(true);
  });

  test('existing different genie entry → updates only that entry, backs up first, keeps siblings', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original =
      'mcp_servers:\n' +
      '  other:\n' +
      '    command: /usr/bin/other\n' +
      '    args:\n' +
      '      - serve\n' +
      '  genie:\n' +
      '    command: /old/stale/genie\n' +
      '    args:\n' +
      '      - mcp\n' +
      'telemetry:\n' +
      '  enabled: true\n';
    writeFileSync(configPath, original);

    const command = bin(root);
    const result = mergeMcpServersGenie({
      configPath,
      binaryPath: command,
      genieHome: root,
      fsExists: () => false,
      now: new Date('2026-07-12T00:00:00Z'),
    });

    expect(result.status).toBe('updated');
    expect(result.backupPath).toBeDefined();
    // Backup captured the original bytes before mutation.
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(original);

    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: { other: { command: string; args: string[] }; genie: { command: string; args: string[] } };
      telemetry: { enabled: boolean };
    };
    // genie updated to the resolved command.
    expect(parsed.mcp_servers.genie.command).toBe(command);
    expect(parsed.mcp_servers.genie.args).toEqual(['mcp']);
    // Sibling server and unrelated top-level key preserved — never deleted.
    expect(parsed.mcp_servers.other).toEqual({ command: '/usr/bin/other', args: ['serve'] });
    expect(parsed.telemetry).toEqual({ enabled: true });
  });

  test('is idempotent: a second merge after an update is a no-op unchanged', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    writeFileSync(configPath, 'mcp_servers:\n  genie:\n    command: /old/genie\n    args:\n      - mcp\n');
    const command = bin(root);

    const first = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(first.status).toBe('updated');
    const afterFirst = readFileSync(configPath, 'utf8');

    const second = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(second.status).toBe('unchanged');
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  test('optional env.GENIE_HOME is emitted when requested', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const result = mergeMcpServersGenie({
      configPath,
      binaryPath: bin(root),
      genieHome: root,
      fsExists: () => false,
      includeGenieHomeEnv: true,
    });
    expect(result.entry.env).toEqual({ GENIE_HOME: root });
    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      mcp_servers: { genie: { env: { GENIE_HOME: string } } };
    };
    expect(parsed.mcp_servers.genie.env.GENIE_HOME).toBe(root);
  });
});
