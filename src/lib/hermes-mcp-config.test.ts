import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HermesConfigError,
  hasDuplicateMcpGenieKeys,
  mergeMcpServersGenie,
  resolveGenieBinaryPath,
} from './hermes-mcp-config.js';

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

/** True when a `<config>.genie-backup-*` sibling exists in the dir. */
function hasBackup(root: string): boolean {
  return readdirSync(root).some((f) => f.includes('genie-backup'));
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

  // A top-level `mcp_servers:` carrying an inline/flow/scalar value on the same line
  // is refused with a typed error rather than blindly appending a duplicate top-level
  // key (which produced spec-invalid duplicate-key YAML, or silently deleted user
  // siblings on last-wins). The refusal happens before any backup or write.
  test('empty flow `mcp_servers: {}` → typed error, nothing written, no backup', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original = 'version: 1\nmcp_servers: {}\n';
    writeFileSync(configPath, original);

    expect(() =>
      mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false }),
    ).toThrow(HermesConfigError);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('flow-with-content is refused cleanly — user sibling survives verbatim, backup untouched', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original = 'mcp_servers: {other: {command: /usr/bin/other, args: [serve]}}\n';
    writeFileSync(configPath, original);

    expect(() =>
      mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false }),
    ).toThrow(HermesConfigError);
    // The user's sibling server is never deleted: the file is left byte-for-byte.
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('scalar/null on the same line `mcp_servers: null` → typed error, nothing written', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original = 'mcp_servers: null\n';
    writeFileSync(configPath, original);

    expect(() =>
      mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false }),
    ).toThrow(HermesConfigError);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('refusal is idempotent: a repeated call still throws and never writes or backs up', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const original = 'mcp_servers: {}\n';
    writeFileSync(configPath, original);

    for (let i = 0; i < 2; i++) {
      expect(() =>
        mergeMcpServersGenie({ configPath, binaryPath: bin(root), genieHome: root, fsExists: () => false }),
      ).toThrow(HermesConfigError);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
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

  // A YAML comment is valid at ANY indentation, including one deeper than the
  // real children. Before the fix, `childIndentOf` picked the comment's indent
  // as the block's child indent, `findChildRange` then missed the real `genie`/
  // sibling lines at the true indent, and a duplicate mis-indented `genie` block
  // was appended — producing output `Bun.YAML.parse` rejects. These cases lock
  // that class of bug down for good.
  describe('comment-line indentation (regression)', () => {
    test('repro: comment deeper-indented than the real sibling child still merges cleanly, output parses', () => {
      const root = tmp();
      const configPath = join(root, 'config.yaml');
      const original = 'mcp_servers:\n      # my servers\n  other:\n    command: x\n';
      writeFileSync(configPath, original);

      const result = mergeMcpServersGenie({
        configPath,
        binaryPath: bin(root),
        genieHome: root,
        fsExists: () => false,
      });
      expect(result.status).toBe('created');

      const text = readFileSync(configPath, 'utf8');
      // Exactly one genie child — no duplicate mis-indented append.
      expect(text.match(/^\s*genie:\s*$/gm)?.length).toBe(1);
      expect(text).toContain('      # my servers\n');

      const parsed = Bun.YAML.parse(text) as {
        mcp_servers: { other: { command: string }; genie: { command: string } };
      };
      expect(parsed.mcp_servers.other.command).toBe('x');
      expect(parsed.mcp_servers.genie.command).toBe(bin(root));
    });

    test('comment at a smaller indent than the genie child is skipped when deriving child indent', () => {
      const root = tmp();
      const configPath = join(root, 'config.yaml');
      const original =
        'mcp_servers:\n# top-level-ish comment\n  genie:\n    command: /old/genie\n    args:\n      - mcp\n';
      writeFileSync(configPath, original);

      const command = bin(root);
      const result = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      expect(result.status).toBe('updated');

      const text = readFileSync(configPath, 'utf8');
      expect(text.match(/^\s*genie:\s*$/gm)?.length).toBe(1);

      const parsed = Bun.YAML.parse(text) as { mcp_servers: { genie: { command: string } } };
      expect(parsed.mcp_servers.genie.command).toBe(command);
    });

    test('a comment sitting between the genie child and a later sibling does not swallow the sibling', () => {
      const root = tmp();
      const configPath = join(root, 'config.yaml');
      const original =
        'mcp_servers:\n' +
        '  genie:\n' +
        '    command: /old/genie\n' +
        '    args:\n' +
        '      - mcp\n' +
        '  # comment between children\n' +
        '  other:\n' +
        '    command: /usr/bin/other\n';
      writeFileSync(configPath, original);

      const command = bin(root);
      const result = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      expect(result.status).toBe('updated');

      const text = readFileSync(configPath, 'utf8');
      expect(text).toContain('  # comment between children\n');

      const parsed = Bun.YAML.parse(text) as {
        mcp_servers: { genie: { command: string }; other: { command: string } };
      };
      expect(parsed.mcp_servers.genie.command).toBe(command);
      expect(parsed.mcp_servers.other.command).toBe('/usr/bin/other');
    });

    test('a comment-only mcp_servers body (no real children yet) still derives a sane child indent and merges cleanly', () => {
      const root = tmp();
      const configPath = join(root, 'config.yaml');
      const original = 'mcp_servers:\n  # nothing configured yet\nother: 1\n';
      writeFileSync(configPath, original);

      const result = mergeMcpServersGenie({
        configPath,
        binaryPath: bin(root),
        genieHome: root,
        fsExists: () => false,
      });
      expect(result.status).toBe('created');

      const text = readFileSync(configPath, 'utf8');
      const parsed = Bun.YAML.parse(text) as { mcp_servers: { genie: { command: string } }; other: number };
      expect(parsed.mcp_servers.genie.command).toBe(bin(root));
      expect(parsed.other).toBe(1);
    });

    test('repro layout is idempotent: a second merge is unchanged and stays parseable', () => {
      const root = tmp();
      const configPath = join(root, 'config.yaml');
      writeFileSync(configPath, 'mcp_servers:\n      # my servers\n  other:\n    command: x\n');
      const command = bin(root);

      const first = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      expect(first.status).toBe('created');
      const afterFirst = readFileSync(configPath, 'utf8');
      Bun.YAML.parse(afterFirst); // still parses

      const second = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      expect(second.status).toBe('unchanged');
      expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
    });
  });
});

