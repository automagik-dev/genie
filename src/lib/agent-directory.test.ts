/**
 * Tests for Agent Directory module.
 *
 * Run with: bun test src/lib/agent-directory.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
    const resolved = await directory.resolve('implementor');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.entry.name).toBe('implementor');
  });

  test('resolves built-in council member', async () => {
    const resolved = await directory.resolve('council-architect');
    expect(resolved).not.toBeNull();
    expect(resolved!.builtin).toBe(true);
    expect(resolved!.entry.name).toBe('council-architect');
  });

  test('user entry overrides built-in', async () => {
    await directory.add({ name: 'implementor', dir: agentDir, promptMode: 'system' });
    const resolved = await directory.resolve('implementor');
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

// ============================================================================
// Edge Cases — QA Plan P0 Tests (U-AD-*)
// ============================================================================

describe('edge cases', () => {
  // U-AD-01: Whitespace-only name
  test('U-AD-01: add() with whitespace-only name throws', async () => {
    await expect(directory.add({ name: '   ', dir: agentDir, promptMode: 'append' })).rejects.toThrow(
      'name is required',
    );
  });

  // U-AD-02: Name containing slashes
  test('U-AD-02: add() with name containing slashes', async () => {
    // The code doesn't explicitly validate slashes — document behavior
    // It stores the name as-is in JSON, which is fine for a dict key
    const entry = await directory.add({
      name: 'feat/agent',
      dir: agentDir,
      promptMode: 'append',
    });
    expect(entry.name).toBe('feat/agent');

    // Verify it can be retrieved
    const retrieved = await directory.get('feat/agent');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('feat/agent');
  });

  // U-AD-05: resolve() is case-sensitive
  test('U-AD-05: resolve() is case-sensitive', async () => {
    // Built-in 'implementor' should be found
    const lower = await directory.resolve('implementor');
    expect(lower).not.toBeNull();

    // 'Implementor' (capital I) should NOT be found
    const upper = await directory.resolve('Implementor');
    expect(upper).toBeNull();
  });

  // U-AD-06: edit() with empty updates (no-op)
  test('U-AD-06: edit() with empty updates preserves all fields', async () => {
    await directory.add({
      name: 'preserve-test',
      dir: agentDir,
      promptMode: 'system',
      model: 'opus',
      roles: ['implementor'],
    });

    // Edit with empty object
    const updated = await directory.edit('preserve-test', {});

    expect(updated.name).toBe('preserve-test');
    expect(updated.dir).toBe(agentDir);
    expect(updated.promptMode).toBe('system');
    expect(updated.model).toBe('opus');
    expect(updated.roles).toEqual(['implementor']);
  });

  // U-AD-07: loadIdentity() after AGENTS.md deleted post-add
  test('U-AD-07: loadIdentity() returns null after AGENTS.md is deleted', async () => {
    const tmpAgentDir = join(testDir, 'stale-agent');
    mkdirSync(tmpAgentDir, { recursive: true });
    writeFileSync(join(tmpAgentDir, 'AGENTS.md'), '# Stale Agent');

    const entry = await directory.add({
      name: 'stale-agent',
      dir: tmpAgentDir,
      promptMode: 'append',
    });

    // Verify identity exists initially
    expect(directory.loadIdentity(entry)).not.toBeNull();

    // Delete AGENTS.md
    unlinkSync(join(tmpAgentDir, 'AGENTS.md'));

    // loadIdentity should now return null
    expect(directory.loadIdentity(entry)).toBeNull();
  });

  // U-AD-08: Unicode name
  test('U-AD-08: add() with unicode name', async () => {
    const entry = await directory.add({
      name: 'agente-日本語',
      dir: agentDir,
      promptMode: 'append',
    });
    expect(entry.name).toBe('agente-日本語');

    const retrieved = await directory.get('agente-日本語');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name).toBe('agente-日本語');
  });

  // F-02: Agent directory file with invalid JSON
  test('F-02: loadDirectory recovers from corrupted JSON', async () => {
    // Write garbage to the directory file
    const dirFilePath = join(testDir, 'agent-directory.json');
    writeFileSync(dirFilePath, 'not valid json {{{');

    // ls() should return empty (loadDirectory catch returns default)
    const entries = await directory.ls();
    expect(entries).toEqual([]);

    // add() should work (overwrites corrupted file)
    const entry = await directory.add({
      name: 'after-corruption',
      dir: agentDir,
      promptMode: 'append',
    });
    expect(entry.name).toBe('after-corruption');
  });

  // U-AD-03: 1000-char name
  test('U-AD-03: add() with 1000-char name accepts (no length limit)', async () => {
    const longName = 'a'.repeat(1000);
    const entry = await directory.add({
      name: longName,
      dir: agentDir,
      promptMode: 'append',
    });
    expect(entry.name).toBe(longName);
    expect(entry.name.length).toBe(1000);

    const retrieved = await directory.get(longName);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.name.length).toBe(1000);
  });

  // U-AD-04: dir pointing to symlink
  test('U-AD-04: add() with dir pointing to symlink follows it', async () => {
    // Create target dir with AGENTS.md
    const realDir = join(testDir, 'real-agent-dir');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'AGENTS.md'), '# Symlinked Agent');

    // Create symlink to target
    const linkDir = join(testDir, 'linked-agent-dir');
    symlinkSync(realDir, linkDir);

    const entry = await directory.add({
      name: 'symlinked-agent',
      dir: linkDir,
      promptMode: 'append',
    });
    expect(entry.name).toBe('symlinked-agent');

    // loadIdentity should find AGENTS.md through symlink
    const identity = directory.loadIdentity(entry);
    expect(identity).not.toBeNull();
    expect(identity).toContain('AGENTS.md');
  });

  // F-04: AGENTS.md deleted between add() and resolve()
  test('F-04: resolve() returns entry even after AGENTS.md deleted', async () => {
    const tmpAgentDir = join(testDir, 'resolve-stale');
    mkdirSync(tmpAgentDir, { recursive: true });
    writeFileSync(join(tmpAgentDir, 'AGENTS.md'), '# Will Be Deleted');

    await directory.add({
      name: 'resolve-stale',
      dir: tmpAgentDir,
      promptMode: 'append',
    });

    // Delete AGENTS.md
    unlinkSync(join(tmpAgentDir, 'AGENTS.md'));

    // resolve() should still return the entry (no re-check of filesystem)
    const resolved = await directory.resolve('resolve-stale');
    expect(resolved).not.toBeNull();
    expect(resolved!.entry.name).toBe('resolve-stale');

    // But loadIdentity should return null
    expect(directory.loadIdentity(resolved!.entry)).toBeNull();
  });
});
