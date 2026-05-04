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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkGenieAgentTemplate,
  checkLegacyAgentFrontmatter,
  findBundledTmuxConfigDir,
  findStaleGenieCandidates,
} from './doctor.js';

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

describe('pgserve v1/v2 coexistence', () => {
  test('doctor --fix never pkills pgserve/postgres after the canonical cutover', () => {
    const source = readFileSync(join(__dirname, 'doctor.ts'), 'utf-8');
    // killStalePostgres was removed entirely — pkill of pm2-supervised
    // processes was the bug behind every "Could not kill stale postgres
    // processes" failure. The doctor now prints a hint and exits.
    expect(source).not.toContain('async function killStalePostgres');
    expect(source).not.toContain('Killing stale Genie legacy pgserve processes');
    expect(source).not.toContain('Could not kill stale Genie legacy pgserve processes');
    expect(source).not.toMatch(/pkill -9 -f "(postgres|pgserve)\.\*/);
    // Replacement: a hint-only function the operator follows manually.
    expect(source).toContain('function printPgserveRecoveryHint');
    expect(source).toContain('pm2 restart pgserve');
  });

  test('doctor --fix leaves legacy port/data files untouched unless legacy repair is enabled', () => {
    const source = readFileSync(join(__dirname, 'doctor.ts'), 'utf-8');
    const fnStart = source.indexOf('function removeStaleFiles');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('async function restartDaemon', fnStart);
    const body = source.slice(fnStart, fnEnd);

    expect(body).toContain('legacyPgserveRepairEnabled()');
    expect(body).toContain('Leaving legacy pgserve v1 port/data files untouched');
    expect(body).toContain("join(genieHome, 'pgserve.port')");
    expect(body).toContain("join(genieHome, 'data', 'pgserve', 'postmaster.pid')");
  });
});

describe('reapStaleGenieProcesses (post-update reaper)', () => {
  // The reaper runs during `genie update` to kill leftover genie processes
  // (TUIs, orphan subprocesses, old daemons) whose in-memory binary is the
  // pre-update version. Without this, those processes hold leaked pgserve
  // connections from the old code path and saturate `max_connections=1000`.

  test('finds the current process when not in exclude set (sanity)', () => {
    if (process.platform !== 'linux') {
      // Reaper is Linux-only; skip on macOS/Windows.
      expect(true).toBe(true);
      return;
    }
    // The current bun:test process is running `dist/genie.js` on real hosts,
    // but inside `bun test` the cmdline is the test runner — not genie.
    // Instead, verify the function honors the exclude set by passing our PID
    // and confirming we get a coherent (possibly empty) list back.
    const exclude = new Set<number>([process.pid]);
    const candidates = findStaleGenieCandidates(exclude);
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).not.toContain(process.pid);
    // Every candidate should be a positive integer that is NOT in exclude.
    for (const pid of candidates) {
      expect(pid).toBeGreaterThan(1);
      expect(exclude.has(pid)).toBe(false);
    }
  });

  test('reapStaleGenieProcesses surface contract', () => {
    const source = readFileSync(join(__dirname, 'doctor.ts'), 'utf-8');
    // The reaper must run BEFORE other maintenance preconditions so freed
    // connections are available for runDoctorMaintenance's pgserve probes.
    const postUpdate = source.indexOf('export async function runPostUpdateMaintenance');
    expect(postUpdate).toBeGreaterThan(-1);
    const fnEnd = source.indexOf('}', postUpdate + 200);
    const body = source.slice(postUpdate, fnEnd);
    const reapIdx = body.indexOf('reapStaleGenieProcessesSafe');
    const preconditionIdx = body.indexOf('runMaintenancePreconditions');
    expect(reapIdx).toBeGreaterThan(-1);
    expect(preconditionIdx).toBeGreaterThan(-1);
    expect(reapIdx).toBeLessThan(preconditionIdx);

    // Honors the GENIE_UPDATE_NO_REAP=1 opt-out.
    expect(source).toContain("process.env.GENIE_UPDATE_NO_REAP === '1'");
    // Walks the parent chain to avoid killing the npm/bun update wrapper.
    expect(source).toContain('getParentChain(process.pid)');
    // Escalates SIGTERM → SIGKILL with a 2s grace window.
    expect(source).toContain("process.kill(pid, 'SIGTERM')");
    expect(source).toContain("process.kill(pid, 'SIGKILL')");
    // Daemon-recycle contract: the active serve daemon (read from
    // `~/.genie/serve.pid`) is INTENTIONALLY NOT excluded — its in-memory
    // binary is stale post-update and it's the largest leak source. After
    // SIGTERM/SIGKILL the stale serve.pid file gets unlinked so the next
    // genie invocation autospawns cleanly.
    const reapFnStart = source.indexOf('async function reapStaleGenieProcesses');
    expect(reapFnStart).toBeGreaterThan(-1);
    const reapFnBody = source.slice(reapFnStart, source.indexOf('\n}\n', reapFnStart));
    // No exclude.add(serveDaemon) call — distinguishing this from the
    // pre-#1588 reaper which preserved the daemon.
    expect(reapFnBody).not.toMatch(/exclude\.add\(sp\)/);
    // Post-refactor (#1653): serve.pid cleanup extracted to clearStaleServePidFile
    // helper, called from reapStaleGenieProcesses. pm2 cleanup remains a direct call.
    expect(reapFnBody).toContain('clearStaleServePidFile()');
    expect(reapFnBody).toContain('cleanupStalePm2Entries(log)');
    const helperStart = source.indexOf('function clearStaleServePidFile');
    expect(helperStart).toBeGreaterThan(-1);
    const helperBody = source.slice(helperStart, source.indexOf('\n}\n', helperStart));
    expect(helperBody).toContain("'serve.pid'");
    expect(helperBody).toContain('unlinkSync(servePidPath)');
  });

  test('cleanupStalePm2Entries removes broken legacy genie-serve.ecosystem name', () => {
    const source = readFileSync(join(__dirname, 'doctor.ts'), 'utf-8');
    const fnStart = source.indexOf('function cleanupStalePm2Entries');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, source.indexOf('\n}\n', fnStart));
    // The name pattern is the broken legacy form from the pre-fix install
    // code (filename was `.ecosystem.cjs`, not `.config.cjs`, so pm2 ran
    // the config as a regular script — restart-loop, no actual genie-serve).
    expect(fnBody).toContain("'genie-serve.ecosystem'");
    // pm2 calls are best-effort: failures are logged with [!!] but don't
    // throw. Update flow continues.
    expect(fnBody).toContain('safePm2Delete');
    expect(source).toContain("execFileSync('pm2', ['delete'");
  });
});
