/**
 * Tests for Agent Directory — PG-backed, derived from agents table + built-ins.
 * Run with: bun test src/lib/agent-directory.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from './agent-directory.js';
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;
  let testDir: string;
  let agentDir: string;

  beforeAll(async () => {
    cleanup = await setupTestSchema();
  });

  afterAll(async () => {
    await cleanup();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM agents`;

    testDir = join(tmpdir(), `genie-dir-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    agentDir = join(testDir, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), '# Test Agent');
  });

  // ============================================================================
  // resolve()
  // ============================================================================

  describe('resolve', () => {
    test('resolves agent from app_store sync entry', async () => {
      const sql = await getConnection();
      await sql`
        INSERT INTO app_store (name, item_type, version, install_path, manifest)
        VALUES ('synced-agent', 'agent', '0.0.0', ${agentDir}, ${sql.json({ repo: '/tmp/repo', promptMode: 'append' })})
      `;

      const resolved = await directory.resolve('synced-agent');
      expect(resolved).not.toBeNull();
      expect(resolved!.builtin).toBe(false);
      expect(resolved!.entry.name).toBe('synced-agent');
      expect(resolved!.entry.dir).toBe(agentDir);
      expect(resolved!.entry.repo).toBe('/tmp/repo');
    });

    test('resolves agent from PG by role', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('a1', '%1', 's', '/tmp', 'working', 'my-agent', now(), now())`;

      const resolved = await directory.resolve('my-agent');
      expect(resolved).not.toBeNull();
      expect(resolved!.entry.name).toBe('my-agent');
    });

    test('resolves built-in role', async () => {
      const resolved = await directory.resolve('engineer');
      expect(resolved).not.toBeNull();
      expect(resolved!.builtin).toBe(true);
    });

    test('resolves built-in council member', async () => {
      const resolved = await directory.resolve('council--architect');
      expect(resolved).not.toBeNull();
      expect(resolved!.builtin).toBe(true);
    });

    test('PG agent overrides built-in', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('eng1', '%1', 's', '/tmp', 'working', 'engineer', now(), now())`;

      const resolved = await directory.resolve('engineer');
      expect(resolved).not.toBeNull();
      expect(resolved!.builtin).toBe(false);
    });

    test('returns null for unknown name', async () => {
      expect(await directory.resolve('nonexistent-xyz')).toBeNull();
    });
  });

  // ============================================================================
  // ls()
  // ============================================================================

  describe('ls', () => {
    test('lists distinct roles from agents table', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('a1', '%1', 's', '/tmp', 'working', 'engineer', now(), now())`;
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('a2', '%2', 's', '/tmp', 'working', 'reviewer', now(), now())`;
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('a3', '%3', 's', '/tmp', 'working', 'engineer', now(), now())`;

      const entries = await directory.ls();
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(['engineer', 'reviewer']);
    });

    test('returns empty array when no agents', async () => {
      expect(await directory.ls()).toEqual([]);
    });
  });

  // ============================================================================
  // add() / rm()
  // ============================================================================

  describe('add and rm', () => {
    test('add validates dir exists', async () => {
      await expect(directory.add({ name: 'ghost', dir: '/nonexistent', promptMode: 'append' })).rejects.toThrow(
        'does not exist',
      );
    });

    test('add validates AGENTS.md exists', async () => {
      const emptyDir = join(testDir, 'empty');
      mkdirSync(emptyDir, { recursive: true });
      await expect(directory.add({ name: 'no-agents', dir: emptyDir, promptMode: 'append' })).rejects.toThrow(
        'AGENTS.md not found',
      );
    });

    test('add rejects empty name', async () => {
      await expect(directory.add({ name: '', dir: agentDir, promptMode: 'append' })).rejects.toThrow(
        'name is required',
      );
    });

    test('add returns entry with registeredAt', async () => {
      const entry = await directory.add({ name: 'test-agent', dir: agentDir, promptMode: 'append' });
      expect(entry.name).toBe('test-agent');
      expect(entry.registeredAt).toBeTruthy();
    });

    test('rm returns false for non-existent', async () => {
      expect(await directory.rm('nonexistent')).toBe(false);
    });
  });

  // ============================================================================
  // get()
  // ============================================================================

  describe('get', () => {
    test('returns built-in agent entry', async () => {
      const entry = await directory.get('engineer');
      expect(entry).not.toBeNull();
      expect(entry!.name).toBe('engineer');
    });

    test('returns null for unknown agent', async () => {
      expect(await directory.get('nonexistent-xyz')).toBeNull();
    });
  });

  // ============================================================================
  // edit()
  // ============================================================================

  describe('edit', () => {
    test('rejects edit of non-existent entry', async () => {
      await expect(directory.edit('nonexistent-xyz', { model: 'opus' })).rejects.toThrow('not found');
    });

    test('validates new dir if provided', async () => {
      // First register an agent via PG
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change) VALUES ('dir:editable', '%1', 's', '/tmp', 'done', 'editable', now(), now())`;

      await expect(directory.edit('editable', { dir: '/nonexistent/path' })).rejects.toThrow('does not exist');
    });
  });

  // ============================================================================
  // loadIdentity()
  // ============================================================================

  describe('loadIdentity', () => {
    test('returns path to AGENTS.md', () => {
      const entry = { name: 'test', dir: agentDir, promptMode: 'append' as const, registeredAt: '' };
      expect(directory.loadIdentity(entry)).toBe(join(agentDir, 'AGENTS.md'));
    });

    test('returns null when dir is empty', () => {
      const entry = { name: 'test', dir: '', promptMode: 'append' as const, registeredAt: '' };
      expect(directory.loadIdentity(entry)).toBeNull();
    });

    test('returns null when AGENTS.md missing', () => {
      const entry = { name: 'test', dir: '/nonexistent', promptMode: 'append' as const, registeredAt: '' };
      expect(directory.loadIdentity(entry)).toBeNull();
    });
  });

  // ============================================================================
  // getProjectRoot()
  // ============================================================================

  describe('getProjectRoot', () => {
    test('respects GENIE_PROJECT_ROOT env var', () => {
      const prev = process.env.GENIE_PROJECT_ROOT;
      process.env.GENIE_PROJECT_ROOT = '/custom/root';
      expect(directory.getProjectRoot()).toBe('/custom/root');
      process.env.GENIE_PROJECT_ROOT = prev;
    });
  });
});
