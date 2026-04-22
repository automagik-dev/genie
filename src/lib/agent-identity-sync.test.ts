/**
 * Integration test for Agent Identity Sync — end-to-end flow.
 *
 * Creates a temp workspace with an agent directory + AGENTS.md frontmatter,
 * then verifies:
 *   1. genie dir sync populates metadata from frontmatter
 *   2. genie dir ls returns all frontmatter fields
 *   3. genie dir edit persists changes to PG
 *   4. Re-sync overwrites edit changes (AGENTS.md wins)
 *
 * Run with: bun test src/lib/agent-identity-sync.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from './agent-directory.js';
import { syncAgentDirectory } from './agent-sync.js';
import { getConnection } from './db.js';
import { DB_AVAILABLE, setupTestDatabase } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('agent identity sync — integration', () => {
  let cleanup: () => Promise<void>;
  let workspaceRoot: string;

  beforeAll(async () => {
    cleanup = await setupTestDatabase();
  });

  afterAll(async () => {
    await cleanup();
  });

  afterEach(async () => {
    const sql = await getConnection();
    await sql`DELETE FROM agents`;
    try {
      rmSync(workspaceRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  /**
   * Helper: create a workspace with an agent dir + AGENTS.md.
   */
  function createWorkspace(agentName: string, frontmatter: string, body = '# Agent'): string {
    workspaceRoot = join(tmpdir(), `genie-sync-int-${Date.now()}`);
    const agentDir = join(workspaceRoot, 'agents', agentName);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), `${frontmatter}\n${body}`);
    return agentDir;
  }

  // ============================================================================
  // Sync populates metadata from frontmatter
  // ============================================================================

  test('sync populates all frontmatter fields into directory', async () => {
    createWorkspace(
      'vegapunk-atlas',
      `---
name: vegapunk/atlas
description: Deep research agent
model: opus
color: blue
promptMode: system
provider: codex
---`,
    );

    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.registered).toContain('vegapunk-atlas');
    expect(result.errors).toHaveLength(0);

    const entry = await directory.get('vegapunk-atlas');
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe('opus');
    expect(entry!.promptMode).toBe('system');
    expect(entry!.color).toBe('blue');
    expect(entry!.provider).toBe('codex');
    expect(entry!.description).toBe('Deep research agent');
  });

  // ============================================================================
  // ls returns all frontmatter fields
  // ============================================================================

  test('ls returns entries with all metadata fields', async () => {
    createWorkspace(
      'vegapunk-lilith',
      `---
description: Design agent
model: sonnet
color: red
provider: claude
---`,
    );

    await syncAgentDirectory(workspaceRoot);

    const entries = await directory.ls();
    const entry = entries.find((e) => e.name === 'vegapunk-lilith');
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe('sonnet');
    expect(entry!.color).toBe('red');
    expect(entry!.provider).toBe('claude');
    expect(entry!.description).toBe('Design agent');
  });

  // ============================================================================
  // edit persists changes to PG
  // ============================================================================

  test('edit persists changes and get reads them back', async () => {
    createWorkspace(
      'vegapunk-edison',
      `---
model: opus
provider: claude
---`,
    );

    await syncAgentDirectory(workspaceRoot);

    // Edit the model via directory.edit
    await directory.edit('vegapunk-edison', { model: 'sonnet', provider: 'codex' });

    // Read directly from PG to verify persistence
    const sql = await getConnection();
    const rows = await sql`SELECT metadata FROM agents WHERE id = 'dir:vegapunk-edison'`;
    expect(rows.length).toBe(1);
    const metadata = rows[0].metadata as Record<string, unknown>;
    expect(metadata.model).toBe('sonnet');
    expect(metadata.provider).toBe('codex');

    // Also verify via directory.get round-trip
    const entry = await directory.get('vegapunk-edison');
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe('sonnet');
    expect(entry!.provider).toBe('codex');
  });

  // ============================================================================
  // Re-sync overwrites edit changes — AGENTS.md wins
  // ============================================================================

  test('re-sync overwrites dir edit changes with AGENTS.md values', async () => {
    createWorkspace(
      'vegapunk-shaka',
      `---
model: opus
color: green
provider: codex
description: Wisdom agent
---`,
    );

    // Initial sync
    const firstSync = await syncAgentDirectory(workspaceRoot);
    expect(firstSync.registered).toContain('vegapunk-shaka');

    // Edit model and provider via directory.edit
    await directory.edit('vegapunk-shaka', { model: 'haiku', provider: 'claude', color: 'yellow' });

    // Verify edit took effect
    const edited = await directory.get('vegapunk-shaka');
    expect(edited!.model).toBe('haiku');
    expect(edited!.provider).toBe('claude');
    expect(edited!.color).toBe('yellow');

    // Re-sync — AGENTS.md values should overwrite the edit
    const secondSync = await syncAgentDirectory(workspaceRoot);
    expect(secondSync.updated).toContain('vegapunk-shaka');

    // Verify AGENTS.md values restored
    const restored = await directory.get('vegapunk-shaka');
    expect(restored).not.toBeNull();
    expect(restored!.model).toBe('opus');
    expect(restored!.color).toBe('green');
    expect(restored!.provider).toBe('codex');
    expect(restored!.description).toBe('Wisdom agent');
  });

  // ============================================================================
  // Sync with no frontmatter — defaults applied
  // ============================================================================

  test('sync with minimal AGENTS.md uses defaults', async () => {
    createWorkspace('minimal-agent', '');

    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.registered).toContain('minimal-agent');

    const entry = await directory.get('minimal-agent');
    expect(entry).not.toBeNull();
    expect(entry!.promptMode).toBe('append');
    expect(entry!.model).toBeUndefined();
    expect(entry!.provider).toBeUndefined();
    expect(entry!.color).toBeUndefined();
    expect(entry!.description).toBeUndefined();
  });

  // ============================================================================
  // Sync unchanged — idempotent
  // ============================================================================

  test('re-sync with no changes reports unchanged', async () => {
    createWorkspace(
      'stable-agent',
      `---
model: opus
---`,
    );

    await syncAgentDirectory(workspaceRoot);
    const result = await syncAgentDirectory(workspaceRoot);
    // Per wish `dir-sync-frontmatter-refresh`: the "Unchanged" skip path was
    // eliminated. Every existing agent gets upserted and lands in `updated`.
    expect(result.updated).toContain('stable-agent');
    expect(result.registered).toHaveLength(0);
  });

  // ============================================================================
  // Sync updates when AGENTS.md changes
  // ============================================================================

  test('sync detects agent.yaml changes (post-migration canonical source)', async () => {
    const agentDir = createWorkspace(
      'evolving-agent',
      `---
model: sonnet
color: blue
---`,
    );

    // First sync migrates the AGENTS.md frontmatter into agent.yaml. Per wish
    // `dir-sync-frontmatter-refresh`, agent.yaml becomes the canonical source
    // thereafter; editing AGENTS.md frontmatter is a no-op.
    await syncAgentDirectory(workspaceRoot);

    // Edit the new canonical source directly.
    writeFileSync(
      join(agentDir, 'agent.yaml'),
      `model: opus
color: red
provider: codex
description: Evolved agent
promptMode: append
`,
    );

    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.updated).toContain('evolving-agent');

    const entry = await directory.get('evolving-agent');
    expect(entry!.model).toBe('opus');
    expect(entry!.color).toBe('red');
    expect(entry!.provider).toBe('codex');
    expect(entry!.description).toBe('Evolved agent');
  });

  // ============================================================================
  // PG metadata survives fresh resolve (simulates process restart)
  // ============================================================================

  test('metadata survives PG round-trip (simulates restart)', async () => {
    createWorkspace(
      'persistent-agent',
      `---
model: opus
color: purple
provider: codex
description: Persistent test
promptMode: system
---`,
    );

    await syncAgentDirectory(workspaceRoot);

    // Resolve fresh from PG — simulates reading after process restart
    const entry = await directory.get('persistent-agent');
    expect(entry).not.toBeNull();
    expect(entry!.model).toBe('opus');
    expect(entry!.color).toBe('purple');
    expect(entry!.provider).toBe('codex');
    expect(entry!.description).toBe('Persistent test');
    expect(entry!.promptMode).toBe('system');
  });

  // ============================================================================
  // dir-sync-frontmatter-refresh (Group 3): migration trigger + always-upsert
  // ============================================================================

  test('first sync on unmigrated agent triggers migration exactly once', async () => {
    const agentDir = createWorkspace(
      'fresh-agent',
      `---
model: sonnet
color: blue
---`,
    );

    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.migrated).toContain('fresh-agent');

    // agent.yaml now exists, .bak preserves the original, AGENTS.md has no frontmatter
    const fs = await import('node:fs');
    expect(fs.existsSync(join(agentDir, 'agent.yaml'))).toBe(true);
    expect(fs.existsSync(join(agentDir, 'AGENTS.md.bak'))).toBe(true);
    const mdAfter = fs.readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(mdAfter).not.toMatch(/^---/m);
  });

  test('second sync is a no-op on the migration path (already-migrated)', async () => {
    createWorkspace(
      'migrated-twice',
      `---
model: sonnet
---`,
    );

    const first = await syncAgentDirectory(workspaceRoot);
    expect(first.migrated).toContain('migrated-twice');

    const second = await syncAgentDirectory(workspaceRoot);
    // Migration already done — second sync must NOT re-migrate
    expect(second.migrated).not.toContain('migrated-twice');
    // But the agent is still reached and upserted
    expect(second.updated).toContain('migrated-twice');
  });

  test('editing agent.yaml + re-sync updates the DB row in one breath (the original reproducer)', async () => {
    const agentDir = createWorkspace(
      'repro-agent',
      `---
model: sonnet
color: blue
---`,
    );

    // First sync migrates AGENTS.md frontmatter into agent.yaml.
    await syncAgentDirectory(workspaceRoot);

    const entryBefore = await directory.get('repro-agent');
    expect(entryBefore!.model).toBe('sonnet');
    expect(entryBefore!.color).toBe('blue');

    // Edit agent.yaml (the new canonical source) — NO manual SQL required.
    writeFileSync(
      join(agentDir, 'agent.yaml'),
      `model: opus
color: red
description: Post-migration edit
promptMode: append
`,
    );

    // Second sync picks it up on the very next run.
    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.updated).toContain('repro-agent');

    const entry = await directory.get('repro-agent');
    expect(entry!.model).toBe('opus');
    expect(entry!.color).toBe('red');
    expect(entry!.description).toBe('Post-migration edit');
  });

  test('SyncResult has no `unchanged` property (removed by wish)', async () => {
    createWorkspace(
      'stable-after-migration',
      `---
model: opus
---`,
    );

    const first = await syncAgentDirectory(workspaceRoot);
    const second = await syncAgentDirectory(workspaceRoot);

    // Both results lack the old `unchanged` key entirely — the type system
    // enforced this but we also verify at runtime for future-proofing.
    expect(Object.hasOwn(first, 'unchanged')).toBe(false);
    expect(Object.hasOwn(second, 'unchanged')).toBe(false);

    // And the agent is reached on every run.
    expect([...first.registered, ...first.updated]).toContain('stable-after-migration');
    expect(second.updated).toContain('stable-after-migration');
  });
});
