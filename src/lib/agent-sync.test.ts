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
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  generateCodexFallbackAllowlist,
  materializeFrozenCodexFallbackRelease,
} from '../../scripts/generate-codex-fallback-allowlist';
import historicalCodexFallbackAllowlist from '../fixtures/codex-fallback-allowlist.json';
import { checkAgentSync } from '../genie-commands/doctor';
import { runAgentSyncSafe } from '../genie-commands/update';
import {
  type AgentReport,
  type AgentSyncOptions,
  type AgentSyncReport,
  CODEX_FALLBACK_RETIREMENT_ROOT,
  LIFECYCLE_LEASE_OWNER_ENV,
  LIFECYCLE_LEASE_PATH_ENV,
  TARGET_NAME,
  WORKFLOW_MANIFEST_NAME,
  acquireLifecycleLease,
  applyCodexFallbackRetirement,
  atomicRenameDirectoryNoClobber,
  computeDirDigest,
  inspectManagedWorkflow,
  lifecycleLockPath,
  planCodexFallbackRetirement,
  publishDirectoryViaNameClaim,
  recoverCodexFallbackRetirements,
  recoverManagedSkillTransactions,
  recoverManagedWorkflowTransactions,
  removeManagedWorkflow,
  resolveGenieSource,
  resolveLinuxRenameat2,
  runAgentSync,
  stampWorkflow,
  writeAllSync,
} from './agent-sync';

