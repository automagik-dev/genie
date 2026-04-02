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
import { DB_AVAILABLE, setupTestSchema } from './test-db.js';

describe.skipIf(!DB_AVAILABLE)('agent identity sync — integration', () => {
  let cleanup: () => Promise<void>;
  let workspaceRoot: string;

  beforeAll(async () => {
    cleanup = await setupTestSchema();
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
    expect(result.unchanged).toContain('stable-agent');
    expect(result.registered).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
  });

  // ============================================================================
  // Sync updates when AGENTS.md changes
  // ============================================================================

  test('sync detects AGENTS.md frontmatter changes', async () => {
    const agentDir = createWorkspace(
      'evolving-agent',
      `---
model: sonnet
color: blue
---`,
    );

    await syncAgentDirectory(workspaceRoot);

    // Update AGENTS.md
    writeFileSync(
      join(agentDir, 'AGENTS.md'),
      `---
model: opus
color: red
provider: codex
description: Evolved agent
---
# Agent`,
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
});
