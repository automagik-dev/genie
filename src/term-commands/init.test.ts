import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scaffoldAgentFiles } from '../templates/index.js';

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
