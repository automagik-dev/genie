import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  preflightCodexPluginMutation,
  registerProjectMcpConfigs,
  retireProjectMcpConfigs,
} from './codex-project-mcp.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'genie-project-mcp-retirement-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('retireProjectMcpConfigs', () => {
  test('retirement remains distinct from the legacy registration helpers', () => {
    expect(typeof preflightCodexPluginMutation).toBe('function');
    expect(typeof registerProjectMcpConfigs).toBe('function');
  });
  test('never parses or rewrites .mcp.json', () => {
    for (const original of [
      '{ definitely not json\n',
      '{\n  "mcpServers": { "genie": { "command": "/old/genie", "args": ["mcp"] } }\n}\n',
    ]) {
      writeFileSync(join(root, '.mcp.json'), original);
      expect(retireProjectMcpConfigs(root)[0]).toMatchObject({ action: 'skipped' });
      expect(readFileSync(join(root, '.mcp.json'), 'utf8')).toBe(original);
    }
  });

  test('removes exactly one complete owned marker pair and keeps unrelated TOML', () => {
    const config = join(root, '.codex', 'config.toml');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      config,
      'model = "keep"\n# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\ncommand = "/old"\nargs = ["mcp"]\n# END GENIE MCP FALLBACK\n',
    );

    expect(retireProjectMcpConfigs(root)[1]).toMatchObject({ action: 'updated' });
    expect(readFileSync(config, 'utf8')).toBe('model = "keep"\n');
  });

  test('refuses duplicate or incomplete markers without mutation', () => {
    const config = join(root, '.codex', 'config.toml');
    mkdirSync(join(root, '.codex'), { recursive: true });
    const fixtures = [
      '# BEGIN GENIE MCP FALLBACK\n[mcp_servers.genie]\n',
      '# BEGIN GENIE MCP FALLBACK\n# END GENIE MCP FALLBACK\n# BEGIN GENIE MCP FALLBACK\n# END GENIE MCP FALLBACK\n',
    ];
    for (const original of fixtures) {
      writeFileSync(config, original);
      expect(() => retireProjectMcpConfigs(root)).toThrow();
      expect(readFileSync(config, 'utf8')).toBe(original);
    }
  });
});

describe('shipped plugin payload', () => {
  test('contains no Genie-owned MCP route, capability, launcher, or server', () => {
    const plugin = join(import.meta.dir, '..', '..', 'plugins', 'genie');
    const manifests = [
      join(plugin, '.codex-plugin', 'plugin.json'),
      join(plugin, '.claude-plugin', 'plugin.json'),
      join(plugin, '.kimi-plugin', 'plugin.json'),
      join(plugin, 'orca-plugin.json'),
    ];
    for (const path of manifests) {
      const text = readFileSync(path, 'utf8');
      expect(text).not.toContain('mcpServers');
      expect(text).not.toContain('mcp-launcher');
    }
    expect(existsSync(join(plugin, '.mcp.json'))).toBe(false);
    expect(existsSync(join(plugin, 'scripts', 'mcp-launcher.cjs'))).toBe(false);
  });
});
