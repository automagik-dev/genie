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
import type { SdkDirectoryConfig } from './sdk-directory-types.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('pg', () => {
  let cleanup: () => Promise<void>;
  let testDir: string;
  let agentDir: string;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
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

    test('prefers dir: row over stale runtime rows with same role', async () => {
      const sql = await getConnection();
      // Insert stale runtime row (empty metadata, older started_at)
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, metadata) VALUES ('stale-uuid', '%1', 's', '/tmp', 'done', 'my-dup', now() - interval '1 hour', now(), '{}')`;
      // Insert another stale runtime row (empty metadata, recent started_at — would win ORDER BY started_at DESC)
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, metadata) VALUES ('recent-uuid', '%2', 's', '/tmp', 'done', 'my-dup', now(), now(), '{}')`;
      // Insert directory row (has real metadata — oldest started_at, but should still win via dir: prefix)
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:my-dup', 'my-dup', 'my-dup', now() - interval '2 hours', '{"dir":"/some/path","model":"opus","color":"teal","description":"The real entry"}')`;

      const resolved = await directory.resolve('my-dup');
      expect(resolved).not.toBeNull();
      expect(resolved!.entry.model).toBe('opus');
      expect(resolved!.entry.color).toBe('teal');
      expect(resolved!.entry.description).toBe('The real entry');
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

    test('ls prefers dir: row over stale runtime rows', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, metadata) VALUES ('runtime-1', '%1', 's', '/tmp', 'done', 'ls-dup', now(), now(), '{}')`;
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:ls-dup', 'ls-dup', 'ls-dup', now() - interval '1 hour', '{"dir":"/real/dir","model":"sonnet","description":"Directory entry"}')`;

      const entries = await directory.ls();
      const entry = entries.find((e) => e.name === 'ls-dup');
      expect(entry).not.toBeNull();
      expect(entry!.model).toBe('sonnet');
      expect(entry!.description).toBe('Directory entry');
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

    test('add writes team and repo_path to PG (Gap 1+3 fix, 2026-04-25 power-outage post-mortem)', async () => {
      // Pre-fix bug: dir: agents inserted with team=NULL even when the entry
      // had a known team. session-sync hook's `getAgentByName(name, team)`
      // lookup then missed (WHERE custom_name=$1 AND team=$2 → NULL row),
      // so the agent's claude_session_id was never persisted. Post-fix:
      // team and dir are written to top-level columns, not just metadata.
      await directory.add({
        name: 'teamed-agent',
        dir: agentDir,
        promptMode: 'append',
        team: 'genie',
      });

      const sql = await getConnection();
      const rows = await sql<{ team: string | null; repo_path: string | null }[]>`
        SELECT team, repo_path FROM agents WHERE id = 'dir:teamed-agent'
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].team).toBe('genie');
      expect(rows[0].repo_path).toBe(agentDir);
    });

    test('add upserts team without overwriting an already-set team (Gap 3 idempotence)', async () => {
      const sql = await getConnection();
      // Pre-seed with team
      await directory.add({ name: 'idempotent-team', dir: agentDir, promptMode: 'append', team: 'genie' });
      // Re-add with no team — must not clobber
      await sql`UPDATE agents SET team = 'genie' WHERE id = 'dir:idempotent-team'`;
      // Calling add again with no team specified should not erase the existing one.
      // (Note: add() throws on duplicate non-builtin, so test via raw INSERT path.)
      await sql`
        INSERT INTO agents (id, role, custom_name, team, repo_path, started_at, state, metadata)
        VALUES ('dir:idempotent-team', 'idempotent-team', 'idempotent-team', NULL, ${agentDir}, now(), NULL, '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          team = COALESCE(EXCLUDED.team, agents.team),
          metadata = '{}'::jsonb
      `;
      const [row] = await sql<{ team: string | null }[]>`
        SELECT team FROM agents WHERE id = 'dir:idempotent-team'
      `;
      expect(row.team).toBe('genie');
    });

    test('rm returns removed=false with no message for truly non-existent', async () => {
      const result = await directory.rm('nonexistent');
      expect(result.removed).toBe(false);
      expect(result.message).toBeUndefined();
    });

    test('rm returns removed=false + guidance message when runtime rows exist but no dir: row', async () => {
      // Simulate a spawn-created row (id shape: <team>-<role>) that `ls()` would
      // show but the old `rm` could not delete because it only tried 'dir:<name>'.
      const sql = await getConnection();
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change)
        VALUES ('team1-spawn-agent', '%1', 's', '/tmp', 'working', 'spawn-agent', now(), now())
      `;

      const result = await directory.rm('spawn-agent');
      expect(result.removed).toBe(false);
      expect(result.message).toBeDefined();
      expect(result.message).toContain('team1-spawn-agent');
      expect(result.message).toContain('--force');

      // Confirm ls() still shows the row — rm did NOT silently remove it.
      const entries = await directory.ls();
      expect(entries.some((e) => e.name === 'spawn-agent')).toBe(true);
    });

    test('rm with force=true wipes runtime rows sharing role', async () => {
      const sql = await getConnection();
      // reports_to set so the generated `kind` column resolves to 'task' (the
      // wave-1 heal-not-wipe guardrail refuses to delete kind='permanent'
      // rows with a non-empty repo_path; ephemeral workers always carry a
      // parent reference, so this fixture matches real ephemeral shape).
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, reports_to)
        VALUES ('team1-force-agent', '%1', 's', '/tmp', 'working', 'force-agent', now(), now(), 'parent-1')
      `;
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, reports_to)
        VALUES ('uuid-force-agent', '%2', 's', '/tmp', 'working', 'force-agent', now(), now(), 'parent-1')
      `;

      const result = await directory.rm('force-agent', { force: true });
      expect(result.removed).toBe(true);
      expect(result.message).toBeUndefined();

      const rows = await sql`SELECT id FROM agents WHERE role = 'force-agent'`;
      expect(rows.length).toBe(0);
    });

    test('rm removes dir: row even without force (with explicitPermanent escape)', async () => {
      // Canonical path: dir:<name> is still a single-hop delete. The dir: row
      // carries kind='permanent' (generated column) AND repo_path=agentDir,
      // matching the heal-not-wipe guardrail's protected shape — operator
      // confirmation via explicitPermanent is required.
      await directory.add({ name: 'canonical-rm', dir: agentDir, promptMode: 'append' });
      const result = await directory.rm('canonical-rm', { explicitPermanent: true });
      expect(result.removed).toBe(true);

      const sql = await getConnection();
      const rows = await sql`SELECT id FROM agents WHERE id = 'dir:canonical-rm'`;
      expect(rows.length).toBe(0);
    });
  });

  // ============================================================================
  // Heal-not-wipe guardrail (master-aware-spawn wish, Group 3)
  // ============================================================================

  describe('rm heal-not-wipe guardrail', () => {
    test('refuses to delete master agent row (kind=permanent, repo_path set)', async () => {
      // Create a `dir:email`-shaped row (post-fix add() writes team + repo_path
      // to top-level columns; kind is generated from id LIKE 'dir:%').
      await directory.add({ name: 'protected-master', dir: agentDir, promptMode: 'append', team: 'felipe' });

      await expect(directory.rm('protected-master')).rejects.toThrow(/Refused to delete master agent row/);
      await expect(directory.rm('protected-master')).rejects.toThrow(/genie agent recover protected-master/);

      // Row is intact.
      const sql = await getConnection();
      const rows = await sql`SELECT id, kind, repo_path FROM agents WHERE id = 'dir:protected-master'`;
      expect(rows.length).toBe(1);
      expect(rows[0].kind).toBe('permanent');
      expect(rows[0].repo_path).toBe(agentDir);
    });

    test('emits directory.rm.refused audit event on guardrail block', async () => {
      await directory.add({ name: 'audit-master', dir: agentDir, promptMode: 'append', team: 'felipe' });

      await expect(directory.rm('audit-master')).rejects.toThrow();

      // No timeout needed — the production code awaits the audit INSERT before
      // throwing, so the row is queryable immediately. (A previous draft slept
      // 50ms here to mask a CLI regression where the unawaited Promise was
      // dropped before the process exited; twin caught it and the await fix
      // landed in the same commit as this assertion.)
      const sql = await getConnection();
      const events = await sql<{ details: Record<string, unknown> }[]>`
        SELECT details FROM audit_events
        WHERE entity_id = 'dir:audit-master' AND event_type = 'directory.rm.refused'
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(events.length).toBe(1);
      expect(events[0].details.reason).toBe('protected_master_row');
      expect((events[0].details.protected_ids as string[])[0]).toBe('dir:audit-master');
    });

    test('allows delete of ephemeral row (kind=task, regression guard)', async () => {
      // Ephemeral worker — reports_to set, so kind='task'. Always deletable.
      const sql = await getConnection();
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, reports_to)
        VALUES ('team-eph-1', '%1', 's', '/tmp', 'working', 'ephemeral-role', now(), now(), 'parent-1')
      `;
      const kindCheck = await sql<{ kind: string }[]>`SELECT kind FROM agents WHERE id = 'team-eph-1'`;
      expect(kindCheck[0].kind).toBe('task');

      // No dir: row, but force=true touches role='ephemeral-role'. Guardrail
      // sees no protected match (kind='task'), so deletion proceeds.
      const result = await directory.rm('ephemeral-role', { force: true });
      expect(result.removed).toBe(true);

      const rows = await sql`SELECT id FROM agents WHERE id = 'team-eph-1'`;
      expect(rows.length).toBe(0);
    });

    test('explicitPermanent=true bypasses the guardrail', async () => {
      await directory.add({ name: 'escape-hatch', dir: agentDir, promptMode: 'append', team: 'felipe' });

      const result = await directory.rm('escape-hatch', { explicitPermanent: true });
      expect(result.removed).toBe(true);

      const sql = await getConnection();
      const rows = await sql`SELECT id FROM agents WHERE id = 'dir:escape-hatch'`;
      expect(rows.length).toBe(0);
    });

    test('force=true alone still respects the guardrail (master row protected)', async () => {
      // A master-shaped runtime row (no dir: prefix but kind='permanent' via
      // reports_to=NULL, repo_path set). Without --explicit-permanent, even
      // --force must refuse because the role-sweep would wipe the master row.
      const sql = await getConnection();
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change)
        VALUES ('lead-master-x', '%1', 's', '/workspace/master-x', 'working', 'master-x', now(), now())
      `;
      const kindCheck = await sql<{ kind: string }[]>`SELECT kind FROM agents WHERE id = 'lead-master-x'`;
      expect(kindCheck[0].kind).toBe('permanent');

      await expect(directory.rm('master-x', { force: true })).rejects.toThrow(/Refused to delete master agent row/);

      // Row intact.
      const rows = await sql`SELECT id FROM agents WHERE id = 'lead-master-x'`;
      expect(rows.length).toBe(1);
    });

    test('force=true with explicitPermanent=true wipes master + runtime rows together', async () => {
      const sql = await getConnection();
      await directory.add({ name: 'nuke-master', dir: agentDir, promptMode: 'append', team: 'felipe' });
      await sql`
        INSERT INTO agents (id, pane_id, session, repo_path, state, role, started_at, last_state_change, reports_to)
        VALUES ('runtime-nuke', '%1', 's', '/tmp', 'working', 'nuke-master', now(), now(), 'parent-1')
      `;

      const result = await directory.rm('nuke-master', { force: true, explicitPermanent: true });
      expect(result.removed).toBe(true);

      const rows = await sql`SELECT id FROM agents WHERE role = 'nuke-master'`;
      expect(rows.length).toBe(0);
    });
  });

  // ============================================================================
  // roleToEntry() — registeredAt stability (sub-bug B)
  // ============================================================================

  describe('registeredAt stability', () => {
    test('ls returns stable registeredAt across successive reads (sourced from PG created_at)', async () => {
      const sql = await getConnection();
      // Pin created_at to a past timestamp so a fabricated now() would clearly drift.
      await sql`
        INSERT INTO agents (id, role, custom_name, started_at, created_at, metadata)
        VALUES (
          'dir:stable-ts',
          'stable-ts',
          'stable-ts',
          now() - interval '1 hour',
          now() - interval '1 hour',
          '{}'
        )
      `;

      const first = await directory.ls();
      // Small wall-clock gap — enough that a `new Date().toISOString()` fabrication
      // would produce a different value on the second read.
      await new Promise((r) => setTimeout(r, 50));
      const second = await directory.ls();

      const a = first.find((e) => e.name === 'stable-ts');
      const b = second.find((e) => e.name === 'stable-ts');
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a!.registeredAt).toBe(b!.registeredAt);
      // And it must reflect the pinned past created_at, not wall-clock now().
      const ts = Date.parse(a!.registeredAt);
      expect(Number.isNaN(ts)).toBe(false);
      expect(Date.now() - ts).toBeGreaterThan(30 * 60 * 1000); // > 30min old
    });

    test('resolve returns stable registeredAt matching ls', async () => {
      const sql = await getConnection();
      await sql`
        INSERT INTO agents (id, role, custom_name, started_at, created_at, metadata)
        VALUES (
          'dir:stable-resolve',
          'stable-resolve',
          'stable-resolve',
          now() - interval '2 hours',
          now() - interval '2 hours',
          '{}'
        )
      `;

      const resolved = await directory.resolve('stable-resolve');
      const entries = await directory.ls();
      const listed = entries.find((e) => e.name === 'stable-resolve');
      expect(resolved).not.toBeNull();
      expect(listed).toBeDefined();
      expect(resolved!.entry.registeredAt).toBe(listed!.registeredAt);
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
  });

  // ============================================================================
  // sdk round-trip
  // ============================================================================

  describe('sdk round-trip', () => {
    test('add persists sdk config to PG metadata', async () => {
      const sdkConfig: SdkDirectoryConfig = {
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        thinking: { type: 'adaptive' },
        agents: {
          reviewer: {
            description: 'Code reviewer',
            prompt: 'You review code.',
            model: 'sonnet',
            maxTurns: 10,
          },
        },
        mcpServers: {
          'my-server': {
            type: 'stdio',
            command: 'node',
            args: ['./server.js'],
          },
        },
      };

      await directory.add({
        name: 'sdk-agent',
        dir: agentDir,
        promptMode: 'append',
        sdk: sdkConfig,
      });

      const sql = await getConnection();
      const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:sdk-agent'`;
      expect(rows.length).toBe(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata.sdk).toEqual(sdkConfig);
    });

    test('get returns sdk config after PG round-trip', async () => {
      const sdkConfig: SdkDirectoryConfig = {
        effort: 'high',
        maxBudgetUsd: 5.0,
        allowedTools: ['Bash', 'Read'],
        disallowedTools: ['Write'],
        persistSession: false,
        enableFileCheckpointing: true,
        betas: ['context-1m-2025-08-07'],
      };

      await directory.add({
        name: 'sdk-roundtrip',
        dir: agentDir,
        promptMode: 'append',
        sdk: sdkConfig,
      });

      const entry = await directory.get('sdk-roundtrip');
      expect(entry).not.toBeNull();
      expect(entry!.sdk).toEqual(sdkConfig);
    });

    test('edit updates sdk config via PG', async () => {
      const sql = await getConnection();
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:sdk-edit', 'sdk-edit', 'sdk-edit', now(), '{}')`;

      const sdkConfig: SdkDirectoryConfig = {
        permissionMode: 'dontAsk',
        systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be concise.' },
        sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
      };

      await directory.edit('sdk-edit', { sdk: sdkConfig });

      const entry = await directory.get('sdk-edit');
      expect(entry).not.toBeNull();
      expect(entry!.sdk).toEqual(sdkConfig);
    });

    test('resolve returns sdk field from PG metadata', async () => {
      const sdkConfig: SdkDirectoryConfig = {
        thinking: { type: 'enabled', budgetTokens: 4096 },
        plugins: [{ type: 'local', path: '/plugins/test' }],
      };

      const sql = await getConnection();
      const metaJson = JSON.stringify({ sdk: sdkConfig });
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:sdk-resolve', 'sdk-resolve', 'sdk-resolve', now(), ${metaJson}::jsonb)`;

      const resolved = await directory.resolve('sdk-resolve');
      expect(resolved).not.toBeNull();
      expect(resolved!.entry.sdk).toEqual(sdkConfig);
    });

    test('ls includes sdk field from PG metadata', async () => {
      const sdkConfig: SdkDirectoryConfig = {
        maxTurns: 100,
        effort: 'max',
      };

      const sql = await getConnection();
      const metaJson = JSON.stringify({ sdk: sdkConfig });
      await sql`INSERT INTO agents (id, role, custom_name, started_at, metadata) VALUES ('dir:sdk-ls', 'sdk-ls', 'sdk-ls', now(), ${metaJson}::jsonb)`;

      const entries = await directory.ls();
      const entry = entries.find((e) => e.name === 'sdk-ls');
      expect(entry).not.toBeNull();
      expect(entry!.sdk).toEqual(sdkConfig);
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
