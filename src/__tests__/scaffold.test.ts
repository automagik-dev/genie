import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILTIN_DEFAULTS } from '../lib/defaults.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { AGENTS_TEMPLATE, scaffoldAgentFiles } from '../templates/index.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `scaffold-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('AGENTS_TEMPLATE', () => {
  test('does not contain model: inherit as active value', () => {
    expect(AGENTS_TEMPLATE).not.toMatch(/^model: inherit/m);
  });

  test('does not contain color: blue as active value', () => {
    expect(AGENTS_TEMPLATE).not.toMatch(/^color: blue/m);
  });

  test('does not contain promptMode: system as active value', () => {
    expect(AGENTS_TEMPLATE).not.toMatch(/^promptMode: system/m);
  });

  test('contains placeholder comments for all BUILTIN_DEFAULTS keys', () => {
    for (const key of Object.keys(BUILTIN_DEFAULTS)) {
      expect(AGENTS_TEMPLATE).toContain(`# ${key}:`);
    }
  });

  test('contains exactly one description comment line', () => {
    const matches = AGENTS_TEMPLATE.match(/# description:/g);
    expect(matches).toHaveLength(1);
  });
});

describe('scaffoldAgentFiles', () => {
  test('scaffold with empty workspace produces built-in defaults in comments', () => {
    scaffoldAgentFiles(testDir, 'test-agent');
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# model: opus');
    expect(content).toContain('# color: blue');
    expect(content).toContain('# promptMode: append');
  });

  test('scaffold with workspace defaults overrides comment values', () => {
    scaffoldAgentFiles(testDir, 'test-agent', { model: 'sonnet' });
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# model: sonnet');
    // Other fields still show built-in
    expect(content).toContain('# color: blue');
  });

  test('scaffold frontmatter parses to object with only name field', () => {
    scaffoldAgentFiles(testDir, 'test-agent');
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    const fm = parseFrontmatter(content);
    // Only the active name: field should parse
    expect(fm.name).toBe('test-agent');
    // All other fields are comments — should not appear
    expect(fm.model).toBeUndefined();
    expect(fm.color).toBeUndefined();
    expect(fm.promptMode).toBeUndefined();
  });

  test('scaffold without agentName produces empty frontmatter', () => {
    scaffoldAgentFiles(testDir);
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    const fm = parseFrontmatter(content);
    expect(fm.name).toBeUndefined();
    expect(fm.model).toBeUndefined();
  });

  test('scaffold creates all three template files', () => {
    scaffoldAgentFiles(testDir, 'test-agent');
    expect(existsSync(join(testDir, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(testDir, 'HEARTBEAT.md'))).toBe(true);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
  });

  test('scaffold with multiple workspace overrides', () => {
    scaffoldAgentFiles(testDir, 'test-agent', { model: 'haiku', color: 'red', effort: 'low' });
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# model: haiku');
    expect(content).toContain('# color: red');
    expect(content).toContain('# effort: low');
    // Unchanged fields use built-in
    expect(content).toContain('# promptMode: append');
  });
});