describe('DF-1: duplicate mcp_servers.genie key repair', () => {
  const markerBegin = '  # genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)';
  const markerEnd = '  # genie:managed:mcp_servers.genie — end';
  const managedBlock = (command: string) =>
    `${markerBegin}\n  genie:\n    command: ${JSON.stringify(command)}\n    args:\n      - mcp\n${markerEnd}\n`;

  test('an empty stray unmarked genie: key alongside the marker-wrapped region repairs to ONE entry, parseable, backup written', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    // An earlier buggy release left a bare `genie:` header with nothing under it,
    // alongside the current marker-wrapped managed region — spec-invalid
    // duplicate-key YAML that last-wins parsing hides.
    const original = `mcp_servers:\n  genie:\n${managedBlock(command)}`;
    writeFileSync(configPath, original);
    expect(hasDuplicateMcpGenieKeys(original)).toBe(true);

    const result = mergeMcpServersGenie({
      configPath,
      binaryPath: command,
      genieHome: root,
      fsExists: () => false,
      now: new Date('2026-07-13T00:00:00Z'),
    });
    expect(result.status).toBe('updated');
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string, 'utf8')).toBe(original);

    const text = readFileSync(configPath, 'utf8');
    expect(text.match(/^\s*genie:\s*$/gm)?.length).toBe(1);
    expect(hasDuplicateMcpGenieKeys(text)).toBe(false);

    const parsed = Bun.YAML.parse(text) as { mcp_servers: { genie: { command: string; args: string[] } } };
    expect(parsed.mcp_servers.genie.command).toBe(command);
    expect(parsed.mcp_servers.genie.args).toEqual(['mcp']);
  });

  test('repair is idempotent: a second merge on the repaired file is unchanged', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    const original = `mcp_servers:\n  genie:\n${managedBlock(command)}`;
    writeFileSync(configPath, original);

    const first = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(first.status).toBe('updated');
    const afterFirst = readFileSync(configPath, 'utf8');

    const second = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(second.status).toBe('unchanged');
    expect(second.backupPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  test('a duplicate with content identical to the managed region also repairs safely', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    // Unmarked leftover carrying the EXACT same command/args as the managed
    // region — safe to drop even though it is not empty.
    const original = `mcp_servers:\n  genie:\n    command: ${JSON.stringify(command)}\n    args:\n      - mcp\n${managedBlock(command)}`;
    writeFileSync(configPath, original);

    const result = mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
    expect(result.status).toBe('updated');

    const text = readFileSync(configPath, 'utf8');
    expect(text.match(/^\s*genie:\s*$/gm)?.length).toBe(1);
    const parsed = Bun.YAML.parse(text) as { mcp_servers: { genie: { command: string } } };
    expect(parsed.mcp_servers.genie.command).toBe(command);
  });

  test('a duplicate with conflicting (non-empty, non-identical) content → typed refusal with the conflict code', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    const original = `mcp_servers:\n  genie:\n    command: /old/stale/genie\n    args:\n      - mcp\n${managedBlock(command)}`;
    writeFileSync(configPath, original);

    try {
      mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      throw new Error('expected a HermesConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesConfigError);
      expect((err as HermesConfigError).code).toBe('duplicate-mcp-genie-conflict');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('no marker-wrapped region among the duplicates → typed refusal with the unmarked code', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    // Two plain unmarked `genie:` children, neither wrapped in markers —
    // ambiguous which one (if either) is authoritative.
    const original =
      'mcp_servers:\n' +
      '  genie:\n    command: /usr/bin/a\n    args:\n      - mcp\n' +
      '  other:\n    command: /usr/bin/other\n' +
      '  genie:\n    command: /usr/bin/b\n    args:\n      - mcp\n';
    writeFileSync(configPath, original);

    try {
      mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      throw new Error('expected a HermesConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesConfigError);
      expect((err as HermesConfigError).code).toBe('duplicate-mcp-genie-unmarked');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('two marker-wrapped regions (ambiguous which is managed) → typed refusal with the unmarked code', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    const original = `mcp_servers:\n${managedBlock('/old/genie')}${managedBlock(command)}`;
    writeFileSync(configPath, original);

    try {
      mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false });
      throw new Error('expected a HermesConfigError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HermesConfigError);
      expect((err as HermesConfigError).code).toBe('duplicate-mcp-genie-unmarked');
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });

  test('refusal is idempotent: a repeated call still throws and never writes or backs up', () => {
    const root = tmp();
    const configPath = join(root, 'config.yaml');
    const command = bin(root);
    const original = `mcp_servers:\n  genie:\n    command: /old/stale/genie\n    args:\n      - mcp\n${managedBlock(command)}`;
    writeFileSync(configPath, original);

    for (let i = 0; i < 2; i++) {
      expect(() =>
        mergeMcpServersGenie({ configPath, binaryPath: command, genieHome: root, fsExists: () => false }),
      ).toThrow(HermesConfigError);
    }
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(hasBackup(root)).toBe(false);
  });
});

describe('hasDuplicateMcpGenieKeys', () => {
  test('false for no mcp_servers key, single key, and empty text', () => {
    expect(hasDuplicateMcpGenieKeys('')).toBe(false);
    expect(hasDuplicateMcpGenieKeys('other: 1\n')).toBe(false);
    expect(hasDuplicateMcpGenieKeys('mcp_servers:\n  genie:\n    command: /x\n')).toBe(false);
  });

  test('true for a textual duplicate even when the parsed value looks correct (last-wins hides it)', () => {
    const text = 'mcp_servers:\n  genie:\n  genie:\n    command: /x\n    args:\n      - mcp\n';
    expect(Bun.YAML.parse(text)).toEqual({ mcp_servers: { genie: { command: '/x', args: ['mcp'] } } });
    expect(hasDuplicateMcpGenieKeys(text)).toBe(true);
  });
});
