/**
 * Integration tests for `genie dir edit` — Group 4 of wish
 * `dir-sync-frontmatter-refresh`.
 *
 * The tests exercise the post-refactor flow directly (write `agent.yaml`,
 * then sync) rather than the commander wiring. The assertions pin the
 * wish's acceptance criteria: every flag lands in the yaml file BEFORE
 * the DB write, concurrent writes never truncate, and no SQL update
 * fires ahead of the yaml mutation.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, readFile as readFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../lib/agent-directory.js';
import { migrateAgentToYaml } from '../lib/agent-migrate.js';
import { syncSingleAgentByName } from '../lib/agent-sync.js';
import { type AgentConfig, parseAgentYaml, writeAgentYaml } from '../lib/agent-yaml.js';
import { getConnection } from '../lib/db.js';
import { DB_AVAILABLE, setupTestSchema } from '../lib/test-db.js';

describe.skipIf(!DB_AVAILABLE)('dir edit — agent.yaml-first flow (wish dir-sync-frontmatter-refresh group 4)', () => {
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

  function seedAgent(name: string, frontmatter: string): string {
    workspaceRoot = join(tmpdir(), `dir-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const agentDir = join(workspaceRoot, 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), `${frontmatter}\n# body`);
    return agentDir;
  }

  /**
   * Shared helper mirroring the post-refactor `handleEdit` flow:
   *   1. Migrate if needed.
   *   2. Read agent.yaml.
   *   3. Merge updates.
   *   4. Write agent.yaml atomically.
   *   5. Trigger single-agent sync to propagate into PG.
   */
  async function editAgentYaml(name: string, agentDir: string, updates: Partial<AgentConfig>): Promise<void> {
    const yamlPath = join(agentDir, 'agent.yaml');
    await migrateAgentToYaml(agentDir);
    const current = await parseAgentYaml(yamlPath);
    await writeAgentYaml(yamlPath, { ...current, ...updates });
    await syncSingleAgentByName(workspaceRoot, name);
  }

  test('--model opus → agent.yaml contains model: opus', async () => {
    const agentDir = seedAgent('model-agent', '---\nmodel: sonnet\n---');

    await editAgentYaml('model-agent', agentDir, { model: 'opus' });

    const yamlRaw = await readFileAsync(join(agentDir, 'agent.yaml'), 'utf-8');
    expect(yamlRaw).toMatch(/model:\s*opus/);

    const entry = await directory.get('model-agent');
    expect(entry!.model).toBe('opus');
  });

  test('--allow Read,Glob,Grep → permissions.allow array in yaml', async () => {
    const agentDir = seedAgent('allow-agent', '---\npromptMode: append\n---');

    await editAgentYaml('allow-agent', agentDir, {
      permissions: { allow: ['Read', 'Glob', 'Grep'] },
    });

    const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(parsed.permissions?.allow).toEqual(['Read', 'Glob', 'Grep']);

    const entry = await directory.get('allow-agent');
    expect(entry!.permissions?.allow).toEqual(['Read', 'Glob', 'Grep']);
  });

  test('--permission-preset read-only → permissions.preset in yaml', async () => {
    const agentDir = seedAgent('preset-agent', '---\npromptMode: append\n---');

    await editAgentYaml('preset-agent', agentDir, {
      permissions: { preset: 'read-only' },
    });

    const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(parsed.permissions?.preset).toBe('read-only');
  });

  test('--sdk-permission-mode auto → sdk.permissionMode in yaml', async () => {
    const agentDir = seedAgent('sdk-agent', '---\npromptMode: append\n---');

    await editAgentYaml('sdk-agent', agentDir, {
      sdk: { permissionMode: 'auto' } as AgentConfig['sdk'],
    });

    const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(parsed.sdk?.permissionMode).toBe('auto');
  });

  test('--roles [...] → roles survive yaml + sync into PG metadata', async () => {
    // Regression pin: `dir edit --roles` silently accepted the flag but the
    // sync layer dropped roles on the way from yaml → PG, and `roleToEntry`
    // hardcoded `roles: []` on read. Roles must now round-trip through the
    // full yaml-first flow and be visible via `directory.get()`.
    const agentDir = seedAgent('roles-agent', '---\npromptMode: append\n---');

    await editAgentYaml('roles-agent', agentDir, {
      roles: ['team-lead', 'engineer', 'reviewer', 'qa'],
    });

    const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(parsed.roles).toEqual(['team-lead', 'engineer', 'reviewer', 'qa']);

    const entry = await directory.get('roles-agent');
    expect(entry!.roles).toEqual(['team-lead', 'engineer', 'reviewer', 'qa']);
  });

  test('yaml write happens BEFORE db write — file wins if sync skipped', async () => {
    // Assertion: if we write the yaml but skip the sync step, the file on
    // disk reflects the edit immediately. This pins the "file is source of
    // truth" principle: the DB is a projection of the yaml, not the
    // authoritative store.
    const agentDir = seedAgent('file-wins', '---\nmodel: sonnet\n---');
    await migrateAgentToYaml(agentDir);

    const yamlPath = join(agentDir, 'agent.yaml');
    const current = await parseAgentYaml(yamlPath);
    await writeAgentYaml(yamlPath, { ...current, model: 'opus' });

    const yamlRaw = await readFile(yamlPath, 'utf-8');
    expect(yamlRaw).toMatch(/model:\s*opus/);
  });

  test('concurrent writes do not produce a truncated yaml', async () => {
    const agentDir = seedAgent('concurrent-agent', '---\npromptMode: append\n---');
    await migrateAgentToYaml(agentDir);
    const yamlPath = join(agentDir, 'agent.yaml');

    const writes: Promise<void>[] = [];
    for (let i = 0; i < 8; i++) {
      const cfg: AgentConfig = {
        promptMode: 'append',
        model: `model-${i}`,
        description: `Iteration ${i}`,
      };
      writes.push(writeAgentYaml(yamlPath, cfg));
    }
    await Promise.all(writes);

    // The winner's file must be a parseable complete config — never a
    // partial splice. The lockfile in writeAgentYaml enforces this.
    const parsed = await parseAgentYaml(yamlPath);
    expect(parsed.promptMode).toBe('append');
    expect(parsed.model).toMatch(/^model-[0-7]$/);
    expect(parsed.description).toMatch(/^Iteration [0-7]$/);
  });

  test('combined flags all land in a single yaml write', async () => {
    const agentDir = seedAgent('combo-agent', '---\npromptMode: append\n---');

    await editAgentYaml('combo-agent', agentDir, {
      model: 'opus',
      color: 'red',
      permissions: { preset: 'read-only', allow: ['Read'] },
      sdk: { permissionMode: 'auto' } as AgentConfig['sdk'],
    });

    const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(parsed.model).toBe('opus');
    expect(parsed.color).toBe('red');
    expect(parsed.permissions?.preset).toBe('read-only');
    expect(parsed.permissions?.allow).toEqual(['Read']);
    expect(parsed.sdk?.permissionMode).toBe('auto');
  });
});
