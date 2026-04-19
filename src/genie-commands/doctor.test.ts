/**
 * Tests for `checkLegacyAgentFrontmatter` — Group 6 of wish
 * `dir-sync-frontmatter-refresh`.
 *
 * The check walks every agent directory under `agents/` and warns when an
 * AGENTS.md starts with a `---` fence while an `agent.yaml` is also
 * present — the configuration-in-wrong-file scenario that sync silently
 * ignores post-migration.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkLegacyAgentFrontmatter } from './doctor.js';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'doctor-legacy-fm-'));
});

afterEach(() => {
  try {
    rmSync(workspaceRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function seedAgent(name: string, files: { agentYaml?: string; agentsMd?: string }): void {
  const agentDir = join(workspaceRoot, 'agents', name);
  mkdirSync(agentDir, { recursive: true });
  if (files.agentYaml !== undefined) writeFileSync(join(agentDir, 'agent.yaml'), files.agentYaml);
  if (files.agentsMd !== undefined) writeFileSync(join(agentDir, 'AGENTS.md'), files.agentsMd);
}

describe('checkLegacyAgentFrontmatter', () => {
  test('warns when AGENTS.md has frontmatter AND agent.yaml exists', async () => {
    seedAgent('drifted', {
      agentYaml: 'promptMode: append\nmodel: opus\n',
      agentsMd: '---\nmodel: sonnet\n---\n\n# body',
    });

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].name).toBe('agents/drifted/AGENTS.md');
    expect(results[0].message).toMatch(/legacy frontmatter/i);
    expect(results[0].suggestion).toMatch(/agent\.yaml/);
  });

  test('silent (pass) when agent.yaml absent — pre-migration state', async () => {
    seedAgent('pre-migration', {
      agentsMd: '---\nmodel: sonnet\n---\n\n# body',
    });

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
    expect(results[0].name).toMatch(/No legacy frontmatter/);
  });

  test('silent (pass) when AGENTS.md has no fence — clean post-migration', async () => {
    seedAgent('clean', {
      agentYaml: 'promptMode: append\n',
      agentsMd: '# Agent: clean\n\nBody content.',
    });

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });

  test('silent when agents/ directory does not exist', async () => {
    // No seeding — workspace has no agents/ dir.
    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(0);
  });

  test('flags multiple agents independently', async () => {
    seedAgent('drifted-one', {
      agentYaml: 'promptMode: append\n',
      agentsMd: '---\nmodel: opus\n---\n# body',
    });
    seedAgent('clean', {
      agentYaml: 'promptMode: append\n',
      agentsMd: '# Agent: clean\n\nBody.',
    });
    seedAgent('drifted-two', {
      agentYaml: 'promptMode: append\n',
      agentsMd: '---\ncolor: red\n---\n# body',
    });

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    // 2 warnings + 0 pass fillers (pass filler only emitted when zero warnings)
    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['agents/drifted-one/AGENTS.md', 'agents/drifted-two/AGENTS.md']);
  });

  test('ignores non-directory entries in agents/', async () => {
    // Seed one drifted agent so we get a warning to assert.
    seedAgent('real', {
      agentYaml: 'promptMode: append\n',
      agentsMd: '---\nmodel: opus\n---\n',
    });
    // Drop a file inside agents/ — should be skipped, not crash.
    writeFileSync(join(workspaceRoot, 'agents', 'README'), 'not an agent');

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('agents/real/AGENTS.md');
  });

  test('skips agent dirs that only have agent.yaml (no AGENTS.md)', async () => {
    seedAgent('yaml-only', { agentYaml: 'promptMode: append\n' });

    const results = checkLegacyAgentFrontmatter(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });
});
