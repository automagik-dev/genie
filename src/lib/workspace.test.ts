import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findWorkspace, getWorkspaceConfig, scanAgents } from './workspace.js';

let testDir: string;
let fakeGenieHome: string;
const originalGenieHome = process.env.GENIE_HOME;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-workspace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  // Isolate ~/.genie/config.json from the developer's real config for every test.
  fakeGenieHome = join(testDir, '.fake-genie-home');
  mkdirSync(fakeGenieHome, { recursive: true });
  process.env.GENIE_HOME = fakeGenieHome;
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  if (originalGenieHome === undefined) {
    // biome-ignore lint/performance/noDelete: process.env assignment coerces undefined→"undefined"; delete is the only correct unset
    delete process.env.GENIE_HOME;
  } else {
    process.env.GENIE_HOME = originalGenieHome;
  }
});

function makeWorkspace(root: string, config: Record<string, unknown> = { name: 'test-ws' }) {
  mkdirSync(join(root, '.genie'), { recursive: true });
  writeFileSync(join(root, '.genie', 'workspace.json'), JSON.stringify(config));
}

function makeAgent(root: string, name: string) {
  const agentDir = join(root, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), `---\nname: ${name}\n---\n`);
}

describe('findWorkspace', () => {
  test('finds workspace from root directory', () => {
    makeWorkspace(testDir);
    const result = findWorkspace(testDir);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(testDir);
    expect(result!.agent).toBeUndefined();
  });

  test('finds workspace from deeply nested path', () => {
    makeWorkspace(testDir);
    const deep = join(testDir, 'some', 'deep', 'path');
    mkdirSync(deep, { recursive: true });
    const result = findWorkspace(deep);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(testDir);
  });

  test('detects agent name when inside agents/<name>/', () => {
    makeWorkspace(testDir);
    makeAgent(testDir, 'sofia');
    const agentDir = join(testDir, 'agents', 'sofia');
    const result = findWorkspace(agentDir);
    expect(result).not.toBeNull();
    expect(result!.root).toBe(testDir);
    expect(result!.agent).toBe('sofia');
  });

  test('detects agent from nested path inside agent directory', () => {
    makeWorkspace(testDir);
    makeAgent(testDir, 'genie');
    const nested = join(testDir, 'agents', 'genie', 'repos', 'project');
    mkdirSync(nested, { recursive: true });
    const result = findWorkspace(nested);
    expect(result).not.toBeNull();
    expect(result!.agent).toBe('genie');
  });

  test('returns null outside any workspace', () => {
    const result = findWorkspace(testDir);
    expect(result).toBeNull();
  });

  test('no agent detected when in agents/ but no AGENTS.md', () => {
    makeWorkspace(testDir);
    const orphanDir = join(testDir, 'agents', 'orphan');
    mkdirSync(orphanDir, { recursive: true });
    const result = findWorkspace(orphanDir);
    expect(result).not.toBeNull();
    expect(result!.agent).toBeUndefined();
  });

  test('no agent detected when at workspace root', () => {
    makeWorkspace(testDir);
    makeAgent(testDir, 'atlas');
    const result = findWorkspace(testDir);
    expect(result!.agent).toBeUndefined();
  });
});

describe('getWorkspaceConfig', () => {
  test('reads workspace.json', () => {
    makeWorkspace(testDir, { name: 'my-ws', pgUrl: 'postgres://localhost:5432/genie' });
    const config = getWorkspaceConfig(testDir);
    expect(config.name).toBe('my-ws');
    expect(config.pgUrl).toBe('postgres://localhost:5432/genie');
  });
});

describe('workspaceRoot persistence', () => {
  test('does not persist workspaces under tmpdir() to GENIE_HOME config', () => {
    // testDir is under tmpdir() by construction — walk-up will succeed, but
    // saveWorkspaceRoot must refuse to write it, so the global config stays clean.
    makeWorkspace(testDir);
    findWorkspace(testDir);

    const configPath = join(fakeGenieHome, 'config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      expect(config.workspaceRoot).toBeUndefined();
    }
    // (if the file doesn't exist at all, that's also a pass — nothing was persisted)
  });

  test('clears stale workspaceRoot from config when the saved path is gone', () => {
    // Simulate a prior run that persisted a path which has since vanished.
    const vanished = join(testDir, 'was-here-now-gone');
    const configPath = join(fakeGenieHome, 'config.json');
    writeFileSync(configPath, JSON.stringify({ workspaceRoot: vanished }));

    // findWorkspace from an unrelated dir triggers the fallback → stale path detected → cleared.
    const unrelated = join(testDir, 'unrelated');
    mkdirSync(unrelated, { recursive: true });
    const result = findWorkspace(unrelated);
    expect(result).toBeNull();

    // The poisoned entry should be scrubbed from the config so future calls don't keep hitting it.
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.workspaceRoot).toBeUndefined();
  });
});

describe('scanAgents', () => {
  test('lists agents with AGENTS.md', () => {
    makeWorkspace(testDir);
    makeAgent(testDir, 'sofia');
    makeAgent(testDir, 'genie');
    makeAgent(testDir, 'atlas');
    // orphan dir without AGENTS.md
    mkdirSync(join(testDir, 'agents', 'orphan'), { recursive: true });

    const agents = scanAgents(testDir);
    expect(agents).toEqual(['atlas', 'genie', 'sofia']);
  });

  test('returns empty array when no agents directory', () => {
    makeWorkspace(testDir);
    const agents = scanAgents(testDir);
    expect(agents).toEqual([]);
  });
});