const require = createRequire(import.meta.url);
const {
  stampCouncilWorkflow,
  recoverTransactions: recoverCjsCouncilTransactions,
  PLACEHOLDER,
} = require('../../plugins/genie/scripts/council-stamp.cjs') as {
  stampCouncilWorkflow: (opts: {
    templatePath: string;
    pluginRoot: string;
    targetDir: string;
    version?: string | null;
    now?: () => Date;
    beforePromotion?: () => void;
    afterAuthorization?: () => void;
    beforePublish?: () => void;
  }) => {
    action: 'written' | 'skipped' | 'kept-unmanaged' | 'kept-modified' | 'metadata-corrupt';
    targetPath: string;
  };
  recoverTransactions: (targetDir: string) => void;
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

  test('a v1 skill upgrades only when its complete physical tree matches canonical source', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ skills: { alpha: { 'SKILL.md': '# alpha\n' } } });
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    seedV1ManagedDir(alphaDir, { 'SKILL.md': '# alpha\n' });

    const claude = agentReport(run({ selection: 'claude' }), 'claude');

    expect(skillAction(claude, 'alpha')).toBe('updated');
    expect(JSON.parse(readFileSync(join(alphaDir, MANIFEST_NAME), 'utf8')).identityVersion).toBe(2);
  });

  test('a chmod-only edit under v1 authority fails closed', () => {
    rmSync(fixture.root, { recursive: true, force: true });
    fixture = setup({ skills: { alpha: { 'SKILL.md': '# alpha\n' } } });
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    seedV1ManagedDir(alphaDir, { 'SKILL.md': '# alpha\n' });
    chmodSync(join(alphaDir, 'SKILL.md'), 0o755);

    const claude = agentReport(run({ selection: 'claude' }), 'claude');

    expect(skillAction(claude, 'alpha')).toBe('kept-modified');
    expect(lstatSync(join(alphaDir, 'SKILL.md')).mode & 0o7777).toBe(0o755);
    expect(JSON.parse(readFileSync(join(alphaDir, MANIFEST_NAME), 'utf8')).identityVersion).toBeUndefined();
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

  test('a same-name dangling skill symlink is preserved instead of failing the sync', () => {
    present(fixture.claudeDir);
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    mkdirSync(dirname(alphaDir), { recursive: true });
    symlinkSync(join(fixture.root, 'target-that-does-not-exist'), alphaDir);

    const report = agentReport(run(), 'claude');

    expect(skillAction(report, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(report.failures ?? []).toEqual([]);
    expect(lstatSync(alphaDir).isSymbolicLink()).toBe(true);
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

  test('an orphan edit after classification is never deleted and no stale backup is presented as exact', () => {
    present(fixture.claudeDir);
    run();
    const betaDir = join(fixture.claudeDir, 'skills', 'beta');
    rmSync(join(fixture.pluginRoot, 'skills', 'beta'), { recursive: true, force: true });

    const report = run({
      beforeManagedDirRemoval(destDir, stage) {
        if (destDir === betaDir && stage === 'before-park') writeFileSync(join(betaDir, 'SKILL.md'), '# raced\n');
      },
    });

    const claude = agentReport(report, 'claude');
    expect(skillAction(claude, 'beta')).toBeUndefined();
    expect(readFileSync(join(betaDir, 'SKILL.md'), 'utf8')).toBe('# raced\n');
    expect(claude.failures?.some((line) => line.includes('changed before removal'))).toBe(true);
    expect(report.backupsDir).toBeNull();
  });

  test('a quarantined orphan changed after backup is preserved as a conflict with the exact backup intact', () => {
    present(fixture.claudeDir);
    run();
    rmSync(join(fixture.pluginRoot, 'skills', 'beta'), { recursive: true, force: true });

    const report = run({
      beforeManagedDirRemoval(_destDir, stage) {
        if (stage !== 'before-delete') return;
        const root = join(fixture.claudeDir, 'skills', '.genie-sync-transactions');
        const transaction = readdirSync(root).find((name) => name.startsWith('delete-')) as string;
        writeFileSync(join(root, transaction, 'parked', 'SKILL.md'), '# raced parked bytes\n');
      },
    });

    const backup = join(report.backupsDir as string, 'claude', 'beta', 'SKILL.md');
    expect(readFileSync(backup, 'utf8')).toBe('# beta\n');
    const transactionRoot = join(fixture.claudeDir, 'skills', '.genie-sync-transactions');
    const conflict = readdirSync(transactionRoot).find((name) => name.startsWith('.conflict-delete-')) as string;
    expect(readFileSync(join(transactionRoot, conflict, 'parked', 'SKILL.md'), 'utf8')).toBe('# raced parked bytes\n');
    expect(agentReport(report, 'claude').failures).toHaveLength(1);
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

  test('identifies symlink kind and target without following external content', () => {
    const dir = join(fixture.root, 'physical-symlink');
    const external = join(fixture.root, 'external.txt');
    writeFile(external, 'one\n');
    mkdirSync(dir, { recursive: true });
    symlinkSync(external, join(dir, 'entry'));
    const linked = computeDirDigest(dir);

    writeFile(external, 'two\n');
    expect(computeDirDigest(dir)).toBe(linked);
    rmSync(join(dir, 'entry'));
    writeFile(join(dir, 'entry'), 'two\n');
    expect(computeDirDigest(dir)).not.toBe(linked);
    rmSync(join(dir, 'entry'));
    symlinkSync('different-target', join(dir, 'entry'));
    expect(computeDirDigest(dir)).not.toBe(linked);
  });

  test('identifies entry modes and broken symlinks', () => {
    const dir = join(fixture.root, 'physical-modes');
    writeFile(join(dir, 'tool'), '#!/bin/sh\n');
    symlinkSync('missing-target', join(dir, 'broken'));
    const before = computeDirDigest(dir);
    chmodSync(join(dir, 'tool'), 0o755);
    expect(computeDirDigest(dir)).not.toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Crash-recovery staging
// ---------------------------------------------------------------------------

describe('staging cleanup', () => {
  test('a promotion failure restores the previous live skill and is strict-visible', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha v2\n');

    const report = run({
      selection: 'claude',
      beforeManagedDirPublish: () => {
        throw new Error('simulated promotion failure');
      },
    });
    const claude = agentReport(report, 'claude');

    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(claude.failures?.join('\n')).toContain('simulated promotion failure');
    const marker = join(fixture.root, '.strict-marker');
    expect(() =>
      runAgentSyncSafe({ sync: () => report, strict: true, markerPath: marker, log: () => undefined }),
    ).toThrow('simulated promotion failure');
    expect(existsSync(marker)).toBe(false);

    expect(skillAction(agentReport(run({ selection: 'claude' }), 'claude'), 'alpha')).toBe('updated');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha v2\n');
  });

  test('a rollback race preserves the live, prior, and staged skill trees', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha incoming\n');

    const claude = agentReport(
      run({
        selection: 'claude',
        beforeManagedDirPublish(destDir) {
          if (destDir !== alphaDir) return;
          writeFile(join(destDir, 'SKILL.md'), '# alpha rollback racer\n');
          throw new Error('fail after racer publication');
        },
      }),
      'claude',
    );

    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha rollback racer\n');
    expect(claude.failures?.join('\n')).toContain('preserved managed skill evidence');
    const transactionRoot = join(fixture.claudeDir, 'skills', '.genie-sync-transactions');
    const conflict = readdirSync(transactionRoot).find((name) => name.startsWith('.conflict-')) as string;
    expect(readFileSync(join(transactionRoot, conflict, 'before', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(readFileSync(join(transactionRoot, conflict, 'staged', 'SKILL.md'), 'utf8')).toBe('# alpha incoming\n');
  });

  test('a managed skill edited after classification wins the CAS and the incoming version is preserved', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha incoming\n');

    const claude = agentReport(
      run({
        selection: 'claude',
        beforeManagedDirPromotion(destDir) {
          if (destDir === alphaDir) writeFile(join(destDir, 'SKILL.md'), '# alpha personal race\n');
        },
      }),
      'claude',
    );

    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha personal race\n');
    expect(claude.failures?.join('\n')).toContain('changed before promotion');
    const transactionRoot = join(fixture.claudeDir, 'skills', '.genie-sync-transactions');
    const conflict = readdirSync(transactionRoot).find((name) => name.startsWith('.conflict-'));
    expect(conflict).toBeDefined();
    expect(readFileSync(join(transactionRoot, conflict as string, 'staged', 'SKILL.md'), 'utf8')).toBe(
      '# alpha incoming\n',
    );
  });

  test('a metadata-only managed-skill edit after classification also revokes promotion authority', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    const manifestPath = join(alphaDir, MANIFEST_NAME);
    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha incoming\n');

    const claude = agentReport(
      run({
        selection: 'claude',
        beforeManagedDirPromotion(destDir) {
          if (destDir !== alphaDir) return;
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
          writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, personalNote: 'keep me' }, null, 2)}\n`);
        },
      }),
      'claude',
    );

    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).personalNote).toBe('keep me');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(claude.failures?.join('\n')).toContain('changed before promotion');
  });

  test('a skill recreated after parking but before final publish is never clobbered', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const alphaDir = join(fixture.claudeDir, 'skills', 'alpha');
    writeFile(join(fixture.pluginRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha incoming\n');

    const claude = agentReport(
      run({
        selection: 'claude',
        beforeManagedDirPublish(destDir) {
          if (destDir !== alphaDir) return;
          writeFile(join(destDir, 'SKILL.md'), '# alpha personal after park\n');
        },
      }),
      'claude',
    );

    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha personal after park\n');
    expect(claude.failures?.join('\n')).toContain('exclusive directory publish failed');
    const transactionRoot = join(fixture.claudeDir, 'skills', '.genie-sync-transactions');
    const conflict = readdirSync(transactionRoot).find((name) => name.startsWith('.conflict-'));
    expect(conflict).toBeDefined();
    expect(readFileSync(join(transactionRoot, conflict as string, 'staged', 'SKILL.md'), 'utf8')).toBe(
      '# alpha incoming\n',
    );
  });

  test('a journaled crash after moving live restores the prior tree before classification', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const skillsDir = join(fixture.claudeDir, 'skills');
    const alphaDir = join(skillsDir, 'alpha');
    const priorContentDigest = computeDirDigest(alphaDir);
    const priorManifestDigest = createHash('sha256')
      .update(readFileSync(join(alphaDir, MANIFEST_NAME)))
      .digest('hex');
    const transactionDir = join(skillsDir, '.genie-sync-transactions', 'txn-616c706861-crashed');
    mkdirSync(transactionDir, { recursive: true });
    renameSync(alphaDir, join(transactionDir, 'before'));
    writeFile(
      join(transactionDir, 'journal.json'),
      `${JSON.stringify({
        version: 2,
        destName: 'alpha',
        hadLive: true,
        beforeContentDigest: priorContentDigest,
        beforeManifestDigest: priorManifestDigest,
        stagedContentDigest: '0'.repeat(64),
        stagedManifestDigest: '1'.repeat(64),
        identityVersion: 2,
      })}\n`,
    );

    const claude = agentReport(run({ selection: 'claude' }), 'claude');

    expect(skillAction(claude, 'alpha')).toBe('unchanged');
    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(existsSync(transactionDir)).toBe(false);
  });

  test('public recovery restores a parked removal even when no live skill is enumerable', () => {
    present(fixture.claudeDir);
    run({ selection: 'claude' });
    const skillsDir = join(fixture.claudeDir, 'skills');
    const alphaDir = join(skillsDir, 'alpha');
    const transactionDir = join(skillsDir, '.genie-sync-transactions', 'delete-616c706861-crashed');
    const contentDigest = computeDirDigest(alphaDir);
    const manifestDigest = createHash('sha256')
      .update(readFileSync(join(alphaDir, MANIFEST_NAME)))
      .digest('hex');
    writeFile(
      join(transactionDir, 'journal.json'),
      `${JSON.stringify({
        version: 2,
        destName: 'alpha',
        contentDigest,
        manifestDigest,
        identityVersion: 2,
      })}\n`,
    );
    renameSync(alphaDir, join(transactionDir, 'parked'));

    recoverManagedSkillTransactions(skillsDir);

    expect(readFileSync(join(alphaDir, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(existsSync(transactionDir)).toBe(false);
  });

  test('hidden pre-journal managed-dir debris is quarantined and does not poison retries', () => {
    present(fixture.claudeDir);
    const debris = join(fixture.claudeDir, 'skills', '.genie-sync-transactions', '.staging-616c706861-crashed');
    writeFile(join(debris, 'staged', 'SKILL.md'), '# incomplete\n');

    const claude = agentReport(run({ selection: 'claude' }), 'claude');

    expect(skillAction(claude, 'alpha')).toBe('created');
    expect(existsSync(debris)).toBe(false);
    expect(readFileSync(join(fixture.claudeDir, 'skills', 'alpha', 'SKILL.md'), 'utf8')).toBe('# alpha\n');
  });

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
// Hermes config convergence: MCP server + skills external dir
// ---------------------------------------------------------------------------

describe('hermes config convergence', () => {
  /** Materialize an executable genie binary so resolveGenieBinaryPath resolves it. */
  function presentGenieBinary(): string {
    const bin = join(fixture.genieHome, 'bin', 'genie');
    writeFile(bin, '#!/usr/bin/env bun\n');
    chmodSync(bin, 0o755);
    return bin;
  }

  /** The product-skills root the helper resolves in the fixture (plugin mirror). */
  function skillsRoot(): string {
    return join(fixture.pluginRoot, 'skills');
  }

  test('default HERMES_HOME: MCP + skills legs converge into config.yaml, idempotent on re-run', () => {
    present(fixture.hermesHome);
    const bin = presentGenieBinary();

    const first = agentReport(run(), 'hermes');
    expect(extraAction(first, 'mcp-config')).toBe('created');
    // The skills leg writes into the config.yaml the MCP leg just created, so a
    // fresh run reports 'updated' (existing non-empty file) — never 'failed'.
    expect(extraAction(first, 'skills-dir')).toBe('updated');
    expect(first.failures).toBeUndefined();

    const configPath = join(fixture.hermesHome, 'config.yaml');
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain(bin);
    expect(text).toContain('skills:');
    expect(text).toContain('external_dirs:');
    expect(text).toContain(skillsRoot());

    // Second run: both legs are steady-state and report unchanged — idempotent.
    const second = agentReport(run(), 'hermes');
    expect(extraAction(second, 'mcp-config')).toBe('unchanged');
    expect(extraAction(second, 'skills-dir')).toBe('unchanged');
    expect(second.failures).toBeUndefined();
  });

  test('sticky active_profile: config.yaml lands in the live profile home, not the default home', () => {
    present(fixture.hermesHome);
    writeFile(join(fixture.hermesHome, 'active_profile'), 'work\n');
    presentGenieBinary();

    const hermes = agentReport(run(), 'hermes');
    expect(extraAction(hermes, 'mcp-config')).toBe('created');
    expect(extraAction(hermes, 'skills-dir')).toBe('updated');

    const profileConfig = join(fixture.hermesHome, 'profiles', 'work', 'config.yaml');
    expect(existsSync(profileConfig)).toBe(true);
    // The default-home config is NOT written while a sticky profile is active.
    expect(existsSync(join(fixture.hermesHome, 'config.yaml'))).toBe(false);
    const text = readFileSync(profileConfig, 'utf8');
    expect(text).toContain('mcp_servers:');
    expect(text).toContain('external_dirs:');
    expect(text).toContain(skillsRoot());

    // Idempotency also holds for the sticky-profile shape.
    const second = agentReport(run(), 'hermes');
    expect(extraAction(second, 'mcp-config')).toBe('unchanged');
    expect(extraAction(second, 'skills-dir')).toBe('unchanged');
  });

  test('inline top-level mcp_servers → WARN skip; plugin link + skills leg still converge, run does not fail', () => {
    present(fixture.hermesHome);
    presentGenieBinary();
    const configPath = join(fixture.hermesHome, 'config.yaml');
    writeFile(configPath, 'mcp_servers: {}\n');

    const hermes = agentReport(run(), 'hermes');
    // The inline-shaped MCP key is a non-fatal skip carrying the remediation hint.
    expect(extraAction(hermes, 'mcp-config')).toBe('skipped');
    const mcp = hermes.extras.find((e) => e.kind === 'mcp-config');
    expect(mcp?.detail).toContain('block mapping');
    expect(hermes.advisories.some((a) => a.includes('inline top-level key'))).toBe(true);
    // Non-fatal: no hermes failure recorded, so a strict `genie update` never throws.
    expect(hermes.failures).toBeUndefined();
    // The other legs still converge: plugin link created + skills external dir written.
    expect(extraAction(hermes, 'symlink')).toBe('created');
    expect(extraAction(hermes, 'skills-dir')).toBe('updated');
    // The operator's original inline line survives byte-for-byte.
    expect(readFileSync(configPath, 'utf8')).toContain('mcp_servers: {}');
  });

  test('inline top-level skills → WARN skip while the MCP leg converges independently', () => {
    present(fixture.hermesHome);
    presentGenieBinary();
    const configPath = join(fixture.hermesHome, 'config.yaml');
    writeFile(configPath, 'skills: {}\n');

    const hermes = agentReport(run(), 'hermes');
    expect(extraAction(hermes, 'skills-dir')).toBe('skipped');
    const skills = hermes.extras.find((e) => e.kind === 'skills-dir');
    expect(skills?.detail).toContain('block mapping');
    expect(hermes.failures).toBeUndefined();
    // MCP leg converges over the pre-existing (non-genie) file.
    expect(extraAction(hermes, 'mcp-config')).toBe('created');
    expect(readFileSync(configPath, 'utf8')).toContain('skills: {}');
    expect(readFileSync(configPath, 'utf8')).toContain('mcp_servers:');
  });

  test('a missing genie binary fails the MCP leg non-fatally while skills still converge', () => {
    present(fixture.hermesHome);
    // No genie binary materialized → resolveGenieBinaryPath cannot resolve one.
    const hermes = agentReport(run(), 'hermes');
    expect(extraAction(hermes, 'mcp-config')).toBe('failed');
    expect(hermes.failures).toBeUndefined(); // failed leg is non-fatal to the run
    expect(extraAction(hermes, 'skills-dir')).toBe('created');
    expect(extraAction(hermes, 'symlink')).toBe('created');
  });

  test('round-trip: syncHermes writes converge and doctor.checkAgentSync reports every hermes leg green', () => {
    // WRITE: runAgentSync → syncHermes converges the plugin link + config.yaml
    // (mcp_servers.genie + skills.external_dirs) into the fixture's HERMES_HOME.
    present(fixture.hermesHome);
    const bin = presentGenieBinary();
    const wrote = agentReport(run(), 'hermes');
    expect(extraAction(wrote, 'mcp-config')).toBe('created');
    expect(extraAction(wrote, 'skills-dir')).toBe('updated');

    // READ-BACK: the doctor's read-only agent-sync check, pointed at the SAME
    // converged tmpdir fixture, must confirm every hermes leg the writer produced.
    // hermesBinary:null skips the enable probe so this test never spawns a process.
    const hermesChecks = checkAgentSync({
      genieHome: fixture.genieHome,
      claudeDir: fixture.claudeDir,
      codexDir: fixture.codexDir,
      agentsSkillsDir: fixture.agentsSkillsDir,
      hermesHome: fixture.hermesHome,
      hermesBinary: null,
      settingsPath: join(fixture.claudeDir, 'settings.json'),
    }).filter((check) => check.name.startsWith('agent sync: hermes'));

    const byName = (name: string) => hermesChecks.find((check) => check.name === name);
    expect(byName('agent sync: hermes')?.status).toBe('pass'); // plugin symlink leg
    expect(byName('agent sync: hermes')?.detail).toContain(fixture.hermesSource);
    expect(byName('agent sync: hermes mcp')?.status).toBe('pass');
    expect(byName('agent sync: hermes mcp')?.detail).toContain(bin);
    expect(byName('agent sync: hermes skills')?.status).toBe('pass');
    expect(byName('agent sync: hermes skills')?.detail).toContain(skillsRoot());
    // Every emitted hermes leg is a pass — the writer and the doctor agree end-to-end.
    expect(hermesChecks.length).toBeGreaterThanOrEqual(3);
    expect(hermesChecks.every((check) => check.status === 'pass')).toBe(true);
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

function seedV1ManagedDir(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) writeFile(join(dir, rel), content);
  const digest = createHash('sha256');
  for (const [rel, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(rel);
    digest.update('\0');
    digest.update(createHash('sha256').update(content).digest('hex'));
    digest.update('\0');
  }
  writeFile(
    join(dir, MANIFEST_NAME),
    `${JSON.stringify({
      managedBy: 'genie-agent-sync',
      version: '8.0.0',
      digest: digest.digest('hex'),
      syncedAt: '2025-01-01T00:00:00.000Z',
    })}\n`,
  );
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

  test('content-only v1 ownership never authorizes destructive legacy cleanup', () => {
    present(fixture.codexDir);
    const legacyAlpha = join(fixture.codexDir, 'skills', '.curated', 'alpha');
    seedV1ManagedDir(legacyAlpha, { 'SKILL.md': '# legacy alpha\n' });

    const codex = agentReport(run(), 'codex');

    expect(readFileSync(join(legacyAlpha, 'SKILL.md'), 'utf8')).toBe('# legacy alpha\n');
    expect(codex.extras).toContainEqual({
      kind: 'legacy-curated',
      action: 'kept-modified',
      detail: legacyAlpha,
    });
  });

  test('a legacy managed dir changed after classification stays live and is not removed', () => {
    present(fixture.codexDir);
    const legacyAlpha = join(fixture.codexDir, 'skills', '.curated', 'alpha');
    seedManagedDir(legacyAlpha, { 'SKILL.md': '# legacy alpha\n' });
    const report = run({
      beforeManagedDirRemoval(destDir, stage) {
        if (destDir === legacyAlpha && stage === 'before-park') {
          writeFileSync(join(legacyAlpha, 'SKILL.md'), '# legacy raced\n');
        }
      },
    });
    expect(readFileSync(join(legacyAlpha, 'SKILL.md'), 'utf8')).toBe('# legacy raced\n');
    expect(agentReport(report, 'codex').failures?.some((line) => line.includes('changed before removal'))).toBe(true);
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
  test('produces byte-identical workflow output and identical skip semantics', () => {
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
    for (const dir of [tsDir, cjsDir]) {
      expect(lstatSync(join(dir, TARGET_NAME)).mode & 0o7777).toBe(0o644);
      expect(lstatSync(join(dir, WORKFLOW_MANIFEST_NAME)).mode & 0o7777).toBe(0o644);
    }

    // idempotent skip on the unchanged re-run, for both implementations
    expect(stampWorkflow({ templatePath, pluginRoot, targetDir: tsDir }).action).toBe('skipped');
    expect(stampCouncilWorkflow({ templatePath, pluginRoot, targetDir: cjsDir }).action).toBe('skipped');
  });

  test('an inventory-missing exact legacy workflow remains byte-identical and unmanaged', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'user-workflows');
    const targetPath = join(targetDir, 'council.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    writeFile(targetPath, TEMPLATE_BODY.split(PLACEHOLDER).join('/personal/plugin'));
    const before = readFileSync(targetPath, 'utf8');

    const result = stampWorkflow({ templatePath, pluginRoot: '/personal/plugin', targetDir });

    expect(result.action).toBe('kept-unmanaged');
    expect(readFileSync(targetPath, 'utf8')).toBe(before);
    expect(existsSync(join(targetDir, WORKFLOW_MANIFEST_NAME))).toBe(false);
    expect(existsSync(join(dirname(targetDir), '.genie-recovery'))).toBe(false);
  });

  test('inspection is pure and pre-journal council debris cannot poison the next stamp', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'recoverable-workflows');
    const debris = join(targetDir, '.council.genie-txn-staging-crashed');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    writeFile(join(debris, 'staged', TARGET_NAME), '// incomplete\n');

    expect(inspectManagedWorkflow(targetDir).state).toBe('unmanaged');
    expect(existsSync(debris)).toBe(true);

    expect(stampWorkflow({ templatePath, pluginRoot: '/plugin', targetDir }).action).toBe('written');
    expect(existsSync(debris)).toBe(false);
    expect(inspectManagedWorkflow(targetDir).state).toBe('managed-clean');
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

  test('council chmod-only edits fail closed before update or removal', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'chmod-workflows');
    const targetPath = join(targetDir, TARGET_NAME);
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    stampWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir });
    chmodSync(targetPath, 0o755);

    expect(stampWorkflow({ templatePath, pluginRoot: '/new/plugin', targetDir }).action).toBe('kept-modified');
    expect(removeManagedWorkflow(targetDir)).toBe('kept-modified');
    expect(lstatSync(targetPath).mode & 0o7777).toBe(0o755);
  });

  test('a chmod race after council removal classification revokes destructive authority', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'chmod-removal-race');
    const targetPath = join(targetDir, TARGET_NAME);
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    stampWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir });

    expect(() =>
      removeManagedWorkflow(targetDir, {
        beforeRemoval: (stage) => {
          if (stage === 'before-park') chmodSync(targetPath, 0o600);
        },
      }),
    ).toThrow('changed before removal');
    expect(lstatSync(targetPath).mode & 0o7777).toBe(0o600);
  });

  test('both council engines preserve a post-classification personal edit and quarantine the incoming version', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const [name, stamp] of [
      ['ts', stampWorkflow],
      ['cjs', stampCouncilWorkflow],
    ] as const) {
      const targetDir = join(fixture.root, `workflow-cas-${name}`);
      const targetPath = join(targetDir, TARGET_NAME);
      stamp({ templatePath, pluginRoot: '/old/plugin', targetDir });
      expect(() =>
        stamp({
          templatePath,
          pluginRoot: '/incoming/plugin',
          targetDir,
          beforePromotion: () => writeFileSync(targetPath, '// personal race\n', 'utf8'),
        }),
      ).toThrow('changed before promotion');
      expect(readFileSync(targetPath, 'utf8')).toBe('// personal race\n');
      const conflict = readdirSync(targetDir).find((entry) => entry.startsWith('.council.genie-conflict-'));
      expect(conflict).toBeDefined();
      expect(readFileSync(join(targetDir, conflict as string, 'staged', TARGET_NAME), 'utf8')).toContain(
        '/incoming/plugin',
      );
    }
  });

  test('both council engines reject directory and symlink races after an expected-absence check', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const [engine, stamp] of [
      ['ts', stampWorkflow],
      ['cjs', stampCouncilWorkflow],
    ] as const) {
      for (const kind of ['directory', 'symlink'] as const) {
        const targetDir = join(fixture.root, `workflow-absence-${engine}-${kind}`);
        const targetPath = join(targetDir, TARGET_NAME);
        expect(() =>
          stamp({
            templatePath,
            pluginRoot: '/incoming/plugin',
            targetDir,
            afterAuthorization: () => {
              if (kind === 'directory') mkdirSync(targetPath);
              else symlinkSync('personal-target', targetPath);
            },
          }),
        ).toThrow('changed during promotion');
        const stat = lstatSync(targetPath);
        expect(kind === 'directory' ? stat.isDirectory() : stat.isSymbolicLink()).toBe(true);
        expect(readdirSync(targetDir).some((name) => name.startsWith('.council.genie-conflict-'))).toBe(true);
      }
    }
  });

  test('both council engines preserve a file recreated after parking but before exclusive publish', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const [engine, stamp] of [
      ['ts', stampWorkflow],
      ['cjs', stampCouncilWorkflow],
    ] as const) {
      const targetDir = join(fixture.root, `workflow-final-publish-${engine}`);
      const targetPath = join(targetDir, TARGET_NAME);
      stamp({ templatePath, pluginRoot: '/old/plugin', targetDir });

      expect(() =>
        stamp({
          templatePath,
          pluginRoot: '/incoming/plugin',
          targetDir,
          beforePublish: () => writeFileSync(targetPath, '// personal after park\n'),
        }),
      ).toThrow('exclusive');
      expect(readFileSync(targetPath, 'utf8')).toBe('// personal after park\n');
      const conflict = readdirSync(targetDir).find((name) => name.startsWith('.council.genie-conflict-'));
      expect(conflict).toBeDefined();
      expect(readFileSync(join(targetDir, conflict as string, 'staged', TARGET_NAME), 'utf8')).toContain(
        '/incoming/plugin',
      );
    }
  });

  test('both council rollbacks preserve a byte-identical chmod racer plus prior and staged evidence', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const [engine, stamp] of [
      ['ts', stampWorkflow],
      ['cjs', stampCouncilWorkflow],
    ] as const) {
      const targetDir = join(fixture.root, `workflow-rollback-race-${engine}`);
      const targetPath = join(targetDir, TARGET_NAME);
      stamp({ templatePath, pluginRoot: '/old/plugin', targetDir });

      expect(() =>
        stamp({
          templatePath,
          pluginRoot: '/incoming/plugin',
          targetDir,
          beforePublish: () => {
            const transaction = readdirSync(targetDir).find((name) => name.startsWith('.council.genie-txn-'));
            if (transaction === undefined) throw new Error('missing workflow transaction');
            writeFileSync(targetPath, readFileSync(join(targetDir, transaction, 'staged', TARGET_NAME)));
            chmodSync(targetPath, 0o600);
            throw new Error('fail after byte-identical chmod racer');
          },
        }),
      ).toThrow('preserved workflow evidence');

      expect(readFileSync(targetPath, 'utf8')).toContain('/incoming/plugin');
      expect(lstatSync(targetPath).mode & 0o7777).toBe(0o600);
      const conflict = readdirSync(targetDir).find((name) => name.startsWith('.council.genie-conflict-')) as string;
      expect(readFileSync(join(targetDir, conflict, 'before', TARGET_NAME), 'utf8')).toContain('/old/plugin');
      expect(readFileSync(join(targetDir, conflict, 'staged', TARGET_NAME), 'utf8')).toContain('/incoming/plugin');
    }
  });

  test('SessionStart recovery preserves a byte-identical chmod racer plus prior and staged evidence', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'cjs-workflow-recovery-race');
    const targetPath = join(targetDir, TARGET_NAME);
    const manifestPath = join(targetDir, WORKFLOW_MANIFEST_NAME);
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    stampCouncilWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir, now: FIXED_NOW });
    const oldTarget = readFileSync(targetPath);
    const oldManifest = readFileSync(manifestPath);
    stampCouncilWorkflow({ templatePath, pluginRoot: '/incoming/plugin', targetDir, now: FIXED_NOW });
    const incomingTarget = readFileSync(targetPath);
    const incomingManifest = readFileSync(manifestPath);
    const transaction = join(targetDir, '.council.genie-txn-cjs-recovery-race');
    writeFile(join(transaction, 'before', TARGET_NAME), oldTarget.toString());
    writeFile(join(transaction, 'before', WORKFLOW_MANIFEST_NAME), oldManifest.toString());
    writeFile(join(transaction, 'staged', TARGET_NAME), incomingTarget.toString());
    writeFile(join(transaction, 'staged', WORKFLOW_MANIFEST_NAME), incomingManifest.toString());
    writeFile(
      join(transaction, 'journal.json'),
      `${JSON.stringify({
        version: 2,
        targetDigest: createHash('sha256').update(incomingTarget).digest('hex'),
        manifestDigest: createHash('sha256').update(incomingManifest).digest('hex'),
        hadTarget: true,
        hadManifest: true,
        beforeTargetDigest: createHash('sha256').update(oldTarget).digest('hex'),
        beforeManifestDigest: createHash('sha256').update(oldManifest).digest('hex'),
        identityVersion: 2,
        targetMode: 0o644,
        manifestMode: 0o644,
        beforeTargetMode: 0o644,
        beforeManifestMode: 0o644,
      })}\n`,
    );
    chmodSync(targetPath, 0o600);

    expect(() => recoverCjsCouncilTransactions(targetDir)).toThrow('preserved workflow evidence');

    expect(readFileSync(targetPath)).toEqual(incomingTarget);
    expect(lstatSync(targetPath).mode & 0o7777).toBe(0o600);
    const conflict = readdirSync(targetDir).find((name) => name.startsWith('.council.genie-conflict-')) as string;
    expect(readFileSync(join(targetDir, conflict, 'before', TARGET_NAME))).toEqual(oldTarget);
    expect(readFileSync(join(targetDir, conflict, 'staged', TARGET_NAME))).toEqual(incomingTarget);
  });

  test('v1 council removal recovery refuses content-only destructive authority', () => {
    const templatePath = join(fixture.root, 'council.template.js');
    const targetDir = join(fixture.root, 'workflow-v1-removal');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    stampWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir });
    const targetDigest = createHash('sha256')
      .update(readFileSync(join(targetDir, TARGET_NAME)))
      .digest('hex');
    const manifestDigest = createHash('sha256')
      .update(readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME)))
      .digest('hex');
    const transaction = join(targetDir, '.council.genie-delete-v1-reviewer');
    writeFile(join(transaction, 'journal.json'), `${JSON.stringify({ version: 1, targetDigest, manifestDigest })}\n`);
    mkdirSync(join(transaction, 'parked'), { recursive: true });
    renameSync(join(targetDir, TARGET_NAME), join(transaction, 'parked', TARGET_NAME));
    renameSync(join(targetDir, WORKFLOW_MANIFEST_NAME), join(transaction, 'parked', WORKFLOW_MANIFEST_NAME));

    expect(() => recoverManagedWorkflowTransactions(targetDir)).toThrow('lacks physical identity authority');
    const conflict = readdirSync(targetDir).find((name) => name.startsWith('.council.genie-delete-conflict-'));
    expect(conflict).toBeDefined();
    expect(readFileSync(join(targetDir, conflict as string, 'parked', TARGET_NAME), 'utf8')).toContain('/old/plugin');
  });

  test("TypeScript and SessionStart engines recover each other's version-2 council journals", () => {
    const templatePath = join(fixture.root, 'council.template.js');
    writeFileSync(templatePath, TEMPLATE_BODY, 'utf8');
    for (const [name, recover] of [
      ['ts-recovers-cjs', recoverManagedWorkflowTransactions],
      ['cjs-recovers-ts', recoverCjsCouncilTransactions],
    ] as const) {
      const targetDir = join(fixture.root, name);
      stampWorkflow({ templatePath, pluginRoot: '/old/plugin', targetDir, now: FIXED_NOW });
      const oldTarget = readFileSync(join(targetDir, TARGET_NAME));
      const oldManifest = readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME));
      stampWorkflow({ templatePath, pluginRoot: '/new/plugin', targetDir, now: FIXED_NOW });
      const nextTarget = readFileSync(join(targetDir, TARGET_NAME));
      const nextManifest = readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME));
      const transaction = join(targetDir, `.council.genie-txn-cross-${name}`);
      writeFile(join(transaction, 'before', TARGET_NAME), oldTarget.toString());
      writeFile(join(transaction, 'before', WORKFLOW_MANIFEST_NAME), oldManifest.toString());
      writeFile(join(transaction, 'staged', TARGET_NAME), nextTarget.toString());
      writeFile(join(transaction, 'staged', WORKFLOW_MANIFEST_NAME), nextManifest.toString());
      writeFile(
        join(transaction, 'journal.json'),
        `${JSON.stringify({
          version: 2,
          targetDigest: createHash('sha256').update(nextTarget).digest('hex'),
          manifestDigest: createHash('sha256').update(nextManifest).digest('hex'),
          hadTarget: true,
          hadManifest: true,
          beforeTargetDigest: createHash('sha256').update(oldTarget).digest('hex'),
          beforeManifestDigest: createHash('sha256').update(oldManifest).digest('hex'),
        })}\n`,
      );

      recover(targetDir);

      expect(readFileSync(join(targetDir, TARGET_NAME))).toEqual(oldTarget);
      expect(readFileSync(join(targetDir, WORKFLOW_MANIFEST_NAME))).toEqual(oldManifest);
      expect(existsSync(transaction)).toBe(false);
    }
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

  test('an aged, dead-owner steal guard is reaped so a subsequent run proceeds', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const guardPath = `${lockPath}.steal`;
    // A crashed run left both a stale lock and the abandoned steal guard behind.
    writeFile(lockPath, '999999:0123456789abcdef0123456789abcdef:unknown\n');
    writeFile(guardPath, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n');
    const agedSec = (Date.now() - 11 * 60 * 1000) / 1000; // 11 min > 10 min age-out
    utimesSync(lockPath, agedSec, agedSec);
    utimesSync(guardPath, agedSec, agedSec);

    // First contact reaps the aged dead-owner guard but still backs off this run
    // (the guard was contended when observed); the lock is left untouched.
    const first = run();
    expect(first.skipped).toContain('holds the lock');
    expect(existsSync(guardPath)).toBe(false); // abandoned guard reaped

    // With the guard cleared, the next run steals the still-stale lock and syncs.
    const second = run();
    expect(second.skipped).toBeUndefined();
    expect(skillAction(agentReport(second, 'claude'), 'alpha')).toBe('created');
    expect(existsSync(lockPath)).toBe(false); // released after the run
  });

  test('a fresh foreign steal guard is never reaped and the run backs off', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const guardPath = `${lockPath}.steal`;
    writeFile(lockPath, '999999:0123456789abcdef0123456789abcdef:unknown\n');
    const agedSec = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, agedSec, agedSec);
    writeFile(guardPath, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n'); // fresh mtime

    const report = run();

    expect(report.skipped).toContain('holds the lock');
    expect(existsSync(guardPath)).toBe(true); // an in-window guard is a live stealer — untouched
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false); // zero writes
    expect(readFileSync(lockPath, 'utf8')).toContain('999999:'); // stale lock left in place
  });

  test('a future-mtime dead-owner steal guard is reaped (far-future = debris, per ± window)', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const guardPath = `${lockPath}.steal`;
    writeFile(lockPath, '999999:0123456789abcdef0123456789abcdef:unknown\n');
    writeFile(guardPath, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n');
    const agedSec = (Date.now() - 11 * 60 * 1000) / 1000;
    const futureSec = (Date.now() + 11 * 60 * 1000) / 1000; // implausibly far future
    utimesSync(lockPath, agedSec, agedSec);
    utimesSync(guardPath, futureSec, futureSec);

    const first = run();
    expect(first.skipped).toContain('holds the lock');
    expect(existsSync(guardPath)).toBe(false); // future-dated debris reaped

    const second = run();
    expect(second.skipped).toBeUndefined();
    expect(existsSync(lockPath)).toBe(false); // stale lock then stolen + released
  });

  test('a symlinked steal guard is treated as contended and never followed or unlinked', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const guardPath = `${lockPath}.steal`;
    const target = join(fixture.root, 'guard-symlink-target');
    writeFile(lockPath, '999999:0123456789abcdef0123456789abcdef:unknown\n');
    const agedSec = (Date.now() - 11 * 60 * 1000) / 1000;
    utimesSync(lockPath, agedSec, agedSec);
    // Aged, dead-owner target: a symlink-FOLLOWING reap would have unlinked the guard.
    writeFile(target, '999999:abcdefabcdefabcdefabcdefabcdefab:unknown\n');
    utimesSync(target, agedSec, agedSec);
    symlinkSync(target, guardPath);

    const report = run();

    expect(report.skipped).toContain('holds the lock');
    expect(lstatSync(guardPath).isSymbolicLink()).toBe(true); // symlink node left intact
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false); // zero writes
  });

  test('a symlinked lock is treated as contended and never unlinked', () => {
    present(fixture.claudeDir);
    const lockPath = join(fixture.genieHome, LOCK_NAME);
    const target = join(fixture.root, 'lock-symlink-target');
    const agedSec = (Date.now() - 11 * 60 * 1000) / 1000;
    // Aged, dead-owner target: a symlink-following reap would unlink the lock link.
    writeFile(target, '999999:0123456789abcdef0123456789abcdef:unknown\n');
    utimesSync(target, agedSec, agedSec);
    symlinkSync(target, lockPath);

    const report = run();

    expect(report.skipped).toContain('holds the lock'); // never steal a symlinked lock
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true); // symlink node left intact
    expect(existsSync(join(fixture.claudeDir, 'skills'))).toBe(false); // zero writes
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

  test('a child borrows only the exact shell-owned lifecycle lease and never releases it', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    const owner = `${process.pid}:${'a'.repeat(32)}:${'b'.repeat(64)}`;
    writeFile(path, `${owner}\n`);
    process.env[LIFECYCLE_LEASE_PATH_ENV] = path;
    process.env[LIFECYCLE_LEASE_OWNER_ENV] = owner;
    try {
      const borrowed = acquireLifecycleLease(fixture.genieHome);
      expect('skipped' in borrowed).toBe(false);
      if ('skipped' in borrowed) throw new Error(borrowed.skipped);
      borrowed.release();
      expect(readFileSync(path, 'utf8')).toBe(`${owner}\n`);
    } finally {
      delete process.env[LIFECYCLE_LEASE_PATH_ENV];
      delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
      rmSync(path, { force: true });
    }
  });

  test('forged or path-mismatched borrowed lifecycle leases fail closed', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    const owner = `${process.pid}:${'c'.repeat(32)}:${'d'.repeat(64)}`;
    writeFile(path, `${owner}\n`);
    try {
      for (const [borrowedPath, borrowedOwner] of [
        [path, `${process.pid}:${'e'.repeat(32)}:${'d'.repeat(64)}`],
        [`${path}.forged`, owner],
      ]) {
        process.env[LIFECYCLE_LEASE_PATH_ENV] = borrowedPath;
        process.env[LIFECYCLE_LEASE_OWNER_ENV] = borrowedOwner;
        const result = acquireLifecycleLease(fixture.genieHome);
        expect('skipped' in result ? result.skipped : '').toContain('did not exactly match');
        expect(readFileSync(path, 'utf8')).toBe(`${owner}\n`);
      }
    } finally {
      delete process.env[LIFECYCLE_LEASE_PATH_ENV];
      delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
      rmSync(path, { force: true });
    }
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

// ---------------------------------------------------------------------------
// Unwired Codex fallback retirement boundary
// ---------------------------------------------------------------------------

function stampFallback(dir: string, version = 'fixture-v1'): string {
  const digest = computeDirDigest(dir);
  writeFile(
    join(dir, MANIFEST_NAME),
    `${JSON.stringify({
      managedBy: 'genie-agent-sync',
      version,
      digest,
      syncedAt: '2026-07-12T00:00:00.000Z',
      identityVersion: 2,
    })}\n`,
  );
  return digest;
}

function writeFallback(parent: string, name: string, body = `# ${name}\n`): { path: string; digest: string } {
  const path = join(parent, name);
  writeFile(join(path, 'SKILL.md'), body);
  return { path, digest: stampFallback(path) };
}

function verifiedTarget(skillName: string, path: string, physicalDigest: string) {
  return { skillName, path, physicalDigest, canonicalVerified: true as const };
}

function frozenHistoricalSkillsRoot(name: string): string {
  const release = materializeFrozenCodexFallbackRelease(join(fixture.root, name));
  return join(release.payloadRoot, 'skills');
}

describe('Codex fallback ownership planning', () => {
  test('accepts all 23 committed historical name/version/physical tuples', () => {
    const fallback = join(fixture.root, 'historical-fallbacks');
    const shippedSkills = frozenHistoricalSkillsRoot('verified-release-all');
    for (const tuple of historicalCodexFallbackAllowlist) {
      const destination = join(fallback, tuple.skillName);
      cpSync(join(shippedSkills, tuple.skillName), destination, { recursive: true });
      expect(stampFallback(destination, tuple.markerVersion)).toBe(tuple.physicalDigest);
    }

    const plan = planCodexFallbackRetirement({
      fallbackSkillsDir: fallback,
      skillNames: historicalCodexFallbackAllowlist.map((tuple) => tuple.skillName),
    });
    expect(plan.accepted).toHaveLength(23);
    expect(plan.preserved).toEqual([]);
    expect(plan.accepted.every((entry) => entry.ownership === 'historical-tuple')).toBe(true);
  });

  test('historical tuples are exact-content policy; syncedAt is not provenance authority', () => {
    const fallback = join(fixture.root, 'historical-policy');
    const shippedSkills = frozenHistoricalSkillsRoot('verified-release-policy');
    const tuple = historicalCodexFallbackAllowlist[0];
    if (tuple === undefined) throw new Error('missing historical tuple');
    const destination = join(fallback, tuple.skillName);
    cpSync(join(shippedSkills, tuple.skillName), destination, { recursive: true });
    stampFallback(destination, tuple.markerVersion);
    const marker = JSON.parse(readFileSync(join(destination, MANIFEST_NAME), 'utf8')) as Record<string, unknown>;
    marker.syncedAt = 'not-authenticated-provenance';
    writeFile(join(destination, MANIFEST_NAME), `${JSON.stringify(marker)}\n`);

    const plan = planCodexFallbackRetirement({ fallbackSkillsDir: fallback, skillNames: [tuple.skillName] });
    expect(plan.accepted[0]?.ownership).toBe('historical-tuple');
  });

  test('accepts and retires a historical tuple stamped by a later, unlisted release', () => {
    // Fallback seeding stamps `marker.version` to whatever release happens to
    // be installed, not the frozen fixture's markerVersion — a pristine tree
    // seeded by a later, unlisted release (e.g. current stable 5.260713.1)
    // with byte-identical content must still be recognized and retired.
    // markerVersion is provenance metadata, never the ownership proof key.
    const fallback = join(fixture.root, 'historical-version-agnostic');
    const shippedSkills = frozenHistoricalSkillsRoot('verified-release-version-agnostic');
    const tuple = historicalCodexFallbackAllowlist[0];
    if (tuple === undefined) throw new Error('missing historical tuple');
    const destination = join(fallback, tuple.skillName);
    cpSync(join(shippedSkills, tuple.skillName), destination, { recursive: true });
    expect(stampFallback(destination, '5.260713.1')).toBe(tuple.physicalDigest);
    expect(tuple.markerVersion).not.toBe('5.260713.1');

    const plan = planCodexFallbackRetirement({ fallbackSkillsDir: fallback, skillNames: [tuple.skillName] });
    expect(plan.preserved).toEqual([]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.ownership).toBe('historical-tuple');
    expect(plan.accepted[0]?.markerVersion).toBe('5.260713.1');
    expect(plan.accepted[0]?.physicalDigest).toBe(tuple.physicalDigest);

    const result = applyCodexFallbackRetirement(plan);
    expect(result.status).toBe('committed');
    expect(result.retired).toEqual([tuple.skillName]);
    expect(existsSync(destination)).toBe(false);
  });

  test('rejects a symlinked fallback root before planning', () => {
    const physical = join(fixture.root, 'physical-fallback');
    mkdirSync(physical, { recursive: true });
    const alias = join(fixture.root, 'fallback-alias');
    symlinkSync(physical, alias);
    expect(() => planCodexFallbackRetirement({ fallbackSkillsDir: alias, skillNames: [] })).toThrow('symlink-free');
  });

  test('accepts an exact same-skill verified target without historical authority', () => {
    const fallback = join(fixture.root, 'fallback');
    const target = join(fixture.root, 'target', 'new-skill');
    const source = writeFallback(fallback, 'new-skill');
    writeFile(join(target, 'SKILL.md'), '# new-skill\n');
    const targetDigest = computeDirDigest(target);

    const plan = planCodexFallbackRetirement({
      fallbackSkillsDir: fallback,
      skillNames: ['new-skill'],
      verifiedTargets: [verifiedTarget('new-skill', target, targetDigest)],
    });
    expect(plan.accepted).toHaveLength(1);
    expect(plan.accepted[0]?.ownership).toBe('verified-target');
    expect(plan.accepted[0]?.physicalDigest).toBe(source.digest);
  });

  test('preserves renamed/cross-skill, forged tuple, malformed, modified, unmanaged, and symlink inputs', () => {
    const fallback = join(fixture.root, 'negative-fallbacks');
    const shippedSkills = frozenHistoricalSkillsRoot('verified-release-negative');
    const architecture = historicalCodexFallbackAllowlist.find((tuple) => tuple.skillName === 'architecture');
    if (architecture === undefined) throw new Error('missing architecture fixture tuple');

    cpSync(join(shippedSkills, 'architecture'), join(fallback, 'renamed'), { recursive: true });
    stampFallback(join(fallback, 'renamed'), architecture.markerVersion);
    const forged = writeFallback(fallback, 'forged');
    const malformed = writeFallback(fallback, 'malformed');
    writeFile(join(malformed.path, MANIFEST_NAME), '{not-json\n');
    const modified = writeFallback(fallback, 'modified');
    writeFile(join(modified.path, 'SKILL.md'), '# edited\n');
    writeFile(join(fallback, 'unmanaged', 'SKILL.md'), '# unmanaged\n');
    symlinkSync('/definitely/missing', join(fallback, 'dangling'));
    const target = join(fixture.root, 'cross-target', 'renamed');
    cpSync(join(shippedSkills, 'architecture'), target, { recursive: true });
    const before = readFileSync(join(forged.path, MANIFEST_NAME));

    const plan = planCodexFallbackRetirement({
      fallbackSkillsDir: fallback,
      skillNames: ['renamed', 'forged', 'malformed', 'modified', 'unmanaged', 'dangling'],
      verifiedTargets: [verifiedTarget('architecture', target, computeDirDigest(target))],
    });
    expect(plan.accepted).toEqual([]);
    expect(Object.fromEntries(plan.preserved.map((entry) => [entry.skillName, entry.reason]))).toEqual({
      dangling: 'symlink',
      forged: 'ambiguous-ownership',
      malformed: 'malformed-marker',
      modified: 'modified-tree',
      renamed: 'ambiguous-ownership',
      unmanaged: 'malformed-marker',
    });
    expect(readFileSync(join(forged.path, MANIFEST_NAME))).toEqual(before);
    expect(lstatSync(join(fallback, 'dangling')).isSymbolicLink()).toBe(true);
  });

  test('rejects unverified or digest-diverged target payloads', () => {
    const fallback = join(fixture.root, 'fallback');
    const source = writeFallback(fallback, 'alpha');
    const target = join(fixture.root, 'target', 'alpha');
    writeFile(join(target, 'SKILL.md'), '# alpha\n');
    const targetDigest = computeDirDigest(target);
    writeFile(join(target, 'changed'), 'changed\n');
    const unverified = {
      skillName: 'alpha',
      path: target,
      physicalDigest: source.digest,
      canonicalVerified: false,
    } as unknown as ReturnType<typeof verifiedTarget>;

    expect(
      planCodexFallbackRetirement({ fallbackSkillsDir: fallback, skillNames: ['alpha'], verifiedTargets: [unverified] })
        .accepted,
    ).toEqual([]);
    expect(
      planCodexFallbackRetirement({
        fallbackSkillsDir: fallback,
        skillNames: ['alpha'],
        verifiedTargets: [verifiedTarget('alpha', target, targetDigest)],
      }).accepted,
    ).toEqual([]);
  });
});

describe('Codex fallback batch retirement', () => {
  function batchFixture() {
    const fallback = join(fixture.root, 'batch-fallback');
    const targetRoot = join(fixture.root, 'batch-target');
    const alpha = writeFallback(fallback, 'alpha');
    const beta = writeFallback(fallback, 'beta');
    writeFile(join(targetRoot, 'alpha', 'SKILL.md'), '# alpha\n');
    writeFile(join(targetRoot, 'beta', 'SKILL.md'), '# beta\n');
    const targets = [
      verifiedTarget('alpha', join(targetRoot, 'alpha'), computeDirDigest(join(targetRoot, 'alpha'))),
      verifiedTarget('beta', join(targetRoot, 'beta'), computeDirDigest(join(targetRoot, 'beta'))),
    ];
    const plan = planCodexFallbackRetirement({
      fallbackSkillsDir: fallback,
      skillNames: ['alpha', 'beta'],
      verifiedTargets: targets,
    });
    return { fallback, alpha, beta, plan };
  }

  test('rejects caller-mutated outside sources before any mutation', () => {
    const { alpha, plan } = batchFixture();
    const outside = writeFallback(join(fixture.root, 'outside'), 'alpha');
    plan.accepted[0]!.source = outside.path;
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('unconfined');
    expect(computeDirDigest(alpha.path)).toBe(alpha.digest);
    expect(computeDirDigest(outside.path)).toBe(outside.digest);
  });

  test('rejects a symlinked hidden transaction root without escaping', () => {
    const { alpha, plan } = batchFixture();
    const outside = join(fixture.root, 'outside-transactions');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(plan.fallbackSkillsDir, '.genie-codex-fallback-retirement'));
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('canonical physical directory');
    expect(readdirSync(outside)).toEqual([]);
    expect(computeDirDigest(alpha.path)).toBe(alpha.digest);
  });

  test('rejects a quarantine replaced by a symlink with zero outside writes or moves', () => {
    const { alpha, plan } = batchFixture();
    const outside = join(fixture.root, 'outside-quarantine');
    mkdirSync(outside, { recursive: true });
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point !== 'after-journal-durable') return;
          const quarantine = join(
            plan.fallbackSkillsDir,
            '.genie-codex-fallback-retirement',
            `txn-${plan.transactionId}`,
            'quarantine',
          );
          rmSync(quarantine, { recursive: true });
          symlinkSync(outside, quarantine);
        },
      }),
    ).toThrow('canonical physical directory');
    expect(readdirSync(outside)).toEqual([]);
    expect(computeDirDigest(alpha.path)).toBe(alpha.digest);
  });

  test('rejects an unconstrained journal destination before recovery mutation', () => {
    const { alpha, plan } = batchFixture();
    let stopped = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (!stopped && point === 'after-journal-durable') {
            stopped = true;
            throw new Error('stop prepared');
          }
        },
      }),
    ).toThrow('stop prepared');
    const journalPath = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
      'journal.json',
    );
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ destination: string }> };
    journal.entries[0]!.destination = join(fixture.root, 'outside-quarantine');
    writeFile(journalPath, `${JSON.stringify(journal)}\n`);
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('unconfined');
    expect(computeDirDigest(alpha.path)).toBe(alpha.digest);
  });

  for (const failpoint of [
    'after-journal-temp-create',
    'before-journal-rename',
    'after-journal-rename',
    'before-move:0',
    'after-move-filesystem:0',
    'before-destination-verification:0',
    'after-commit-journal',
  ] as const) {
    test(`retry restores or commits after persisted crash shape ${failpoint}`, () => {
      const { plan } = batchFixture();
      let stopped = false;
      expect(() =>
        applyCodexFallbackRetirement(plan, {
          failpoint: (point) => {
            if (!stopped && point === failpoint) {
              stopped = true;
              throw new Error(`crash ${point}`);
            }
            if (stopped && point === 'before-restore:0') throw new Error('crash recovery');
          },
        }),
      ).toThrow();
      expect(['committed', 'already-committed']).toContain(applyCodexFallbackRetirement(plan).status);
    });
  }

  test('a personal edit at before-move is re-identified and remains live', () => {
    const { alpha, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'before-move:0') writeFile(join(alpha.path, 'USER.txt'), 'personal before move\n');
        },
      }),
    ).toThrow('source changed at move boundary');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('personal before move\n');
    const quarantine = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
      'quarantine',
      'alpha',
    );
    expect(existsSync(quarantine)).toBe(false);
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('source changed after planning');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('personal before move\n');
  });

  test('a personal edit in the final check/rename race is republished from quarantine', () => {
    const { alpha, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'personal in rename race\n');
          }
        },
      }),
    ).toThrow('destination verification failed');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('personal in rename race\n');
    const transactionDir = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
    );
    expect(existsSync(join(transactionDir, 'quarantine', 'alpha'))).toBe(false);
    const journal = JSON.parse(readFileSync(join(transactionDir, 'journal.json'), 'utf8')) as {
      phase: string;
      entries: Array<{ phase: string; observedTreeDigest?: string }>;
    };
    expect(journal.phase).toBe('restored');
    expect(journal.entries[0]?.phase).toBe('restored');
    expect(journal.entries[0]?.observedTreeDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  for (const restoreFailpoint of [
    'after-restore-observation:0',
    'after-restore-staging-create:0',
    'after-restore-copy:0:0',
    'after-restore-verification:0',
    'after-restore-sync:0',
    'before-restore-publication:0',
    'after-restore-publication:0',
    'after-restore-filesystem:0',
    'before-restore-cleanup:0',
  ] as const) {
    test(`changed-content republication recovers after ${restoreFailpoint}`, () => {
      const { alpha, plan } = batchFixture();
      let changedMovedTree = false;
      let interrupted = false;
      expect(() =>
        applyCodexFallbackRetirement(plan, {
          failpoint: (point) => {
            if (point === 'after-move-boundary-identification:0') {
              writeFile(join(alpha.path, 'USER.txt'), `personal ${restoreFailpoint}\n`);
              changedMovedTree = true;
            }
            if (changedMovedTree && !interrupted && point === restoreFailpoint) {
              interrupted = true;
              throw new Error(`interrupt ${point}`);
            }
          },
        }),
      ).toThrow('fallback retirement restore failed');
      expect(() => applyCodexFallbackRetirement(plan)).toThrow('source changed after planning');
      expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe(`personal ${restoreFailpoint}\n`);
      const quarantine = join(
        plan.fallbackSkillsDir,
        '.genie-codex-fallback-retirement',
        `txn-${plan.transactionId}`,
        'quarantine',
        'alpha',
      );
      expect(existsSync(quarantine)).toBe(false);
    });
  }

  test('a stop immediately after atomic changed-tree publication leaves two complete retryable copies', () => {
    const { alpha, plan } = batchFixture();
    let movedTreeChanged = false;
    let interrupted = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'atomic publication content\n');
            movedTreeChanged = true;
          }
          if (movedTreeChanged && !interrupted && point === 'after-restore-publication:0') {
            interrupted = true;
            throw new Error('stop after atomic publication');
          }
        },
      }),
    ).toThrow('fallback retirement restore failed');
    const quarantine = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
      'quarantine',
      'alpha',
    );
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('atomic publication content\n');
    expect(readFileSync(join(quarantine, 'USER.txt'), 'utf8')).toBe('atomic publication content\n');
    expect(computeDirDigest(alpha.path)).toBe(computeDirDigest(quarantine));
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('source changed after planning');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('atomic publication content\n');
    expect(existsSync(quarantine)).toBe(false);
  });

  test('a replacement at changed-tree cleanup keeps the intact quarantine and reports a recoverable conflict', () => {
    const { alpha, plan } = batchFixture();
    let movedTreeChanged = false;
    let replaced = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'quarantined user content\n');
            movedTreeChanged = true;
          }
          if (movedTreeChanged && !replaced && point === 'before-restore-cleanup:0') {
            replaced = true;
            rmSync(alpha.path, { recursive: true });
            writeFile(join(alpha.path, 'REPLACEMENT.txt'), 'concurrent replacement\n');
          }
        },
      }),
    ).toThrow('restored source changed during cleanup');
    const quarantine = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
      'quarantine',
      'alpha',
    );
    expect(readFileSync(join(alpha.path, 'REPLACEMENT.txt'), 'utf8')).toBe('concurrent replacement\n');
    expect(readFileSync(join(quarantine, 'USER.txt'), 'utf8')).toBe('quarantined user content\n');
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('both trees retained with recoverable status');
    expect(readFileSync(join(quarantine, 'USER.txt'), 'utf8')).toBe('quarantined user content\n');
  });

  test('a removal at changed-tree cleanup keeps quarantine intact and retry republishes atomically', () => {
    const { alpha, plan } = batchFixture();
    let movedTreeChanged = false;
    let removed = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'removed publication content\n');
            movedTreeChanged = true;
          }
          if (movedTreeChanged && !removed && point === 'before-restore-cleanup:0') {
            removed = true;
            rmSync(alpha.path, { recursive: true });
          }
        },
      }),
    ).toThrow('intact quarantine retained with recoverable status');
    const quarantine = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
      'quarantine',
      'alpha',
    );
    expect(existsSync(alpha.path)).toBe(false);
    expect(readFileSync(join(quarantine, 'USER.txt'), 'utf8')).toBe('removed publication content\n');
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('source changed after planning');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('removed publication content\n');
    expect(existsSync(quarantine)).toBe(false);
  });

  test('a changed quarantine and live publication conflict are both retained with recoverable status', () => {
    const { alpha, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'changed quarantine\n');
          }
          if (point === 'before-restore-publication:0') {
            writeFile(join(alpha.path, 'CONFLICT.txt'), 'live conflict\n');
          }
        },
      }),
    ).toThrow('both trees retained with recoverable status');
    expect(readFileSync(join(alpha.path, 'CONFLICT.txt'), 'utf8')).toBe('live conflict\n');
    const transactionDir = join(
      plan.fallbackSkillsDir,
      '.genie-codex-fallback-retirement',
      `txn-${plan.transactionId}`,
    );
    expect(readFileSync(join(transactionDir, 'quarantine', 'alpha', 'USER.txt'), 'utf8')).toBe('changed quarantine\n');
    const journal = JSON.parse(readFileSync(join(transactionDir, 'journal.json'), 'utf8')) as {
      phase: string;
      entries: Array<{ phase: string; observedTreeDigest?: string }>;
    };
    expect(journal.phase).toBe('restore-conflict');
    expect(journal.entries[0]?.phase).toBe('restore-conflict');
    expect(journal.entries[0]?.observedTreeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('both trees retained with recoverable status');
    expect(readFileSync(join(alpha.path, 'CONFLICT.txt'), 'utf8')).toBe('live conflict\n');
    expect(readFileSync(join(transactionDir, 'quarantine', 'alpha', 'USER.txt'), 'utf8')).toBe('changed quarantine\n');
  });

  test('retry reconciles a crash after restore rename but before restored phase persistence', () => {
    const { plan } = batchFixture();
    let moved = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (!moved && point === 'after-move-filesystem:0') {
            moved = true;
            throw new Error('crash move');
          }
          if (moved && point === 'after-restore-filesystem:0') throw new Error('crash restore');
        },
      }),
    ).toThrow('fallback retirement restore failed');
    expect(applyCodexFallbackRetirement(plan).status).toBe('committed');
  });

  for (const failpoint of [
    'after-journal-durable',
    'after-move:0',
    'after-move:1',
    'after-verification:0',
    'after-verification:1',
    'before-commit',
  ] as const) {
    test(`restores the complete batch in reverse after ${failpoint}`, () => {
      const { alpha, beta, plan } = batchFixture();
      expect(() =>
        applyCodexFallbackRetirement(plan, {
          failpoint: (point) => {
            if (point === failpoint) throw new Error(`stop at ${point}`);
          },
        }),
      ).toThrow(`stop at ${failpoint}`);
      expect(computeDirDigest(alpha.path)).toBe(alpha.digest);
      expect(computeDirDigest(beta.path)).toBe(beta.digest);
      expect(applyCodexFallbackRetirement(plan).status).toBe('committed');
    });
  }

  for (const restoreFailpoint of ['after-restore:1', 'after-restore:0'] as const) {
    test(`${restoreFailpoint} leaves the same transaction recoverable`, () => {
      const { alpha, beta, plan } = batchFixture();
      let primaryThrown = false;
      expect(() =>
        applyCodexFallbackRetirement(plan, {
          failpoint: (point) => {
            if (point === 'after-move:1') primaryThrown = true;
            if (point === 'after-move:1' || (primaryThrown && point === restoreFailpoint)) {
              throw new Error(`stop ${point}`);
            }
          },
        }),
      ).toThrow('fallback retirement restore failed');
      expect(applyCodexFallbackRetirement(plan).status).toBe('committed');
      expect(existsSync(alpha.path)).toBe(false);
      expect(existsSync(beta.path)).toBe(false);
    });
  }

  for (const restoreFailpoint of [
    'after-restore-staging-create:0',
    'after-restore-copy:0:0',
    'after-restore-verification:0',
    'after-restore-sync:0',
    'before-restore-publication:0',
    'after-restore-publication:0',
    'after-restore-filesystem:0',
    'before-restore-cleanup:0',
  ] as const) {
    test(`interrupted staged restoration is recoverable at ${restoreFailpoint}`, () => {
      const { plan } = batchFixture();
      let restoring = false;
      expect(() =>
        applyCodexFallbackRetirement(plan, {
          failpoint: (point) => {
            if (point === 'after-move:0') {
              restoring = true;
              throw new Error('start recovery');
            }
            if (restoring && point === restoreFailpoint) throw new Error(`stop ${point}`);
          },
        }),
      ).toThrow('fallback retirement restore failed');
      expect(applyCodexFallbackRetirement(plan).status).toBe('committed');
    });
  }

  test('a restore conflict preserves both the live conflict and recoverable quarantine', () => {
    const { alpha, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'racing user bytes\n');
            throw new Error('inject restore conflict');
          }
        },
      }),
    ).toThrow('restore conflict');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('racing user bytes\n');
    expect(
      existsSync(join(plan.fallbackSkillsDir, '.genie-codex-fallback-retirement', `txn-${plan.transactionId}`)),
    ).toBe(true);
  });

  test('a conflict created at staged restore publication is never clobbered', () => {
    const { alpha, plan } = batchFixture();
    let restoring = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move:0') {
            restoring = true;
            throw new Error('start recovery');
          }
          if (restoring && point === 'before-restore-publication:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'publication racer\n');
          }
        },
      }),
    ).toThrow('restore conflict');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('publication racer\n');
    expect(existsSync(join(plan.fallbackSkillsDir, '.genie-codex-fallback-retirement'))).toBe(true);
  });

  test('atomic restore publication does not replace a concurrently created empty directory', () => {
    const { alpha, plan } = batchFixture();
    let restoring = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move:0') {
            restoring = true;
            throw new Error('start recovery');
          }
          if (restoring && point === 'before-restore-publication:0') mkdirSync(alpha.path);
        },
      }),
    ).toThrow('restore conflict');
    expect(readdirSync(alpha.path)).toEqual([]);
    expect(
      existsSync(
        join(
          plan.fallbackSkillsDir,
          '.genie-codex-fallback-retirement',
          `txn-${plan.transactionId}`,
          'quarantine',
          'alpha',
        ),
      ),
    ).toBe(true);
  });

  test('commits only after destination verification and retry retains one transaction', () => {
    const { fallback, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-commit-durable') throw new Error('crash after commit');
        },
      }),
    ).toThrow('crash after commit');
    const retry = applyCodexFallbackRetirement(plan);
    expect(retry.status).toBe('already-committed');
    expect(readdirSync(join(fallback, '.genie-codex-fallback-retirement'))).toEqual([`txn-${plan.transactionId}`]);
    expect(existsSync(join(retry.transactionDir, 'journal.json'))).toBe(true);
    expect(readdirSync(join(retry.transactionDir, 'quarantine')).sort()).toEqual(['alpha', 'beta']);
  });

  test('an exact managed resurrection is retired into one distinct committed generation', () => {
    const { fallback, plan } = batchFixture();
    const first = applyCodexFallbackRetirement(plan);
    cpSync(join(first.transactionDir, 'quarantine', 'alpha'), join(fallback, 'alpha'), { recursive: true });
    const second = applyCodexFallbackRetirement(plan);
    expect(second.status).toBe('committed');
    expect(second.transactionId).not.toBe(first.transactionId);
    expect(existsSync(join(fallback, 'alpha'))).toBe(false);
    const transactions = readdirSync(join(fallback, '.genie-codex-fallback-retirement')).sort();
    expect(transactions).toHaveLength(2);
    expect(applyCodexFallbackRetirement(plan).status).toBe('already-committed');
    expect(readdirSync(join(fallback, '.genie-codex-fallback-retirement')).sort()).toEqual(transactions);
  });

  test('a modified or personal resurrection is preserved without creating a generation', () => {
    const { fallback, plan } = batchFixture();
    const first = applyCodexFallbackRetirement(plan);
    cpSync(join(first.transactionDir, 'quarantine', 'alpha'), join(fallback, 'alpha'), { recursive: true });
    writeFile(join(fallback, 'alpha', 'USER.txt'), 'personal\n');
    expect(applyCodexFallbackRetirement(plan).status).toBe('already-committed');
    expect(readFileSync(join(fallback, 'alpha', 'USER.txt'), 'utf8')).toBe('personal\n');
    expect(readdirSync(join(fallback, '.genie-codex-fallback-retirement'))).toHaveLength(1);
  });

  test('active sync remains unwired and preserves the dangling legacy symlink behavior', () => {
    present(fixture.codexDir);
    const dangling = join(fixture.agentsSkillsDir, 'alpha');
    mkdirSync(dirname(dangling), { recursive: true });
    symlinkSync('/definitely/missing', dangling);
    const report = agentReport(run(), 'codex');
    expect(skillAction(report, 'alpha')).toBe('skipped-unmanaged-kept');
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(existsSync(join(fixture.agentsSkillsDir, '.genie-codex-fallback-retirement'))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Group A recovery gaps (G1 final-copy safety, G2 serialization, G3 discovery)
  // ---------------------------------------------------------------------------

  const RETIREMENT_ROOT = CODEX_FALLBACK_RETIREMENT_ROOT;

  function retirementRunnerPath(): string {
    const runnerPath = join(fixture.root, 'retire-runner.ts');
    writeFileSync(
      runnerPath,
      [
        "import { existsSync, readFileSync } from 'node:fs';",
        `import { applyCodexFallbackRetirement, recoverCodexFallbackRetirements } from ${JSON.stringify(
          join(import.meta.dir, 'agent-sync.ts'),
        )};`,
        'const goFile = process.env.RETIRE_GO_FILE;',
        'if (goFile) { while (!existsSync(goFile)) Bun.sleepSync(2); }',
        'try {',
        "  if (process.env.RETIRE_MODE === 'recover') {",
        '    const results = recoverCodexFallbackRetirements(process.env.RETIRE_FALLBACK as string);',
        '    process.stdout.write(JSON.stringify({ ok: true, results }));',
        '  } else {',
        "    const plan = JSON.parse(readFileSync(process.env.RETIRE_PLAN as string, 'utf8'));",
        '    const result = applyCodexFallbackRetirement(plan);',
        '    process.stdout.write(JSON.stringify({ ok: true, status: result.status, transactionId: result.transactionId }));',
        '  }',
        '} catch (e) {',
        '  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    return runnerPath;
  }

  interface RetireRunnerResult {
    ok: boolean;
    status?: string;
    transactionId?: string;
    error?: string;
    results?: Array<{ status: string; transactionId: string }>;
  }

  async function spawnRetire(runnerPath: string, env: Record<string, string>): Promise<RetireRunnerResult> {
    const proc = Bun.spawn(['bun', runnerPath], {
      env: { ...process.env, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return JSON.parse(out || '{"ok":false,"error":"no runner output"}') as RetireRunnerResult;
  }

  test('G1: a source deleted in the disposal window archives the changed copy as evidence — never zero copies', () => {
    const { alpha, plan } = batchFixture();
    let changed = false;
    let deleted = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'changed final copy\n');
            changed = true;
          }
          if (changed && !deleted && point === 'before-quarantine-disposal:0') {
            deleted = true;
            rmSync(alpha.path, { recursive: true }); // delete the only live copy inside the disposal window
          }
        },
      }),
    ).toThrow('changed evidence retained');
    const txnDir = join(plan.fallbackSkillsDir, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    const evidence = join(txnDir, 'evidence', 'alpha');
    // An intact changed copy survived — the quarantine copy was MOVED aside, never recursive-deleted.
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(join(evidence, 'USER.txt'), 'utf8')).toBe('changed final copy\n');
    expect(readFileSync(join(evidence, 'SKILL.md'), 'utf8')).toBe('# alpha\n');
    expect(existsSync(join(txnDir, 'quarantine', 'alpha'))).toBe(false);
    const journal = JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')) as {
      entries: Array<{ evidence?: string; observedTreeDigest?: string }>;
    };
    expect(journal.entries[0]?.evidence).toBe('alpha');
    expect(journal.entries[0]?.observedTreeDigest).toMatch(/^[a-f0-9]{64}$/);
    // A subsequent attempt is a recoverable conflict, never the catastrophic throw.
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('changed evidence retained');
    expect(() => applyCodexFallbackRetirement(plan)).not.toThrow('neither live nor quarantined');
    expect(existsSync(evidence)).toBe(true);
  });

  test('G1 cross-process: a source deleted by another process during disposal keeps the changed evidence copy', async () => {
    const { alpha, plan } = batchFixture();
    const planPath = join(fixture.root, 'race-plan.json');
    writeFile(planPath, JSON.stringify(plan));
    const readyFile = join(fixture.root, 'race-ready');
    const goFile = join(fixture.root, 'race-go');
    const runnerPath = join(fixture.root, 'disposal-race-runner.ts');
    writeFileSync(
      runnerPath,
      [
        "import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        `import { applyCodexFallbackRetirement } from ${JSON.stringify(join(import.meta.dir, 'agent-sync.ts'))};`,
        'const plan = JSON.parse(readFileSync(process.env.RACE_PLAN as string, "utf8"));',
        'const readyFile = process.env.RACE_READY as string;',
        'const goFile = process.env.RACE_GO as string;',
        'const userPath = process.env.RACE_USER_PATH as string;',
        'try {',
        '  applyCodexFallbackRetirement(plan, { failpoint: (point) => {',
        "    if (point === 'after-move-boundary-identification:0') {",
        '      mkdirSync(dirname(userPath), { recursive: true });',
        "      writeFileSync(userPath, 'cross-process changed\\n');",
        '    }',
        "    if (point === 'before-quarantine-disposal:0') {",
        "      writeFileSync(readyFile, 'ready\\n');",
        '      while (!existsSync(goFile)) Bun.sleepSync(2);',
        '    }',
        '  }});',
        '  process.stdout.write(JSON.stringify({ ok: true }));',
        '} catch (e) {',
        '  process.stdout.write(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    const proc = Bun.spawn(['bun', runnerPath], {
      env: {
        ...process.env,
        RACE_PLAN: planPath,
        RACE_READY: readyFile,
        RACE_GO: goFile,
        RACE_USER_PATH: join(alpha.path, 'USER.txt'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(readyFile) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(readyFile)).toBe(true);
    rmSync(alpha.path, { recursive: true, force: true }); // another process deletes the live source mid-disposal
    writeFile(goFile, 'go\n');
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    const result = JSON.parse(out || '{"ok":false}') as RetireRunnerResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed evidence retained');
    const txnDir = join(plan.fallbackSkillsDir, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    const evidence = join(txnDir, 'evidence', 'alpha');
    expect(existsSync(evidence)).toBe(true);
    expect(readFileSync(join(evidence, 'USER.txt'), 'utf8')).toBe('cross-process changed\n');
    expect(existsSync(join(txnDir, 'quarantine', 'alpha'))).toBe(false);
  }, 25_000);

  test('G2: N concurrent same-plan retirements commit exactly once and never revoke a returned commit', async () => {
    const { fallback, plan } = batchFixture();
    const planPath = join(fixture.root, 'race-plan.json');
    writeFile(planPath, JSON.stringify(plan));
    const runnerPath = retirementRunnerPath();
    const goFile = join(fixture.root, 'nway-go');
    const N = 4;
    const pending = Array.from({ length: N }, () =>
      spawnRetire(runnerPath, { RETIRE_PLAN: planPath, RETIRE_GO_FILE: goFile }),
    );
    await Bun.sleep(200); // let every runner park on the go-file barrier
    writeFile(goFile, 'go\n');
    const results = await Promise.all(pending);
    for (const r of results) expect(r.ok).toBe(true);
    const committed = results.filter((r) => r.status === 'committed');
    const already = results.filter((r) => r.status === 'already-committed');
    expect(committed).toHaveLength(1); // exactly one authoritative commit under N-way concurrency
    expect(already).toHaveLength(N - 1);
    const txnDir = join(fallback, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    const journal = JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')) as { phase: string };
    expect(journal.phase).toBe('committed'); // terminal, never rewritten to a pre-commit phase
    expect(existsSync(join(fallback, 'alpha'))).toBe(false);
    expect(existsSync(join(fallback, 'beta'))).toBe(false);
    expect(readdirSync(join(txnDir, 'quarantine')).sort()).toEqual(['alpha', 'beta']);
    expect(existsSync(join(fallback, RETIREMENT_ROOT, '.retirement.lock'))).toBe(false); // released in finally
  }, 30_000);

  test('G2: a reentrant retirement while the lock is held fails closed without corrupting the journal', () => {
    const { plan } = batchFixture();
    const prev = process.env.GENIE_RETIREMENT_LOCK_WAIT_MS;
    process.env.GENIE_RETIREMENT_LOCK_WAIT_MS = '150'; // bounded deadline so the reentrant attempt fails fast
    let reentered = false;
    let reentrantError = '';
    try {
      const result = applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'before-journal-rename' && !reentered) {
            reentered = true;
            try {
              applyCodexFallbackRetirement(plan); // same process already holds the lock → contended
            } catch (e) {
              reentrantError = e instanceof Error ? e.message : String(e);
            }
          }
        },
      });
      expect(result.status).toBe('committed');
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'GENIE_RETIREMENT_LOCK_WAIT_MS');
      else process.env.GENIE_RETIREMENT_LOCK_WAIT_MS = prev;
    }
    expect(reentered).toBe(true);
    expect(reentrantError).toContain('lock contended');
    expect(reentrantError).toContain('no data changed');
    const txnDir = join(plan.fallbackSkillsDir, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    const journal = JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')) as { phase: string };
    expect(journal.phase).toBe('committed'); // the contended reentrant call never rewrote the durable journal
  });

  test('G3: recovery discovers and converges an unfinished transaction that replanning cannot rediscover', () => {
    const { alpha, beta, fallback, plan } = batchFixture();
    // Crash after both moves and abort the restore, leaving both trees quarantined.
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move:1') throw new Error('hard crash after moves');
          if (point === 'before-restore:1') throw new Error('restore aborted');
        },
      }),
    ).toThrow('fallback retirement restore failed');
    const txnDir = join(fallback, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    expect(existsSync(join(txnDir, 'quarantine', 'alpha'))).toBe(true);
    expect(existsSync(join(txnDir, 'quarantine', 'beta'))).toBe(true);
    expect(existsSync(alpha.path)).toBe(false);
    expect(existsSync(beta.path)).toBe(false);
    // A fresh replan from live paths is blind — sources are gone, so it hashes an empty batch.
    const blind = planCodexFallbackRetirement({ fallbackSkillsDir: fallback, skillNames: ['alpha', 'beta'] });
    expect(blind.accepted).toHaveLength(0);
    expect(blind.transactionId).not.toBe(plan.transactionId);
    // Store-enumerating recovery reconstructs the plan from the journal alone and converges it.
    const results = recoverCodexFallbackRetirements(fallback);
    expect(results).toHaveLength(1);
    expect(['committed', 'already-committed']).toContain(results[0]!.status);
    const journal = JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')) as { phase: string };
    expect(['committed', 'restored']).toContain(journal.phase);
  });

  test('G3 real-process: a bare runner that knows only the fallback dir recovers a quarantined crash', async () => {
    const { alpha, beta, fallback, plan } = batchFixture();
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move:1') throw new Error('hard crash after moves');
          if (point === 'before-restore:1') throw new Error('restore aborted');
        },
      }),
    ).toThrow('fallback retirement restore failed');
    expect(existsSync(alpha.path)).toBe(false);
    expect(existsSync(beta.path)).toBe(false);
    const runnerPath = retirementRunnerPath();
    const result = await spawnRetire(runnerPath, { RETIRE_MODE: 'recover', RETIRE_FALLBACK: fallback });
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(['committed', 'already-committed']).toContain(result.results![0]!.status);
    const txnDir = join(fallback, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    const journal = JSON.parse(readFileSync(join(txnDir, 'journal.json'), 'utf8')) as { phase: string };
    expect(['committed', 'restored']).toContain(journal.phase);
  }, 20_000);

  test('G3: recovery finishes a committed base generation and isolates a corrupt sibling transaction', () => {
    const { fallback, plan } = batchFixture();
    const first = applyCodexFallbackRetirement(plan);
    expect(first.status).toBe('committed');
    // Resurrect alpha exactly (managed) so the committed base owes a generation.
    cpSync(join(first.transactionDir, 'quarantine', 'alpha'), join(fallback, 'alpha'), { recursive: true });
    // A corrupt sibling transaction (valid txn name, unreadable journal, non-empty quarantine) must not sink the sweep.
    const corruptId = 'd'.repeat(32);
    const corruptDir = join(fallback, RETIREMENT_ROOT, `txn-${corruptId}`);
    writeFile(join(corruptDir, 'quarantine', 'ghost', 'SKILL.md'), '# ghost\n');
    writeFile(join(corruptDir, 'journal.json'), 'not valid json {{{');
    expect(() => recoverCodexFallbackRetirements(fallback)).toThrow(`txn-${corruptId}`);
    // Despite the corrupt sibling, the committed base still produced a distinct committed generation.
    expect(existsSync(join(fallback, 'alpha'))).toBe(false);
    const txns = readdirSync(join(fallback, RETIREMENT_ROOT))
      .filter((n) => n.startsWith('txn-'))
      .sort();
    expect(txns).toHaveLength(3); // base, generation, corrupt sibling all retained
    expect(txns).toContain(`txn-${plan.transactionId}`);
    expect(txns).toContain(`txn-${corruptId}`);
  });

  test('G1/G5 integration: a changed-tree restore keeps both the republished tree and its archived evidence copy', () => {
    const { alpha, plan } = batchFixture();
    let changed = false;
    let interrupted = false;
    expect(() =>
      applyCodexFallbackRetirement(plan, {
        failpoint: (point) => {
          if (point === 'after-move-boundary-identification:0') {
            writeFile(join(alpha.path, 'USER.txt'), 'integration content\n');
            changed = true;
          }
          if (changed && !interrupted && point === 'after-quarantine-disposal:0') {
            interrupted = true;
            throw new Error('stop immediately after atomic archive');
          }
        },
      }),
    ).toThrow('fallback retirement restore failed');
    const txnDir = join(plan.fallbackSkillsDir, RETIREMENT_ROOT, `txn-${plan.transactionId}`);
    // The atomically republished live tree AND the archived evidence copy both survive the interruption.
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('integration content\n');
    expect(readFileSync(join(txnDir, 'evidence', 'alpha', 'USER.txt'), 'utf8')).toBe('integration content\n');
    expect(existsSync(join(txnDir, 'quarantine', 'alpha'))).toBe(false);
    // Retry converges to a terminal state without ever losing the changed bytes.
    expect(() => applyCodexFallbackRetirement(plan)).toThrow('source changed after planning');
    expect(readFileSync(join(alpha.path, 'USER.txt'), 'utf8')).toBe('integration content\n');
  });
});

