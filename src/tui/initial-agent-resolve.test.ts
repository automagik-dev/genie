import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInitialAgent } from './initial-agent.js';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-initial-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(testDir, '.genie'), { recursive: true });
  writeFileSync(join(testDir, '.genie', 'workspace.json'), JSON.stringify({ name: 'test' }));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveInitialAgent', () => {
  test('prefers explicit workspace agent', () => {
    expect(resolveInitialAgent(testDir, 'vegapunk')).toBe('vegapunk');
  });

  test('falls back to the first scanned agent when no explicit agent exists', () => {
    mkdirSync(join(testDir, 'agents', 'atlas'), { recursive: true });
    mkdirSync(join(testDir, 'agents', 'genie'), { recursive: true });
    writeFileSync(join(testDir, 'agents', 'atlas', 'AGENTS.md'), '---\nname: atlas\n---\n');
    writeFileSync(join(testDir, 'agents', 'genie', 'AGENTS.md'), '---\nname: genie\n---\n');

    expect(resolveInitialAgent(testDir)).toBe('atlas');
  });

  test('returns undefined when workspace has no agents', () => {
    expect(resolveInitialAgent(testDir)).toBeUndefined();
  });

  test('returns undefined without a workspace root', () => {
    expect(resolveInitialAgent(undefined, undefined)).toBeUndefined();
  });
});
