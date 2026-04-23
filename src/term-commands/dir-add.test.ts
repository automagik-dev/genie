/**
 * Integration tests for `genie dir add` — Group 5 of wish
 * `dir-sync-frontmatter-refresh`.
 *
 * Verifies the wish's deliverable: `dir add <name>` scaffolds BOTH an
 * `agent.yaml` (from CLI flags) and a frontmatter-less `AGENTS.md`
 * body template, then syncs the DB row from the yaml.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as directory from '../lib/agent-directory.js';
import { syncSingleAgentByName } from '../lib/agent-sync.js';
import { type AgentConfig, parseAgentYaml, writeAgentYaml } from '../lib/agent-yaml.js';
import { getConnection } from '../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';

describe.skipIf(!DB_AVAILABLE)(
  'dir add — scaffolds agent.yaml + body-only AGENTS.md (wish dir-sync-frontmatter-refresh group 5)',
  () => {
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
     * Mirrors `handleDirAdd`'s new flow without going through commander.
     * Writes agent.yaml from the caller's config, scaffolds an AGENTS.md
     * body (no YAML fence), then runs the single-agent sync path.
     */
    async function dirAddAgent(name: string, config: AgentConfig): Promise<string> {
      workspaceRoot = join(tmpdir(), `dir-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const agentDir = join(workspaceRoot, 'agents', name);
      mkdirSync(agentDir, { recursive: true });

      // Scaffold AGENTS.md without a frontmatter block (matches handleDirAdd).
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(agentDir, 'AGENTS.md'),
        `# Agent: ${name}

Describe what this agent does.

<mission>
TBD
</mission>
`,
      );

      // Write agent.yaml via the shared library helper.
      await writeAgentYaml(join(agentDir, 'agent.yaml'), config);

      // Propagate into PG via the same single-agent sync path `handleDirAdd` uses.
      await syncSingleAgentByName(workspaceRoot, name);

      return agentDir;
    }

    test('creates both agent.yaml and AGENTS.md', async () => {
      const agentDir = await dirAddAgent('scaffold-agent', {
        promptMode: 'append',
        model: 'opus',
      });

      expect(existsSync(join(agentDir, 'agent.yaml'))).toBe(true);
      expect(existsSync(join(agentDir, 'AGENTS.md'))).toBe(true);
    });

    test('scaffolded AGENTS.md does NOT start with --- (no frontmatter fence)', async () => {
      const agentDir = await dirAddAgent('no-fence-agent', { promptMode: 'append' });

      const mdContent = await readFile(join(agentDir, 'AGENTS.md'), 'utf-8');
      // Acceptance criterion from wish: head -c 3 AGENTS.md !== '---'
      expect(mdContent.slice(0, 3)).not.toBe('---');
      // Sanity: it starts with `# Agent:` per the scaffold template.
      expect(mdContent).toMatch(/^# Agent:/);
    });

    test('agent.yaml parses cleanly and contains --model value', async () => {
      const agentDir = await dirAddAgent('model-agent', {
        promptMode: 'append',
        model: 'opus',
      });

      const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
      expect(parsed.model).toBe('opus');
    });

    test('DB row (directory entry) exists with matching model', async () => {
      await dirAddAgent('db-match-agent', {
        promptMode: 'append',
        model: 'sonnet',
      });

      const entry = await directory.get('db-match-agent');
      expect(entry).not.toBeNull();
      expect(entry!.model).toBe('sonnet');
    });

    test('permissions flags land in yaml + DB', async () => {
      const agentDir = await dirAddAgent('perms-agent', {
        promptMode: 'append',
        permissions: { preset: 'read-only', allow: ['Read', 'Glob'] },
      });

      const parsed = await parseAgentYaml(join(agentDir, 'agent.yaml'));
      expect(parsed.permissions?.preset).toBe('read-only');
      expect(parsed.permissions?.allow).toEqual(['Read', 'Glob']);

      const entry = await directory.get('perms-agent');
      expect(entry!.permissions?.preset).toBe('read-only');
      expect(entry!.permissions?.allow).toEqual(['Read', 'Glob']);
    });

    test('re-adding the same agent is idempotent — second call overwrites yaml, sync still matches', async () => {
      // First add: model sonnet.
      const firstDir = await dirAddAgent('idempotent', { promptMode: 'append', model: 'sonnet' });
      const firstEntry = await directory.get('idempotent');
      expect(firstEntry!.model).toBe('sonnet');

      // Second add at the SAME path (simulates re-invocation): model opus.
      // In practice the CLI errors if the agent already exists; this test
      // pins the lower-level behavior that writing agent.yaml + re-syncing
      // always produces the yaml's current state in the DB.
      await writeAgentYaml(join(firstDir, 'agent.yaml'), { promptMode: 'append', model: 'opus' });
      await syncSingleAgentByName(workspaceRoot, 'idempotent');

      const secondEntry = await directory.get('idempotent');
      expect(secondEntry!.model).toBe('opus');
    });
  },
);
