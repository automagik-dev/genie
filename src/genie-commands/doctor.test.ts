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
import { checkGenieAgentTemplate, checkLegacyAgentFrontmatter, findBundledTmuxConfigDir } from './doctor.js';

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

// Stale-template marker matching what scaffoldAgentFiles wrote pre-#1374
// (lifted verbatim from the generic AGENTS_TEMPLATE body — `seed` mimics
// what an old workspace would have on disk after upgrading the package).
const GENERIC_AGENTS_MD = [
  '@HEARTBEAT.md',
  '',
  '<mission>',
  "Define your agent's mission here. What is their primary goal? What do they own?",
  '</mission>',
  '',
  '<principles>',
  '- **Clarity over ambiguity.** Be specific.',
  '</principles>',
  '',
].join('\n');

const GENERIC_AGENT_YAML_NO_MODEL = [
  'team: genie',
  'promptMode: system',
  'description: Describe what this agent does.',
  'color: blue',
  '',
].join('\n');

const SPECIALIST_AGENTS_MD = [
  '---',
  'name: genie',
  'description: Workspace concierge and orchestrator.',
  'model: opus',
  'promptMode: append',
  'color: cyan',
  '---',
  '',
  '@HEARTBEAT.md',
  '',
  '<mission>',
  'You are the **genie specialist**.',
  '</mission>',
  '',
].join('\n');

const SPECIALIST_AGENT_YAML = ['name: genie', 'model: opus', 'color: cyan', 'promptMode: append', ''].join('\n');

describe('checkGenieAgentTemplate', () => {
  test('warns when AGENTS.md still uses generic placeholder template', () => {
    seedAgent('genie', {
      agentYaml: SPECIALIST_AGENT_YAML,
      agentsMd: GENERIC_AGENTS_MD,
    });

    const results = checkGenieAgentTemplate(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toMatch(/generic placeholder template/);
    expect(results[0].suggestion).toMatch(/genie doctor --fix/);
  });

  test('warns when agent.yaml is missing model field', () => {
    seedAgent('genie', {
      agentYaml: GENERIC_AGENT_YAML_NO_MODEL,
      agentsMd: SPECIALIST_AGENTS_MD,
    });

    const results = checkGenieAgentTemplate(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toMatch(/missing model/);
  });

  test('reports both symptoms in the same warning when both stale', () => {
    seedAgent('genie', {
      agentYaml: GENERIC_AGENT_YAML_NO_MODEL,
      agentsMd: GENERIC_AGENTS_MD,
    });

    const results = checkGenieAgentTemplate(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toMatch(
      /generic placeholder template.*missing model|missing model.*generic placeholder template/,
    );
  });

  test('passes when both files match the modern specialist template', () => {
    seedAgent('genie', {
      agentYaml: SPECIALIST_AGENT_YAML,
      agentsMd: SPECIALIST_AGENTS_MD,
    });

    const results = checkGenieAgentTemplate(workspaceRoot);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('pass');
  });

  test('returns empty when agents/genie/ does not exist (non-genie workspace)', () => {
    seedAgent('other-agent', {
      agentYaml: 'promptMode: append\nmodel: opus\n',
      agentsMd: '# something else',
    });

    const results = checkGenieAgentTemplate(workspaceRoot);
    expect(results).toEqual([]);
  });

  test('returns empty when no workspace root resolved', () => {
    // Pass an explicit non-existent root — the early-return path.
    const results = checkGenieAgentTemplate(join(workspaceRoot, 'does-not-exist'));
    expect(results).toEqual([]);
  });
});

describe('findBundledTmuxConfigDir', () => {
  test('locates the bundled scripts/tmux directory in the dev tree', () => {
    const dir = findBundledTmuxConfigDir();
    // Running from the genie repo, the helper must resolve scripts/tmux
    // relative to this module's URL.
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/scripts[/\\]tmux$/);
  });
});
