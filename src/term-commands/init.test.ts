import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAgentFiles } from '../templates/index.js';
import { scaffoldAgentInWorkspace } from './init.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('scaffoldAgentFiles', () => {
  test('creates AGENTS.md, SOUL.md, HEARTBEAT.md', () => {
    scaffoldAgentFiles(testDir);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
    expect(existsSync(join(testDir, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(testDir, 'HEARTBEAT.md'))).toBe(true);
  });

  test('substitutes agent name in AGENTS.md frontmatter', () => {
    scaffoldAgentFiles(testDir, 'atlas');
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('name: atlas');
    expect(content).not.toContain('name: my-agent');
  });

  test('no active name field when no agent name provided', () => {
    scaffoldAgentFiles(testDir);
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    // With the new template, name derives from directory — no active name: field
    expect(content).not.toMatch(/^name:/m);
  });
});

describe('scaffoldAgentInWorkspace', () => {
  test('writes settings.local.json with auto-memory enabled and seeds MEMORY.md', () => {
    // Minimal workspace.json so getWorkspaceConfig doesn't crash
    mkdirSync(join(testDir, '.genie'), { recursive: true });
    writeFileSync(join(testDir, '.genie', 'workspace.json'), `${JSON.stringify({ name: 'test-ws' }, null, 2)}\n`);

    scaffoldAgentInWorkspace(testDir, 'atlas');

    const settingsPath = join(testDir, 'agents', 'atlas', '.claude', 'settings.local.json');
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings).toEqual({
      agentName: 'atlas',
      autoMemoryEnabled: true,
      autoMemoryDirectory: './brain/memory',
    });

    const memoryPath = join(testDir, 'agents', 'atlas', 'brain', 'memory', 'MEMORY.md');
    expect(existsSync(memoryPath)).toBe(true);
    const memory = readFileSync(memoryPath, 'utf-8');
    expect(memory).toContain('# Memory Index');
    expect(memory).toContain('auto-memory system');
  });
});
