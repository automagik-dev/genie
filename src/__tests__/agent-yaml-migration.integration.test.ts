/**
 * Integration tests for wish `dir-sync-frontmatter-refresh` (Group 7).
 *
 * End-to-end proof that the wish's invariants hold across G1-G6:
 *   - G1: AgentConfigSchema / parseAgentYaml / writeAgentYaml
 *   - G2: migrateAgentToYaml
 *   - G3: syncAgentDirectory (always upsert, no "Unchanged" skip)
 *   - G4: dir edit yaml-first flow
 *   - G5: dir add scaffolds both files
 *   - G6: checkLegacyAgentFrontmatter
 *
 * These tests compose the layers and pin the user-visible reproducer
 * from today's session: edit `agent.yaml`, run sync, DB picks it up in
 * the next breath — no "Unchanged" message anywhere in stdout.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLegacyAgentFrontmatter } from '../genie-commands/doctor.js';
import * as directory from '../lib/agent-directory.js';
import { printSyncResult, syncAgentDirectory } from '../lib/agent-sync.js';
import { parseAgentYaml, writeAgentYaml } from '../lib/agent-yaml.js';
import { getConnection } from '../lib/db.js';
import { DB_AVAILABLE, setupTestDatabase } from '../lib/test-db.js';

describe.skipIf(!DB_AVAILABLE)('dir-sync-frontmatter-refresh — integration', () => {
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

  function createAgent(name: string, agentsMdContent: string): string {
    workspaceRoot = join(tmpdir(), `integ-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const agentDir = join(workspaceRoot, 'agents', name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'AGENTS.md'), agentsMdContent);
    return agentDir;
  }

  /**
   * Capture console.log + console.warn output during a block. Returns the
   * combined stdout stream. Restores original handlers on finally.
   */
  async function captureStdout<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
    const chunks: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    console.log = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      chunks.push(args.map(String).join(' '));
    };
    try {
      const value = await fn();
      return { value, output: chunks.join('\n') };
    } finally {
      console.log = origLog;
      console.warn = origWarn;
    }
  }

  // ==========================================================================
  // Today's reproducer — the end-to-end promise of this wish.
  // ==========================================================================

  test('TODAYS REPRODUCER: edit agent.yaml + re-sync → DB picks it up, no "Unchanged" anywhere', async () => {
    // (a) Seed AGENTS.md with frontmatter (pre-migration state).
    const agentDir = createAgent('alice', '---\nteam: simone\nmodel: sonnet\n---\n\n# Agent body\n');

    // (b) First sync — triggers migration + upsert.
    const first = await captureStdout(() => syncAgentDirectory(workspaceRoot));
    const firstPrint = await captureStdout(async () => {
      printSyncResult(first.value);
    });

    // Migration happened — yaml + .bak exist, frontmatter gone from AGENTS.md.
    expect(first.value.migrated).toContain('alice');
    expect(existsSync(join(agentDir, 'agent.yaml'))).toBe(true);
    expect(existsSync(join(agentDir, 'AGENTS.md.bak'))).toBe(true);
    const mdAfter = readFileSync(join(agentDir, 'AGENTS.md'), 'utf-8');
    expect(mdAfter.slice(0, 3)).not.toBe('---');

    // (c) agent.yaml has team: simone carried over from frontmatter.
    const yamlAfterMigrate = await parseAgentYaml(join(agentDir, 'agent.yaml'));
    expect(yamlAfterMigrate.team).toBe('simone');
    expect(yamlAfterMigrate.model).toBe('sonnet');

    // (d) DB row reflects the yaml model (team isn't propagated by sync
    // today — pre-existing gap documented in G3's PR).
    const entryAfterMigrate = await directory.get('alice');
    expect(entryAfterMigrate!.model).toBe('sonnet');

    // (e) Edit agent.yaml — the canonical source.
    writeFileSync(join(agentDir, 'agent.yaml'), 'team: new-team\nmodel: opus\npromptMode: append\n');

    // (f) Re-run sync — picks up the edit.
    const second = await captureStdout(() => syncAgentDirectory(workspaceRoot));
    const secondPrint = await captureStdout(async () => {
      printSyncResult(second.value);
    });

    // (g) DB row matches the yaml edit in one breath — no manual SQL.
    const entryAfterEdit = await directory.get('alice');
    expect(entryAfterEdit!.model).toBe('opus');

    // (h) No "Unchanged" literal in any of the captured stdout.
    expect(firstPrint.output).not.toMatch(/Unchanged/);
    expect(secondPrint.output).not.toMatch(/Unchanged/);
    // And the summary line ends with the new wording.
    expect(secondPrint.output).toMatch(/Synced:\s+\d+\s+agent/);
  });

  // ==========================================================================
  // Invisible migration — .bak byte-equality + body preservation
  // ==========================================================================

  test('migration preserves AGENTS.md body byte-for-byte in .bak + strips frontmatter from AGENTS.md', async () => {
    const body = '# Header\n\nParagraph with **bold** and `code`.\n\n- bullet\n\n日本語 тест\n';
    const md = `---\nname: bytes\nteam: simone\n---\n${body}`;
    const agentDir = createAgent('bytes', md);

    await syncAgentDirectory(workspaceRoot);

    expect(await readFile(join(agentDir, 'AGENTS.md.bak'), 'utf-8')).toBe(md);
    expect(await readFile(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe(body);
  });

  test('migration preserves CRLF line endings in body', async () => {
    const body = 'line-a\r\nline-b\r\n';
    const md = `---\nname: crlf\n---\n${body}`;
    const agentDir = createAgent('crlf', md);

    await syncAgentDirectory(workspaceRoot);

    expect(await readFile(join(agentDir, 'AGENTS.md'), 'utf-8')).toBe(body);
  });

  // ==========================================================================
  // CLI-only round-trip — permissions.bashAllowPatterns using exact TS name
  // ==========================================================================

  test('permissions.bashAllowPatterns round-trips through write → parse', async () => {
    const agentDir = createAgent('bap', '---\nname: bap\npromptMode: append\n---\nbody\n');
    await syncAgentDirectory(workspaceRoot);

    // Emulate `genie dir edit --bash-allow` by writing the nested field directly.
    const yamlPath = join(agentDir, 'agent.yaml');
    const current = await parseAgentYaml(yamlPath);
    await writeAgentYaml(yamlPath, {
      ...current,
      permissions: { ...current.permissions, bashAllowPatterns: ['^ls\\b', '^git\\s+status\\b'] },
    });

    const parsed = await parseAgentYaml(yamlPath);
    expect(parsed.permissions?.bashAllowPatterns).toEqual(['^ls\\b', '^git\\s+status\\b']);
  });

  // ==========================================================================
  // Idempotent sync — second run makes no new migrations, still upserts
  // ==========================================================================

  test('idempotent sync: second call does not re-migrate, still upserts, no "Unchanged"', async () => {
    createAgent('idem', '---\nname: idem\nmodel: sonnet\n---\nbody\n');

    const first = await syncAgentDirectory(workspaceRoot);
    expect(first.migrated).toContain('idem');

    const second = await captureStdout(async () => {
      const res = await syncAgentDirectory(workspaceRoot);
      printSyncResult(res);
      return res;
    });

    expect(second.value.migrated).not.toContain('idem');
    expect(second.value.updated).toContain('idem');
    expect(second.output).not.toMatch(/Unchanged/);
  });

  // ==========================================================================
  // Legacy frontmatter post-migration → doctor warns (Group 6)
  // ==========================================================================

  test('post-migration: if someone re-adds frontmatter to AGENTS.md, doctor flags it', async () => {
    const agentDir = createAgent('drift', '---\nname: drift\nmodel: sonnet\n---\n# body\n');
    await syncAgentDirectory(workspaceRoot);
    expect(existsSync(join(agentDir, 'agent.yaml'))).toBe(true);

    // Re-pollute: user pastes config back into AGENTS.md (mistake).
    writeFileSync(join(agentDir, 'AGENTS.md'), '---\nmodel: pasted-here-by-mistake\n---\n# body\n');

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    const warning = results.find((r) => r.status === 'warn' && r.name.includes('drift'));
    expect(warning).toBeDefined();
    expect(warning!.suggestion).toMatch(/agent\.yaml/);
  });

  // ==========================================================================
  // Fresh agent flow: no frontmatter ever → still registered with defaults
  // ==========================================================================

  test('fresh agent with no frontmatter and no agent.yaml still syncs with defaults', async () => {
    createAgent('blank', '# Plain AGENTS.md — no fence\n\nBody.\n');

    const result = await syncAgentDirectory(workspaceRoot);
    expect(result.registered).toContain('blank');
    expect(result.migrated).not.toContain('blank');

    const entry = await directory.get('blank');
    expect(entry).not.toBeNull();
  });
});
