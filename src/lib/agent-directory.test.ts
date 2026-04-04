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

    test('resolve returns sdk config from PG metadata', async () => {
      const sql = await getConnection();
      const sdkMeta = {
        sdk: {
          permissionMode: 'dontAsk',
          maxTurns: 25,
          betas: ['interleaved-thinking'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be concise.' },
        },
      };
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:sdk-resolve', 'sdk-resolve', 'sdk-resolve', now(), ${sql.json(sdkMeta)})`;

      const resolved = await directory.resolve('sdk-resolve');
      expect(resolved).not.toBeNull();
      expect(resolved!.entry.sdk).toBeDefined();
      expect(resolved!.entry.sdk!.permissionMode).toBe('dontAsk');
      expect(resolved!.entry.sdk!.maxTurns).toBe(25);
      expect(resolved!.entry.sdk!.betas).toEqual(['interleaved-thinking']);
      expect(resolved!.entry.sdk!.systemPrompt).toEqual({
        type: 'preset',
        preset: 'claude_code',
        append: 'Be concise.',
      });
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

    test('ls includes metadata fields from PG', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:ls-meta', 'ls-meta', 'ls-meta', now(), '{"model":"opus","color":"green","provider":"codex","description":"Ls test"}')`;

      const entries = await directory.ls();
      const entry = entries.find((e) => e.name === 'ls-meta');
      expect(entry).not.toBeNull();
      expect(entry!.model).toBe('opus');
      expect(entry!.color).toBe('green');
      expect(entry!.provider).toBe('codex');
      expect(entry!.description).toBe('Ls test');
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

    test('add writes metadata to PG', async () => {
      await directory.add({
        name: 'meta-add-agent',
        dir: agentDir,
        promptMode: 'system',
        model: 'opus',
        color: 'red',
        description: 'A test agent',
        provider: 'codex',
      });

      const sql = await getConnection();
      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:meta-add-agent'`;
      expect(rows.length).toBe(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.model).toBe('opus');
      expect(metadata.color).toBe('red');
      expect(metadata.description).toBe('A test agent');
      expect(metadata.provider).toBe('codex');
      expect(metadata.promptMode).toBe('system');
      expect(metadata.dir).toBe(agentDir);
    });

    test('rm returns false for non-existent', async () => {
      expect(await directory.rm('nonexistent')).toBe(false);
    });

    test('add with sdk config persists to PG metadata', async () => {
      const sdkConfig = {
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        maxTurns: 10,
        model: 'claude-sonnet-4-20250514',
        mcpServers: {
          myServer: { command: 'node', args: ['server.js'] },
        },
      };

      await directory.add({
        name: 'sdk-add-agent',
        dir: agentDir,
        promptMode: 'append',
        sdk: sdkConfig,
      });

      const sql = await getConnection();
      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:sdk-add-agent'`;
      expect(rows.length).toBe(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.sdk).toBeDefined();
      const sdk = metadata.sdk as Record<string, unknown>;
      expect(sdk.permissionMode).toBe('bypassPermissions');
      expect(sdk.allowDangerouslySkipPermissions).toBe(true);
      expect(sdk.maxTurns).toBe(10);
      expect(sdk.model).toBe('claude-sonnet-4-20250514');
      expect(sdk.mcpServers).toEqual({
        myServer: { command: 'node', args: ['server.js'] },
      });
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

    test('edit persists model to PG metadata', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:meta-agent', 'meta-agent', 'meta-agent', now(), '{}')`;

      await directory.edit('meta-agent', { model: 'opus' });

      // Read directly from PG to verify persistence
      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:meta-agent'`;
      expect(rows.length).toBe(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.model).toBe('opus');
    });

    test('edit persists multiple metadata fields to PG', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:multi-meta', 'multi-meta', 'multi-meta', now(), '{}')`;

      await directory.edit('multi-meta', {
        model: 'sonnet',
        color: 'blue',
        provider: 'codex',
        description: 'Test agent',
      });

      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:multi-meta'`;
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.model).toBe('sonnet');
      expect(metadata.color).toBe('blue');
      expect(metadata.provider).toBe('codex');
      expect(metadata.description).toBe('Test agent');
    });

    test('get returns edited model after PG round-trip', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:roundtrip', 'roundtrip', 'roundtrip', now(), '{}')`;

      await directory.edit('roundtrip', { model: 'opus', provider: 'codex' });

      // Resolve fresh from PG — simulates process restart
      const entry = await directory.get('roundtrip');
      expect(entry).not.toBeNull();
      expect(entry!.model).toBe('opus');
      expect(entry!.provider).toBe('codex');
    });

    test('edit with sdk config round-trips through PG', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:sdk-edit', 'sdk-edit', 'sdk-edit', now(), '{}')`;

      const sdkConfig = {
        permissionMode: 'acceptEdits' as const,
        maxBudgetUsd: 5.0,
        effort: 'high' as const,
        allowedTools: ['Read', 'Write', 'Bash'],
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
      };

      await directory.edit('sdk-edit', { sdk: sdkConfig });

      // Read directly from PG to verify persistence
      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:sdk-edit'`;
      expect(rows.length).toBe(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.sdk).toBeDefined();
      const sdk = metadata.sdk as Record<string, unknown>;
      expect(sdk.permissionMode).toBe('acceptEdits');
      expect(sdk.maxBudgetUsd).toBe(5.0);
      expect(sdk.effort).toBe('high');
      expect(sdk.allowedTools).toEqual(['Read', 'Write', 'Bash']);
      expect(sdk.sandbox).toEqual({ enabled: true, autoAllowBashIfSandboxed: true });

      // Verify round-trip via get()
      const entry = await directory.get('sdk-edit');
      expect(entry).not.toBeNull();
      expect(entry!.sdk).toBeDefined();
      expect(entry!.sdk!.permissionMode).toBe('acceptEdits');
      expect(entry!.sdk!.maxBudgetUsd).toBe(5.0);
      expect(entry!.sdk!.effort).toBe('high');
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
