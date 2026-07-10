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
import {
  type AgentReport,
  type AgentSyncOptions,
  type AgentSyncReport,
  computeDirDigest,
  resolveGenieSource,
  runAgentSync,
  stampWorkflow,
} from './agent-sync';

const require = createRequire(import.meta.url);
const { stampCouncilWorkflow, PLACEHOLDER } = require('../../plugins/genie/scripts/council-stamp.cjs') as {
  stampCouncilWorkflow: (opts: { templatePath: string; pluginRoot: string; targetDir: string }) => {
    action: 'written' | 'skipped';
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
    targets: { claude: fixture.claudeDir, codex: fixture.codexDir, hermes: fixture.hermesHome },
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
    expect(council).toContain(`const LENS_ROOT = '${fixture.pluginRoot}';`);
    expect(council).not.toContain(PLACEHOLDER);
  });

  test('codex: skills land under skills/.curated with a restart advisory', () => {
    present(fixture.codexDir);
    const report = agentReport(run(), 'codex');

    expect(report.detected).toBe(true);
    expect(existsSync(join(fixture.codexDir, 'skills', '.curated', 'alpha', 'SKILL.md'))).toBe(true);
    expect(readManifest(join(fixture.codexDir, 'skills', '.curated', 'alpha')).managedBy).toBe('genie-agent-sync');
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
// Adopt-with-backup
// ---------------------------------------------------------------------------

describe('auto-adopt with backup', () => {
  test('a user-modified managed skill is backed up then rewritten', () => {
    present(fixture.claudeDir);
    run();
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# hand-edited\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('adopted');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n'); // restored from source

    expect(report.backupsDir).not.toBeNull();
    const backup = join(report.backupsDir as string, 'claude', 'alpha', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe('# hand-edited\n'); // the edit is preserved
  });

  test('an unmanaged same-name dir (no manifest) is adopted with a backup', () => {
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# pre-existing unmanaged\n');

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('adopted');
    expect(existsSync(join(alphaDir, MANIFEST_NAME))).toBe(true); // now managed
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');

    const backup = join(report.backupsDir as string, 'claude', 'alpha', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe('# pre-existing unmanaged\n');
  });

  test('a target dir with a corrupt manifest is adopted with a backup, never crashes', () => {
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(alphaDir, 'SKILL.md'), '# pre-existing with corrupt manifest\n');
    writeFile(join(alphaDir, MANIFEST_NAME), '{ this is not valid json '); // unparsable → treated as unmanaged

    const report = run();
    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'alpha')).toBe('adopted');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n'); // restored from source

    expect(report.backupsDir).not.toBeNull();
    const backup = join(report.backupsDir as string, 'claude', 'alpha', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe('# pre-existing with corrupt manifest\n'); // the edit is preserved
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
    expect(existsSync(join(fixture.codexDir, 'skills', '.curated', 'council', 'SKILL.md'))).toBe(true);
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
// Codex .system protection
// ---------------------------------------------------------------------------

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

    const tsWrite = stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir });
    const cjsWrite = stampCouncilWorkflow({ templatePath, pluginRoot, targetDir: cjsDir });
    expect(tsWrite.action).toBe('written');
    expect(cjsWrite.action).toBe('written');
    expect(readFileSync(join(tsDir, 'council.js'), 'utf8')).toBe(readFileSync(join(cjsDir, 'council.js'), 'utf8'));

    // idempotent skip on the unchanged re-run, for both implementations
    expect(stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir }).action).toBe('skipped');
    expect(stampCouncilWorkflow({ templatePath, pluginRoot, targetDir: cjsDir }).action).toBe('skipped');
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
    writeFile(lockPath, '999\n');
    const staleSec = (Date.now() - 11 * 60 * 1000) / 1000; // 11 min > 10 min age-out
    utimesSync(lockPath, staleSec, staleSec);

    const report = run();

    expect(report.skipped).toBeUndefined();
    expect(skillAction(agentReport(report, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(lockPath)).toBe(false); // released after the run
  });

  test('the lock is released after a run, so a sequential re-run proceeds normally', () => {
    present(fixture.claudeDir);
    run();
    expect(existsSync(join(fixture.genieHome, LOCK_NAME))).toBe(false);

    const second = run();
    expect(second.skipped).toBeUndefined();
    expect(skillAction(agentReport(second, 'claude'), 'alpha')).toBe('unchanged');
  });

  test('the throttle marker is written from the injected clock', () => {
    present(fixture.claudeDir);
    run();
    expect(readFileSync(join(fixture.genieHome, MARKER_NAME), 'utf8')).toBe('2026-07-10T12:00:00.000Z\n');
  });

  test('two simultaneous runs: exactly one writes, the other reports the skip advisory, target never half-written', async () => {
    present(fixture.claudeDir);
    present(fixture.codexDir);
    present(fixture.hermesHome);
    // Out-of-process runner: real concurrency (runAgentSync is synchronous, so
    // two in-process calls would serialize). The holder sleeps INSIDE the sync
    // (in the hermes-enable exec seam, i.e. while the lock is held) so the
    // contender's whole run deterministically overlaps it.
    const runnerPath = join(fixture.root, 'sync-runner.ts');
    writeFileSync(
      runnerPath,
      [
        `import { runAgentSync } from ${JSON.stringify(join(import.meta.dir, 'agent-sync.ts'))};`,
        `const sleepMs = Number(process.env.SYNC_TEST_ENABLE_SLEEP_MS ?? '0');`,
        'const report = runAgentSync({',
        '  genieHome: process.env.SYNC_TEST_GENIE_HOME as string,',
        '  targets: {',
        '    claude: process.env.SYNC_TEST_CLAUDE as string,',
        '    codex: process.env.SYNC_TEST_CODEX as string,',
        '    hermes: process.env.SYNC_TEST_HERMES as string,',
        '  },',
        `  hermesBinary: '/fake/bin/hermes',`,
        '  execHermesEnable: () => {',
        '    if (sleepMs > 0) Bun.sleepSync(sleepMs);',
        '  },',
        '  log: () => undefined,',
        '});',
        'process.stdout.write(JSON.stringify(report));',
        '',
      ].join('\n'),
      'utf8',
    );
    const baseEnv = {
      ...process.env,
      SYNC_TEST_GENIE_HOME: fixture.genieHome,
      SYNC_TEST_CLAUDE: fixture.claudeDir,
      SYNC_TEST_CODEX: fixture.codexDir,
      SYNC_TEST_HERMES: fixture.hermesHome,
    };
    const spawnRunner = async (sleepMs: number): Promise<AgentSyncReport> => {
      const proc = Bun.spawn(['bun', runnerPath], {
        env: { ...baseEnv, SYNC_TEST_ENABLE_SLEEP_MS: String(sleepMs) },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      expect(code).toBe(0);
      return JSON.parse(out) as AgentSyncReport;
    };

    const holder = spawnRunner(2000);
    // The engine writes the throttle marker at sync START (right after lock
    // acquisition), so its appearance proves the holder is mid-sync — the
    // deterministic gate for launching the contender.
    const markerPath = join(fixture.genieHome, MARKER_NAME);
    const deadline = Date.now() + 10_000;
    while (!existsSync(markerPath) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(markerPath)).toBe(true); // marker at START, not completion

    const contender = spawnRunner(0);
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
    expect(existsSync(join(fixture.genieHome, LOCK_NAME))).toBe(false); // holder released
  }, 20_000);
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