describe('Codex fallback allowlist generator', () => {
  test('requires a canonically verified complete release skills digest', () => {
    const payloadRoot = join(fixture.root, 'release');
    writeFile(join(payloadRoot, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    const skillsDigest = computeDirDigest(join(payloadRoot, 'skills'));
    expect(() =>
      generateCodexFallbackAllowlist({
        payloadRoot,
        markerVersion: 'release-v1',
        verifiedSkillsDigest: skillsDigest,
        canonicalVerified: false,
      } as unknown as Parameters<typeof generateCodexFallbackAllowlist>[0]),
    ).toThrow('release payload is not canonically verified');
    expect(() =>
      generateCodexFallbackAllowlist({
        payloadRoot,
        markerVersion: 'release-v1',
        verifiedSkillsDigest: '0'.repeat(64),
        canonicalVerified: true,
      }),
    ).toThrow('verified release payload digest mismatch');
    expect(
      generateCodexFallbackAllowlist({
        payloadRoot,
        markerVersion: 'release-v1',
        verifiedSkillsDigest: skillsDigest,
        canonicalVerified: true,
      }),
    ).toEqual([
      {
        markerVersion: 'release-v1',
        skillName: 'alpha',
        physicalDigest: computeDirDigest(join(payloadRoot, 'skills', 'alpha')),
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// G4 short-write loop + G5 musl-safe no-clobber directory publish primitives
// ---------------------------------------------------------------------------

describe('writeAllSync short-write loop (G4)', () => {
  test('completes a whole buffer across a partial write then a full write', () => {
    const path = join(fixture.root, 'writeall-target');
    const buffer = Buffer.from('the quick brown fox jumps over the lazy dog\n');
    let calls = 0;
    const partialOnce: typeof writeSync = ((fd: number, buf: Buffer, offset: number, length: number) => {
      calls += 1;
      const chunk = calls === 1 ? Math.min(4, length) : length; // short write on the first call only
      return writeSync(fd, buf, offset, chunk);
    }) as typeof writeSync;
    const fd = openSync(path, 'w');
    try {
      writeAllSync(fd, buffer, partialOnce);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path)).toEqual(buffer); // every byte landed despite the short write
    expect(calls).toBeGreaterThanOrEqual(2); // the loop advanced the offset and finished the tail
  });

  test('a writer that never makes progress raises rather than looping forever', () => {
    const zeroWriter: typeof writeSync = (() => 0) as typeof writeSync;
    expect(() => writeAllSync(1, Buffer.from('x'), zeroWriter)).toThrow('made no progress');
  });
});

describe('no-clobber directory publish (G5 musl portability)', () => {
  function stagedTree(name: string, body = `# ${name}\n`): string {
    const dir = join(fixture.root, name);
    writeFile(join(dir, 'SKILL.md'), body);
    return dir;
  }

  function bufPath(b: Buffer): string {
    return b.toString('utf8').replace(/\0$/, '');
  }

  // A JS stand-in for renameat2(RENAME_NOREPLACE): refuse when the target exists.
  const noReplaceRenamer = (s: Buffer, t: Buffer): number => {
    const target = bufPath(t);
    if (existsSync(target)) return -1;
    renameSync(bufPath(s), target);
    return 0;
  };

  test('resolveLinuxRenameat2 tries candidate sonames in order and returns the first that resolves', () => {
    const attempted: string[] = [];
    const opener = (soname: string) => {
      attempted.push(soname);
      return soname === 'good.so' ? noReplaceRenamer : null;
    };
    const resolved = resolveLinuxRenameat2(opener, ['bad-1.so', 'good.so', 'never-reached.so']);
    expect(resolved).toBe(noReplaceRenamer);
    expect(attempted).toEqual(['bad-1.so', 'good.so']); // stops at the first success
  });

  test('a resolved renameat2 publishes atomically onto an absent target and rejects an existing one', () => {
    const staged = stagedTree('rn-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'rn-target');
    atomicRenameDirectoryNoClobber(staged, target, { opener: () => noReplaceRenamer, probe: {} });
    expect(computeDirDigest(target)).toBe(digest);
    const staged2 = stagedTree('rn-src2');
    expect(() =>
      atomicRenameDirectoryNoClobber(staged2, target, { opener: () => noReplaceRenamer, probe: {} }),
    ).toThrow('target preserved');
    expect(computeDirDigest(target)).toBe(digest); // pre-existing target bytes untouched
  });

  test('with no libc renameat2 available, the portable name-claim publishes onto an absent target', () => {
    const staged = stagedTree('portable-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'portable-target'); // absent
    atomicRenameDirectoryNoClobber(staged, target, { opener: () => null, probe: {} });
    expect(computeDirDigest(target)).toBe(digest); // mkdir-claim + rename-onto-empty reproduces the tree
  });

  test('with no libc renameat2 available, a non-empty target is preserved and NoClobberPublishError is raised', () => {
    const staged = stagedTree('portable-src2');
    const target = join(fixture.root, 'portable-target2');
    writeFile(join(target, 'EXISTING.txt'), 'user bytes\n');
    const before = computeDirDigest(target);
    expect(() => atomicRenameDirectoryNoClobber(staged, target, { opener: () => null, probe: {} })).toThrow(
      'portable directory claim failed',
    );
    expect(computeDirDigest(target)).toBe(before); // target never clobbered
    expect(readFileSync(join(target, 'EXISTING.txt'), 'utf8')).toBe('user bytes\n');
  });

  test('publishDirectoryViaNameClaim replaces only an empty claimed dir and rejects a populated target', () => {
    const staged = stagedTree('claim-src');
    const digest = computeDirDigest(staged);
    const target = join(fixture.root, 'claim-target'); // absent
    publishDirectoryViaNameClaim(staged, target);
    expect(computeDirDigest(target)).toBe(digest);
    const staged2 = stagedTree('claim-src2');
    const before = computeDirDigest(target);
    expect(() => publishDirectoryViaNameClaim(staged2, target)).toThrow('portable directory claim failed');
    expect(computeDirDigest(target)).toBe(before); // a real (non-empty) target is never touched
  });

  test('feature detection is memoized at first use across publishes', () => {
    let calls = 0;
    const probe = {}; // fresh probe cache shared across both publishes
    const opener = () => {
      calls += 1;
      return null; // simulate musl: no candidate resolves
    };
    atomicRenameDirectoryNoClobber(stagedTree('cache-1'), join(fixture.root, 'cache-t1'), { opener, probe });
    const afterFirst = calls;
    atomicRenameDirectoryNoClobber(stagedTree('cache-2'), join(fixture.root, 'cache-t2'), { opener, probe });
    expect(calls).toBe(afterFirst); // the second publish reuses the memoized probe — no re-detection
    if (process.platform === 'linux') expect(afterFirst).toBeGreaterThan(0);
  });
});
