/**
 * Tests for the agent-sync engine. Everything runs inside a tmpdir: GENIE_HOME
 * and every agent target dir are injected, so the real `$HOME` is never
 * touched. afterEach removes the tmpdir. Real files, no mocks — the only seams
 * are the injectable clock, the hermes binary override, and the hermes-enable
 * exec spy (so no process is ever spawned).
 *
 * The stamp-parity test loads the shipped council-stamp.cjs through
 * createRequire and asserts byte-identical output + identical skip semantics.
 *
 * Run with: bun test src/lib/agent-sync.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runAgentSyncSafe } from '../genie-commands/update';
import {
  type AgentReport,
  type AgentSyncOptions,
  type AgentSyncReport,
  WORKFLOW_MANIFEST_NAME,
  acquireLifecycleLease,
  computeDirDigest,
  lifecycleLockPath,
  resolveGenieSource,
  runAgentSync,
  stampWorkflow,
} from './agent-sync';

const require = createRequire(import.meta.url);
const { stampCouncilWorkflow, PLACEHOLDER } = require('../../plugins/genie/scripts/council-stamp.cjs') as {
  stampCouncilWorkflow: (opts: {
    templatePath: string;
    pluginRoot: string;
    targetDir: string;
    version?: string | null;
    now?: () => Date;
  }) => {
    action: 'written' | 'skipped' | 'kept-unmanaged' | 'kept-modified' | 'metadata-corrupt';
    targetPath: string;
  };
  PLACEHOLDER: string;
};

const MANIFEST_NAME = '.genie-sync.json';
const FIXED_NOW = () => new Date('2026-07-10T12:00:00.000Z');
const TEMPLATE_BODY = `export const meta = { name: 'council' };\nconst LENS_ROOT = '${PLACEHOLDER}';\n`;

// ---------------------------------------------------------------------------
// Fixture harness
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  genieHome: string;
  pluginRoot: string;
  claudeDir: string;
  codexDir: string;
  /** Live codex skills tier (`~/.agents/skills` in production). */
  agentsSkillsDir: string;
  hermesHome: string;
  hermesSource: string;
}

let fixture: Fixture;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

/** Materialize a source skill dir under the plugin root. */
function writeSourceSkill(pluginRoot: string, name: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    writeFile(join(pluginRoot, 'skills', name, rel), content);
  }
}

interface SetupOptions {
  binLayout?: boolean;
  version?: string | null;
  skills?: Record<string, Record<string, string>>;
  withTemplate?: boolean;
}

function setup(opts: SetupOptions = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-sync-'));
  const genieHome = join(root, 'genie');
  const pluginsBase = opts.binLayout ? join(genieHome, 'bin', 'plugins') : join(genieHome, 'plugins');
  const pluginRoot = join(pluginsBase, 'genie');
  const hermesSource = join(pluginsBase, 'hermes-genie');

  const skills = opts.skills ?? {
    alpha: { 'SKILL.md': '# alpha\n', 'references/a.md': 'alpha ref\n' },
    beta: { 'SKILL.md': '# beta\n' },
  };
  for (const [name, files] of Object.entries(skills)) writeSourceSkill(pluginRoot, name, files);

  if (opts.withTemplate ?? true) writeFile(join(pluginRoot, 'workflows', 'council.js'), TEMPLATE_BODY);
  writeFile(join(hermesSource, 'plugin.json'), '{"name":"hermes-genie"}\n');

  const version = opts.version === undefined ? '9.9.9' : opts.version;
  if (version !== null) writeFile(join(genieHome, 'VERSION'), `${version}\n`);

  return {
    root,
    genieHome,
    pluginRoot,
    claudeDir: join(root, 'claude'),
    codexDir: join(root, 'codex'),
    agentsSkillsDir: join(root, 'agents', 'skills'),
    hermesHome: join(root, 'hermes'),
    hermesSource,
  };
}

