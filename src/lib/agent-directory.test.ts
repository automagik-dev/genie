/**
 * Tests for Agent Directory module.
 *
 * Run with: bun test src/lib/agent-directory.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from './agent-directory.js';

// ============================================================================
// Test setup — use temp dir for GENIE_HOME
// ============================================================================

let testDir: string;
let agentDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-dir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.env.GENIE_HOME = testDir;

  // Create a fake agent dir with AGENTS.md
  agentDir = join(testDir, 'test-agent-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Test Agent\nYou are a test agent.');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  process.env.GENIE_HOME = undefined;
});

// ============================================================================
// add()
// ============================================================================

describe('add', () => {
  test('persists entry to directory', async () => {
    const entry = await directory.add({
      name: 'test-agent',
      dir: agentDir,
      promptMode: 'append',
    });

    expect(entry.name).toBe('test-agent');
    expect(entry.dir).toBe(agentDir);
    expect(entry.promptMode).toBe('append');
    expect(entry.registeredAt).toBeTruthy();

    // Verify persisted
    const retrieved = await directory.get('test-agent');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('test-agent');
  });

  test('persists with all optional fields', async () => {
    const entry = await directory.add({
      name: 'full-agent',
      dir: agentDir,
      repo: agentDir, // reuse dir as repo for test
      promptMode: 'system',
      model: 'opus',
      roles: ['implementor', 'tester'],
    });

    expect(entry.repo).toBe(agentDir);
    expect(entry.promptMode).toBe('system');
    expect(entry.model).toBe('opus');
    expect(entry.roles).toEqual(['implementor', 'tester']);
  });

  test('rejects duplicate name', async () => {
    await directory.add({ name: 'agent1', dir: agentDir, promptMode: 'append' });
    await expect(directory.add({ name: 'agent1', dir: agentDir, promptMode: 'append' })).rejects.toThrow(
      'already exists',
    );
  });

  test('rejects missing directory', async () => {
    await expect(directory.add({ name: 'ghost', dir: '/nonexistent/path', promptMode: 'append' })).rejects.toThrow(
      'does not exist',
    );
  });

  test('rejects directory without AGENTS.md', async () => {
    const emptyDir = join(testDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    await expect(directory.add({ name: 'no-agents', dir: emptyDir, promptMode: 'append' })).rejects.toThrow(
      'AGENTS.md not found',
    );
  });

  test('rejects empty name', async () => {
    await expect(directory.add({ name: '', dir: agentDir, promptMode: 'append' })).rejects.toThrow('name is required');
  });
});

// ============================================================================
// rm()
// ============================================================================

describe('rm', () => {
  test('removes existing entry', async () => {
    await directory.add({ name: 'to-remove', dir: agentDir, promptMode: 'append' });
    const removed = await directory.rm('to-remove');
    expect(removed).toBe(true);

    const retrieved = await directory.get('to-remove');
    expect(retrieved).toBeNull();
  });

  test('returns false for non-existent entry', async () => {
    const removed = await directory.rm('nonexistent');
    expect(removed).toBe(false);
  });
});

// ============================================================================
// resolve()
// ============================================================================

describe('resolve', () => {
  test('resolves user directory entry', async () => {
    await directory.add({ name: 'my-agent', dir: agentDir, promptMode: 'append' });
    const resolved = await directory.resolve('my-agent');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.entry.name).toBe('my-agent');
  });

  test('resolves built-in role', async () => {
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.entry.name).toBe('engineer');
  });

  test('resolves built-in council member', async () => {
    const resolved = await directory.resolve('council-architect');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.entry.name).toBe('council-architect');
  });

  test('user entry overrides built-in', async () => {
    await directory.add({ name: 'engineer', dir: agentDir, promptMode: 'system' });
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.entry.promptMode).toBe('system');
  });

  test('returns null for unknown name', async () => {
    const resolved = await directory.resolve('nonexistent');
    expect(resolved).toBeNull();
  });
});

// ============================================================================
// ls()
// ============================================================================

describe('ls', () => {
  test('lists all user entries', async () => {
    await directory.add({ name: 'agent-a', dir: agentDir, promptMode: 'append' });
    await directory.add({ name: 'agent-b', dir: agentDir, promptMode: 'system' });

    const entries = await directory.ls();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.name).sort()).toEqual(['agent-a', 'agent-b']);
  });

  test('returns empty array when no entries', async () => {
    const entries = await directory.ls();
    expect(entries).toEqual([]);
  });
});

// ============================================================================
// edit()
// ============================================================================

describe('edit', () => {
  test('updates model', async () => {
    await directory.add({ name: 'editable', dir: agentDir, promptMode: 'append' });
    const updated = await directory.edit('editable', { model: 'opus' });
    expect(updated.model).toBe('opus');

    // Verify persisted
    const retrieved = await directory.get('editable');
    expect(retrieved!.model).toBe('opus');
  });

  test('updates promptMode', async () => {
    await directory.add({ name: 'editable', dir: agentDir, promptMode: 'append' });
    const updated = await directory.edit('editable', { promptMode: 'system' });
    expect(updated.promptMode).toBe('system');
  });

  test('updates roles', async () => {
    await directory.add({ name: 'editable', dir: agentDir, promptMode: 'append' });
    const updated = await directory.edit('editable', { roles: ['implementor', 'reviewer'] });
    expect(updated.roles).toEqual(['implementor', 'reviewer']);
  });

  test('rejects edit of non-existent entry', async () => {
    await expect(directory.edit('nonexistent', { model: 'opus' })).rejects.toThrow('not found');
  });

  test('validates new dir if provided', async () => {
    await directory.add({ name: 'editable', dir: agentDir, promptMode: 'append' });
    await expect(directory.edit('editable', { dir: '/nonexistent/path' })).rejects.toThrow('does not exist');
  });
});

// ============================================================================
// loadIdentity()
// ============================================================================

describe('loadIdentity', () => {
  test('returns path to AGENTS.md', async () => {
    const entry = await directory.add({ name: 'identity-test', dir: agentDir, promptMode: 'append' });
    const identity = directory.loadIdentity(entry);
    expect(identity).toBe(join(agentDir, 'AGENTS.md'));
  });

  test('returns null when AGENTS.md missing', async () => {
    const emptyEntry = {
      name: 'no-identity',
      dir: '/nonexistent',
      promptMode: 'append' as const,
      registeredAt: new Date().toISOString(),
    };
    const identity = directory.loadIdentity(emptyEntry);
    expect(identity).toBeNull();
  });
});
