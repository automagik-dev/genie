/**
 * Tests for `genie uninstall`: the record-driven skills.sh channel removal, the
 * durable uninstall batch journal, and the atomic external captures.
 *
 * The interactive prompt stays out of scope. Every seam runs under a tmpdir, so
 * no test touches the real HOME.
 *
 * Ownership contract under test: uninstall deletes only what genie provably
 * shipped — a skills directory whose recorded digest still matches, a
 * marker-proven v4 rules file, an owned source symlink, and GENIE_HOME itself
 * under an exact removal commitment. Anything whose identity changed after the
 * batch was recorded is preserved byte-identically and reported.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import {
  SKILLS_CLI_VERSION,
  computeSkillDirDigest,
  skillsInstallRecordPath,
  writeSkillsInstallRecord,
} from '../lib/skills-installer.js';
import {
  type ProvenV4Rules,
  type UninstallBatchScope,
  type UninstallResult,
  clearUninstallBatchDecision,
  discardLegacyUninstallBatchDecision,
  executeUninstallBatch,
  hasUninstallWork,
  inspectUninstallPlan,
  isGenieSymlink,
  isSameOrContainedPath,
  performFreshUninstallPlan,
  readUninstallBatchDecision,
  recordUninstallBatchDecision,
  removeProvenV4Rules,
  removeRulesMember,
  removeSkillsChannelInstall,
  removeSymlinkMembers,
  removeSymlinks,
  settleRuntimeIntegrationProgress,
  uninstallBatchIntegrationViolations,
  uninstallBatchJournalPath,
  uninstallBatchMemberId,
  uninstallBatchRuntimeMemberId,
  uninstallBatchRuntimeTargets,
  updateUninstallBatchProgress,
} from './uninstall.js';

describe('skills.sh channel removal (wish skills-everywhere, group 1)', () => {
  let root: string;
  let genieHome: string;
  let claudeSkills: string;
  let codexSkills: string;

  /**
   * Seed the record install-time would have written: a content digest for
   * every recorded `<agentDir>/<skill>` that exists right now. `legacy` writes
   * the 5.260830.x shape with no digests at all.
   */
  function seedRecord(inventory: string[], agentDirs: string[], options: { legacy?: boolean } = {}): void {
    const dirDigests: Record<string, string> = {};
    if (!options.legacy) {
      for (const agentDir of agentDirs) {
        for (const name of inventory) {
          const digest = computeSkillDirDigest(join(agentDir, name));
          if (digest !== null) dirDigests[join(agentDir, name)] = digest;
        }
      }
    }
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory,
      agentDirs,
      ...(options.legacy ? {} : { dirDigests }),
      installedAt: '2026-08-30T12:00:00.000Z',
    });
  }

  function seedSkillDir(agentDir: string, name: string): string {
    const dir = join(agentDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
    return dir;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-uninstall-skills-'));
    genieHome = join(root, '.genie');
    claudeSkills = join(root, 'home', '.claude', 'skills');
    codexSkills = join(root, 'home', '.codex', 'skills');
    mkdirSync(genieHome, { recursive: true });
    mkdirSync(claudeSkills, { recursive: true });
    mkdirSync(codexSkills, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('removes exactly the recorded inventory dirs and leaves foreign skills untouched', () => {
    const recorded = [seedSkillDir(claudeSkills, 'wish'), seedSkillDir(codexSkills, 'wish')];
    const foreign = [seedSkillDir(claudeSkills, 'someone-elses-skill'), seedSkillDir(codexSkills, 'pdf-filler')];
    seedRecord(['wish'], [claudeSkills, codexSkills]);

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed.sort()).toEqual([...recorded].sort());
    expect(removal.failures).toEqual([]);
    expect(removal.preserved).toEqual([]);
    for (const dir of recorded) expect(existsSync(dir)).toBe(false);
    for (const dir of foreign) expect(existsSync(dir)).toBe(true);
    // The agent dirs themselves survive; only genie's own skill dirs go.
    expect(existsSync(claudeSkills)).toBe(true);
    expect(existsSync(codexSkills)).toBe(true);
  });

  test('deletes the record so a second run is a clean no-op', () => {
    seedSkillDir(claudeSkills, 'work');
    seedRecord(['work'], [claudeSkills]);

    const first = removeSkillsChannelInstall(genieHome);
    expect(first.recordRemoved).toBe(true);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);

    const second = removeSkillsChannelInstall(genieHome);
    expect(second).toEqual({ record: null, removed: [], failures: [], preserved: [], recordRemoved: false });
  });

  test('no record is nothing to do', () => {
    const foreign = seedSkillDir(claudeSkills, 'wish');
    expect(removeSkillsChannelInstall(genieHome)).toEqual({
      record: null,
      removed: [],
      failures: [],
      preserved: [],
      recordRemoved: false,
    });
    expect(existsSync(foreign)).toBe(true);
  });

  test('a recorded name that is a file, a symlink, or absent is left alone', () => {
    const outside = join(root, 'outside-target');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(claudeSkills, 'work'), 'not a skill dir\n', 'utf8');
    symlinkSync(outside, join(claudeSkills, 'wish'));
    seedRecord(['work', 'wish', 'never-installed'], [claudeSkills]);

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed).toEqual([]);
    expect(existsSync(join(claudeSkills, 'work'))).toBe(true);
    expect(existsSync(join(claudeSkills, 'wish'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  test('a traversal-carrying record is rejected wholesale, so nothing is removed', () => {
    const sibling = seedSkillDir(join(root, 'home', '.claude'), 'agents');
    writeFileSync(
      skillsInstallRecordPath(genieHome),
      JSON.stringify({
        ref: 'v5.260830.16',
        cliVersion: SKILLS_CLI_VERSION,
        inventory: ['../agents'],
        agentDirs: [claudeSkills],
        installedAt: '2026-08-30T12:00:00.000Z',
      }),
      'utf8',
    );

    expect(removeSkillsChannelInstall(genieHome).record).toBeNull();
    expect(existsSync(sibling)).toBe(true);
  });

  test('a user-modified recorded dir is preserved and reported, never deleted', () => {
    const wish = seedSkillDir(claudeSkills, 'wish');
    seedRecord(['wish'], [claudeSkills]);
    writeFileSync(join(wish, 'SKILL.md'), '# my precious local edit\n', 'utf8');

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed).toEqual([]);
    expect(removal.preserved).toEqual([wish]);
    expect(removal.failures).toEqual([]);
    expect(removal.recordRemoved).toBe(false);
    expect(readFileSync(join(wish, 'SKILL.md'), 'utf8')).toBe('# my precious local edit\n');
    // The receipt survives an incomplete removal so the uninstall is retryable.
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(true);
  });

  test('a foreign same-name dir that replaced the install is preserved', () => {
    const dir = seedSkillDir(claudeSkills, 'docs');
    seedRecord(['docs'], [claudeSkills]);
    // The user replaced the whole directory with their own skill: different
    // file set, different bytes, same generic name in a shared home.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# my own docs skill\n', 'utf8');
    writeFileSync(join(dir, 'extra.md'), 'mine\n', 'utf8');

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed).toEqual([]);
    expect(removal.preserved).toEqual([dir]);
    expect(removal.recordRemoved).toBe(false);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('# my own docs skill\n');
    expect(readFileSync(join(dir, 'extra.md'), 'utf8')).toBe('mine\n');
  });

  test('a matching dir is removed while a modified sibling of the same inventory is preserved', () => {
    const matching = seedSkillDir(claudeSkills, 'wish');
    const modified = seedSkillDir(codexSkills, 'wish');
    seedRecord(['wish'], [claudeSkills, codexSkills]);
    writeFileSync(join(modified, 'SKILL.md'), '# edited\n', 'utf8');

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed).toEqual([matching]);
    expect(removal.preserved).toEqual([modified]);
    expect(existsSync(matching)).toBe(false);
    expect(existsSync(modified)).toBe(true);
    expect(removal.recordRemoved).toBe(false);
  });

  test('a legacy record without digests (5.260830.x) preserves every recorded dir', () => {
    const wish = seedSkillDir(claudeSkills, 'wish');
    const work = seedSkillDir(codexSkills, 'work');
    seedRecord(['wish', 'work'], [claudeSkills, codexSkills], { legacy: true });

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.removed).toEqual([]);
    expect(removal.preserved.sort()).toEqual([wish, work].sort());
    expect(removal.recordRemoved).toBe(false);
    expect(existsSync(wish)).toBe(true);
    expect(existsSync(work)).toBe(true);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(true);
  });

  /**
   * Wish `skills-everywhere-b` decision 2: `source` and `collisions` are
   * OPTIONAL in the record schema. A required field would make every
   * 5.260830.x record on disk schema-invalid — `readSkillsInstallRecord`
   * returns `null` for those — turning this removal into a silent no-op over
   * directories that are really there. The record below is the exact on-disk
   * shape that release wrote: digests, four agent dirs, no `source`.
   */
  test('a 5.260830.x record with no source still parses and still drives the removal', () => {
    const agentDirs = [
      claudeSkills,
      codexSkills,
      join(root, 'home', '.config', 'goose', 'skills'),
      join(root, 'home', '.codeium', 'windsurf', 'skills'),
    ];
    const dirDigests: Record<string, string> = {};
    const seeded: string[] = [];
    for (const agentDir of agentDirs) {
      mkdirSync(agentDir, { recursive: true });
      const dir = seedSkillDir(agentDir, 'wish');
      seeded.push(dir);
      const digest = computeSkillDirDigest(dir);
      if (digest === null) throw new Error(`fixture skill dir was not digestable: ${dir}`);
      dirDigests[dir] = digest;
    }
    writeFileSync(
      skillsInstallRecordPath(genieHome),
      `${JSON.stringify(
        {
          ref: 'v5.260830.16',
          cliVersion: SKILLS_CLI_VERSION,
          inventory: ['wish'],
          agentDirs,
          dirDigests,
          installedAt: '2026-08-30T12:00:00.000Z',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const removal = removeSkillsChannelInstall(genieHome);

    expect(removal.record?.source).toBeUndefined();
    expect(removal.record?.collisions).toBeUndefined();
    expect(removal.removed.sort()).toEqual([...seeded].sort());
    expect(removal.preserved).toEqual([]);
    expect(removal.recordRemoved).toBe(true);
    for (const dir of seeded) expect(existsSync(dir)).toBe(false);
  });
});

describe('skills.sh channel removal inside the fresh uninstall plan (PR #2866 promotion review)', () => {
  let root: string;
  let genieHome: string;
  let claudeSkills: string;
  let output: string[];
  let logSpy: ReturnType<typeof spyOn>;
  const savedExitCode = process.exitCode;

  /** Isolate every env-resolved home the plan and its inspectors read. */
  function withIsolatedEnv<T>(run: () => T): T {
    const overrides = {
      GENIE_HOME: genieHome,
      CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'),
      CODEX_HOME: join(root, 'home', '.codex'),
      HERMES_HOME: join(root, 'home', '.hermes'),
    };
    const prior = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
      return run();
    } finally {
      for (const [name, value] of Object.entries(prior)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  /** A GENIE_HOME that is a real removable install root, not just a record holder. */
  function seedRemovableGenieHome(): void {
    mkdirSync(join(genieHome, 'plugins', 'genie'), { recursive: true });
    writeFileSync(join(genieHome, 'plugins', 'genie', 'payload.txt'), 'delivered\n', 'utf8');
  }

  function seedWishSkill(): string {
    const wish = join(claudeSkills, 'wish');
    mkdirSync(wish, { recursive: true });
    writeFileSync(join(wish, 'SKILL.md'), '# wish\n', 'utf8');
    return wish;
  }

  function seedChannelRecord(wish: string, digest: string): void {
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [claudeSkills],
      dirDigests: { [wish]: digest },
      installedAt: '2026-08-30T12:00:00.000Z',
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-uninstall-skills-plan-'));
    genieHome = join(root, 'genie');
    claudeSkills = join(root, 'home', '.claude', 'skills');
    mkdirSync(claudeSkills, { recursive: true });
    output = [];
    process.exitCode = 0;
    logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
    process.exitCode = savedExitCode;
    rmSync(root, { recursive: true, force: true });
  });

  test('an unverified skill dir aborts the plan before GENIE_HOME cleanup and keeps the record', () => {
    seedRemovableGenieHome();
    const wish = seedWishSkill();
    seedChannelRecord(wish, 'deadbeef'.repeat(8)); // never matches the live content

    const outcome = withIsolatedEnv(() => performFreshUninstallPlan(genieHome, false));

    expect(outcome.result.failures).toHaveLength(1);
    expect(outcome.result.failures[0]?.step).toBe('skills.sh channel');
    expect(outcome.result.failures[0]?.detail).toContain(wish);
    expect(outcome.result.failures[0]?.detail).toContain('preserved');
    // The preserved dir is reported distinctly from outright removal failures.
    expect(output.some((line) => line.includes(`skills.sh channel: preserved ${wish}`))).toBe(true);
    // Aborted before the batch: the home (and the receipt inside it) survive.
    expect(existsSync(genieHome)).toBe(true);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(true);
    expect(existsSync(wish)).toBe(true);
    expect(existsSync(join(genieHome, 'plugins', 'genie', 'payload.txt'))).toBe(true);
  });

  test('a fully verified removal deletes the record and completes the uninstall', () => {
    seedRemovableGenieHome();
    const wish = seedWishSkill();
    const digest = computeSkillDirDigest(wish);
    if (digest === null) throw new Error('fixture skill dir was not digestable');
    seedChannelRecord(wish, digest);

    const outcome = withIsolatedEnv(() => performFreshUninstallPlan(genieHome, false));

    expect(outcome.result.failures).toEqual([]);
    expect(existsSync(wish)).toBe(false);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(false);
    // The record deletion happens before the home snapshot, so the batch can
    // still authorize a clean wholesale removal of GENIE_HOME's contents.
    expect(existsSync(join(genieHome, 'plugins'))).toBe(false);
    expect(readdirSync(genieHome)).toEqual([]);
  });
});

describe('path containment', () => {
  test('uses Windows path semantics without accepting sibling prefixes or cross-drive paths', () => {
    const genieHome = 'C:\\Users\\genie\\.genie';

    expect(isSameOrContainedPath(genieHome, genieHome, win32)).toBe(true);
    expect(isSameOrContainedPath(genieHome, 'C:\\Users\\genie\\.genie\\plugins\\hermes-genie', win32)).toBe(true);
    expect(isSameOrContainedPath(genieHome, 'C:\\Users\\genie\\.genie-foreign\\payload', win32)).toBe(false);
    expect(isSameOrContainedPath(genieHome, 'D:\\Users\\genie\\.genie\\payload', win32)).toBe(false);
  });
});

describe('durable uninstall batch', () => {
  let root: string;
  let genieHome: string;

  // The journal-mechanics tests exercise member ids (name-based), not physical
  // removal, so a synthetic-but-valid source-symlink identity satisfies the v4
  // schema. `genie` and `term` are the only two member names the scope allows.
  const syntheticLinkIdentity = { dev: 1, ino: 2, mode: 0o120777 };

  function scope(names: Array<'genie' | 'term'> = []): UninstallBatchScope {
    return {
      genieHomeIdentity: null,
      genieHomeRemovalDigest: null,
      ownedRules: null,
      removeMarketplace: false,
      runtimeClients: { codex: false, claude: false },
      runtimePlugins: { codex: false, claude: false },
      symlinks: names.map((name) => ({
        name,
        target: join(root, 'home', '.genie', 'bin', 'genie'),
        identity: syntheticLinkIdentity,
      })),
    };
  }

  /** Write an AUTHENTIC legacy v1 journal (v1 shape + v1 digest) at the canonical path. */
  function writeLegacyV1Journal(active: string | null = null): string {
    // Field order must match the v1 zod schema so the digest survives the parse
    // round-trip (zod reconstructs keys in schema order before re-serializing).
    const payload = {
      schemaVersion: 1 as const,
      genieHome: resolve(genieHome),
      scope: {
        agentAssets: [] as unknown[],
        codexRoleAgents: [] as unknown[],
        codexRoleInventoryStatus: 'missing',
        genieHomePresent: false,
        ownedRulesPath: null,
        removeMarketplace: false,
        runtimeClients: { codex: false, claude: false },
        runtimePlugins: { codex: false, claude: false },
        symlinks: [] as unknown[],
      },
      progress: { active, completed: [] as unknown[] },
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const journalPath = uninstallBatchJournalPath(genieHome);
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    writeFileSync(journalPath, `${JSON.stringify({ ...payload, digest }, null, 2)}\n`, { mode: 0o600 });
    return journalPath;
  }

  /** Write an authentic legacy v2 journal whose pathname boolean grants no v3 deletion authority. */
  function writeLegacyV2Journal(active: string | null = null): string {
    const payload = {
      schemaVersion: 2 as const,
      genieHome: resolve(genieHome),
      scope: {
        agentAssets: [] as unknown[],
        codexRoleAgents: [] as unknown[],
        codexRoleInventoryStatus: 'missing',
        genieHomePresent: true,
        ownedRulesPath: null,
        removeMarketplace: false,
        runtimeClients: { codex: false, claude: false },
        runtimePlugins: { codex: false, claude: false },
        symlinks: [] as unknown[],
      },
      progress: { active, completed: [] as unknown[], preserved: [] as unknown[] },
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const journalPath = uninstallBatchJournalPath(genieHome);
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    writeFileSync(journalPath, `${JSON.stringify({ ...payload, digest }, null, 2)}\n`, { mode: 0o600 });
    return journalPath;
  }

  /**
   * Write an AUTHENTIC legacy v3 journal (v3 shape + v3 digest) at the canonical
   * path. v3 was the CURRENT generation every shipped 5.2608xx binary wrote, so
   * an interrupted uninstall on any released host leaves exactly this file — the
   * one generation the v4 bump made legacy.
   */
  function writeLegacyV3Journal(active: string | null = null): string {
    const payload = {
      schemaVersion: 3 as const,
      genieHome: resolve(genieHome),
      scope: {
        agentAssets: [] as unknown[],
        codexRoleAgents: [] as unknown[],
        codexRoleInventoryStatus: 'missing',
        genieHomeIdentity: null,
        genieHomeRemovalDigest: null,
        ownedRules: null,
        removeMarketplace: false,
        runtimeClients: { codex: false, claude: false },
        runtimePlugins: { codex: false, claude: false },
        symlinks: [] as unknown[],
      },
      progress: { active, completed: [] as unknown[], preserved: [] as unknown[] },
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const journalPath = uninstallBatchJournalPath(genieHome);
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
    writeFileSync(journalPath, `${JSON.stringify({ ...payload, digest }, null, 2)}\n`, { mode: 0o600 });
    return journalPath;
  }

  function journalReplacementRace(
    boundary: 'beforeCapture' | 'afterCapture',
    caseName: string,
    replacementBytes: Buffer,
  ): {
    displacedPath: string;
    wasInvoked: () => boolean;
    options: {
      beforeCapture?: (journalPath: string) => void;
      afterCapture?: (journalPath: string) => void;
    };
  } {
    const displacedPath = join(root, `${caseName}-authenticated-original.json`);
    let invoked = false;
    const replace = (journalPath: string) => {
      invoked = true;
      if (boundary === 'beforeCapture') renameSync(journalPath, displacedPath);
      writeFileSync(journalPath, replacementBytes, { flag: 'wx', mode: 0o600 });
    };
    return {
      displacedPath,
      wasInvoked: () => invoked,
      options: boundary === 'beforeCapture' ? { beforeCapture: replace } : { afterCapture: replace },
    };
  }

  function expectRetainedJournalRaceEvidence(
    journalPath: string,
    boundary: 'beforeCapture' | 'afterCapture',
    displacedPath: string,
    quarantineLabel: 'journal-discard' | 'journal-progress' | 'journal-clear',
    replacementBytes: Buffer,
  ): void {
    expect(readFileSync(journalPath).equals(replacementBytes)).toBe(true);
    if (boundary === 'beforeCapture') {
      expect(existsSync(displacedPath)).toBe(true);
      return;
    }
    const quarantine = readdirSync(dirname(journalPath)).find((name) =>
      name.startsWith(`.genie-uninstall-${quarantineLabel}-`),
    );
    expect(quarantine).toBeDefined();
    expect(existsSync(join(dirname(journalPath), quarantine as string, 'captured'))).toBe(true);
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uninstall-batch-'));
    genieHome = join(root, 'home', '.genie');
    mkdirSync(genieHome, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('retains the authenticated journal across cleanup failure and clears it last on retry', () => {
    const events: string[] = [];
    const firstAsset = join(root, 'bin', 'genie');
    const secondAsset = join(root, 'bin', 'term');
    mkdirSync(dirname(firstAsset), { recursive: true });
    writeFileSync(firstAsset, 'link\n');
    writeFileSync(secondAsset, 'link\n');
    const plannedScope = scope(['genie', 'term']);
    const firstMember = uninstallBatchMemberId('symlink', 'genie');
    const secondMember = uninstallBatchMemberId('symlink', 'term');
    const first = executeUninstallBatch(genieHome, plannedScope, (decisionScope, progress) => {
      events.push('cleanup-failed');
      expect(decisionScope.symlinks.map((symlink) => symlink.name)).toEqual(['genie', 'term']);
      progress.begin(firstMember);
      rmSync(firstAsset, { recursive: true, force: true });
      progress.complete(firstMember);
      return { failures: [{ step: 'injected cleanup', detail: 'retry me' }] };
    });
    const journalPath = uninstallBatchJournalPath(genieHome);
    const pending = readUninstallBatchDecision(genieHome);

    expect(first.result.failures).toHaveLength(1);
    expect(existsSync(journalPath)).toBe(true);
    expect(journalPath.startsWith(`${genieHome}/`)).toBe(false);
    expect(pending?.digest).toBe(first.decision.digest);
    expect(pending?.progress).toEqual({ active: null, completed: [firstMember], preserved: [] });

    // A fresh object later occupies the already-completed slot. The retry must
    // skip it rather than replaying path authority from the immutable scope.
    writeFileSync(firstAsset, 'preserve me\n');

    const retried = executeUninstallBatch(
      genieHome,
      plannedScope,
      (decisionScope, progress) => {
        events.push('cleanup-retried');
        expect(existsSync(journalPath)).toBe(true);
        expect(decisionScope.symlinks.map((symlink) => symlink.name)).toEqual(['genie', 'term']);
        expect(progress.isCompleted(firstMember)).toBe(true);
        expect(existsSync(firstAsset)).toBe(true);
        expect(existsSync(secondAsset)).toBe(true);
        progress.begin(secondMember);
        rmSync(secondAsset, { recursive: true, force: true });
        progress.complete(secondMember);
        return { failures: [] };
      },
      {
        clearDecision(home, digest) {
          events.push('journal-cleared');
          clearUninstallBatchDecision(home, digest);
        },
      },
    );

    expect(retried.decision.progress.completed).toEqual([firstMember, secondMember].sort());
    expect(retried.result.failures).toEqual([]);
    expect(events).toEqual(['cleanup-failed', 'cleanup-retried', 'journal-cleared']);
    expect(readFileSync(firstAsset, 'utf8')).toBe('preserve me\n');
    expect(existsSync(journalPath)).toBe(false);
  });

  test('an interrupted member remains active and is never replayed automatically', () => {
    const member = uninstallBatchMemberId('symlink', 'genie');
    const interruptedScope = scope(['genie']);
    const first = executeUninstallBatch(genieHome, interruptedScope, (_decisionScope, progress) => {
      progress.begin(member);
      return { failures: [{ step: 'injected crash boundary', detail: 'ambiguous outcome' }] };
    });
    let replayed = false;

    const retried = executeUninstallBatch(genieHome, interruptedScope, () => {
      replayed = true;
      return { failures: [] };
    });

    expect(first.decision.progress.active).toBe(member);
    expect(replayed).toBe(false);
    expect(retried.result.failures[0]?.detail).toContain('refused to replay that slot');
    expect(readUninstallBatchDecision(genieHome)?.progress.active).toBe(member);
  });

  test('a structured runtime-integration failure clears its active receipt so retry can converge', () => {
    const plannedScope = scope();
    plannedScope.runtimePlugins = { codex: true, claude: false };
    const member = uninstallBatchRuntimeMemberId(plannedScope);

    const first = executeUninstallBatch(genieHome, plannedScope, (_decisionScope, progress) => {
      progress.begin(member);
      // Mirrors removeIntegrationState after removeRuntimeIntegrations returns a
      // structured failure (e.g. a transient codex/claude CLI timeout): no
      // mutation is in flight, per-step outcomes are idempotent, and the batch
      // must stay retryable rather than stranding behind the replay guard.
      settleRuntimeIntegrationProgress(member, true, progress);
      return { failures: [{ step: 'Removing codex plugin', detail: 'injected runtime failure' }] };
    });

    expect(first.result.failures).toHaveLength(1);
    expect(readUninstallBatchDecision(genieHome)?.progress.active).toBeNull();

    let replayed = false;
    const retried = executeUninstallBatch(genieHome, plannedScope, (_decisionScope, progress) => {
      replayed = true;
      progress.begin(member);
      settleRuntimeIntegrationProgress(member, false, progress);
      return { failures: [] };
    });

    expect(replayed).toBe(true);
    expect(retried.result.failures).toEqual([]);
    expect(readUninstallBatchDecision(genieHome)).toBeNull();
  });

  test('never clears a batch while a requested member lacks a completion receipt', () => {
    const plannedScope = scope(['genie']);

    const result = executeUninstallBatch(genieHome, plannedScope, () => ({ failures: [] }));

    expect(result.result.failures[0]?.detail).toContain(
      'requested members lack durable completion or preservation receipts',
    );
    expect(readUninstallBatchDecision(genieHome)).not.toBeNull();
  });

  test('refuses to publish a progress receipt outside the exact recorded scope', () => {
    const unplanned = uninstallBatchMemberId('symlink', 'term');

    expect(() =>
      executeUninstallBatch(genieHome, scope(['genie']), (_decisionScope, progress) => {
        progress.begin(unplanned);
        return { failures: [] };
      }),
    ).toThrow('outside the exact recorded scope');
    expect(readUninstallBatchDecision(genieHome)?.progress).toEqual({ active: null, completed: [], preserved: [] });
  });

  test('rejects a decision whose authenticated scope was edited', () => {
    executeUninstallBatch(genieHome, scope(), () => ({
      failures: [{ step: 'injected cleanup', detail: 'retain decision' }],
    }));
    const journalPath = uninstallBatchJournalPath(genieHome);
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      scope: { removeMarketplace: boolean };
    };
    parsed.scope.removeMarketplace = true;
    writeFileSync(journalPath, `${JSON.stringify(parsed, null, 2)}\n`);

    expect(() => readUninstallBatchDecision(genieHome)).toThrow('authentication failed');
  });

  test('rejects duplicate members before publishing an uninstall allowlist', () => {
    const duplicated = scope(['genie', 'genie']);

    expect(() => recordUninstallBatchDecision(genieHome, duplicated)).toThrow('duplicate symlink names');
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('fails closed when the recovery root is a symlink', () => {
    const recoveryRoot = join(root, 'home', '.genie-recovery');
    const redirected = join(root, 'redirected-recovery');
    mkdirSync(redirected, { recursive: true });
    symlinkSync(redirected, recoveryRoot);

    expect(() => recordUninstallBatchDecision(genieHome, scope())).toThrow(
      'uninstall recovery root is not a physical directory',
    );
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('rejects a group-writable uninstall journal', () => {
    executeUninstallBatch(genieHome, scope(), () => ({
      failures: [{ step: 'injected cleanup', detail: 'retain decision' }],
    }));
    const journalPath = uninstallBatchJournalPath(genieHome);
    chmodSync(journalPath, 0o620);

    expect(() => readUninstallBatchDecision(genieHome)).toThrow('uninstall batch journal is group/world-writable');
  });

  test('a preserved member lets the batch clear once completed ∪ preserved covers every member', () => {
    const preservedMember = uninstallBatchMemberId('symlink', 'genie');
    const otherMember = uninstallBatchMemberId('symlink', 'term');

    const outcome = executeUninstallBatch(genieHome, scope(['genie', 'term']), (_scope, progress) => {
      progress.begin(preservedMember);
      progress.preserve(preservedMember);
      progress.begin(otherMember);
      progress.complete(otherMember);
      return { failures: [] };
    });

    expect(outcome.result.failures).toEqual([]);
    expect(outcome.decision.progress.preserved).toEqual([preservedMember]);
    expect(outcome.decision.progress.completed).toEqual([otherMember]);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('a preserved member survives a retained batch and is never reprocessed on retry', () => {
    const preservedMember = uninstallBatchMemberId('symlink', 'genie');
    const otherMember = uninstallBatchMemberId('symlink', 'term');
    const plannedScope = scope(['genie', 'term']);
    let preservedProcessed = 0;

    executeUninstallBatch(genieHome, plannedScope, (_scope, progress) => {
      progress.begin(preservedMember);
      progress.preserve(preservedMember);
      preservedProcessed += 1;
      // The other member is never receipted, so the batch is retained for retry.
      return { failures: [{ step: 'injected', detail: 'retry me' }] };
    });
    expect(readUninstallBatchDecision(genieHome)?.progress.preserved).toEqual([preservedMember]);

    const retry = executeUninstallBatch(genieHome, plannedScope, (_scope, progress) => {
      // The durable preserve receipt survives; restoring authority must be refused.
      expect(progress.isPreserved(preservedMember)).toBe(true);
      if (!progress.isPreserved(preservedMember)) {
        progress.begin(preservedMember);
        progress.preserve(preservedMember);
        preservedProcessed += 1;
      }
      progress.begin(otherMember);
      progress.complete(otherMember);
      return { failures: [] };
    });

    expect(preservedProcessed).toBe(1);
    expect(retry.result.failures).toEqual([]);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('an authentic legacy v1 journal is discarded and re-recorded as v4, then execution proceeds', () => {
    writeLegacyV1Journal();
    const member = uninstallBatchMemberId('symlink', 'genie');
    const events: string[] = [];

    const outcome = executeUninstallBatch(genieHome, scope(['genie']), (decisionScope, progress) => {
      events.push('cleanup');
      // The fresh v4 scope is the CURRENT live scope, not the empty migrated v1 one.
      expect(decisionScope.symlinks.map((a) => a.name)).toEqual(['genie']);
      progress.begin(member);
      progress.complete(member);
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(4);
    expect(outcome.result.failures).toEqual([]);
    expect(events).toEqual(['cleanup']);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('an authentic legacy v2 pathname journal is re-planned as v4 before execution', () => {
    writeLegacyV2Journal();
    const outcome = executeUninstallBatch(genieHome, scope(), (decisionScope) => {
      expect(decisionScope.genieHomeIdentity).toBeNull();
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(4);
    expect(outcome.result.failures).toEqual([]);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
    expect(existsSync(genieHome)).toBe(true);
  });

  test('an authentic legacy v3 journal is discarded and re-recorded as v4, then execution proceeds', () => {
    // v3 is the generation every released binary wrote, so this is the migration
    // lane a real interrupted-uninstall host takes on the first v4 binary. If the
    // discard guard forgets v3, `genie uninstall` fails closed forever here.
    writeLegacyV3Journal();
    const member = uninstallBatchMemberId('symlink', 'genie');
    const events: string[] = [];

    const outcome = executeUninstallBatch(genieHome, scope(['genie']), (decisionScope, progress) => {
      events.push('cleanup');
      expect(decisionScope.symlinks.map((a) => a.name)).toEqual(['genie']);
      progress.begin(member);
      progress.complete(member);
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(4);
    expect(outcome.result.failures).toEqual([]);
    expect(events).toEqual(['cleanup']);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('a migrated legacy v3 journal with an interrupted member surfaces a note', () => {
    const staleMember = uninstallBatchMemberId('symlink', 'term');
    writeLegacyV3Journal(staleMember);

    const outcome = executeUninstallBatch(genieHome, scope(), () => ({ failures: [] }));

    expect(outcome.result.failures).toEqual([]);
    expect((outcome.result.notes ?? []).some((note) => note.includes(staleMember))).toBe(true);
  });

  test('a tampered legacy v3 journal fails closed and is not migrated', () => {
    const journalPath = writeLegacyV3Journal();
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { scope: { removeMarketplace: boolean } };
    parsed.scope.removeMarketplace = true;
    writeFileSync(journalPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    expect(() => executeUninstallBatch(genieHome, scope(), () => ({ failures: [] }))).toThrow('authentication failed');
    expect(existsSync(journalPath)).toBe(true);
  });

  test('a migrated legacy v1 journal with an interrupted member surfaces a note', () => {
    const staleMember = uninstallBatchMemberId('symlink', 'term');
    writeLegacyV1Journal(staleMember);

    const outcome = executeUninstallBatch(genieHome, scope(), () => ({ failures: [] }));

    expect(outcome.result.failures).toEqual([]);
    expect((outcome.result.notes ?? []).some((note) => note.includes(staleMember))).toBe(true);
  });

  test('a tampered legacy v1 journal fails closed and is not migrated', () => {
    const journalPath = writeLegacyV1Journal();
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as { scope: { removeMarketplace: boolean } };
    parsed.scope.removeMarketplace = true;
    writeFileSync(journalPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });

    expect(() => executeUninstallBatch(genieHome, scope(), () => ({ failures: [] }))).toThrow('authentication failed');
    expect(existsSync(journalPath)).toBe(true);
  });

  for (const boundary of ['beforeCapture', 'afterCapture'] as const) {
    test(`legacy journal discard refuses a ${boundary} pathname replacement without clobbering it`, () => {
      const journalPath = writeLegacyV1Journal();
      const replacementBytes = Buffer.from(`foreign legacy replacement at ${boundary}\n`);
      const race = journalReplacementRace(boundary, `discard-${boundary}`, replacementBytes);

      expect(() => discardLegacyUninstallBatchDecision(genieHome, race.options)).toThrow();
      expect(race.wasInvoked()).toBe(true);

      expectRetainedJournalRaceEvidence(journalPath, boundary, race.displacedPath, 'journal-discard', replacementBytes);
    });

    test(`progress update refuses a ${boundary} pathname replacement without clobbering it`, () => {
      const decision = recordUninstallBatchDecision(genieHome, scope());
      const journalPath = uninstallBatchJournalPath(genieHome);
      const replacementBytes = Buffer.from(`foreign progress replacement at ${boundary}\n`);
      const race = journalReplacementRace(boundary, `progress-${boundary}`, replacementBytes);

      expect(() => updateUninstallBatchProgress(genieHome, decision.digest, decision.progress, race.options)).toThrow();
      expect(race.wasInvoked()).toBe(true);

      expectRetainedJournalRaceEvidence(
        journalPath,
        boundary,
        race.displacedPath,
        'journal-progress',
        replacementBytes,
      );
    });

    test(`final journal clear refuses a ${boundary} pathname replacement without clobbering it`, () => {
      const decision = recordUninstallBatchDecision(genieHome, scope());
      const journalPath = uninstallBatchJournalPath(genieHome);
      const replacementBytes = Buffer.from(`foreign clear replacement at ${boundary}\n`);
      const race = journalReplacementRace(boundary, `clear-${boundary}`, replacementBytes);

      expect(() => clearUninstallBatchDecision(genieHome, decision.digest, race.options)).toThrow();
      expect(race.wasInvoked()).toBe(true);

      expectRetainedJournalRaceEvidence(journalPath, boundary, race.displacedPath, 'journal-clear', replacementBytes);
    });
  }
});

describe('durable runtime integration allowlist', () => {
  function scope(): UninstallBatchScope {
    return {
      genieHomeIdentity: { dev: 1, ino: 1, mode: 0o40700 },
      genieHomeRemovalDigest: 'f'.repeat(64),
      ownedRules: null,
      removeMarketplace: false,
      runtimeClients: { codex: true, claude: true },
      runtimePlugins: { codex: false, claude: true },
      symlinks: [],
    };
  }

  test('targets only recorded plugins unless marketplace consent recorded a client', () => {
    const planned = scope();
    expect(uninstallBatchRuntimeTargets(planned)).toEqual({ codex: false, claude: true });
    expect(uninstallBatchRuntimeTargets({ ...planned, removeMarketplace: true })).toEqual({
      codex: true,
      claude: true,
    });
  });

  test('rejects later plugins and unreadable runtime state before mutation', () => {
    const planned = scope();
    const violations = uninstallBatchIntegrationViolations(planned, {
      codex: true,
      claude: true,
      errors: { codex: ['corrupt config'], claude: [] },
    });

    expect(violations).toContain('codex integration state is unreadable: corrupt config');
    expect(violations).toContain('codex Genie plugin appeared after the uninstall batch was recorded');
  });
});

describe('uninstall ownership and work detection', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uninstall-links-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('only canonical Genie symlinks are classified and removed, including dangling owned links', () => {
    const genieHome = join(root, 'genie');
    const localBin = join(root, 'bin');
    mkdirSync(localBin, { recursive: true });
    const owned = join(localBin, 'genie');
    const foreign = join(localBin, 'term');
    symlinkSync(join(genieHome, 'bin', 'genie'), owned);
    symlinkSync(join(root, 'foreign-term'), foreign);

    expect(isGenieSymlink(owned, genieHome)).toBe(true);
    expect(isGenieSymlink(foreign, genieHome)).toBe(false);
    const result = removeSymlinks(localBin, genieHome);
    expect(result).toEqual({ removed: ['genie'], preserved: [], failures: [] });
    expect(lstatSync(foreign).isSymbolicLink()).toBe(true);
    expect(isGenieSymlink(foreign, genieHome)).toBe(false);
  });

  test('a frozen symlink allowlist does not absorb a later canonical sibling', () => {
    const genieHome = join(root, 'genie');
    const localBin = join(root, 'bin');
    mkdirSync(localBin, { recursive: true });
    const genieLink = join(localBin, 'genie');
    const laterTermLink = join(localBin, 'term');
    symlinkSync(join(genieHome, 'bin', 'genie'), genieLink);
    symlinkSync(join(genieHome, 'bin', 'term'), laterTermLink);

    expect(removeSymlinks(localBin, genieHome, ['genie'])).toEqual({
      removed: ['genie'],
      preserved: [],
      failures: [],
    });
    expect(existsSync(genieLink)).toBe(false);
    expect(lstatSync(laterTermLink).isSymbolicLink()).toBe(true);
  });

  test('runtime evidence and an explicit marketplace request both prevent false nothing-to-uninstall', () => {
    const base = {
      hasGenieDir: false,
      hasHookScript: false,
      hasOrchestrationRules: false,
      symlinkCount: 0,
      runtimeEvidence: { codex: false, claude: false },
      removeMarketplace: false,
    };
    expect(hasUninstallWork(base)).toBe(false);
    expect(hasUninstallWork({ ...base, runtimeEvidence: { codex: true, claude: false } })).toBe(true);
    expect(hasUninstallWork({ ...base, removeMarketplace: true })).toBe(true);
    expect(hasUninstallWork({ ...base, hasPendingBatch: true })).toBe(true);
  });

  test('a post-confirmation replan observes state that appeared while the preview was open', () => {
    let present = false;
    const inspectors = {
      hasGenieDir: () => present,
      captureGenieHomeIdentity: () => (present ? { dev: 1, ino: 1, mode: 0o40700 } : null),
      hookScriptExists: () => false,
      detectV4Install: () => ({
        rulesFile: { path: join(root, 'rules.md'), status: 'absent' as const },
        cacheDirs: [],
        hasRelics: false,
      }),
      existingSymlinks: () => [],
      inspectRuntimeClientAvailability: () => ({
        codex: false,
        claude: false,
        errors: { codex: [], claude: [] },
      }),
      inspectRuntimeIntegrationEvidence: () => ({
        codex: false,
        claude: false,
        errors: { codex: [], claude: [] },
      }),
      hasPendingBatch: () => false,
    };

    const preview = inspectUninstallPlan(join(root, 'genie'), false, inspectors);
    present = true;
    const execution = inspectUninstallPlan(join(root, 'genie'), false, inspectors);

    expect(preview.hasGenieDir).toBe(false);
    expect(execution.hasGenieDir).toBe(true);
    expect(
      hasUninstallWork({
        hasGenieDir: execution.hasGenieDir,
        hasHookScript: false,
        hasOrchestrationRules: false,
        symlinkCount: 0,
        runtimeEvidence: execution.runtimeEvidence,
        removeMarketplace: false,
      }),
    ).toBe(true);
  });
});

describe('atomic external uninstall captures', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uninstall-capture-races-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function rulesIdentity(path: string): ProvenV4Rules {
    const stat = lstatSync(path);
    return {
      path: resolve(path),
      digest: createHash('sha256').update(readFileSync(path)).digest('hex'),
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode },
    };
  }

  function scope(options: {
    rules?: ProvenV4Rules;
    symlinks?: UninstallBatchScope['symlinks'];
  }): UninstallBatchScope {
    return {
      genieHomeIdentity: null,
      genieHomeRemovalDigest: null,
      ownedRules: options.rules ?? null,
      removeMarketplace: false,
      runtimeClients: { codex: false, claude: false },
      runtimePlugins: { codex: false, claude: false },
      symlinks: options.symlinks ?? [],
    };
  }

  test('direct source-link capture restores a regular-file replacement and reports no removal', () => {
    const genieHome = join(root, 'genie');
    const localBin = join(root, 'bin');
    const link = join(localBin, 'genie');
    const parked = join(root, 'parked-link');
    mkdirSync(localBin, { recursive: true });
    symlinkSync(join(genieHome, 'bin', 'genie'), link);

    const result = removeSymlinks(localBin, genieHome, ['genie'], {
      beforeCapture(path) {
        renameSync(path, parked);
        writeFileSync(path, 'foreign-source-link\n');
      },
    });

    expect(result.removed).toEqual([]);
    expect(result.preserved).toEqual(['genie']);
    expect(result.failures).toHaveLength(1);
    expect(readFileSync(link, 'utf8')).toBe('foreign-source-link\n');
    expect(lstatSync(parked).isSymbolicLink()).toBe(true);
  });

  test('authenticated source-link swap records preservation, never completion', () => {
    const genieHome = join(root, 'genie');
    const localBin = join(root, 'bin');
    const link = join(localBin, 'genie');
    mkdirSync(localBin, { recursive: true });
    symlinkSync(join(genieHome, 'bin', 'genie'), link);
    const stat = lstatSync(link);
    const planned = {
      name: 'genie' as const,
      target: readlinkSync(link),
      identity: { dev: stat.dev, ino: stat.ino, mode: stat.mode },
    };
    const member = uninstallBatchMemberId('symlink', 'genie');

    const outcome = executeUninstallBatch(genieHome, scope({ symlinks: [planned] }), (_scope, progress) => {
      const result: UninstallResult = { failures: [], preserved: [], notes: [] };
      result.failures.push(
        ...removeSymlinkMembers(genieHome, [planned], result, progress, localBin, {
          beforeCapture(path) {
            renameSync(path, join(root, 'parked-batch-link'));
            writeFileSync(path, 'foreign-batch-link\n');
          },
        }),
      );
      return result;
    });

    expect(outcome.result.failures).toEqual([]);
    expect(outcome.decision.progress.completed).not.toContain(member);
    expect(outcome.decision.progress.preserved).toContain(member);
    expect(readFileSync(link, 'utf8')).toBe('foreign-batch-link\n');
  });

  test('v4 replacement at capture becomes a durable preserved receipt', () => {
    const genieHome = join(root, 'genie');
    const path = join(root, 'rules.md');
    writeFileSync(path, 'owned-rules\n');
    const planned = rulesIdentity(path);
    const member = uninstallBatchMemberId('rules', path);

    const outcome = executeUninstallBatch(genieHome, scope({ rules: planned }), (_scope, progress) => {
      const result: UninstallResult = { failures: [], preserved: [], notes: [] };
      const failure = removeRulesMember(genieHome, planned, result, progress, {
        beforeCapture(livePath) {
          renameSync(livePath, join(root, 'parked-rules'));
          writeFileSync(livePath, 'foreign-rules\n');
        },
      });
      if (failure !== null) result.failures.push(failure);
      return result;
    });

    expect(outcome.result.failures).toEqual([]);
    expect(outcome.decision.progress.completed).not.toContain(member);
    expect(outcome.decision.progress.preserved).toContain(member);
    expect(readFileSync(path, 'utf8')).toBe('foreign-rules\n');
  });

  test('v4 replacement after backup survives and prevents a false removal', () => {
    const genieHome = join(root, 'genie');
    const path = join(root, 'rules.md');
    writeFileSync(path, 'owned-after-backup\n');
    const planned = rulesIdentity(path);
    let backup = '';

    expect(() =>
      removeProvenV4Rules(genieHome, planned, {
        afterBackup(livePath, backupPath) {
          backup = backupPath;
          writeFileSync(livePath, 'foreign-after-backup\n');
        },
      }),
    ).toThrow('replacement appeared');
    expect(readFileSync(path, 'utf8')).toBe('foreign-after-backup\n');
    expect(readFileSync(backup, 'utf8')).toBe('owned-after-backup\n');
  });

  test('v4 absent completes idempotently while preexisting changed content is preserved', () => {
    const absentHome = join(root, 'absent-home');
    const absentPath = join(root, 'absent-rules.md');
    writeFileSync(absentPath, 'owned-absent\n');
    const absent = rulesIdentity(absentPath);
    rmSync(absentPath);
    const absentMember = uninstallBatchMemberId('rules', absentPath);
    const absentOutcome = executeUninstallBatch(absentHome, scope({ rules: absent }), (_scope, progress) => {
      const result: UninstallResult = { failures: [], preserved: [], notes: [] };
      const failure = removeRulesMember(absentHome, absent, result, progress);
      if (failure !== null) result.failures.push(failure);
      return result;
    });
    expect(absentOutcome.decision.progress.completed).toContain(absentMember);

    const changedHome = join(root, 'changed-home');
    const changedPath = join(root, 'changed-rules.md');
    writeFileSync(changedPath, 'owned-before-change\n');
    const changed = rulesIdentity(changedPath);
    writeFileSync(changedPath, 'foreign-preexisting-change\n');
    const changedMember = uninstallBatchMemberId('rules', changedPath);
    const changedOutcome = executeUninstallBatch(changedHome, scope({ rules: changed }), (_scope, progress) => {
      const result: UninstallResult = { failures: [], preserved: [], notes: [] };
      const failure = removeRulesMember(changedHome, changed, result, progress);
      if (failure !== null) result.failures.push(failure);
      return result;
    });
    expect(changedOutcome.decision.progress.completed).not.toContain(changedMember);
    expect(changedOutcome.decision.progress.preserved).toContain(changedMember);
    expect(readFileSync(changedPath, 'utf8')).toBe('foreign-preexisting-change\n');
  });
});

// ============================================================================
// Interactive uninstallCommand — warning, lifecycle-busy loser, isolation (D6/D8/D9)
// ============================================================================

import { readFileSync as readFileSyncForSource } from 'node:fs';
import { type UninstallDeps, uninstallCommand } from './uninstall.js';

describe('uninstallCommand — warning, lifecycle lease, isolation (Group D)', () => {
  let root: string;
  let priorEnv: Record<string, string | undefined>;
  const ENV_KEYS = ['HOME', 'GENIE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HERMES_HOME'] as const;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'uninstall-cmd-'));
    priorEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const key of ENV_KEYS) {
      const dir = join(root, key.toLowerCase());
      mkdirSync(dir, { recursive: true });
      process.env[key] = dir;
    }
    // GENIE_HOME must contain some removable state so the plan reaches the prompt.
    writeFileSync(join(process.env.GENIE_HOME as string, 'config.json'), '{}\n', 'utf8');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; exitCode: number }> {
    const priorExit = process.exitCode;
    process.exitCode = 0;
    let out = '';
    let err = '';
    // The source mixes console.log/console.error (Bun binds these to the original
    // writer) with direct process.stdout.write (the machine trailer). Spy on both.
    const realWrite = process.stdout.write.bind(process.stdout);
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out += `${a.join(' ')}\n`;
    });
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      err += `${a.join(' ')}\n`;
    });
    process.stdout.write = ((c: string) => {
      out += c;
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
      return { out, err, exitCode: process.exitCode ?? 0 };
    } finally {
      process.stdout.write = realWrite;
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = priorExit ?? 0;
    }
  }

  test('prints the task-breakage warning BEFORE confirmation; a decline mutates nothing', async () => {
    const { out } = await capture(() =>
      uninstallCommand(
        {},
        {
          // A sentinel emitted at prompt time proves the warning already printed.
          confirm: (async () => {
            process.stdout.write('<<CONFIRM-INVOKED>>\n');
            return false;
          }) as unknown as UninstallDeps['confirm'],
        },
      ),
    );
    expect(out).toContain('can break current or resumable tasks');
    expect(out).toContain('Uninstall cancelled.');
    // The warning was emitted before the confirmation prompt was invoked.
    expect(out.indexOf('can break current or resumable tasks')).toBeLessThan(out.indexOf('<<CONFIRM-INVOKED>>'));
    // Zero mutation: the GENIE_HOME artifact survives a decline.
    expect(existsSync(join(process.env.GENIE_HOME as string, 'config.json'))).toBe(true);
  });

  test('a preserved skills dir exits non-zero, keeps the record, and never removes GENIE_HOME', async () => {
    const genieHome = process.env.GENIE_HOME as string;
    const claudeSkills = join(process.env.CLAUDE_CONFIG_DIR as string, 'skills');
    const wish = join(claudeSkills, 'wish');
    mkdirSync(wish, { recursive: true });
    writeFileSync(join(wish, 'SKILL.md'), '# wish\n', 'utf8');
    // A digest that can never match the live content: the recorded dir is
    // unverified, so the plan must stop before the GENIE_HOME cleanup batch.
    writeSkillsInstallRecord(genieHome, {
      ref: 'v5.260830.16',
      cliVersion: SKILLS_CLI_VERSION,
      inventory: ['wish'],
      agentDirs: [claudeSkills],
      dirDigests: { [wish]: 'deadbeef'.repeat(8) },
      installedAt: '2026-08-30T12:00:00.000Z',
    });

    const { out, exitCode } = await capture(() =>
      uninstallCommand(
        {},
        {
          confirm: (async () => true) as unknown as UninstallDeps['confirm'],
          acquireLease: () => ({ path: join(root, 'test-lifecycle.lock'), release: () => undefined }),
        },
      ),
    );

    expect(exitCode).toBe(1);
    expect(out).toContain(`skills.sh channel: preserved ${wish}`);
    expect(out).toContain('Genie CLI uninstall is incomplete');
    expect(out).toContain('retry `genie uninstall`');
    // The receipt (the record inside GENIE_HOME) survives for a retry.
    expect(existsSync(genieHome)).toBe(true);
    expect(existsSync(skillsInstallRecordPath(genieHome))).toBe(true);
    expect(existsSync(wish)).toBe(true);
    expect(existsSync(join(genieHome, 'config.json'))).toBe(true);
  });

  test('a busy lifecycle lease exits 2 on one stderr line, no trailer, zero removal', async () => {
    // The 2026-08-02 incident: this branch used to `throw new Error(...)`, so an
    // operator whose other lifecycle command held the lease got a stack trace
    // instead of an explanation — and no assurance that nothing was removed.
    const priorWait = process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS;
    // Millisecond-scale bounded poll; 500ms (not 60ms) so a GC/scheduler pause
    // cannot collapse the 25ms poll loop to a single attempt and flake the
    // `attempts > 1` assertion.
    process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = '500';
    const lockPath = '/fixture/home/.genie-lifecycle-0123456789abcdef.lock';
    let attempts = 0;
    let thrown: unknown;
    try {
      const { out, err, exitCode } = await capture(async () => {
        await uninstallCommand(
          {},
          {
            confirm: (async () => true) as unknown as UninstallDeps['confirm'],
            acquireLease: () => {
              attempts += 1;
              return {
                skipped: `another Genie process holds the lock at ${lockPath}; retry shortly, or remove the file if its owner has crashed`,
                cause: 'held',
              };
            },
          },
        ).catch((error: unknown) => {
          thrown = error;
        });
      });

      expect(thrown).toBeUndefined();
      expect(exitCode).toBe(2);
      expect(attempts).toBeGreaterThan(1); // the bounded wait polled before giving up

      // Exactly one human-readable stderr line, and it promises zero removal.
      const errLines = err.split('\n').filter((line) => line.length > 0);
      expect(errLines).toHaveLength(1);
      expect(errLines[0]).toContain('Another Genie lifecycle command is active');
      expect(errLines[0]).toContain(`holds the lock at ${lockPath}`);
      expect(errLines[0]).toContain('No files were removed');

      // No machine trailer: a lease holder is not `codex-lifecycle-busy`.
      const output = `${out}\n${err}`;
      expect(output).not.toContain('codex-lifecycle-busy');
      expect(output).not.toContain('schemaVersion');
      expect(output).not.toContain('deliveryComplete');
      expect(output).not.toContain('the holder converges the same targets');
      expect(output).not.toMatch(/\n\s+at /);

      // Zero mutation: executeConfirmedUninstall never ran.
      expect(existsSync(join(process.env.GENIE_HOME as string, 'config.json'))).toBe(true);
    } finally {
      if (priorWait === undefined) Reflect.deleteProperty(process.env, 'GENIE_LIFECYCLE_LEASE_WAIT_MS');
      else process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = priorWait;
    }
  });

  test('uninstall never mints or accepts an activation assertion/permit', () => {
    const source = readFileSyncForSource(join(import.meta.dir, 'uninstall.ts'), 'utf8');
    for (const forbidden of [
      'requestRetirementAssertion',
      'authorizeCodexActivation',
      'executeCodexActivation',
      'beginActivation',
      'mintActivationPermit',
    ]) {
      expect(source.includes(forbidden)).toBe(false);
    }
  });

  test('uninstall is not callable from update/install/setup/doctor/init/post-delivery source', () => {
    const dir = join(import.meta.dir);
    const termDir = join(import.meta.dir, '..', 'term-commands');
    const callers: Array<[string, string]> = [
      [dir, 'update.ts'],
      [dir, 'install.ts'],
      [dir, 'setup.ts'],
      [dir, 'doctor.ts'],
      [dir, 'update-integrations.ts'],
      [termDir, 'init.ts'],
    ];
    for (const [base, file] of callers) {
      const source = readFileSyncForSource(join(base, file), 'utf8');
      for (const forbidden of ['uninstallCommand', 'executeConfirmedUninstall', 'performUninstall']) {
        expect(source.includes(forbidden)).toBe(false);
      }
    }
  });
});
