import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasDuplicateMcpGenieKeys, retireMcpServersGenie } from './hermes-mcp-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Hermes MCP retirement', () => {
  test('removes only the owned marker block and preserves unrelated bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'hermes-mcp-retire-'));
    roots.push(root);
    const path = join(root, 'config.yaml');
    writeFileSync(
      path,
      'before: true\nmcp_servers:\n  # genie:managed:mcp_servers.genie — begin (managed by genie; edit via genie only)\n  genie:\n    command: /old/genie\n  # genie:managed:mcp_servers.genie — end\n  other:\n    command: keep\nafter: true\n',
    );
    expect(retireMcpServersGenie({ configPath: path, now: new Date('2026-08-29T00:00:00Z') }).status).toBe('updated');
    expect(readFileSync(path, 'utf8')).toBe('before: true\nmcp_servers:\n  other:\n    command: keep\nafter: true\n');
    expect(retireMcpServersGenie({ configPath: path }).status).toBe('unchanged');
  });

  test('preserves unowned routes and detects duplicate direct children', () => {
    expect(hasDuplicateMcpGenieKeys('mcp_servers:\n  genie: {}\n  other: {}\n  genie: {}\n')).toBe(true);
    expect(hasDuplicateMcpGenieKeys('mcp_servers:\n  genie: {}\n  other: {}\n')).toBe(false);
  });
});
