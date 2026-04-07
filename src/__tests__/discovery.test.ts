import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExternalAgents, importAgents } from '../lib/discovery.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function mkAgent(dir: string, name?: string): void {
  const agentDir = name ? join(dir, name) : dir;
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '---\nname: test\n---\n# Agent\n');
}

function mkWorkspace(root: string): void {
  mkdirSync(join(root, '.genie'), { recursive: true });
  writeFileSync(join(root, '.genie', 'workspace.json'), JSON.stringify({ name: 'test', agents: { defaults: {} } }));
}

// ─── discoverExternalAgents ─────────────────────────────────────────────────

describe('discoverExternalAgents()', () => {
  test('finds agents outside canonical agents/ directory', async () => {
    mkWorkspace(testDir);
    mkAgent(testDir, 'services/auth');
    mkdirSync(join(testDir, 'agents', 'genie'), { recursive: true });
    writeFileSync(join(testDir, 'agents', 'genie', 'AGENTS.md'), '---\n---\n');

    const discovered = await discoverExternalAgents(testDir);

    expect(discovered.length).toBe(1);
    expect(discovered[0].name).toBe('auth');
    expect(discovered[0].relativePath).toBe('services/auth');
  });

  test('returns empty array when no external agents exist', async () => {
    mkWorkspace(testDir);
    mkdirSync(join(testDir, 'agents', 'genie'), { recursive: true });
    writeFileSync(join(testDir, 'agents', 'genie', 'AGENTS.md'), '---\n---\n');

    const discovered = await discoverExternalAgents(testDir);

    expect(discovered).toEqual([]);
  });

  test('skips agents that share a name with canonical agents', async () => {
    mkWorkspace(testDir);
    mkdirSync(join(testDir, 'agents', 'bot'), { recursive: true });
    writeFileSync(join(testDir, 'agents', 'bot', 'AGENTS.md'), '---\n---\n');
    mkAgent(testDir, 'packages/bot');

    const discovered = await discoverExternalAgents(testDir);

    expect(discovered).toEqual([]);
  });

  test('finds multiple external agents', async () => {
    mkWorkspace(testDir);
    mkAgent(testDir, 'services/auth');
    mkAgent(testDir, 'services/billing');
    mkAgent(testDir, 'tools/cli');

    const discovered = await discoverExternalAgents(testDir);

    expect(discovered.length).toBe(3);
    const names = discovered.map((d) => d.name).sort();
    expect(names).toEqual(['auth', 'billing', 'cli']);
  });

  test('respects .genieignore', async () => {
    mkWorkspace(testDir);
    writeFileSync(join(testDir, '.genieignore'), 'ignored-dir\n');
    mkAgent(testDir, 'ignored-dir/hidden');
    mkAgent(testDir, 'visible/agent');

    const discovered = await discoverExternalAgents(testDir);

    expect(discovered.length).toBe(1);
    expect(discovered[0].name).toBe('agent');
  });
});

// ─── importAgents ────────────────────────────────────────────────────────────

describe('importAgents()', () => {
  test('creates symlinks in agents/ directory', () => {
    mkWorkspace(testDir);
    mkAgent(testDir, 'services/auth');

    const agents = [
      {
        name: 'auth',
        path: join(testDir, 'services', 'auth'),
        relativePath: 'services/auth',
        isSubAgent: false,
      },
    ];

    const result = importAgents(testDir, agents);

    expect(result.imported).toEqual(['auth']);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);

    const linkPath = join(testDir, 'agents', 'auth');
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(join(testDir, 'services', 'auth'));
  });

  test('resolves name collisions with numeric suffix', () => {
    mkWorkspace(testDir);
    mkdirSync(join(testDir, 'agents', 'auth'), { recursive: true });
    writeFileSync(join(testDir, 'agents', 'auth', 'AGENTS.md'), '---\n---\n');
    mkAgent(testDir, 'services/auth');

    const agents = [
      {
        name: 'auth',
        path: join(testDir, 'services', 'auth'),
        relativePath: 'services/auth',
        isSubAgent: false,
      },
    ];

    const result = importAgents(testDir, agents);

    expect(result.imported).toEqual(['auth-2']);
    expect(result.errors).toEqual([]);

    const linkPath = join(testDir, 'agents', 'auth-2');
    expect(existsSync(linkPath)).toBe(true);
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
  });

  test('creates agents/ directory if it does not exist', () => {
    mkWorkspace(testDir);
    mkAgent(testDir, 'services/bot');

    const agents = [
      {
        name: 'bot',
        path: join(testDir, 'services', 'bot'),
        relativePath: 'services/bot',
        isSubAgent: false,
      },
    ];

    const result = importAgents(testDir, agents);

    expect(result.imported).toEqual(['bot']);
    expect(existsSync(join(testDir, 'agents'))).toBe(true);
  });
});