function present(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Run the engine against the fixture with test-safe defaults (no PATH, no exec). */
function run(extra: Partial<AgentSyncOptions> = {}): AgentSyncReport {
  return runAgentSync({
    genieHome: fixture.genieHome,
    targets: {
      claude: fixture.claudeDir,
      codex: fixture.codexDir,
      hermes: fixture.hermesHome,
      agentsSkills: fixture.agentsSkillsDir,
    },
    hermesBinary: null,
    now: FIXED_NOW,
    log: () => undefined,
    ...extra,
  });
}

function agentReport(report: AgentSyncReport, agent: AgentReport['agent']): AgentReport {
  const found = report.agents.find((entry) => entry.agent === agent);
  if (!found) throw new Error(`no ${agent} report`);
  return found;
}

function skillAction(report: AgentReport, name: string): string | undefined {
  return report.skills.find((skill) => skill.name === name)?.action;
}

function extraAction(report: AgentReport, kind: string): string | undefined {
  return report.extras.find((entry) => entry.kind === kind)?.action;
}

function readManifest(dir: string): { managedBy: string; version: string | null; digest: string; syncedAt: string } {
  return JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8'));
}

beforeEach(() => {
  fixture = setup();
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fresh create
// ---------------------------------------------------------------------------

describe('fresh create', () => {
  test('claude: skills created with manifests + council.js stamped', () => {
    present(fixture.claudeDir);
    const report = agentReport(run(), 'claude');

    expect(report.detected).toBe(true);
    expect(skillAction(report, 'alpha')).toBe('created');
    expect(skillAction(report, 'beta')).toBe('created');

    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(readFileSync(join(alphaDir, 'references', 'a.md'), 'utf8')).toBe('alpha ref\n');
    expect(readManifest(alphaDir).managedBy).toBe('genie-agent-sync');
    expect(readManifest(alphaDir).version).toBe('9.9.9');
    expect(readManifest(alphaDir).syncedAt).toBe('2026-07-10T12:00:00.000Z');

    expect(extraAction(report, 'stamp')).toBe('written');
    const council = readFileSync(join(fixture.claudeDir, 'workflows', 'council.js'), 'utf8');
    expect(council).toContain(`const LENS_ROOT = ${JSON.stringify(fixture.pluginRoot)};`);
    expect(council).not.toContain(PLACEHOLDER);
    const workflowManifest = JSON.parse(
      readFileSync(join(fixture.claudeDir, 'workflows', WORKFLOW_MANIFEST_NAME), 'utf8'),
    ) as { managedBy: string; version: string; digest: string };
    expect(workflowManifest.managedBy).toBe('genie-agent-sync');
    expect(workflowManifest.version).toBe('9.9.9');
    expect(workflowManifest.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('codex: skills land top-level under the agents skills tier with a restart advisory', () => {
    present(fixture.codexDir);
    const report = agentReport(run(), 'codex');

    expect(report.detected).toBe(true);
    expect(existsSync(join(fixture.agentsSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(readManifest(join(fixture.agentsSkillsDir, 'alpha')).managedBy).toBe('genie-agent-sync');
    // nothing is ever written into the retired `<codexDir>/skills/.curated` lane
    expect(existsSync(join(fixture.codexDir, 'skills', '.curated'))).toBe(false);
    expect(report.advisories).toContain('restart Codex to pick up updated skills');
  });

  test('hermes: symlink created + enable exec fired exactly once', () => {
    present(fixture.hermesHome);
    const enableCalls: string[][] = [];
    const report = agentReport(
      run({ hermesBinary: '/fake/bin/hermes', execHermesEnable: (args) => enableCalls.push(args) }),
      'hermes',
    );

    expect(report.detected).toBe(true);
    const link = join(fixture.hermesHome, 'plugins', 'genie');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(fixture.hermesSource);
    expect(extraAction(report, 'symlink')).toBe('created');
    expect(enableCalls).toEqual([['plugins', 'enable', 'genie']]);
    expect(extraAction(report, 'enable')).toBe('ran');
  });

  test('report carries the resolved source metadata', () => {
    present(fixture.claudeDir);
    const report = run();
    expect(report.source.pluginRoot).toBe(fixture.pluginRoot);
    expect(report.source.hermesRoot).toBe(fixture.hermesSource);
    expect(report.source.version).toBe('9.9.9');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotent re-run', () => {
  test('everything unchanged, stamp skipped, enable not re-fired, no backups', () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    const enableCalls: string[][] = [];
    const opts: Partial<AgentSyncOptions> = {
      hermesBinary: '/fake/bin/hermes',
      execHermesEnable: (args) => enableCalls.push(args),
    };

    run(opts);
    const second = run(opts);

    const claude = agentReport(second, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('unchanged');
    expect(skillAction(claude, 'beta')).toBe('unchanged');
    expect(extraAction(claude, 'stamp')).toBe('skipped');

    const codex = agentReport(second, 'codex');
    expect(skillAction(codex, 'alpha')).toBe('unchanged');
    expect(codex.advisories).not.toContain('restart Codex to pick up updated skills');

    const hermes = agentReport(second, 'hermes');
    expect(extraAction(hermes, 'symlink')).toBe('unchanged');

    expect(enableCalls).toHaveLength(1); // fired on the first run only
    expect(second.backupsDir).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Update on source change
// ---------------------------------------------------------------------------

describe('source change', () => {
  test('a changed source skill is updated and the manifest digest advances', () => {
    present(fixture.claudeDir);
    run();
    const before = readManifest(join(fixture.claudeDir, 'skills', 'alpha')).digest;

    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n');
    const report = agentReport(run(), 'claude');

    expect(skillAction(report, 'alpha')).toBe('updated');
    expect(skillAction(report, 'beta')).toBe('unchanged');
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha v2\n');
    expect(readManifest(alphaDir).digest).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Same-name collision preservation
// ---------------------------------------------------------------------------

describe('same-name collision preservation', () => {
  test('a user-modified managed skill is kept byte-identical and not overwritten', () => {
    present(fixture.claudeDir);
    run();
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# hand-edited\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('kept-modified');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# hand-edited\n');
    expect(report.backupsDir).toBeNull();
  });

  test('an unmanaged same-name dir (no manifest) is kept and never adopted', () => {
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# pre-existing unmanaged\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(existsSync(join(alphaDir, MANIFEST_NAME))).toBe(false);
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# pre-existing unmanaged\n');
    expect(report.backupsDir).toBeNull();
  });

  test('a target dir with a corrupt manifest is kept byte-identical and never crashes', () => {
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# pre-existing with corrupt manifest\n');
    const corrupt = '{ this is not valid json ';
    writeFile(join(alphaDir, MANIFEST_NAME), corrupt);

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# pre-existing with corrupt manifest\n');
    expect(readFileSync(join(alphaDir, MANIFEST_NAME), 'utf8')).toBe(corrupt);
    expect(report.backupsDir).toBeNull();
  });

  test('a same-name skill symlink is never followed, adopted, or replaced', () => {
    present(fixture.claudeDir);
    const outside = join(fixture.root, 'personal-alpha');
    writeFile(join(outside, 'SKILL.md'), '# personal symlink target\n');
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    mkdirSync(dirname(alphaDir), { recursive: true });
    symlinkSync(outside, alphaDir);

    const report = agentReport(run(), 'claude');

    expect(skillAction(report, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(lstatSync(alphaDir).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'SKILL.md'), 'utf8')).toBe('# personal symlink target\n');
  });

  test('a dir genie never shipped is left completely untouched', () => {
    present(fixture.claudeDir);
    const customDir = join(fixture.claudeDir, 'skills', 'my-custom-skill');
    writeFile(join(customDir, 'SKILL.md'), '# mine\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'my-custom-skill')).toBeUndefined();
    expect(readFileSync(join(customDir, 'SKILL.md'), 'utf8')).toBe('# mine\n');
    expect(existsSync(join(customDir, MANIFEST_NAME))).toBe(false);
    expect(report.backupsDir).toBeNull(); // nothing was touched, so no backup root
  });
});

// ---------------------------------------------------------------------------
// Orphan removal
// ---------------------------------------------------------------------------

describe('managed orphan handling', () => {
  test('an unmodified managed orphan is backed up then removed', () => {
    present(fixture.claudeDir);
    run(); // creates alpha + beta as managed
    rmSync(join(fixture.pluginRoot, 'skills', 'beta'), { recursive: true, force: true }); // beta leaves source

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'beta')).toBe('removed');
    expect(existsSync(join(fixture.claudeDir, 'skills', 'beta'))).toBe(false);

    const backup = join(report.backupsDir as string, 'claude', 'beta', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe('# beta\n');
  });

  test('a modified managed orphan is kept with an advisory, never deleted', () => {
    present(fixture.claudeDir);
    run();
    const betaDir = join(fixture.claudeDir, 'skills', 'beta');
    writeFile(join(betaDir, 'SKILL.md'), '# beta hand-edited\n'); // now diverges from manifest
    rmSync(join(fixture.pluginRoot, 'skills', 'beta'), { recursive: true, force: true });

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'beta')).toBe('kept-modified-orphan');
    expect(existsSync(join(betaDir, 'SKILL.md'))).toBe(true);
    expect(claude.advisories.some((line) => line.includes('kept modified orphan beta'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claude council exclusion (skill-vs-workflow collision, Decision 8)
// ---------------------------------------------------------------------------

describe('claude council exclusion', () => {
  const councilFiles = { 'SKILL.md': '# council (portable, non-workflow runtimes)\n' };

  test('council is synced to codex but never to claude (workflow owns the name there)', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ skills: { alpha: { 'SKILL.md': '# alpha\n' }, council: councilFiles } });
    present(fixture.claudeDir);
    present(fixture.codexDir);

    const report = run();
    const claude = agentReport(report, 'claude');
    const codex = agentReport(report, 'codex');
    expect(skillAction(claude, 'council')).toBeUndefined();
    expect(existsSync(join(fixture.claudeDir, 'skills', 'council'))).toBe(false);
    expect(skillAction(claude, 'alpha')).toBe('created');
    expect(skillAction(codex, 'council')).toBe('created');
    expect(existsSync(join(fixture.agentsSkillsDir, 'council', 'SKILL.md'))).toBe(true);
  });

  test('a managed council already synced to claude (pre-exclusion release) is backed up and removed', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ skills: { alpha: { 'SKILL.md': '# alpha\n' }, council: councilFiles } });
    present(fixture.claudeDir);
    // Simulate the pre-exclusion release: a digest-clean managed council in the claude target.
    const destDir = join(fixture.claudeDir, 'skills', 'council');
    writeFile(join(destDir, 'SKILL.md'), councilFiles['SKILL.md']);
    const digest = computeDirDigest(destDir);
    writeFile(
      join(destDir, MANIFEST_NAME),
      JSON.stringify({ managedBy: 'genie-agent-sync', version: '9.9.8', digest, syncedAt: '2026-07-10T00:00:00.000Z' }),
    );

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'council')).toBe('removed');
    expect(existsSync(destDir)).toBe(false);
    const backup = join(report.backupsDir as string, 'claude', 'council', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe(councilFiles['SKILL.md']);
  });

  test('a user-created unmanaged council dir in claude is never touched', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ skills: { alpha: { 'SKILL.md': '# alpha\n' }, council: councilFiles } });
    present(fixture.claudeDir);
    const userDir = join(fixture.claudeDir, 'skills', 'council');
    writeFile(join(userDir, 'SKILL.md'), '# my own council launcher\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'council')).toBeUndefined();
    expect(readFileSync(join(userDir, 'SKILL.md'), 'utf8')).toBe('# my own council launcher\n');
  });
});

// ---------------------------------------------------------------------------
// Missing agents
// ---------------------------------------------------------------------------

describe('undetected agents', () => {
  test('a missing agent dir yields detected:false and zero writes', () => {
    // no target dirs created at all
    const report = run();
    for (const agent of ['claude', 'codex', 'hermes'] as const) {
      expect(agentReport(report, agent).detected).toBe(false);
    }
    expect(existsSync(fixture.claudeDir)).toBe(false);
    expect(existsSync(fixture.codexDir)).toBe(false);
    expect(existsSync(join(fixture.hermesHome, 'plugins'))).toBe(false);
    expect(report.backupsDir).toBeNull();
  });

  test('a null plugin source yields an empty report and no agents', () => {
    const emptyHome = join(fixture.root, 'empty-genie');
    mkdirSync(emptyHome, { recursive: true });
    const report = runAgentSync({ genieHome: emptyHome, hermesBinary: null, log: () => undefined });
    expect(report.source.pluginRoot).toBeNull();
    expect(report.agents).toHaveLength(0);
    expect(report.backupsDir).toBeNull();
  });
});

describe('explicit client selection', () => {
  test('codex selection leaves Claude and Hermes homes byte-identical', () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    const report = run({ selection: 'codex' });
    expect(report.agents.map((agent) => agent.agent)).toEqual(['codex']);
    expect(existsSync(join(fixture.agentsSkillsDir, 'alpha', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false);
    expect(existsSync(join(fixture.hermesHome, 'plugins', 'genie'))).toBe(false);
  });

  test('none selection mutates no client home', () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    const report = run({ selection: 'none' });
    expect(report.agents).toEqual([]);
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false);
    expect(existsSync(join(fixture.agentsSkillsDir, 'alpha'))).toBe(false);
    expect(existsSync(join(fixture.hermesHome, 'plugins', 'genie'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Report fidelity on a late adapter failure
// ---------------------------------------------------------------------------

describe('partial report preservation on late failure', () => {
  test('a throw after skills are collected keeps the partial report, not a fresh empty one', () => {
    present(fixture.claudeDir);
    // Force a late throw INSIDE syncClaude, AFTER skills are synced: make the
    // workflows target a file so the stamp step's mkdirSync throws.
    writeFile(join(fixture.claudeDir, 'workflows'), 'not a directory\n');

    const claude = agentReport(run(), 'claude');

    // detection + the skill lines collected before the throw all survive...
    expect(claude.detected).toBe(true);
    expect(skillAction(claude, 'alpha')).toBe('created');
    expect(skillAction(claude, 'beta')).toBe('created');
    // ...and the failure is surfaced as an advisory rather than discarded
    expect(claude.advisories.some((line) => line.startsWith('claude sync failed'))).toBe(true);
    // the writes really landed on disk before the throw
    expect(readFileSync(join(fixture.claudeDir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
  });
});

// ---------------------------------------------------------------------------
// Digest properties
// ---------------------------------------------------------------------------

describe('computeDirDigest', () => {
  test('is stable regardless of directory entry creation order', () => {
    const dirA = join(fixture.root, 'digest-a');
    writeFile(join(dirA, 'b.md'), 'B');
    writeFile(join(dirA, 'a.md'), 'A');
    writeFile(join(dirA, 'nested', 'c.md'), 'C');

    const dirB = join(fixture.root, 'digest-b');
    writeFile(join(dirB, 'nested', 'c.md'), 'C');
    writeFile(join(dirB, 'a.md'), 'A');
    writeFile(join(dirB, 'b.md'), 'B');

    expect(computeDirDigest(dirA)).toBe(computeDirDigest(dirB));
  });

  test('excludes the manifest so a manifest does not change the digest', () => {
    const dir = join(fixture.root, 'digest-manifest');
    writeFile(join(dir, 'SKILL.md'), 'body');
    const before = computeDirDigest(dir);
    writeFile(join(dir, MANIFEST_NAME), '{"managedBy":"genie-agent-sync","digest":"x"}');
    expect(computeDirDigest(dir)).toBe(before);
  });

  test('changes when file content changes', () => {
    const dir = join(fixture.root, 'digest-content');
    writeFile(join(dir, 'SKILL.md'), 'one');
    const before = computeDirDigest(dir);
    writeFile(join(dir, 'SKILL.md'), 'two');
    expect(computeDirDigest(dir)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery staging
// ---------------------------------------------------------------------------

describe('staging cleanup', () => {
  test('stale genie-sync staging debris from a crashed run is pre-cleaned', () => {
    present(fixture.claudeDir);
    const staleStage = join(fixture.claudeDir, 'skills', 'alpha.genie-sync.staging');
    writeFile(join(staleStage, 'garbage.txt'), 'left over from a crash');

    const report = agentReport(run(), 'claude');
    expect(skillAction(report, 'alpha')).toBe('created');
    expect(existsSync(staleStage)).toBe(false);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    expect(existsSync(join(alphaDir, 'garbage.txt'))).toBe(false);
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
  });

  test('HIGH-1: a user <name>.old backup sibling survives sync untouched', () => {
    // Common manual-backup convention: `mv alpha alpha.old` before letting genie
    // resync alpha. The old `.old` staging suffix would have DELETED this on the
    // first sync; the collision-proof suffix must leave it completely intact.
    present(fixture.claudeDir);
    const skillsDir = join(fixture.claudeDir, 'skills');
    const userBackup = join(skillsDir, 'alpha.old');
    writeFile(join(userBackup, 'SKILL.md'), '# user manual backup — do not delete\n');
    // genie's own crashed-run staging debris sitting next to the same skill
    writeFile(join(skillsDir, 'alpha.genie-sync.staging', 'garbage.txt'), 'crash debris\n');

    const report = agentReport(run(), 'claude');

    // the real skill is (re)created from source
    expect(skillAction(report, 'alpha')).toBe('created');
    // the user's sibling survives on disk with its content intact
    expect(existsSync(userBackup)).toBe(true);
    expect(readFileSync(join(userBackup, 'SKILL.md'), 'utf8')).toBe('# user manual backup — do not delete\n');
    // and it never appears anywhere as a removed skill
    const removed = report.skills.filter((skill) => skill.action === 'removed').map((skill) => skill.name);
    expect(removed).not.toContain('alpha.old');
    // genie's own crashed-run staging debris IS cleaned
    expect(existsSync(join(skillsDir, 'alpha.genie-sync.staging'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hermes edge cases
// ---------------------------------------------------------------------------

describe('hermes linking', () => {
  test('a real dir at the link target is adopted with a backup', () => {
    const link = join(fixture.hermesHome, 'plugins', 'genie');
    writeFile(join(link, 'stale-real-dir.txt'), 'was a real dir\n');

    const report = run();
    const hermes = agentReport(report, 'hermes');
    expect(extraAction(hermes, 'symlink')).toBe('adopted');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(fixture.hermesSource);

    const backup = join(report.backupsDir as string, 'hermes', 'plugins-genie', 'stale-real-dir.txt');
    expect(readFileSync(backup, 'utf8')).toBe('was a real dir\n');
  });

  test('the adopt transition (real dir → symlink) also fires enable exactly once', () => {
    // A real dir where the link belongs, plus a detected binary: adopting it is
    // "newly linked" just like a fresh create, so enable must fire once.
    const link = join(fixture.hermesHome, 'plugins', 'genie');
    writeFile(join(link, 'stale-real-dir.txt'), 'was a real dir\n');
    const enableCalls: string[][] = [];

    const hermes = agentReport(
      run({ hermesBinary: '/fake/bin/hermes', execHermesEnable: (args) => enableCalls.push(args) }),
      'hermes',
    );
    expect(extraAction(hermes, 'symlink')).toBe('adopted');
    expect(enableCalls).toEqual([['plugins', 'enable', 'genie']]);
    expect(extraAction(hermes, 'enable')).toBe('ran');
  });

  test('a foreign symlink (dev checkout) is left alone with an advisory', () => {
    const foreign = join(fixture.root, 'dev-checkout');
    mkdirSync(foreign, { recursive: true });
    const link = join(fixture.hermesHome, 'plugins', 'genie');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(foreign, link);

    const hermes = agentReport(run(), 'hermes');
    expect(extraAction(hermes, 'symlink')).toBe('skipped-unmanaged-kept');
    expect(readlinkSync(link)).toBe(foreign); // untouched
    expect(hermes.advisories.some((line) => line.includes('points elsewhere'))).toBe(true);
  });

  test('an active sticky profile also gets its plugins/genie link', () => {
    present(fixture.hermesHome);
    writeFile(join(fixture.hermesHome, 'active_profile'), 'work\n');

    run();
    const profileLink = join(fixture.hermesHome, 'profiles', 'work', 'plugins', 'genie');
    expect(lstatSync(profileLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(profileLink)).toBe(fixture.hermesSource);
  });

  test('an unsafe active_profile cannot escape the Hermes profiles root', () => {
    present(fixture.hermesHome);
    writeFile(join(fixture.hermesHome, 'active_profile'), '../../outside');
    const outside = join(fixture.root, 'outside', 'plugins', 'genie');

    const report = run({ hermesBinary: null });

    expect(existsSync(outside)).toBe(false);
    const hermes = agentReport(report, 'hermes');
    expect(hermes.failures?.join('\n')).toContain('invalid Hermes active_profile');
  });

  test('detection via binary alone creates the link under a fresh hermes home', () => {
    // hermesHome does not exist; only a binary override is provided
    const enableCalls: string[][] = [];
    const hermes = agentReport(
      run({ hermesBinary: '/fake/bin/hermes', execHermesEnable: (args) => enableCalls.push(args) }),
      'hermes',
    );
    expect(hermes.detected).toBe(true);
    expect(lstatSync(join(fixture.hermesHome, 'plugins', 'genie')).isSymbolicLink()).toBe(true);
    expect(enableCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Codex: .system protection + one-time .curated → ~/.agents/skills migration
// ---------------------------------------------------------------------------

/** Materialize a dir that looks exactly like one agent-sync shipped (manifest incl. matching digest). */
function seedManagedDir(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) writeFile(join(dir, rel), content);
  const manifest = {
    managedBy: 'genie-agent-sync',
    version: '9.9.8',
    digest: computeDirDigest(dir),
    syncedAt: '2026-01-01T00:00:00.000Z',
  };
  writeFile(join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe('codex .system', () => {
  test('the OpenAI-owned .system tree is never enumerated or touched', () => {
    present(fixture.codexDir);
    const systemSkill = join(fixture.codexDir, 'skills', '.system', 'openai-builtin', 'SKILL.md');
    writeFile(systemSkill, '# openai builtin\n');

    const report = agentReport(run(), 'codex');
    expect(skillAction(report, 'openai-builtin')).toBeUndefined();
    expect(readFileSync(systemSkill, 'utf8')).toBe('# openai builtin\n');
    expect(existsSync(join(systemSkill, '..', MANIFEST_NAME))).toBe(false);
  });
});

describe('codex legacy .curated migration', () => {
  test('manifest-managed legacy dirs are backed up then removed; the empty lane dir goes too', () => {
    present(fixture.codexDir);
    const legacyDir = join(fixture.codexDir, 'skills', '.curated');
    seedManagedDir(join(legacyDir, 'alpha'), { 'SKILL.md': '# legacy alpha\n' });
    seedManagedDir(join(legacyDir, 'zombie'), { 'SKILL.md': '# legacy zombie\n' });

    const report = run();
    const codex = agentReport(report, 'codex');

    expect(existsSync(legacyDir)).toBe(false); // lane fully retired
    expect((report.backupsDir as string).startsWith(`${fixture.genieHome}/`)).toBe(false);
    // both legacy dirs were backed up before removal
    const backupRoot = join(report.backupsDir as string, 'codex-legacy-curated');
    expect(readFileSync(join(backupRoot, 'alpha', 'SKILL.md'), 'utf8')).toBe('# legacy alpha\n');
    expect(readFileSync(join(backupRoot, 'zombie', 'SKILL.md'), 'utf8')).toBe('# legacy zombie\n');
    rmSync(fixture.genieHome, { recursive: true, force: true });
    expect(readFileSync(join(backupRoot, 'alpha', 'SKILL.md'), 'utf8')).toBe('# legacy alpha\n');
    const removed = codex.extras.filter((entry) => entry.kind === 'legacy-curated' && entry.action === 'removed');
    expect(removed).toHaveLength(2);
    // and the live tier got the current source skills
    expect(readFileSync(join(fixture.agentsSkillsDir, 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
  });

  test('a user-modified managed legacy dir is preserved in place byte-identically', () => {
    present(fixture.codexDir);
    const legacyAlpha = join(fixture.codexDir, 'skills', '.curated', 'alpha');
    seedManagedDir(legacyAlpha, { 'SKILL.md': '# legacy alpha\n' });
    writeFile(join(legacyAlpha, 'SKILL.md'), '# hand-edited legacy\n'); // digest now diverges
    const manifestBefore = readFileSync(join(legacyAlpha, MANIFEST_NAME), 'utf8');

    const report = run();
    const codex = agentReport(report, 'codex');
    expect(readFileSync(join(legacyAlpha, 'SKILL.md'), 'utf8')).toBe('# hand-edited legacy\n');
    expect(readFileSync(join(legacyAlpha, MANIFEST_NAME), 'utf8')).toBe(manifestBefore);
    expect(report.backupsDir).toBeNull();
    expect(codex.extras).toContainEqual({
      kind: 'legacy-curated',
      action: 'kept-modified',
      detail: legacyAlpha,
    });
  });

  test('unmanaged legacy entries are kept (with an advisory) and keep the lane dir alive', () => {
    present(fixture.codexDir);
    const legacyDir = join(fixture.codexDir, 'skills', '.curated');
    seedManagedDir(join(legacyDir, 'alpha'), { 'SKILL.md': '# legacy alpha\n' });
    const userSkill = join(legacyDir, 'my-own-thing', 'SKILL.md');
    writeFile(userSkill, '# not genie-managed\n'); // no manifest

    const codex = agentReport(run(), 'codex');

    expect(existsSync(join(legacyDir, 'alpha'))).toBe(false); // managed dir migrated out
    expect(readFileSync(userSkill, 'utf8')).toBe('# not genie-managed\n'); // user content untouched
    expect(codex.advisories.some((line) => line.includes('unmanaged entries'))).toBe(true);
  });

  test('the migration is one-time: a second run sees no legacy lane and reports no legacy extras', () => {
    present(fixture.codexDir);
    seedManagedDir(join(fixture.codexDir, 'skills', '.curated', 'alpha'), { 'SKILL.md': '# legacy alpha\n' });
    run();

    const second = agentReport(run(), 'codex');
    expect(second.extras.filter((entry) => entry.kind === 'legacy-curated')).toHaveLength(0);
    expect(skillAction(second, 'alpha')).toBe('unchanged'); // live tier already converged
  });

  test('unmanaged siblings already in the shared agents skills tier are never touched', () => {
    present(fixture.codexDir);
    const foreign = join(fixture.agentsSkillsDir, 'somebody-elses-skill');
    writeFile(join(foreign, 'SKILL.md'), '# installed by another tool\n');

    const report = run();
    const codex = agentReport(report, 'codex');
    expect(skillAction(codex, 'somebody-elses-skill')).toBeUndefined();
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf8')).toBe('# installed by another tool\n');
    expect(existsSync(join(foreign, MANIFEST_NAME))).toBe(false);
  });

  test('a personal Codex skill colliding with a shipped name remains byte-identical and unmanaged', () => {
    present(fixture.codexDir);
    const personal = join(fixture.agentsSkillsDir, 'alpha');
    writeFile(join(personal, 'SKILL.md'), '# personal Codex adaptation\n');
    writeFile(join(personal, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');

    const codex = agentReport(run(), 'codex');

    expect(skillAction(codex, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(readFileSync(join(personal, 'SKILL.md'), 'utf8')).toBe('# personal Codex adaptation\n');
    expect(readFileSync(join(personal, 'agents', 'openai.yaml'), 'utf8')).toContain('allow_implicit_invocation');
    expect(existsSync(join(personal, MANIFEST_NAME))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

describe('resolveGenieSource', () => {
  test('falls back to the bin/plugins layout', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ binLayout: true });
    present(fixture.claudeDir);

    const report = run();
    expect(report.source.pluginRoot).toBe(fixture.pluginRoot);
    expect(report.source.pluginRoot).toContain(join('bin', 'plugins', 'genie'));
    expect(skillAction(agentReport(report, 'claude'), 'alpha')).toBe('created');
  });

  test('reads the version from the VERSION file, or null when absent', () => {
    expect(resolveGenieSource(fixture.genieHome).version).toBe('9.9.9');

    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ version: null });
    expect(resolveGenieSource(fixture.genieHome).version).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Stamp parity with the shipped .cjs
// ---------------------------------------------------------------------------

describe('stampWorkflow parity with council-stamp.cjs', () => {
  test('produces byte-identical output and identical skip semantics', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    const pluginRoot = '/opt/some/plugins/genie';
    const tsDir = join(fixture.root, 'ts-out');
    const cjsDir = join(fixture.root, 'cjs-out');

    const tsWrite = stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir, version: '1.2.3', now: FIXED_NOW });
    const cjsWrite = stampCouncilWorkflow({
      templatePath,
      pluginRoot,
      targetDir: cjsDir,
      version: '1.2.3',
      now: FIXED_NOW,
    });
    expect(tsWrite.action).toBe('written');
    expect(cjsWrite.action).toBe('written');
    expect(readFileSync(join(tsDir, 'council.js'), 'utf8')).toBe(readFileSync(join(cjsDir, 'council.js'), 'utf8'));
    expect(readFileSync(join(tsDir, WORKFLOW_MANIFEST_NAME), 'utf8')).toBe(
      readFileSync(join(cjsDir, WORKFLOW_MANIFEST_NAME), 'utf8'),
    );

    // idempotent skip on the unchanged re-run, for both implementations
    expect(stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir }).action).toBe('skipped');
    expect(stampCouncilWorkflow({ templatePath, pluginRoot, targetDir: cjsDir }).action).toBe('skipped');
  });

  test('an inventory-missing exact legacy workflow is adopted only after a recovery backup', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'user-workflows');
    const targetPath = join(targetDir, 'council.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    writeFile(targetPath, TEMPLATE_BODY.split(PLACEHOLDER).join('/personal/plugin'));
    const before = readFileSync(targetPath, 'utf8');

    const result = stampWorkflow({ templatePath, pluginRoot: '/personal/plugin', targetDir });

    expect(result.action).toBe('adopted-legacy');
    expect(readFileSync(targetPath, 'utf8')).not.toBe(before);
    expect(existsSync(join(targetDir, WORKFLOW_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(dirname(targetDir), '.genie-recovery', 'council-bootstrap'))).toBe(true);
  });

  test('a clean digest-owned workflow updates, while a modified one is preserved', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'managed-workflows');
    const targetPath = join(targetDir, 'council.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    expect(stampWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir }).action).toBe('written');
    expect(stampWorkflow({ templatePath, pluginRoot: '/new/plugin', targetDir }).action).toBe('written');
    expect(readFileSync(targetPath, 'utf8')).toContain('const LENS_ROOT = "/new/plugin";');

    writeFileSync(targetPath, `${readFileSync(targetPath, 'utf8')}\n// personal edit\n`, 'utf8');
    const modified = readFileSync(targetPath, 'utf8');
    expect(stampWorkflow({ templatePath, pluginRoot: '/newer/plugin', targetDir }).action).toBe('kept-modified');
    expect(readFileSync(targetPath, 'utf8')).toBe(modified);
  });

  test('corrupt workflow ownership metadata fails closed with zero target writes', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'corrupt-workflows');
    const targetPath = join(targetDir, 'council.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    writeFile(targetPath, '// mine\n');
    writeFile(join(targetDir, WORKFLOW_MANIFEST_NAME), '{broken');

    expect(stampWorkflow({ templatePath, pluginRoot: '/new/plugin', targetDir }).action).toBe('metadata-corrupt');
    expect(readFileSync(targetPath, 'utf8')).toBe('// mine\n');
    expect(readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME), 'utf8')).toBe('{broken');
  });

  test('workflow paths are emitted as valid escaped JavaScript literals in both stampers', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const pluginRoot of ["/opt/O'Brien/genie", 'C:\\Users\\genie', '/tmp/line\nbreak']) {
      const tsDir = join(fixture.root, `escaped-ts-${Buffer.from(pluginRoot).toString('hex')}`);
      const cjsDir = join(fixture.root, `escaped-cjs-${Buffer.from(pluginRoot).toString('hex')}`);
      stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir });
      stampCouncilWorkflow({ templatePath, pluginRoot, targetDir: cjsDir });
      const ts = readFileSync(join(tsDir, 'council.js'), 'utf8');
      const cjs = readFileSync(join(cjsDir, 'council.js'), 'utf8');
      expect(ts).toBe(cjs);
      expect(ts).toContain(`const LENS_ROOT = ${JSON.stringify(pluginRoot)};`);
      expect(() => new Function(ts.replace('export const meta', 'const meta'))).not.toThrow();
    }
  });

  test('claude stamp reports unavailable (never throws) when the template is missing', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ withTemplate: false });
    present(fixture.claudeDir);

    const claude = agentReport(run(), 'claude');
    expect(extraAction(claude, 'stamp')).toBe('unavailable');
    expect(existsSync(join(fixture.claudeDir, 'workflows', 'council.js'))).toBe(false);
    expect(skillAction(claude, 'alpha')).toBe('created'); // skills still synced
  });
});

// ---------------------------------------------------------------------------
// Cross-process lock + start-of-sync throttle marker
// ---------------------------------------------------------------------------

const LOCK_NAME = '.agent-sync.lock';
const MARKER_NAME = '.last-agent-sync';

describe('cross-process sync lock', () => {
  test('a fresh lock held elsewhere skips the whole sync with an advisory — zero writes, lock untouched', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, '12345\n'); // fresh mtime → live holder
    const lines: string[] = [];

    const report = run({ log: (line) => lines.push(line) });

    expect(report.skipped).toContain('holds the lock');
    expect(report.agents).toHaveLength(0);
    expect(report.backupsDir).toBeNull();
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false); // no writes at all
    expect(existsSync(join(fixture.genieHome, MARKER_NAME))).toBe(false); // marker not stolen either
    expect(lines.some((line) => line.includes('holds the lock'))).toBe(true);
    expect(existsSync(lockPath)).toBe(true); // never releases someone else's live lock
  });

  test('a stale lock (older than the age-out) is stolen and the sync proceeds', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, '2147483647\n');
    const staleSec = (Date.now() - 11 * 60 * 1000) / 1000; // 11 min > 10 min age-out
    utimesSync(lockPath, staleSec, staleSec);

    const report = run();

    expect(report.skipped).toBeUndefined();
    expect(skillAction(agentReport(report, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(lockPath)).toBe(false); // released after the run
  });

  test('an ordinary stale timestamp never permits stealing from a live PID', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, `${process.pid}:0123456789abcdef0123456789abcdef\n`);
    const staleSec = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, staleSec, staleSec);

    const report = run();

    expect(report.skipped).toContain('holds the lock');
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toContain(`${process.pid}:`);
  });

  test('a stale lock with a reused live PID but mismatched start identity is stealable', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, `${process.pid}:0123456789abcdef0123456789abcdef:${'0'.repeat(64)}\n`);
    const staleSec = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, staleSec, staleSec);

    const report = run();

    expect(report.skipped).toBeUndefined();
    expect(skillAction(agentReport(report, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a far-future lock timestamp is treated as invalid debris rather than suppressing sync indefinitely', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, 'future\n');
    const futureSec = (Date.now() + 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, futureSec, futureSec);

    const report = run();

    expect(report.skipped).toBeUndefined();
    expect(skillAction(agentReport(report, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a far-future lock with a live owner is not stolen under clock skew', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, `${process.pid}\n`);
    const futureSec = (Date.now() + 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, futureSec, futureSec);

    const report = run();

    expect(report.skipped).toContain('holds the lock');
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false);
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}\n`);
  });

  test('lock acquisition I/O failure fails closed and performs zero target writes', () => {
    present(fixture.claudeDir);
    chmodSync(fixture.genieHome, 0o500);
    try {
      const report = run();
      expect(report.skipped).toContain('could not acquire agent-sync lock');
      expect(report.agents).toEqual([]);
      expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false);
    } finally {
      chmodSync(fixture.genieHome, 0o700);
    }
  });

  test('the lock is released after a run, so a sequential re-run proceeds normally', () => {
    present(fixture.claudeDir);
    run();
    expect(existsSync(join(fixture.genieHome, LOCK_NAME))).toBe(false);

    const second = run();
    expect(second.skipped).toBeUndefined();
    expect(skillAction(agentReport(second, 'claude'), 'alpha')).toBe('unchanged');
  });

  test('release preserves a replacement lock whose ownership token changed mid-run', () => {
    present(fixture.hermesHome);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const replacement = `${process.pid}:ffffffffffffffffffffffffffffffff\n`;

    const report = run({
      hermesBinary: '/fake/bin/hermes',
      execHermesEnable: () => writeFileSync(lockPath, replacement, 'utf8'),
    });

    expect(report.skipped).toBeUndefined();
    expect(readFileSync(lockPath, 'utf8')).toBe(replacement);
  });

  test('the raw engine never marks convergence complete', () => {
    present(fixture.claudeDir);
    run();
    expect(existsSync(join(fixture.genieHome, MARKER_NAME))).toBe(false);
  });

  /**
   * Out-of-process runner harness: real concurrency (runAgentSync is
   * synchronous, so two in-process calls would serialize). SYNC_TEST_GO_FILE
   * (optional) is a start barrier — the runner spins until the file exists, so
   * N pre-spawned runners can be released into runAgentSync near-simultaneously.
   * SYNC_TEST_ENABLE_SLEEP_MS sleeps INSIDE the sync (in the hermes-enable exec
   * seam, i.e. while the lock is held) so contenders deterministically overlap
   * the holder.
   */
  function writeSyncRunner(): string {
    const runnerPath = join(fixture.root, 'sync-runner.ts');
    writeFileSync(
      runnerPath,
      [
        `import { existsSync, writeFileSync } from 'node:fs';`,
        `import { runAgentSync } from ${JSON.stringify(join(import.meta.dir, 'agent-sync.ts'))};`,
        `const sleepMs = Number(process.env.SYNC_TEST_ENABLE_SLEEP_MS ?? '0');`,
        'const goFile = process.env.SYNC_TEST_GO_FILE;',
        'if (goFile) {',
        '  while (!existsSync(goFile)) Bun.sleepSync(2);',
        '}',
        'const report = runAgentSync({',
        '  genieHome: process.env.SYNC_TEST_GENIE_HOME as string,',
        '  targets: {',
        '    claude: process.env.SYNC_TEST_CLAUDE as string,',
        '    codex: process.env.SYNC_TEST_CODEX as string,',
        '    hermes: process.env.SYNC_TEST_HERMES as string,',
        '    agentsSkills: process.env.SYNC_TEST_AGENTS_SKILLS as string,',
        '  },',
        `  hermesBinary: '/fake/bin/hermes',`,
        '  execHermesEnable: () => {',
        '    const readyFile = process.env.SYNC_TEST_READY_FILE;',
        "    if (readyFile) writeFileSync(readyFile, 'ready\\n');",
        '    if (sleepMs > 0) Bun.sleepSync(sleepMs);',
        '  },',
        '  log: () => undefined,',
        '});',
        'process.stdout.write(JSON.stringify(report));',
        '',
      ].join('\n'),
      'utf8',
    );
    return runnerPath;
  }

  function runnerEnv(extra: Record<string, string>): Record<string, string | undefined> {
    return {
      ...process.env,
      SYNC_TEST_GENIE_HOME: fixture.genieHome,
      SYNC_TEST_CLAUDE: fixture.claudeDir,
      SYNC_TEST_CODEX: fixture.codexDir,
      SYNC_TEST_HERMES: fixture.hermesHome,
      SYNC_TEST_AGENTS_SKILLS: fixture.agentsSkillsDir,
      ...extra,
    };
  }

  async function spawnRunner(runnerPath: string, extraEnv: Record<string, string>): Promise<AgentSyncReport> {
    const proc = Bun.spawn(['bun', runnerPath], {
      env: runnerEnv(extraEnv),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    return JSON.parse(out) as AgentSyncReport;
  }

  test('two simultaneous runs: exactly one writes, the other reports the skip advisory, target never half-written', async () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    const runnerPath = writeSyncRunner();
    const readyPath = join(fixture.root, 'holder-ready');

    const holder = spawnRunner(runnerPath, {
      SYNC_TEST_ENABLE_SLEEP_MS: '2000',
      SYNC_TEST_READY_FILE: readyPath,
    });
    // The injected Hermes seam runs while the holder owns the lifecycle lock.
    // Its explicit ready file is the deterministic overlap barrier; the
    // convergence marker must remain absent until the safe outer wrapper has
    // also completed role convergence.
    const markerPath = join(fixture.genieHome, MARKER_NAME);
    const deadline = Date.now() + 10_000;
    while (!existsSync(readyPath) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(readyPath)).toBe(true);
    expect(existsSync(markerPath)).toBe(false);

    const contender = spawnRunner(runnerPath, { SYNC_TEST_ENABLE_SLEEP_MS: '0' });
    const contenderReport = await contender; // resolves while the holder still sleeps in-lock
    expect(contenderReport.skipped).toContain('holds the lock');
    expect(contenderReport.agents).toHaveLength(0);
    // Mid-run observation point: the holder wrote claude/codex before its
    // hermes sleep — the managed target is fully present, never half-written.
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(readManifest(alphaDir).managedBy).toBe('genie-agent-sync');
    expect(existsSync(`${alphaDir}.genie-sync.staging`)).toBe(false);
    expect(existsSync(`${alphaDir}.genie-sync.prev`)).toBe(false);

    const settled = await Promise.allSettled([holder, contender]);
    const reports = settled.map((res) => {
      if (res.status !== 'fulfilled') throw new Error(`runner failed: ${res.reason}`);
      return res.value;
    });
    const wrote = reports.filter((report) => report.skipped === undefined);
    const skippedRuns = reports.filter((report) => report.skipped !== undefined);
    expect(wrote).toHaveLength(1); // exactly one performed the sync
    expect(skippedRuns).toHaveLength(1); // the other skipped with the advisory
    expect(skillAction(agentReport(wrote[0] as AgentSyncReport, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(fixture.genieHome, LOCK_NAME))).toBe(false); // holder released
  }, 20_000);

  test('simultaneous stale-lock steals: at most one run wins, the rest skip', async () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    const runnerPath = writeSyncRunner();
    // A crashed run's stale lock that every racer will try to steal.
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    writeFile(lockPath, '2147483647\n');
    const staleSec = (Date.now() - 11 * 60 * 1000) / 1000; // 11 min > 10 min age-out
    utimesSync(lockPath, staleSec, staleSec);

    // Pre-spawn four runners parked on the go-file barrier, then release them
    // together so the steal attempts overlap. The winner sleeps 2s INSIDE the
    // lock (hermes-enable seam), so every loser's full acquire+steal attempt
    // lands while the winner's fresh lock is live. The old unlink-then-create
    // steal fails this: a second stealer's unlink removes the first stealer's
    // FRESH lock and both proceed as writers.
    const goFile = join(fixture.root, 'go');
    const racers = [1, 2, 3, 4].map(() =>
      spawnRunner(runnerPath, { SYNC_TEST_ENABLE_SLEEP_MS: '2000', SYNC_TEST_GO_FILE: goFile }),
    );
    await Bun.sleep(300); // let all four park on the barrier
    writeFile(goFile, 'go\n');

    const settled = await Promise.allSettled(racers);
    const reports = settled.map((res) => {
      if (res.status !== 'fulfilled') throw new Error(`runner failed: ${res.reason}`);
      return res.value;
    });
    const wrote = reports.filter((report) => report.skipped === undefined);
    const skippedRuns = reports.filter((report) => report.skipped !== undefined);
    expect(wrote.length).toBeLessThanOrEqual(1); // mutual exclusion under steal contention
    expect(wrote.length + skippedRuns.length).toBe(4);
    if (wrote.length === 1) {
      expect(skillAction(agentReport(wrote[0] as AgentSyncReport, 'claude'), 'alpha')).toBe('created');
    }
    expect(existsSync(lockPath)).toBe(false); // stale lock is gone; any winner released its own
  }, 30_000);
});

describe('shared lifecycle lease', () => {
  test('lives beside GENIE_HOME and is reentrant within one lifecycle process', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    expect(dirname(path)).toBe(dirname(fixture.genieHome));
    expect(path.startsWith(`${fixture.genieHome}/`)).toBe(false);
    const first = acquireLifecycleLease(fixture.genieHome);
    expect('skipped' in first).toBe(false);
    if ('skipped' in first) throw new Error(first.skipped);
    const second = acquireLifecycleLease(fixture.genieHome);
    expect('skipped' in second).toBe(false);
    if ('skipped' in second) throw new Error(second.skipped);
    expect(existsSync(path)).toBe(true);
    second.release();
    expect(existsSync(path)).toBe(true);
    first.release();
    expect(existsSync(path)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex role-agent TOML refresh wiring (update.ts runAgentSyncSafe). Lives
// here rather than __tests__/update.test.ts only because that file is owned by
// a concurrent lane — the integrator may relocate this block verbatim.
// ---------------------------------------------------------------------------

describe('runAgentSyncSafe codex role-agent refresh wiring', () => {
  function fakeReport(overrides: Partial<AgentSyncReport> = {}, codexDetected = true): AgentSyncReport {
    return {
      source: { pluginRoot: '/home/.genie/plugins/genie', hermesRoot: null, version: '5.0.0' },
      agents: [
        { agent: 'claude', detected: true, skills: [], extras: [], advisories: [] },
        { agent: 'codex', detected: codexDetected, skills: [], extras: [], advisories: [] },
        { agent: 'hermes', detected: false, skills: [], extras: [], advisories: [] },
      ],
      backupsDir: null,
      ...overrides,
    };
  }

  function markerPath(): string {
    return join(fixture.root, '.last-agent-sync');
  }

  test('codex detected → the refresh seam runs once and the summary reports counts', () => {
    const lines: string[] = [];
    let calls = 0;
    runAgentSyncSafe({
      sync: () => fakeReport(),
      codexRefresh: () => {
        calls += 1;
        return {
          installed: 7,
          skippedUserOwned: ['genie-reviewer.toml'],
          keptModified: [],
          removed: [],
          backedUp: ['genie-wish.toml'],
        };
      },
      log: (line) => lines.push(line),
      markerPath: markerPath(),
    });
    expect(calls).toBe(1);
    const joined = lines.join('\n');
    expect(joined).toContain('codex — 7 role-agent TOMLs refreshed');
    expect(joined).toContain('1 user-tuned backed up');
    expect(joined).toContain('1 user-owned kept');
  });

  test('codex not detected → the refresh never runs', () => {
    let calls = 0;
    runAgentSyncSafe({
      sync: () => fakeReport({}, false),
      codexRefresh: () => {
        calls += 1;
        return { installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] };
      },
      log: () => undefined,
      markerPath: markerPath(),
    });
    expect(calls).toBe(0);
  });

  test('a lock-skipped sync run → the refresh never runs (the lock holder converges TOMLs too)', () => {
    let calls = 0;
    runAgentSyncSafe({
      sync: () => fakeReport({ agents: [], skipped: 'another agent-sync run holds the lock' }),
      codexRefresh: () => {
        calls += 1;
        return { installed: 7, skippedUserOwned: [], keptModified: [], removed: [], backedUp: [] };
      },
      log: () => undefined,
      markerPath: markerPath(),
    });
    expect(calls).toBe(0);
  });

  test('a refresh returning null (bundle lacks codex-agents) emits no refresh line', () => {
    const lines: string[] = [];
    runAgentSyncSafe({
      sync: () => fakeReport(),
      codexRefresh: () => null,
      log: (line) => lines.push(line),
      markerPath: markerPath(),
    });
    expect(lines.join('\n')).not.toContain('role-agent TOMLs');
  });

  test('a best-effort refresh throw is advisory and leaves the retry marker untouched', () => {
    const lines: string[] = [];
    const marker = markerPath();
    expect(() =>
      runAgentSyncSafe({
        sync: () => fakeReport(),
        codexRefresh: () => {
          throw new Error('toml copy exploded');
        },
        log: (line) => lines.push(line),
        markerPath: marker,
      }),
    ).not.toThrow();
    expect(lines.join('\n')).toContain('codex role-agent refresh failed: toml copy exploded');
    expect(existsSync(marker)).toBe(false);
  });

  test('strict explicit convergence propagates a role-agent failure', () => {
    const marker = markerPath();
    expect(() =>
      runAgentSyncSafe({
        sync: () => fakeReport(),
        codexRefresh: () => {
          throw new Error('inventory unavailable');
        },
        strict: true,
        log: () => undefined,
        markerPath: marker,
      }),
    ).toThrow('inventory unavailable');
    expect(existsSync(marker)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Digest guards a real tree (belt-and-suspenders on readdir usage)
// ---------------------------------------------------------------------------

describe('orphan detection ignores non-managed siblings', () => {
  test('staging siblings and unmanaged dirs never appear as removed and survive on disk', () => {
    present(fixture.claudeDir);
    run();
    const skillsDir = join(fixture.claudeDir, 'skills');
    // an unmanaged sibling + a genie-sync staging sibling should both be ignored by removal
    writeFile(join(skillsDir, 'unmanaged', 'SKILL.md'), '# unmanaged\n');
    writeFile(join(skillsDir, 'beta.genie-sync.prev', 'left.txt'), 'staging debris\n');

    const claude = agentReport(run(), 'claude');
    const removed = claude.skills.filter((skill) => skill.action === 'removed').map((skill) => skill.name);
    expect(removed).toHaveLength(0);
    // both survive on disk, not merely absent from the report
    expect(existsSync(join(skillsDir, 'unmanaged', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'beta.genie-sync.prev', 'left.txt'))).toBe(true);
  });
});
