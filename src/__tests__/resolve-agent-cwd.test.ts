import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAgentFromCwd } from '../lib/resolve-agent-cwd.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let wsRoot: string;

beforeEach(() => {
  wsRoot = join(tmpdir(), `genie-resolve-cwd-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(wsRoot, '.genie'), { recursive: true });
  writeFileSync(join(wsRoot, '.genie', 'workspace.json'), '{}');
});

afterEach(() => {
  rmSync(wsRoot, { recursive: true, force: true });
});

function scaffoldAgent(name: string): string {
  const dir = join(wsRoot, 'agents', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), `---\nname: ${name}\n---\n`);
  return dir;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('resolveAgentFromCwd()', () => {
  test('exact match: cwd IS the agent directory', () => {
    const agentDir = scaffoldAgent('my-bot');
    const result = resolveAgentFromCwd(agentDir, wsRoot);
    expect(result).toEqual({ agent: 'my-bot', source: 'exact' });
  });

  test('parent match: cwd is inside an agent directory', () => {
    const agentDir = scaffoldAgent('my-bot');
    const subDir = join(agentDir, 'src', 'lib');
    mkdirSync(subDir, { recursive: true });

    const result = resolveAgentFromCwd(subDir, wsRoot);
    expect(result).toEqual({ agent: 'my-bot', source: 'parent' });
  });

  test('parent match: cwd is in agent brain subdirectory', () => {
    const agentDir = scaffoldAgent('researcher');
    const brainDir = join(agentDir, 'brain', 'memory');
    mkdirSync(brainDir, { recursive: true });

    const result = resolveAgentFromCwd(brainDir, wsRoot);
    expect(result).toEqual({ agent: 'researcher', source: 'parent' });
  });

  test('default: cwd is workspace root', () => {
    scaffoldAgent('my-bot');
    const result = resolveAgentFromCwd(wsRoot, wsRoot);
    expect(result).toEqual({ agent: 'genie', source: 'default' });
  });

  test('default: cwd is a non-agent subfolder of workspace', () => {
    scaffoldAgent('my-bot');
    const srcDir = join(wsRoot, 'src', 'lib');
    mkdirSync(srcDir, { recursive: true });

    const result = resolveAgentFromCwd(srcDir, wsRoot);
    expect(result).toEqual({ agent: 'genie', source: 'default' });
  });

  test('default: cwd is inside agents/ but no AGENTS.md', () => {
    const noAgentDir = join(wsRoot, 'agents', 'incomplete');
    mkdirSync(noAgentDir, { recursive: true });

    const result = resolveAgentFromCwd(noAgentDir, wsRoot);
    expect(result).toEqual({ agent: 'genie', source: 'default' });
  });

  test('default: workspace has no agents at all', () => {
    const result = resolveAgentFromCwd(wsRoot, wsRoot);
    expect(result).toEqual({ agent: 'genie', source: 'default' });
  });

  test('resolves first agent in path when multiple agents exist', () => {
    scaffoldAgent('alpha');
    scaffoldAgent('beta');

    const alphaSubDir = join(wsRoot, 'agents', 'alpha', 'deep', 'nested');
    mkdirSync(alphaSubDir, { recursive: true });

    const result = resolveAgentFromCwd(alphaSubDir, wsRoot);
    expect(result).toEqual({ agent: 'alpha', source: 'parent' });
  });

  test('non-canonical agent: AGENTS.md outside agents/ dir triggers parent walk-up', () => {
    const customDir = join(wsRoot, 'custom', 'my-agent');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'AGENTS.md'), '---\nname: my-agent\n---\n');

    const deepDir = join(customDir, 'src');
    mkdirSync(deepDir, { recursive: true });

    const result = resolveAgentFromCwd(deepDir, wsRoot);
    expect(result).toEqual({ agent: 'my-agent', source: 'parent' });
  });

  test('default: cwd is the agents/ directory itself (not a specific agent)', () => {
    scaffoldAgent('my-bot');
    const agentsDir = join(wsRoot, 'agents');

    const result = resolveAgentFromCwd(agentsDir, wsRoot);
    expect(result).toEqual({ agent: 'genie', source: 'default' });
  });
});
