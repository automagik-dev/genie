import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HealResult, healAgentFile } from '../lib/agent-sync.js';
import { parseFrontmatter } from '../lib/frontmatter.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `heal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeAgent(name: string, frontmatter: string, body = '\nAgent body content.\n'): string {
  const dir = join(testDir, 'agents', name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'AGENTS.md');
  writeFileSync(path, `---\n${frontmatter}\n---\n${body}`);
  return path;
}

describe('healAgentFile', () => {
  test('removes model: inherit from frontmatter', () => {
    const path = writeAgent('agent1', 'name: agent1\nmodel: inherit\ncolor: red');
    const result: HealResult = { healed: [] };
    const modified = healAgentFile(path, 'agent1', result);

    expect(modified).toBe(true);
    expect(result.healed).toHaveLength(1);
    expect(result.healed[0]).toEqual({ agent: 'agent1', field: 'model', value: 'inherit' });

    const content = readFileSync(path, 'utf-8');
    expect(content).not.toContain('model: inherit');
    expect(content).toContain('name: agent1');
    expect(content).toContain('color: red');
  });

  test('healed file parses cleanly', () => {
    const path = writeAgent('agent2', 'name: agent2\nmodel: inherit\ndescription: test');
    const result: HealResult = { healed: [] };
    healAgentFile(path, 'agent2', result);

    const content = readFileSync(path, 'utf-8');
    const fm = parseFrontmatter(content);
    expect(fm.name).toBe('agent2');
    expect(fm.description).toBe('test');
    expect(fm.model).toBeUndefined();
  });

  test('no-op on clean file (no writes)', () => {
    const path = writeAgent('clean', 'name: clean\nmodel: opus');
    const result: HealResult = { healed: [] };
    const modified = healAgentFile(path, 'clean', result);

    expect(modified).toBe(false);
    expect(result.healed).toHaveLength(0);
  });

  test('idempotent — second run on healed file is no-op', () => {
    const path = writeAgent('agent3', 'name: agent3\nmodel: inherit');
    const result1: HealResult = { healed: [] };
    healAgentFile(path, 'agent3', result1);
    expect(result1.healed).toHaveLength(1);

    const result2: HealResult = { healed: [] };
    const modified = healAgentFile(path, 'agent3', result2);
    expect(modified).toBe(false);
    expect(result2.healed).toHaveLength(0);
  });

  test('preserves body content after frontmatter', () => {
    const body = '\n@HEARTBEAT.md\n\n<mission>Important stuff</mission>\n';
    const path = writeAgent('agent4', 'name: agent4\nmodel: inherit', body);
    const result: HealResult = { healed: [] };
    healAgentFile(path, 'agent4', result);

    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('@HEARTBEAT.md');
    expect(content).toContain('<mission>Important stuff</mission>');
  });

  test('heals 5 agents in a fixture workspace', () => {
    const paths: string[] = [];
    for (let i = 1; i <= 5; i++) {
      paths.push(writeAgent(`agent${i}`, `name: agent${i}\nmodel: inherit\ncolor: green`));
    }

    const result: HealResult = { healed: [] };
    for (let i = 0; i < 5; i++) {
      healAgentFile(paths[i], `agent${i + 1}`, result);
    }

    expect(result.healed).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      const content = readFileSync(paths[i], 'utf-8');
      expect(content).not.toContain('model: inherit');
      expect(content).toContain(`name: agent${i + 1}`);
      expect(content).toContain('color: green');
      // Parses cleanly
      const fm = parseFrontmatter(content);
      expect(fm.model).toBeUndefined();
    }
  });

  test('no frontmatter block is a no-op', () => {
    const dir = join(testDir, 'agents', 'nofm');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, 'Just plain markdown content.');

    const result: HealResult = { healed: [] };
    const modified = healAgentFile(path, 'nofm', result);
    expect(modified).toBe(false);
  });

  test('does not modify model: inherit in body text (outside frontmatter)', () => {
    const body = '\nThis agent uses model: inherit pattern.\n';
    const path = writeAgent('agent5', 'name: agent5\ncolor: blue', body);
    const result: HealResult = { healed: [] };
    const modified = healAgentFile(path, 'agent5', result);

    expect(modified).toBe(false);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('model: inherit pattern');
  });
});
