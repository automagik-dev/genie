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
// Test setup — use temp dirs for both GENIE_HOME (global) and project root
// ============================================================================

let testDir: string;
let agentDir: string;
let projectRoot: string;

beforeEach(() => {
  testDir = join(tmpdir(), `genie-dir-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  process.env.GENIE_HOME = testDir;

  // Separate project root for project-scoped directory (with .genie dir for lock files)
  projectRoot = join(testDir, 'project');
  mkdirSync(join(projectRoot, '.genie'), { recursive: true });
  process.env.GENIE_PROJECT_ROOT = projectRoot;

  // Create a fake agent dir with AGENTS.md
  agentDir = join(testDir, 'test-agent-home');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'AGENTS.md'), '# Test Agent\nYou are a test agent.');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  process.env.GENIE_HOME = undefined;
  process.env.GENIE_PROJECT_ROOT = undefined;
});

// ============================================================================
// add()
// ============================================================================

describe('add', () => {
  test('persists entry to project directory by default', async () => {
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

  test('persists to global directory with global option', async () => {
    const entry = await directory.add(
      { name: 'global-agent', dir: agentDir, promptMode: 'append' },
      { global: true },
    );

    expect(entry.name).toBe('global-agent');

    // Should be retrievable
    const retrieved = await directory.get('global-agent');
    expect(retrieved).not.toBeNull();
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

  test('rejects duplicate name in same scope', async () => {
    await directory.add({ name: 'agent1', dir: agentDir, promptMode: 'append' });
    await expect(directory.add({ name: 'agent1', dir: agentDir, promptMode: 'append' })).rejects.toThrow(
      'already exists',
    );
  });

  test('allows same name in different scopes', async () => {
    await directory.add({ name: 'engineer', dir: agentDir, promptMode: 'append' });
    const globalEntry = await directory.add(
      { name: 'engineer', dir: agentDir, promptMode: 'system' },
      { global: true },
    );
    expect(globalEntry.name).toBe('engineer');
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
  test('removes existing entry from project', async () => {
    await directory.add({ name: 'to-remove', dir: agentDir, promptMode: 'append' });
    const removed = await directory.rm('to-remove');
    expect(removed).toBe(true);

    const retrieved = await directory.get('to-remove');
    expect(retrieved).toBeNull();
  });

  test('removes existing entry from global', async () => {
    await directory.add({ name: 'global-rm', dir: agentDir, promptMode: 'append' }, { global: true });
    const removed = await directory.rm('global-rm', { global: true });
    expect(removed).toBe(true);
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
  test('resolves project directory entry first', async () => {
    await directory.add({ name: 'my-agent', dir: agentDir, promptMode: 'append' });
    const resolved = await directory.resolve('my-agent');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.source).toBe('project');
    expect(resolved!.entry.name).toBe('my-agent');
  });

  test('resolves global directory entry', async () => {
    await directory.add({ name: 'global-only', dir: agentDir, promptMode: 'append' }, { global: true });
    const resolved = await directory.resolve('global-only');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.source).toBe('global');
    expect(resolved!.entry.name).toBe('global-only');
  });

  test('project overrides global', async () => {
    await directory.add({ name: 'shared', dir: agentDir, promptMode: 'system' }, { global: true });
    await directory.add({ name: 'shared', dir: agentDir, promptMode: 'append' });
    const resolved = await directory.resolve('shared');
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe('project');
    expect(resolved!.entry.promptMode).toBe('append');
  });

  test('resolves built-in role', async () => {
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.source).toBe('built-in');
    expect(resolved!.entry.name).toBe('engineer');
  });

  test('resolves built-in council member', async () => {
    const resolved = await directory.resolve('council--architect');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.source).toBe('built-in');
    expect(resolved!.entry.name).toBe('council--architect');
  });

  test('project entry overrides built-in', async () => {
    await directory.add({ name: 'engineer', dir: agentDir, promptMode: 'system' });
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.source).toBe('project');
    expect(resolved!.entry.promptMode).toBe('system');
  });

  test('global entry overrides built-in', async () => {
    await directory.add({ name: 'engineer', dir: agentDir, promptMode: 'system' }, { global: true });
    const resolved = await directory.resolve('engineer');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(false);
    expect(resolved!.source).toBe('global');
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
  test('lists project entries with scope', async () => {
    await directory.add({ name: 'agent-a', dir: agentDir, promptMode: 'append' });
    await directory.add({ name: 'agent-b', dir: agentDir, promptMode: 'system' });

    const entries = await directory.ls();
    expect(entries.length).toBe(2);
    expect(entries.map((e) => e.name).sort()).toEqual(['agent-a', 'agent-b']);
    expect(entries.every((e) => e.scope === 'project')).toBe(true);
  });

  test('lists global entries with scope', async () => {
    await directory.add({ name: 'global-a', dir: agentDir, promptMode: 'append' }, { global: true });

    const entries = await directory.ls();
    expect(entries.length).toBe(1);
    expect(entries[0].scope).toBe('global');
  });

  test('merges project and global entries', async () => {
    await directory.add({ name: 'proj-agent', dir: agentDir, promptMode: 'append' });
    await directory.add({ name: 'global-agent', dir: agentDir, promptMode: 'append' }, { global: true });

    const entries = await directory.ls();
    expect(entries.length).toBe(2);
    const scopes = entries.map((e) => ({ name: e.name, scope: e.scope }));
    expect(scopes).toContainEqual({ name: 'proj-agent', scope: 'project' });
    expect(scopes).toContainEqual({ name: 'global-agent', scope: 'global' });
  });

  test('project entry shadows global with same name', async () => {
    await directory.add({ name: 'shared', dir: agentDir, promptMode: 'system' }, { global: true });
    await directory.add({ name: 'shared', dir: agentDir, promptMode: 'append' });

    const entries = await directory.ls();
    expect(entries.length).toBe(1);
    expect(entries[0].scope).toBe('project');
    expect(entries[0].promptMode).toBe('append');
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

  test('edits global entry with global option', async () => {
    await directory.add({ name: 'global-edit', dir: agentDir, promptMode: 'append' }, { global: true });
    const updated = await directory.edit('global-edit', { model: 'opus' }, { global: true });
    expect(updated.model).toBe('opus');
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
