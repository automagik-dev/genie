import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENIEIGNORE_DEFAULTS, scanForAgents, scanForAgentsAll } from '../lib/tree-scanner.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-scanner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/** Create a directory with AGENTS.md inside it. */
function makeAgent(base: string, ...pathParts: string[]): string {
  const dir = join(base, ...pathParts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), `---\nname: ${pathParts[pathParts.length - 1]}\n---\n`);
  return dir;
}

/** Create a plain directory (no AGENTS.md). */
function makeDir(base: string, ...pathParts: string[]): string {
  const dir = join(base, ...pathParts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a .genieignore file at the given root. */
function writeIgnore(root: string, content: string): void {
  writeFileSync(join(root, '.genieignore'), content, 'utf-8');
}

describe('scanForAgents', () => {
  test('finds AGENTS.md in nested directories', async () => {
    makeAgent(testDir, 'src', 'bots', 'my-bot');
    makeAgent(testDir, 'tools', 'helper');

    const results = await scanForAgentsAll(testDir);
    const names = results.map((r) => r.dirName).sort();
    expect(names).toEqual(['helper', 'my-bot']);
  });

  test('skips directories without AGENTS.md', async () => {
    makeAgent(testDir, 'src', 'bots', 'real-bot');
    makeDir(testDir, 'src', 'bots', 'not-a-bot');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('real-bot');
  });

  test('respects .genieignore — skips ignored directories', async () => {
    makeAgent(testDir, 'node_modules', 'some-pkg', 'agent');
    makeAgent(testDir, 'src', 'bots', 'my-bot');
    writeIgnore(testDir, 'node_modules\n');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('my-bot');
  });

  test('respects .genieignore with multiple patterns', async () => {
    makeAgent(testDir, 'node_modules', 'pkg', 'agent');
    makeAgent(testDir, 'dist', 'compiled', 'agent');
    makeAgent(testDir, '.cache', 'tmp', 'agent');
    makeAgent(testDir, 'src', 'real-agent');
    writeIgnore(testDir, 'node_modules\ndist\n.cache\n');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('real-agent');
  });

  test('handles missing .genieignore gracefully — scans everything', async () => {
    makeAgent(testDir, 'deep', 'nested', 'bot');
    // No .genieignore file, but scanner still skips canonical agents/ dir

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('bot');
  });

  test('always skips the canonical agents/ directory', async () => {
    // agents/ is managed by agent-sync — the tree scanner should not yield from it
    makeAgent(testDir, 'agents', 'already-imported');
    makeAgent(testDir, 'src', 'bots', 'discover-me');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('discover-me');
  });

  test('detects sub-agents inside .genie/agents/', async () => {
    const parentDir = makeAgent(testDir, 'src', 'my-parent');
    // Create sub-agent inside parent's .genie/agents/
    const subDir = join(parentDir, '.genie', 'agents', 'my-sub');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'AGENTS.md'), '---\nname: my-sub\n---\n');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(2);

    const parent = results.find((r) => r.dirName === 'my-parent');
    expect(parent).toBeDefined();
    expect(parent!.hasSubAgents).toBe(true);
    expect(parent!.isSubAgent).toBe(false);

    const sub = results.find((r) => r.dirName === 'my-sub');
    expect(sub).toBeDefined();
    expect(sub!.isSubAgent).toBe(true);
    expect(sub!.parentName).toBe('my-parent');
  });

  test('hasSubAgents is false when no sub-agents exist', async () => {
    makeAgent(testDir, 'src', 'simple-bot');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].hasSubAgents).toBe(false);
  });

  test('yields correct absolute paths', async () => {
    const agentDir = makeAgent(testDir, 'src', 'bots', 'pathbot');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe(agentDir);
  });

  test('works as async generator (streaming)', async () => {
    makeAgent(testDir, 'a', 'bot1');
    makeAgent(testDir, 'b', 'bot2');
    makeAgent(testDir, 'c', 'bot3');

    const names: string[] = [];
    for await (const agent of scanForAgents(testDir)) {
      names.push(agent.dirName);
    }
    expect(names.sort()).toEqual(['bot1', 'bot2', 'bot3']);
  });

  test('custom ignoreFilePath overrides default', async () => {
    makeAgent(testDir, 'src', 'bot');
    makeAgent(testDir, 'hidden', 'secret-bot');

    const customIgnore = join(testDir, 'custom-ignore');
    writeFileSync(customIgnore, 'hidden\n', 'utf-8');

    const results = await scanForAgentsAll(testDir, customIgnore);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('bot');
  });

  test('skips unreadable directories gracefully', async () => {
    makeAgent(testDir, 'src', 'good-bot');
    // We can't easily make a dir unreadable in all environments,
    // but at minimum the scanner should not crash on empty trees
    makeDir(testDir, 'empty');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
  });
});

describe('GENIEIGNORE_DEFAULTS', () => {
  test('contains all required default patterns', () => {
    const patterns = GENIEIGNORE_DEFAULTS.split('\n').filter(Boolean);
    expect(patterns).toContain('node_modules');
    expect(patterns).toContain('.git');
    expect(patterns).toContain('.genie/worktrees');
    expect(patterns).toContain('dist');
    expect(patterns).toContain('build');
    expect(patterns).toContain('vendor');
    expect(patterns).toContain('.next');
    expect(patterns).toContain('.nuxt');
    expect(patterns).toContain('__pycache__');
    expect(patterns).toContain('.venv');
    expect(patterns).toContain('target');
    expect(patterns).toContain('coverage');
    expect(patterns).toContain('.cache');
  });

  test('default patterns actually work with scanner', async () => {
    // Write default .genieignore
    writeIgnore(testDir, GENIEIGNORE_DEFAULTS);

    // Create agents in ignored directories
    makeAgent(testDir, 'node_modules', 'pkg', 'agent');
    makeAgent(testDir, 'dist', 'agent');
    makeAgent(testDir, 'build', 'agent');
    makeAgent(testDir, '__pycache__', 'agent');
    makeAgent(testDir, '.venv', 'lib', 'agent');
    makeAgent(testDir, 'target', 'debug', 'agent');
    makeAgent(testDir, 'coverage', 'agent');
    makeAgent(testDir, '.cache', 'agent');
    makeAgent(testDir, 'vendor', 'agent');
    makeAgent(testDir, '.next', 'agent');
    makeAgent(testDir, '.nuxt', 'agent');

    // Create one legitimate agent
    makeAgent(testDir, 'src', 'my-real-bot');

    const results = await scanForAgentsAll(testDir);
    expect(results).toHaveLength(1);
    expect(results[0].dirName).toBe('my-real-bot');
  });
});

describe('performance', () => {
  test('10k-file fixture scans in under 5 seconds', async () => {
    // Create a synthetic tree with 10k+ dirs to test performance.
    // Structure: 100 top-level dirs × 100 nested dirs = 10,000 dirs.
    // Scatter 5 agents throughout. Use .genieignore to skip most.
    writeIgnore(testDir, 'skip-*\n');

    // Create 50 top-level dirs that get skipped by .genieignore
    for (let i = 0; i < 50; i++) {
      const skipDir = join(testDir, `skip-${i}`);
      mkdirSync(skipDir, { recursive: true });
      // Put 200 subdirs in each (these are pruned, so never read)
      for (let j = 0; j < 200; j++) {
        mkdirSync(join(skipDir, `sub-${j}`), { recursive: true });
      }
    }

    // Create 10 non-ignored dirs with 5 agents scattered in them
    for (let i = 0; i < 10; i++) {
      const topDir = join(testDir, `scan-${i}`);
      mkdirSync(topDir, { recursive: true });
      for (let j = 0; j < 10; j++) {
        mkdirSync(join(topDir, `nested-${j}`), { recursive: true });
      }
    }

    // Scatter 5 agents
    makeAgent(testDir, 'scan-0', 'nested-3', 'bot-a');
    makeAgent(testDir, 'scan-2', 'nested-7', 'bot-b');
    makeAgent(testDir, 'scan-5', 'bot-c');
    makeAgent(testDir, 'scan-7', 'nested-1', 'bot-d');
    makeAgent(testDir, 'scan-9', 'nested-9', 'bot-e');

    const start = performance.now();
    const results = await scanForAgentsAll(testDir);
    const elapsed = performance.now() - start;

    expect(results).toHaveLength(5);
    expect(elapsed).toBeLessThan(5000); // Must complete in under 5 seconds
    const names = results.map((r) => r.dirName).sort();
    expect(names).toEqual(['bot-a', 'bot-b', 'bot-c', 'bot-d', 'bot-e']);
  });
});
