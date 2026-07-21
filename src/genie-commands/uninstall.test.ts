/**
 * Tests for the agent-sync managed-asset removal in `genie uninstall`.
 *
 * The interactive prompt stays out of scope. Manifest-verified removal seams and
 * a fully injected noninteractive flow run under a tmpdir, so no test touches the
 * real HOME.
 *
 * Ownership contract under test: uninstall deletes only what genie provably
 * shipped — a managed dir whose computeDirDigest still matches its manifest.
 * A managed-skill digest mismatch stays byte-identical at the same path. A flat
 * agent mismatch is transactionally disowned and kept aside so it stops loading
 * while its exact user bytes survive.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
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
import { basename, dirname, join, resolve, win32 } from 'node:path';
import {
  MANAGED_BY,
  PHYSICAL_TREE_IDENTITY_VERSION,
  WORKFLOW_MANIFEST_NAME,
  acquireAgentSyncLock,
  computeDirDigest,
  computeFileDigest,
  readAgentFilesManifest,
  stampWorkflow,
} from '../lib/agent-sync.js';
import {
  type ProvenV4Rules,
  type UninstallBatchScope,
  type UninstallResult,
  clearUninstallBatchDecision,
  collectAgentSyncAssets,
  discardLegacyUninstallBatchDecision,
  executeUninstallBatch,
  hasPendingUninstallTransactions,
  hasRemovableGenieInstallState,
  hasUninstallWork,
  inspectUninstallPlan,
  isGenieSymlink,
  isSameOrContainedPath,
  performFreshUninstallPlan,
  performUninstall,
  readUninstallBatchDecision,
  recordUninstallBatchDecision,
  recoverUninstallTransactions,
  removeAgentSyncAssets,
  removeProvenV4Rules,
  removeRulesMember,
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

describe('path containment', () => {
  test('uses Windows path semantics without accepting sibling prefixes or cross-drive paths', () => {
    const genieHome = 'C:\\Users\\genie\\.genie';

    expect(isSameOrContainedPath(genieHome, genieHome, win32)).toBe(true);
    expect(isSameOrContainedPath(genieHome, 'C:\\Users\\genie\\.genie\\plugins\\hermes-genie', win32)).toBe(true);
    expect(isSameOrContainedPath(genieHome, 'C:\\Users\\genie\\.genie-foreign\\payload', win32)).toBe(false);
    expect(isSameOrContainedPath(genieHome, 'D:\\Users\\genie\\.genie\\payload', win32)).toBe(false);
  });
});

describe('agent-sync managed-asset removal', () => {
  let tmp: string;
  let claudeDir: string;
  let codexDir: string;
  let agentsSkillsDir: string;
  let hermesHome: string;
  let genieHome: string;

  const fixedNow = () => new Date('2026-07-11T12:00:00.000Z');

  function targets() {
    return { claudeDir, codexDir, agentsSkillsDir, hermesHome, genieHome, now: fixedNow };
  }

  function withIsolatedHomes<T>(run: () => T): T {
    const overrides = {
      GENIE_HOME: genieHome,
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      HERMES_HOME: hermesHome,
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

  function requireCapturedPath(path: string | null): string {
    if (path === null) throw new Error('expected destructive-path fixture to capture an object');
    return path;
  }

  function uninstallBackupCollisionPath(): string {
    return join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z',
      'claude',
      'agents',
      'scout.md',
    );
  }

  /** A managed dir exactly as agent-sync ships it: manifest digest matches content. */
  function managedSkill(parent: string, name: string): string {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf8');
    const manifest = { managedBy: MANAGED_BY, version: '1', digest: computeDirDigest(dir), syncedAt: 'now' };
    writeFileSync(join(dir, '.genie-sync.json'), JSON.stringify(manifest), 'utf8');
    return dir;
  }

  /** A managed dir the user edited after sync: manifest present but digest diverged. */
  function modifiedManagedSkill(parent: string, name: string): string {
    const dir = managedSkill(parent, name);
    writeFileSync(join(dir, 'SKILL.md'), '# my precious local edits\n', 'utf8');
    return dir;
  }

  function unmanagedSkill(parent: string, name: string): string {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# mine\n', 'utf8');
    return dir;
  }

  /** The exact physical identity a durable uninstall batch records for a clean skill dir. */
  function skillIdentity(dir: string): { kind: 'skill'; contentDigest: string; manifestDigest: string } {
    return {
      kind: 'skill',
      contentDigest: computeDirDigest(dir),
      manifestDigest: createHash('sha256')
        .update(readFileSync(join(dir, '.genie-sync.json')))
        .digest('hex'),
    };
  }

  /** Rewrite a managed skill dir in place so it is managed-CLEAN with a different digest. */
  function reStampManagedSkill(dir: string, content: string): void {
    writeFileSync(join(dir, 'SKILL.md'), content, 'utf8');
    const manifest = { managedBy: MANAGED_BY, version: '1', digest: computeDirDigest(dir), syncedAt: 'now' };
    writeFileSync(join(dir, '.genie-sync.json'), JSON.stringify(manifest), 'utf8');
  }

  /** Add one flat Claude agent plus its entry in the shared per-file manifest. */
  function managedAgent(name: string, content = '# managed agent\n'): string {
    const parent = join(claudeDir, 'agents');
    const path = join(parent, name);
    mkdirSync(parent, { recursive: true });
    writeFileSync(path, content, 'utf8');
    const manifest = readAgentFilesManifest(parent) ?? { managedBy: MANAGED_BY, files: {} };
    manifest.files[name] = {
      digest: computeFileDigest(path),
      version: '1.0.0',
      syncedAt: '2026-07-11T10:00:00.000Z',
    };
    writeFileSync(join(parent, '.genie-sync.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return path;
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'uninstall-agentsync-'));
    claudeDir = join(tmp, 'claude');
    codexDir = join(tmp, 'codex');
    agentsSkillsDir = join(tmp, 'agents', 'skills');
    hermesHome = join(tmp, 'hermes');
    genieHome = join(tmp, 'genie');
    mkdirSync(join(genieHome, 'plugins', 'hermes-genie'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('collects only genie-managed skill dirs; unmanaged ones are invisible', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');
    const mine = unmanagedSkill(join(claudeDir, 'skills'), 'my-own');
    // Codex: live shared tier AND the retired `.curated` lane are both collected;
    // foreign siblings in the shared tier stay invisible (manifest-gated).
    const codexManaged = managedSkill(agentsSkillsDir, 'review');
    const codexLegacy = managedSkill(join(codexDir, 'skills', '.curated'), 'wish');
    const foreign = unmanagedSkill(agentsSkillsDir, 'someone-elses-skill');

    const paths = collectAgentSyncAssets(targets()).map((a) => a.path);
    expect(paths).toContain(managed);
    expect(paths).toContain(codexManaged);
    expect(paths).toContain(codexLegacy);
    expect(paths).not.toContain(mine);
    expect(paths).not.toContain(foreign);
  });

  test('collect flags digest-diverged managed dirs as modified, digest-clean ones as not', () => {
    const clean = managedSkill(join(claudeDir, 'skills'), 'wish');
    const edited = modifiedManagedSkill(join(claudeDir, 'skills'), 'review');

    const assets = collectAgentSyncAssets(targets());
    expect(assets.find((a) => a.path === clean)?.modified).toBe(false);
    expect(assets.find((a) => a.path === edited)?.modified).toBe(true);
  });

  test('removes digest-clean managed skills but leaves unmanaged dirs intact', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');
    const mine = unmanagedSkill(join(claudeDir, 'skills'), 'my-own');

    const { removed, kept, failures } = removeAgentSyncAssets(targets());
    expect(removed).toContain(managed);
    expect(kept).toEqual([]);
    expect(failures).toEqual([]);
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  test('recovers a parked managed skill with no live sibling before authoritative enumeration', () => {
    const parent = join(claudeDir, 'skills');
    const managed = managedSkill(parent, 'wish');
    const contentDigest = computeDirDigest(managed);
    const manifestDigest = createHash('sha256')
      .update(readFileSync(join(managed, '.genie-sync.json')))
      .digest('hex');
    const transaction = join(parent, '.genie-sync-transactions', 'delete-crashed');
    mkdirSync(transaction, { recursive: true });
    writeFileSync(
      join(transaction, 'journal.json'),
      `${JSON.stringify({
        version: 2,
        destName: 'wish',
        contentDigest,
        manifestDigest,
        identityVersion: PHYSICAL_TREE_IDENTITY_VERSION,
      })}\n`,
    );
    renameSync(managed, join(transaction, 'parked'));

    expect(existsSync(managed)).toBe(false);
    expect(collectAgentSyncAssets(targets()).map((asset) => asset.path)).not.toContain(managed);
    expect(hasPendingUninstallTransactions(targets())).toBe(true);

    const result = removeAgentSyncAssets(targets());

    expect(result.failures).toEqual([]);
    expect(result.removed).toContain(managed);
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(transaction)).toBe(false);
  });

  test('retained Genie-home capture is visible pending evidence and blocks automatic recovery', () => {
    const capture = mkdtempSync(join(dirname(genieHome), `.${basename(genieHome)}.uninstall-capture-`));
    const precious = join(capture, 'object', 'FOREIGN.txt');
    mkdirSync(dirname(precious));
    writeFileSync(precious, 'retained root capture\n');

    expect(hasPendingUninstallTransactions(targets())).toBe(true);
    expect(() => recoverUninstallTransactions(targets())).toThrow(
      `retained uninstall capture requires no-clobber recovery review: ${capture}`,
    );
    expect(readFileSync(precious, 'utf8')).toBe('retained root capture\n');
  });

  test('user-modified managed dir is kept byte-identical at the same path', () => {
    const edited = modifiedManagedSkill(join(claudeDir, 'skills'), 'review');
    const manifestBefore = readFileSync(join(edited, '.genie-sync.json'), 'utf8');

    const { removed, kept, failures } = removeAgentSyncAssets(targets());
    expect(removed).not.toContain(edited);
    expect(kept).toEqual([edited]);
    expect(failures).toEqual([]);
    expect(readFileSync(join(edited, 'SKILL.md'), 'utf8')).toBe('# my precious local edits\n');
    expect(readFileSync(join(edited, '.genie-sync.json'), 'utf8')).toBe(manifestBefore);
  });

  test('a nested broken symlink is a physical modification and revokes uninstall authority', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');
    symlinkSync('missing-personal-target', join(managed, 'personal-link'));

    const assets = collectAgentSyncAssets(targets());
    expect(assets.find((asset) => asset.path === managed)?.modified).toBe(true);
    const result = removeAgentSyncAssets(targets());
    expect(result.kept).toEqual([managed]);
    expect(lstatSync(join(managed, 'personal-link')).isSymbolicLink()).toBe(true);
  });

  test('uninstall uses agent-sync park/reverify and preserves a post-classification skill edit', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');
    const personal = '# personal uninstall race\n';

    const result = removeAgentSyncAssets(targets(), {
      beforeManagedDirRemoval(path, stage) {
        if (path === managed && stage === 'before-park') writeFileSync(join(path, 'SKILL.md'), personal);
      },
    });

    expect(result.removed).toEqual([]);
    expect(result.failures[0]?.path).toBe(managed);
    expect(readFileSync(join(managed, 'SKILL.md'), 'utf8')).toBe(personal);
  });

  test('repeated uninstall attempts keep a modified artifact unchanged and retryable', () => {
    const parent = join(claudeDir, 'skills');
    const edited = modifiedManagedSkill(parent, 'review');
    const before = readFileSync(join(edited, 'SKILL.md'), 'utf8');
    expect(removeAgentSyncAssets(targets()).kept).toEqual([edited]);
    expect(removeAgentSyncAssets(targets()).kept).toEqual([edited]);
    expect(readFileSync(join(edited, 'SKILL.md'), 'utf8')).toBe(before);
  });

  test('mixed tree: clean removed, modified kept, in one pass', () => {
    const clean = managedSkill(join(claudeDir, 'skills'), 'wish');
    const edited = modifiedManagedSkill(join(codexDir, 'skills', '.curated'), 'review');

    const { removed, kept, failures } = removeAgentSyncAssets(targets());
    expect(removed).toEqual([clean]);
    expect(kept).toEqual([edited]);
    expect(failures).toEqual([]);
    expect(existsSync(clean)).toBe(false);
    expect(existsSync(edited)).toBe(true);
  });

  test('a durable batch allowlist does not absorb a later managed sibling', () => {
    const planned = managedSkill(join(claudeDir, 'skills'), 'wish');
    const later = managedSkill(join(claudeDir, 'skills'), 'review');

    const result = removeAgentSyncAssets(targets(), {
      plannedAssets: [{ path: planned, identity: skillIdentity(planned) }],
    });

    expect(result.removed).toEqual([planned]);
    expect(existsSync(later)).toBe(true);
  });

  test('collectAgentSyncAssets scoped to a path digests only that path, not its siblings', () => {
    // Guards the O(N) batch cost: a per-member removal re-collects once per member,
    // and each such call must digest only the planned path — never every sibling.
    const a = managedSkill(join(claudeDir, 'skills'), 'wish');
    const b = managedSkill(join(claudeDir, 'skills'), 'review');

    expect(collectAgentSyncAssets(targets(), new Set([resolve(a)])).map((asset) => asset.path)).toEqual([a]);
    // An unrestricted scan still sees both — the scope only bounds the work, not the contract.
    expect(
      collectAgentSyncAssets(targets())
        .map((asset) => asset.path)
        .sort(),
    ).toEqual([a, b].sort());
  });

  test('a recorded removable asset modified after the batch is preserved, not blocking (F43 contract)', () => {
    const planned = managedSkill(join(claudeDir, 'skills'), 'wish');
    const identity = skillIdentity(planned);
    // The user edits the recorded-clean asset after the batch captured its identity.
    writeFileSync(join(planned, 'SKILL.md'), '# my precious local edits\n', 'utf8');

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: planned, identity }] });

    // New semantics: preserved byte-identical with NO failure so the batch clears.
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([planned]);
    expect(result.identityMismatch).toEqual([]); // modified in place, not a swap
    expect(result.failures).toEqual([]);
    expect(readFileSync(join(planned, 'SKILL.md'), 'utf8')).toBe('# my precious local edits\n');
  });

  test('F43: a recorded skill replaced by a different managed-clean tree is preserved, not removed', () => {
    const parent = join(claudeDir, 'skills');
    const original = managedSkill(parent, 'wish');
    const recordedIdentity = skillIdentity(original);
    // Attacker replaces the UNSTARTED recorded tree with a DIFFERENT managed-clean
    // tree (its own valid manifest, different digest) at the same path.
    rmSync(original, { recursive: true, force: true });
    const replacement = managedSkill(parent, 'wish');
    reStampManagedSkill(replacement, '# a totally different but still managed skill\n');
    expect(computeDirDigest(replacement)).not.toBe(recordedIdentity.contentDigest);

    const result = removeAgentSyncAssets(targets(), {
      plannedAssets: [{ path: original, identity: recordedIdentity }],
    });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([replacement]);
    expect(result.identityMismatch).toEqual([replacement]);
    expect(result.failures).toEqual([]);
    expect(existsSync(replacement)).toBe(true);
    expect(readFileSync(join(replacement, 'SKILL.md'), 'utf8')).toBe('# a totally different but still managed skill\n');
  });

  test('identity-bound removal proceeds for a matching skill', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');

    const result = removeAgentSyncAssets(targets(), {
      plannedAssets: [{ path: managed, identity: skillIdentity(managed) }],
    });

    expect(result.removed).toEqual([managed]);
    expect(result.identityMismatch).toEqual([]);
    expect(existsSync(managed)).toBe(false);
  });

  test('an absent planned asset yields no work and no failure (trivially already-removed)', () => {
    const gone = join(claudeDir, 'skills', 'wish');

    const result = removeAgentSyncAssets(targets(), {
      plannedAssets: [
        { path: gone, identity: { kind: 'skill', contentDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) } },
      ],
    });

    expect(result).toEqual({ removed: [], kept: [], identityMismatch: [], failures: [] });
  });

  test('asset removal I/O failures are structured and leave the asset retryable', () => {
    const parent = join(claudeDir, 'skills');
    const managed = managedSkill(parent, 'wish');
    chmodSync(parent, 0o500);
    try {
      const result = removeAgentSyncAssets(targets());
      expect(result.removed).toEqual([]);
      expect(result.failures[0]?.path).toBe(managed);
      expect(existsSync(managed)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  // R6: uninstall is classifier-only. It must never delete the Codex fallback
  // retirement quarantine (retained transaction evidence), even though the
  // quarantined trees themselves carry genie-agent-sync markers.
  function snapshotTree(root: string): Map<string, string> {
    const snap = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir).sort()) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        const rel = path.slice(root.length);
        if (stat.isSymbolicLink()) snap.set(rel, `symlink:${readlinkSync(path)}`);
        else if (stat.isDirectory()) {
          snap.set(rel, 'dir');
          walk(path);
        } else snap.set(rel, `file:${readFileSync(path, 'utf8')}`);
      }
    };
    walk(root);
    return snap;
  }

  function seedRetirementQuarantine(): string {
    const root = join(agentsSkillsDir, '.genie-codex-fallback-retirement');
    const txn = join(root, 'txn-deadbeef');
    const quarantined = managedSkill(join(txn, 'quarantine'), 'wish');
    writeFileSync(join(txn, 'journal.json'), '{"version":1}\n', 'utf8');
    writeFileSync(join(txn, 'COMMITTED'), '', 'utf8');
    // A changed-tree evidence copy archived aside (Group A conflict class).
    mkdirSync(join(txn, 'evidence', 'wish'), { recursive: true });
    writeFileSync(join(txn, 'evidence', 'wish', 'SKILL.md'), '# changed personal copy\n', 'utf8');
    // A symlink inside quarantine must survive by link target (lstat), never followed.
    symlinkSync('missing-target', join(quarantined, 'personal-link'));
    return root;
  }

  test('R6: retirement quarantine is never collected and stays byte/link-identical through uninstall', () => {
    mkdirSync(agentsSkillsDir, { recursive: true });
    const quarantineRoot = seedRetirementQuarantine();
    const liveClean = managedSkill(agentsSkillsDir, 'review');
    const before = snapshotTree(quarantineRoot);

    const collected = collectAgentSyncAssets(targets()).map((a) => a.path);
    // Nothing under the quarantine root is ever collected as a managed asset.
    expect(collected.some((p) => p.startsWith(quarantineRoot))).toBe(false);
    // The live clean fallback IS still an uninstall target.
    expect(collected).toContain(liveClean);

    const result = removeAgentSyncAssets(targets());
    expect(result.removed).toContain(liveClean);
    expect(result.failures).toEqual([]);
    expect(existsSync(liveClean)).toBe(false);
    // Quarantine tree unchanged byte-for-byte and link-for-link.
    expect(snapshotTree(quarantineRoot)).toEqual(before);
    expect(
      lstatSync(join(quarantineRoot, 'txn-deadbeef', 'quarantine', 'wish', 'personal-link')).isSymbolicLink(),
    ).toBe(true);
  });

  test('R6: uninstall source requires no plugin health — no probe, launcher, or plugin-enable calls', () => {
    const source = readFileSync(join(import.meta.dir, 'uninstall.ts'), 'utf8');
    expect(source).not.toContain('probeCodexGeniePlugin');
    expect(source).not.toContain('runBoundedCodexMcpSession');
    expect(source).not.toContain('proveCodexPluginHealth');
    // Never re-enables a plugin during teardown.
    expect(source).not.toMatch(/plugin['"]\s*,\s*['"]enable/);
  });

  test('digest-owned council.js and its sidecar are removed; an unmanaged lookalike is kept', () => {
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const sidecar = join(workflows, WORKFLOW_MANIFEST_NAME);
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "export const meta = { name: 'council' };\nconst LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });

    let result = removeAgentSyncAssets(targets());
    expect(result.removed).toContain(council);
    expect(existsSync(council)).toBe(false);
    expect(existsSync(sidecar)).toBe(false);

    writeFileSync(council, 'console.log("my own workflow");\n', 'utf8');
    result = removeAgentSyncAssets(targets());
    expect(result.removed).not.toContain(council);
    expect(existsSync(council)).toBe(true);
  });

  test('modified or corrupt-metadata council workflows fail closed and remain byte-identical', () => {
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const sidecar = join(workflows, WORKFLOW_MANIFEST_NAME);
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "const LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });
    writeFileSync(council, 'console.log("my edited workflow");\n', 'utf8');
    const modifiedCouncil = readFileSync(council, 'utf8');
    const validSidecar = readFileSync(sidecar, 'utf8');

    let result = removeAgentSyncAssets(targets());
    expect(result.kept).toContain(council);
    expect(readFileSync(council, 'utf8')).toBe(modifiedCouncil);
    expect(readFileSync(sidecar, 'utf8')).toBe(validSidecar);

    writeFileSync(sidecar, '{broken', 'utf8');
    result = removeAgentSyncAssets(targets());
    expect(result.kept).toContain(council);
    expect(readFileSync(council, 'utf8')).toBe(modifiedCouncil);
    expect(readFileSync(sidecar, 'utf8')).toBe('{broken');
  });

  test('uninstall parks and revalidates council files before deletion', () => {
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "const LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });

    const result = removeAgentSyncAssets(targets(), {
      beforeWorkflowRemoval(stage) {
        if (stage === 'before-park') writeFileSync(council, '// personal council race\n');
      },
    });

    expect(result.removed).toEqual([]);
    expect(result.failures[0]?.path).toBe(council);
    expect(readFileSync(council, 'utf8')).toBe('// personal council race\n');
  });

  test('published council transaction recovery failure blocks every destructive asset removal', () => {
    const skill = managedSkill(join(claudeDir, 'skills'), 'wish');
    const transaction = join(claudeDir, 'workflows', '.council.genie-txn-crashed');
    mkdirSync(transaction, { recursive: true });

    const result = removeAgentSyncAssets(targets());

    expect(result.removed).toEqual([]);
    expect(result.failures[0]?.detail).toContain('pending council workflow transaction could not be recovered');
    expect(existsSync(skill)).toBe(true);
  });

  test('a preserved managed-skill transaction conflict blocks authoritative enumeration and removal', () => {
    const skill = managedSkill(join(claudeDir, 'skills'), 'wish');
    const conflict = join(claudeDir, 'skills', '.genie-sync-transactions', '.conflict-delete-crashed');
    mkdirSync(join(conflict, 'parked'), { recursive: true });

    expect(hasPendingUninstallTransactions(targets())).toBe(true);
    expect(() => recoverUninstallTransactions(targets())).toThrow(
      'unresolved managed-skill transaction conflict requires review',
    );

    const result = removeAgentSyncAssets(targets());
    expect(result.removed).toEqual([]);
    expect(result.failures[0]?.detail).toContain('unresolved managed-skill transaction conflict requires review');
    expect(existsSync(skill)).toBe(true);
    expect(existsSync(conflict)).toBe(true);
  });

  test('hermes symlink into the genie home is removed; one pointing elsewhere is kept', () => {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    const link = join(hermesHome, 'plugins', 'genie');
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), link);

    expect(removeAgentSyncAssets(targets()).removed).toContain(link);
    expect(existsSync(link)).toBe(false);

    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, link);
    expect(removeAgentSyncAssets(targets()).removed).not.toContain(link);
    expect(existsSync(link)).toBe(true);
  });

  test('all owned Hermes profile links are removed, not only the main link', () => {
    const profileLink = join(hermesHome, 'profiles', 'work', 'plugins', 'genie');
    mkdirSync(join(hermesHome, 'profiles', 'work', 'plugins'), { recursive: true });
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), profileLink);

    const result = removeAgentSyncAssets(targets());

    expect(result.removed).toContain(profileLink);
    expect(existsSync(profileLink)).toBe(false);
  });

  test('a real (non-symlink) dir at hermes plugins/genie is never removed', () => {
    const link = join(hermesHome, 'plugins', 'genie');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'plugin.json'), '{}', 'utf8');

    expect(removeAgentSyncAssets(targets()).removed).not.toContain(link);
    expect(existsSync(link)).toBe(true);
  });

  test('empty / agentless home → nothing collected, nothing removed', () => {
    expect(collectAgentSyncAssets(targets())).toEqual([]);
    expect(removeAgentSyncAssets(targets())).toEqual({ removed: [], kept: [], identityMismatch: [], failures: [] });
  });

  test('identity-bound removal proceeds for a matching council workflow', () => {
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "const LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });
    const identity = collectAgentSyncAssets(targets()).find((a) => a.path === council)?.identity;
    if (identity?.kind !== 'workflow') throw new Error('expected a workflow identity for the stamped council');

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: council, identity }] });

    expect(result.removed).toContain(council);
    expect(existsSync(council)).toBe(false);
  });

  test('a council workflow re-stamped after the batch is preserved (identity mismatch)', () => {
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "const LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });
    const recorded = collectAgentSyncAssets(targets()).find((a) => a.path === council)?.identity;
    if (recorded?.kind !== 'workflow') throw new Error('expected a workflow identity for the stamped council');
    // Re-stamp with a different plugin root → different target digest, still managed-clean.
    stampWorkflow({ templatePath: template, pluginRoot: '/y', targetDir: workflows });

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: council, identity: recorded }] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([council]);
    expect(result.identityMismatch).toEqual([council]);
    expect(existsSync(council)).toBe(true);
  });

  test('a recorded identity of a different kind than the collected asset is preserved, never removed unbound', () => {
    // The path is now a clean council workflow, but the batch recorded a SKILL
    // identity for it. A kind mismatch must be refused, not degraded to an
    // unbound (identity-free) removal of the clean council.
    const workflows = join(claudeDir, 'workflows');
    const council = join(workflows, 'council.js');
    const template = join(tmp, 'council-template.js');
    writeFileSync(template, "const LENS_ROOT = '__GENIE_LENS_ROOT__';\n");
    stampWorkflow({ templatePath: template, pluginRoot: '/x', targetDir: workflows });
    const mismatchedKind = { kind: 'skill' as const, contentDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64) };

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: council, identity: mismatchedKind }] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([council]);
    expect(result.identityMismatch).toEqual([council]);
    expect(existsSync(council)).toBe(true);
  });

  test('identity-bound removal proceeds for a matching hermes link', () => {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    const link = join(hermesHome, 'plugins', 'genie');
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), link);
    const identity = collectAgentSyncAssets(targets()).find((a) => a.path === link)?.identity;
    if (identity?.kind !== 'link') throw new Error('expected a link identity for the hermes symlink');

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: link, identity }] });

    expect(result.removed).toContain(link);
    expect(existsSync(link)).toBe(false);
  });

  test('a hermes link repointed after the batch is preserved, not unlinked (identity mismatch)', () => {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    const link = join(hermesHome, 'plugins', 'genie');
    const originalTarget = join(genieHome, 'plugins', 'hermes-genie');
    symlinkSync(originalTarget, link);
    const recordedStat = lstatSync(link);
    const recorded = {
      kind: 'link' as const,
      target: originalTarget,
      identity: { dev: recordedStat.dev, ino: recordedStat.ino, mode: recordedStat.mode },
    };
    // Repoint to a different owned target inside the genie home (still collected).
    const otherTarget = join(genieHome, 'plugins', 'hermes-genie-2');
    mkdirSync(otherTarget, { recursive: true });
    rmSync(link);
    symlinkSync(otherTarget, link);

    const result = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: link, identity: recorded }] });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([link]);
    expect(result.identityMismatch).toEqual([link]);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(otherTarget);
  });

  test('F43 end-to-end: an unstarted recorded skill swapped before retry is preserved and the batch clears', () => {
    const parent = join(claudeDir, 'skills');
    const skill = managedSkill(parent, 'wish');
    const identity = skillIdentity(skill);
    const member = uninstallBatchMemberId('asset', skill);
    const batchScope: UninstallBatchScope = {
      agentAssets: [{ path: skill, disposition: 'remove', identity }],
      codexRoleAgents: [],
      codexRoleInventoryStatus: 'missing',
      genieHomeIdentity: null,
      genieHomeRemovalDigest: null,
      ownedRules: null,
      removeMarketplace: false,
      runtimeClients: { codex: false, claude: false },
      runtimePlugins: { codex: false, claude: false },
      symlinks: [],
    };
    // Mirrors the production per-asset wiring (removeSyncedAgentAssets) but against
    // injected tmp targets so the real HOME is never touched.
    const cleanupOneSkill: Parameters<typeof executeUninstallBatch>[2] = (_scope, progress) => {
      if (progress.isCompleted(member) || progress.isPreserved(member)) return { failures: [] };
      progress.begin(member);
      const removal = removeAgentSyncAssets(targets(), { plannedAssets: [{ path: skill, identity }] });
      if (removal.failures.length > 0) {
        progress.abort(member);
        return { failures: removal.failures.map((f) => ({ step: 'asset', detail: f.detail })) };
      }
      if (removal.kept.length > 0) {
        progress.preserve(member);
        return { failures: [] };
      }
      progress.complete(member);
      return { failures: [] };
    };

    // Attempt 1 fails before the skill member is ever started (skill stays unstarted).
    const first = executeUninstallBatch(genieHome, batchScope, () => ({
      failures: [{ step: 'earlier step', detail: 'boom' }],
    }));
    expect(first.result.failures).toHaveLength(1);
    expect(readUninstallBatchDecision(genieHome)?.progress).toEqual({ active: null, completed: [], preserved: [] });

    // Between attempts, the unstarted recorded tree is replaced by a DIFFERENT
    // managed-clean tree at the same path (the F43 attack).
    rmSync(skill, { recursive: true, force: true });
    const replacement = managedSkill(parent, 'wish');
    reStampManagedSkill(replacement, '# swapped in between attempts\n');
    expect(computeDirDigest(replacement)).not.toBe(identity.contentDigest);

    // Retry: the replacement is refused (identity mismatch), durably preserved, and
    // the batch clears because completed ∪ preserved covers every member.
    const retry = executeUninstallBatch(genieHome, batchScope, cleanupOneSkill);
    expect(retry.result.failures).toEqual([]);
    expect(retry.decision.progress.preserved).toEqual([member]);
    expect(retry.decision.progress.completed).toEqual([]);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
    expect(existsSync(replacement)).toBe(true);
    expect(readFileSync(join(replacement, 'SKILL.md'), 'utf8')).toBe('# swapped in between attempts\n');
  });
  test('collects only flat Claude agents represented in the shared manifest', () => {
    const scout = managedAgent('scout.md');
    const own = join(claudeDir, 'agents', 'my-own-agent.md');
    writeFileSync(own, '# entirely mine\n', 'utf8');

    const assets = collectAgentSyncAssets(targets());
    const agentPaths = assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.path);

    expect(agentPaths).toEqual([scout]);
    expect(agentPaths).not.toContain(own);
  });

  test('agent uninstall backs up/removes clean entries, keeps modified bytes, and never touches user files', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const reviewer = managedAgent('reviewer.md', '# shipped reviewer\n');
    const reviewerBytes = Buffer.from('# reviewer with local edits\n');
    writeFileSync(reviewer, reviewerBytes);
    const own = join(claudeDir, 'agents', 'my-own-agent.md');
    const ownBytes = Buffer.from([0x23, 0x20, 0x6d, 0x79, 0x20, 0x6f, 0x77, 0x6e, 0x0a]);
    writeFileSync(own, ownBytes);

    const { removed, kept } = removeAgentSyncAssets(targets());
    const reviewerKept = `${reviewer}.genie-kept`;

    expect(removed).toContain(scout);
    expect(existsSync(scout)).toBe(false);
    expect(kept).toContain(reviewerKept);
    expect(existsSync(reviewer)).toBe(false);
    expect(readFileSync(reviewerKept)).toEqual(reviewerBytes);
    expect(readFileSync(own)).toEqual(ownBytes);
    expect(readAgentFilesManifest(join(claudeDir, 'agents'))).toBeNull();

    const backup = join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z',
      'claude',
      'agents',
      'scout.md',
    );
    expect(readFileSync(backup, 'utf8')).toBe('# shipped scout\n');
  });

  test('a symlink backup collision and its victim survive while uninstall allocates a distinct root', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const collision = uninstallBackupCollisionPath();
    const victim = join(tmp, 'uninstall-backup-symlink-victim');
    const victimBytes = Buffer.from('symlink victim bytes\n');
    writeFileSync(victim, victimBytes);
    mkdirSync(dirname(collision), { recursive: true });
    symlinkSync(victim, collision);

    const result = removeAgentSyncAssets(targets());
    const distinctBackup = join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z-1',
      'claude',
      'agents',
      'scout.md',
    );

    expect(result.removed).toEqual([scout]);
    expect(lstatSync(collision).isSymbolicLink()).toBe(true);
    expect(readFileSync(victim)).toEqual(victimBytes);
    expect(readFileSync(distinctBackup, 'utf8')).toBe('# shipped scout\n');
  });

  test('a multiply-linked backup collision preserves both prior names and creates a distinct backup', () => {
    managedAgent('scout.md', '# shipped scout\n');
    const collision = uninstallBackupCollisionPath();
    const victim = join(tmp, 'uninstall-backup-hardlink-victim');
    const victimBytes = Buffer.from('hardlink victim bytes\n');
    writeFileSync(victim, victimBytes);
    mkdirSync(dirname(collision), { recursive: true });
    linkSync(victim, collision);

    removeAgentSyncAssets(targets());
    const distinctBackup = join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z-1',
      'claude',
      'agents',
      'scout.md',
    );

    expect(lstatSync(victim).nlink).toBe(2);
    expect(readFileSync(victim)).toEqual(victimBytes);
    expect(readFileSync(collision)).toEqual(victimBytes);
    expect(readFileSync(distinctBackup, 'utf8')).toBe('# shipped scout\n');
  });

  test('an existing regular backup collision is never overwritten', () => {
    managedAgent('scout.md', '# shipped scout\n');
    const collision = uninstallBackupCollisionPath();
    const collisionBytes = Buffer.from('prior regular backup\n');
    mkdirSync(dirname(collision), { recursive: true });
    writeFileSync(collision, collisionBytes);

    removeAgentSyncAssets(targets());
    const distinctBackup = join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z-1',
      'claude',
      'agents',
      'scout.md',
    );

    expect(readFileSync(collision)).toEqual(collisionBytes);
    expect(readFileSync(distinctBackup, 'utf8')).toBe('# shipped scout\n');
  });

  test('a replacement at the captured-to-remove boundary survives live and stays unowned', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const replacementBytes = Buffer.from('# concurrent replacement\n');
    let crossedBarrier = false;

    const result = removeAgentSyncAssets({
      ...targets(),
      beforeAgentFileMutation: (event) => {
        if (!crossedBarrier && event.operation === 'remove' && event.path === scout) {
          crossedBarrier = true;
          writeFileSync(scout, replacementBytes);
        }
      },
    });

    expect(crossedBarrier).toBe(true);
    expect(result.removed).not.toContain(scout);
    expect(result.kept).toEqual([]);
    expect(readFileSync(scout)).toEqual(replacementBytes);
    expect(readAgentFilesManifest(join(claudeDir, 'agents'))).toBeNull();
    expect(result.advisories?.some((line) => line.includes('concurrently appeared'))).toBe(true);
    expect(
      readFileSync(
        join(
          genieHome,
          'state-backups',
          'agent-sync-uninstall-2026-07-11T12:00:00.000Z',
          'claude',
          'agents',
          'scout.md',
        ),
      ),
    ).toEqual(Buffer.from('# shipped scout\n'));
  });

  test('a replacement at the captured-to-keep boundary stays live while prior edits are kept', () => {
    const reviewer = managedAgent('reviewer.md', '# shipped reviewer\n');
    writeFileSync(reviewer, '# initial local edit\n');
    const newestBytes = Buffer.from('# newest edit at barrier\n');

    const result = removeAgentSyncAssets({
      ...targets(),
      beforeAgentFileMutation: (event) => {
        if (event.operation === 'keep' && event.path === reviewer) writeFileSync(reviewer, newestBytes);
      },
    });

    expect(result.kept).toHaveLength(1);
    expect(readFileSync(result.kept[0] as string, 'utf8')).toBe('# initial local edit\n');
    expect(readFileSync(reviewer)).toEqual(newestBytes);
    expect(readAgentFilesManifest(join(claudeDir, 'agents'))).toBeNull();
    expect(result.advisories?.some((line) => line.includes('concurrently appeared'))).toBe(true);
  });

  test('manifest CAS failure restores exact staged bytes and never claims removal', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const agentsDir = join(claudeDir, 'agents');
    const manifestPath = join(agentsDir, '.genie-sync.json');
    const scoutBytes = readFileSync(scout);
    let changedDigest = '';

    const result = removeAgentSyncAssets({
      ...targets(),
      beforeAgentFileMutation: (event) => {
        if (event.operation !== 'remove' || event.path !== scout) return;
        const manifest = readAgentFilesManifest(agentsDir);
        if (manifest === null) throw new Error('fixture manifest missing at CAS barrier');
        changedDigest = 'f'.repeat(64);
        manifest.files['scout.md'] = { ...manifest.files['scout.md']!, digest: changedDigest };
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    });

    expect(result.removed).not.toContain(scout);
    expect(result.kept).toEqual([]);
    expect(readFileSync(scout)).toEqual(scoutBytes);
    expect(readAgentFilesManifest(agentsDir)?.files['scout.md']?.digest).toBe(changedDigest);
    expect(result.advisories?.some((line) => line.includes('manifest ownership changed'))).toBe(true);
  });

  test('a manifest-owned directory at an agent filename is preserved at an exclusive kept path', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    rmSync(scout);
    mkdirSync(scout);
    writeFileSync(join(scout, 'precious.txt'), 'directory bytes\n');

    const result = removeAgentSyncAssets(targets());

    expect(result.kept).toEqual([`${scout}.genie-kept`]);
    expect(readFileSync(join(`${scout}.genie-kept`, 'precious.txt'), 'utf8')).toBe('directory bytes\n');
    expect(existsSync(scout)).toBe(false);
  });

  test('a manifest-owned symlink is kept as a symlink without following or changing its victim', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const victim = join(tmp, 'agent-symlink-victim');
    const victimBytes = Buffer.from('victim stays untouched\n');
    writeFileSync(victim, victimBytes);
    rmSync(scout);
    symlinkSync(victim, scout);

    const result = removeAgentSyncAssets(targets());
    const keptPath = `${scout}.genie-kept`;

    expect(result.kept).toEqual([keptPath]);
    expect(lstatSync(keptPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(keptPath)).toBe(victim);
    expect(readFileSync(victim)).toEqual(victimBytes);
  });

  test('the shared sync lock makes uninstall fail closed without touching live or manifest bytes', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const manifestPath = join(claudeDir, 'agents', '.genie-sync.json');
    const manifestBytes = readFileSync(manifestPath);
    writeFileSync(join(genieHome, '.agent-sync.lock'), 'holder\n');

    const result = removeAgentSyncAssets(targets());

    expect(result.skipped).toContain('holds the lock');
    expect(readFileSync(scout, 'utf8')).toBe('# shipped scout\n');
    expect(readFileSync(manifestPath)).toEqual(manifestBytes);
  });

  test('an absent GENIE_HOME still permits backup-first removal of an external manifest-owned agent', () => {
    const scout = managedAgent('scout.md', '# shipped outside an absent home\n');
    const agentsDir = join(claudeDir, 'agents');
    const manifestPath = join(agentsDir, '.genie-sync.json');
    rmSync(genieHome, { recursive: true, force: true });
    expect(existsSync(genieHome)).toBe(false);

    const result = removeAgentSyncAssets(targets());

    expect(result.failures).toEqual([]);
    expect(result.removed).toEqual([scout]);
    expect(existsSync(scout)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);
    expect(readAgentFilesManifest(agentsDir)).toBeNull();
    expect(readFileSync(uninstallBackupCollisionPath(), 'utf8')).toBe('# shipped outside an absent home\n');
    expect(existsSync(join(genieHome, '.agent-sync.lock'))).toBe(false);
  });

  test('fixed staging debris remains byte-identical while two uninstall runs converge', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const agentsDir = join(claudeDir, 'agents');
    const manifestDebris = join(agentsDir, '.genie-sync.json.genie-sync.staging');
    const uninstallDebris = join(agentsDir, '.genie-uninstall.staging');
    const manifestDebrisBytes = Buffer.from('manifest stage debris\n');
    const uninstallDebrisBytes = Buffer.from('uninstall stage debris\n');
    writeFileSync(manifestDebris, manifestDebrisBytes);
    writeFileSync(uninstallDebris, uninstallDebrisBytes);

    const first = removeAgentSyncAssets(targets());
    const second = removeAgentSyncAssets(targets());

    expect(first.removed).toEqual([scout]);
    expect(second).toEqual({ removed: [], kept: [], identityMismatch: [], failures: [] });
    expect(readFileSync(manifestDebris)).toEqual(manifestDebrisBytes);
    expect(readFileSync(uninstallDebris)).toEqual(uninstallDebrisBytes);
  });

  test('modified-agent kept allocation never overwrites prior base or timestamp artifacts', () => {
    const reviewer = managedAgent('reviewer.md', '# shipped reviewer\n');
    const editedBytes = Buffer.from('# newest local reviewer edits\n');
    writeFileSync(reviewer, editedBytes);
    const baseKept = `${reviewer}.genie-kept`;
    const timestampKept = `${baseKept}-${fixedNow().getTime()}`;
    const baseBytes = Buffer.from('# older base kept artifact\n');
    const timestampBytes = Buffer.from('# older timestamp kept artifact\n');
    writeFileSync(baseKept, baseBytes);
    writeFileSync(timestampKept, timestampBytes);

    const result = removeAgentSyncAssets(targets());
    const newestKept = `${timestampKept}-1`;

    expect(result.kept).toEqual([newestKept]);
    expect(readFileSync(baseKept)).toEqual(baseBytes);
    expect(readFileSync(timestampKept)).toEqual(timestampBytes);
    expect(readFileSync(newestKept)).toEqual(editedBytes);
    expect(existsSync(reviewer)).toBe(false);
  });

  test('missing manifest-owned files are pruned and a second uninstall is a strict no-op', () => {
    const live = managedAgent('live.md', '# live managed agent\n');
    const parent = join(claudeDir, 'agents');
    const manifest = readAgentFilesManifest(parent);
    if (manifest === null) throw new Error('fixture manifest missing');
    manifest.files['missing.md'] = {
      digest: 'd'.repeat(64),
      version: '1.0.0',
      syncedAt: '2026-07-11T10:00:00.000Z',
    };
    writeFileSync(join(parent, '.genie-sync.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const first = removeAgentSyncAssets(targets());

    expect(first.removed).toEqual([live]);
    expect(first.kept).toEqual([]);
    expect(existsSync(live)).toBe(false);
    expect(readAgentFilesManifest(parent)).toBeNull();
    expect(removeAgentSyncAssets(targets())).toEqual({ removed: [], kept: [], identityMismatch: [], failures: [] });
  });

  test('the fully injected uninstall flow is a strict second-run no-op with backups-only GENIE_HOME', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const own = join(claudeDir, 'agents', 'my-own-agent.md');
    const ownBytes = Buffer.from([0x00, 0x23, 0x20, 0x6d, 0x69, 0x6e, 0x65, 0xff]);
    writeFileSync(own, ownBytes);
    const installState = join(genieHome, 'plugins', 'genie', 'payload.txt');
    mkdirSync(join(genieHome, 'plugins', 'genie'), { recursive: true });
    writeFileSync(installState, 'remove me\n', 'utf8');

    let runtimeRemovalCalls = 0;
    const dependencies = {
      agentSyncTargets: targets(),
      orchestrationRulesPath: join(tmp, 'no-legacy-rules'),
      removeRuntimeIntegrations: () => {
        runtimeRemovalCalls += 1;
      },
    };

    performUninstall(false, [], genieHome, true, true, false, dependencies);

    const backup = join(
      genieHome,
      'state-backups',
      'agent-sync-uninstall-2026-07-11T12:00:00.000Z',
      'claude',
      'agents',
      'scout.md',
    );
    expect(existsSync(scout)).toBe(false);
    expect(readFileSync(backup, 'utf8')).toBe('# shipped scout\n');
    expect(readFileSync(own)).toEqual(ownBytes);
    expect(existsSync(installState)).toBe(false);
    expect(hasRemovableGenieInstallState(genieHome)).toBe(false);
    expect(runtimeRemovalCalls).toBe(1);

    const backupBytes = readFileSync(backup);
    performUninstall(false, [], genieHome, true, true, false, dependencies);

    expect(runtimeRemovalCalls).toBe(1);
    expect(readFileSync(backup)).toEqual(backupBytes);
    expect(readFileSync(own)).toEqual(ownBytes);
  });

  test('full uninstall preserves a foreign empty GENIE_HOME swapped in while its lock is held', () => {
    const displacedHome = join(tmp, 'displaced-lock-home');
    const foreignIdentity = { dev: -1, ino: -1, mode: -1 };
    let runtimeRemovalCalls = 0;
    rmSync(genieHome, { recursive: true, force: true });

    performUninstall(false, [], genieHome, false, false, true, {
      agentSyncTargets: { genieHome },
      removeRuntimeIntegrations: () => {
        runtimeRemovalCalls += 1;
        expect(existsSync(join(genieHome, '.agent-sync.lock'))).toBe(true);
        renameSync(genieHome, displacedHome);
        mkdirSync(genieHome);
        const stat = lstatSync(genieHome);
        foreignIdentity.dev = stat.dev;
        foreignIdentity.ino = stat.ino;
        foreignIdentity.mode = stat.mode;
      },
    });

    expect(runtimeRemovalCalls).toBe(1);
    const after = lstatSync(genieHome);
    expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual(foreignIdentity);
    expect(readdirSync(genieHome)).toEqual([]);
    expect(existsSync(join(displacedHome, '.agent-sync.lock'))).toBe(true);
  });

  test('compatibility uninstall preserves nested foreign bytes when the original child inode transits a replacement root', () => {
    const originalPayload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    mkdirSync(dirname(originalPayload), { recursive: true });
    writeFileSync(originalPayload, 'original\n');
    const displacedHome = join(tmp, 'displaced-home');
    const displacedForeignHome = join(tmp, 'displaced-foreign-home');
    const foreignBytes = Buffer.from('foreign must survive\n');
    const output: string[] = [];
    let capturedPath: string | null = null;
    let swapped = false;
    const log = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    });

    try {
      performUninstall(false, [], genieHome, true, false, false, {
        agentSyncTargets: targets(),
        removeRuntimeIntegrations: () => {},
        genieHomeRemoval: {
          beforeEntryCapture: () => {
            if (swapped) return;
            swapped = true;
            renameSync(genieHome, displacedHome);
            mkdirSync(genieHome);
            // Move A's already-authorized top-level inode into replacement root
            // B, then add foreign nested bytes beneath that SAME inode.
            renameSync(join(displacedHome, 'plugins'), join(genieHome, 'plugins'));
            writeFileSync(join(genieHome, 'plugins', 'FOREIGN.txt'), foreignBytes);
            writeFileSync(join(genieHome, 'root-marker.txt'), foreignBytes);
          },
          afterEntryCapture: (_entry, captured) => {
            capturedPath = captured;
            renameSync(genieHome, displacedForeignHome);
            renameSync(displacedHome, genieHome);
          },
        },
      });
    } finally {
      log.mockRestore();
    }

    expect(swapped).toBe(true);
    expect(readFileSync(join(displacedForeignHome, 'root-marker.txt'))).toEqual(foreignBytes);
    const preservedCapture = requireCapturedPath(capturedPath);
    expect(readFileSync(join(preservedCapture, 'FOREIGN.txt'))).toEqual(foreignBytes);
    expect(readFileSync(join(preservedCapture, 'genie', 'payload.txt'), 'utf8')).toBe('original\n');
    expect(
      output.some((line) => line.includes('captured Genie install tree changed from its exact root-bound snapshot')),
    ).toBe(true);
    expect(output.some((line) => line.includes('Install state removed'))).toBe(false);
  });

  test('authenticated production batch preserves nested foreign bytes when the original child inode transits B', () => {
    const originalPayload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    mkdirSync(dirname(originalPayload), { recursive: true });
    writeFileSync(originalPayload, 'original\n');
    const displacedHome = join(tmp, 'batch-displaced-home');
    const displacedForeignHome = join(tmp, 'batch-displaced-foreign-home');
    const foreignBytes = Buffer.from('batch foreign must survive\n');
    let capturedPath: string | null = null;
    let swapped = false;

    const outcome = withIsolatedHomes(() =>
      performFreshUninstallPlan(genieHome, false, {
        beforeEntryCapture: () => {
          if (swapped) return;
          swapped = true;
          renameSync(genieHome, displacedHome);
          mkdirSync(genieHome);
          renameSync(join(displacedHome, 'plugins'), join(genieHome, 'plugins'));
          writeFileSync(join(genieHome, 'plugins', 'FOREIGN.txt'), foreignBytes);
          writeFileSync(join(genieHome, 'root-marker.txt'), foreignBytes);
        },
        afterEntryCapture: (_entry, captured) => {
          capturedPath = captured;
          renameSync(genieHome, displacedForeignHome);
          renameSync(displacedHome, genieHome);
        },
      }),
    );

    expect(swapped).toBe(true);
    expect(
      outcome.result.failures.some((failure) =>
        failure.detail.includes('captured Genie install tree changed from its exact root-bound snapshot'),
      ),
    ).toBe(true);
    expect(readFileSync(join(displacedForeignHome, 'root-marker.txt'))).toEqual(foreignBytes);
    const preservedCapture = requireCapturedPath(capturedPath);
    expect(readFileSync(join(preservedCapture, 'FOREIGN.txt'))).toEqual(foreignBytes);
    expect(readFileSync(join(preservedCapture, 'genie', 'payload.txt'), 'utf8')).toBe('original\n');
    const homeMember = uninstallBatchMemberId('home', resolve(genieHome));
    expect(readUninstallBatchDecision(genieHome)?.progress.completed).not.toContain(homeMember);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(true);
  });

  test('authenticated home commitment rejects a same-root descendant inserted after planning', () => {
    const payload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    const foreign = join(genieHome, 'plugins', 'FOREIGN.txt');
    const foreignBytes = Buffer.from('same-run foreign must survive\n');
    mkdirSync(dirname(payload), { recursive: true });
    writeFileSync(payload, 'planned source\n');
    let injected = false;

    const outcome = withIsolatedHomes(() =>
      performFreshUninstallPlan(genieHome, false, {
        beforeRemovalSnapshot: () => {
          if (injected) return;
          injected = true;
          writeFileSync(foreign, foreignBytes);
        },
      }),
    );

    expect(injected).toBe(true);
    expect(
      outcome.result.failures.some((failure) =>
        failure.detail.includes('changed after its authenticated removal commitment'),
      ),
    ).toBe(true);
    expect(readFileSync(foreign)).toEqual(foreignBytes);
    expect(readFileSync(payload, 'utf8')).toBe('planned source\n');
    const homeMember = uninstallBatchMemberId('home', resolve(genieHome));
    expect(readUninstallBatchDecision(genieHome)?.progress.completed).not.toContain(homeMember);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(true);
  });

  test('pending authenticated home commitment never widens to a descendant added before retry', () => {
    const payload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    const foreign = join(genieHome, 'plugins', 'FOREIGN-on-retry.txt');
    const foreignBytes = Buffer.from('pending-batch foreign must survive\n');
    mkdirSync(dirname(payload), { recursive: true });
    writeFileSync(payload, 'planned before interruption\n');
    const execution = withIsolatedHomes(() => inspectUninstallPlan(genieHome, false));
    if (execution.genieHomeIdentity === null || execution.genieHomeRemovalDigest === null) {
      throw new Error('fixture did not produce Genie home removal authority');
    }
    const pendingScope: UninstallBatchScope = {
      agentAssets: [],
      codexRoleAgents: [],
      codexRoleInventoryStatus: 'missing',
      genieHomeIdentity: execution.genieHomeIdentity,
      genieHomeRemovalDigest: execution.genieHomeRemovalDigest,
      ownedRules: null,
      removeMarketplace: false,
      runtimeClients: { codex: false, claude: false },
      runtimePlugins: { codex: false, claude: false },
      symlinks: [],
    };
    recordUninstallBatchDecision(genieHome, pendingScope);
    writeFileSync(foreign, foreignBytes);

    const firstRetry = withIsolatedHomes(() => performFreshUninstallPlan(genieHome, false));
    const secondRetry = withIsolatedHomes(() => performFreshUninstallPlan(genieHome, false));

    for (const retry of [firstRetry, secondRetry]) {
      expect(
        retry.result.failures.some((failure) =>
          failure.detail.includes('changed after its authenticated removal commitment'),
        ),
      ).toBe(true);
    }
    expect(readFileSync(foreign)).toEqual(foreignBytes);
    expect(readFileSync(payload, 'utf8')).toBe('planned before interruption\n');
    const decision = readUninstallBatchDecision(genieHome);
    expect(decision?.scope.genieHomeRemovalDigest).toBe(execution.genieHomeRemovalDigest);
    expect(decision?.progress.completed).not.toContain(uninstallBatchMemberId('home', resolve(genieHome)));
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(true);
  });

  test('late nested insertion survives the final non-recursive rmdir check without a completion receipt', () => {
    const payload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    const foreignBytes = Buffer.from('late foreign must survive\n');
    mkdirSync(dirname(payload), { recursive: true });
    writeFileSync(payload, 'planned source\n');
    let foreign: string | null = null;

    const outcome = withIsolatedHomes(() =>
      performFreshUninstallPlan(genieHome, false, {
        beforeDirectoryRemoval: (directory) => {
          if (foreign !== null) return;
          foreign = join(directory, 'LATE-FOREIGN.txt');
          writeFileSync(foreign, foreignBytes);
        },
      }),
    );

    const preservedForeign = requireCapturedPath(foreign);
    expect(readFileSync(preservedForeign)).toEqual(foreignBytes);
    expect(outcome.result.failures.some((failure) => failure.detail.includes('ENOTEMPTY'))).toBe(true);
    const homeMember = uninstallBatchMemberId('home', resolve(genieHome));
    expect(readUninstallBatchDecision(genieHome)?.progress.completed).not.toContain(homeMember);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(true);
  });

  test('authenticated uninstall rejects truncated ownership state before source removal', () => {
    const originalPayload = join(genieHome, 'plugins', 'genie', 'payload.txt');
    mkdirSync(dirname(originalPayload), { recursive: true });
    writeFileSync(originalPayload, 'keep source\n');
    const agentsDir = join(claudeDir, 'agents');
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, '.genie-sync.json'), '{"managedBy":"genie-agent-sync","files":{');

    expect(() => withIsolatedHomes(() => performFreshUninstallPlan(genieHome, false))).toThrow(
      'Claude agent ownership manifest is unsafe',
    );
    expect(readFileSync(originalPayload, 'utf8')).toBe('keep source\n');
  });

  test('INV1: uninstall preserves captured bytes mutated after validation instead of discarding them', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const agentsDir = join(claudeDir, 'agents');
    const mutatedBytes = Buffer.from('# mutated after capture\n');

    const result = removeAgentSyncAssets({
      ...targets(),
      beforeAgentFileMutation: (event) => {
        if (event.operation !== 'remove' || event.path !== scout) return;
        // The live file is already quarantined at this barrier; mutate the captured inode.
        const quarantine = readdirSync(agentsDir).find((name) => name.startsWith('.scout.md.agent-retire-'));
        if (quarantine === undefined) throw new Error('captured quarantine dir not found');
        writeFileSync(join(agentsDir, quarantine, 'object'), mutatedBytes);
      },
    });

    expect(result.removed).toEqual([scout]);
    expect(readAgentFilesManifest(agentsDir)).toBeNull();
    // the mutated bytes survive visibly instead of being unlinked into nothing
    expect(result.kept).toEqual([`${scout}.genie-kept`]);
    expect(readFileSync(`${scout}.genie-kept`)).toEqual(mutatedBytes);
    expect(result.advisories?.some((line) => line.includes('changed after validation'))).toBe(true);
    // the backup still holds exactly the validated bytes
    expect(readFileSync(uninstallBackupCollisionPath(), 'utf8')).toBe('# shipped scout\n');
  });

  test('INV4: a replacement manifest installed during relinquish is detected — never a false success', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const agentsDir = join(claudeDir, 'agents');
    const manifestPath = join(agentsDir, '.genie-sync.json');
    const replacement = {
      managedBy: MANAGED_BY,
      files: {
        'scout.md': {
          digest: 'e'.repeat(64),
          version: '2.0.0',
          syncedAt: '2026-07-11T11:00:00.000Z',
        },
      },
    };
    const replacementBytes = Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`);

    const result = removeAgentSyncAssets({
      ...targets(),
      // fires inside the removal commit, after the base manifest is captured away
      beforeAgentManifestCommit: () => {
        writeFileSync(manifestPath, replacementBytes);
      },
    });

    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(readFileSync(scout, 'utf8')).toBe('# shipped scout\n'); // rollback restored the live agent
    expect(readFileSync(manifestPath)).toEqual(replacementBytes); // the replacement stays live, unclobbered
    expect(result.advisories?.some((line) => line.includes('replacement manifest appeared'))).toBe(true);
    expect(result.advisories?.some((line) => line.includes('preserved previous manifest'))).toBe(true);
  });

  test('INV5: one lock spans asset removal and canonical-source deletion in the full uninstall', () => {
    const scout = managedAgent('scout.md', '# shipped scout\n');
    const sourcePayload = join(genieHome, 'plugins', 'genie', 'agents', 'scout.md');
    mkdirSync(dirname(sourcePayload), { recursive: true });
    writeFileSync(sourcePayload, '# canonical source\n', 'utf8');

    let probedDuringAssets = false;
    let probedBetween = false;
    const dependencies = {
      agentSyncTargets: {
        ...targets(),
        beforeAgentFileMutation: () => {
          probedDuringAssets = true;
          expect(acquireAgentSyncLock(genieHome)).toBeNull(); // lock held during asset removal
        },
      },
      orchestrationRulesPath: join(tmp, 'no-legacy-rules'),
      removeRuntimeIntegrations: () => {
        probedBetween = true;
        expect(acquireAgentSyncLock(genieHome)).toBeNull(); // still held in the former gap
        expect(existsSync(sourcePayload)).toBe(true); // canonical source not yet deleted
      },
    };

    performUninstall(false, [], genieHome, true, true, false, dependencies);

    expect(probedDuringAssets).toBe(true);
    expect(probedBetween).toBe(true);
    expect(existsSync(sourcePayload)).toBe(false); // source deleted under the same lock
    expect(existsSync(scout)).toBe(false);
    const released = acquireAgentSyncLock(genieHome);
    expect(released).not.toBeNull(); // lock released only after everything
    released?.release();
    expect(hasRemovableGenieInstallState(genieHome)).toBe(false);
  });

  test('INV6: an exception after staging restores the live agent — no hidden bytes, ownership intact', () => {
    const reviewer = managedAgent('reviewer.md', '# shipped reviewer\n');
    const editedBytes = Buffer.from('# precious local edits\n');
    writeFileSync(reviewer, editedBytes);
    const agentsDir = join(claudeDir, 'agents');

    const first = removeAgentSyncAssets({
      ...targets(),
      beforeAgentFileMutation: (event) => {
        if (event.operation === 'keep') throw new Error('injected post-staging fault');
      },
    });

    expect(first.kept).toEqual([]);
    expect(first.removed).toEqual([]);
    expect(readFileSync(reviewer)).toEqual(editedBytes); // live path restored, byte-identical
    expect(readAgentFilesManifest(agentsDir)?.files['reviewer.md']).toBeDefined(); // ownership unchanged
    expect(first.advisories?.some((line) => line.includes('injected post-staging fault'))).toBe(true);
    // no hidden staging or quarantine debris is left holding the bytes
    expect(readdirSync(agentsDir).sort()).toEqual(['.genie-sync.json', 'reviewer.md']);

    const second = removeAgentSyncAssets(targets()); // clean retry succeeds
    expect(second.kept).toEqual([`${reviewer}.genie-kept`]);
    expect(readFileSync(`${reviewer}.genie-kept`)).toEqual(editedBytes);
    expect(readAgentFilesManifest(agentsDir)).toBeNull();
  });
});

describe('durable uninstall batch', () => {
  let root: string;
  let genieHome: string;

  // The journal-mechanics tests exercise member ids (path-based), not physical
  // removal, so a synthetic-but-valid skill identity satisfies the v3 schema.
  const syntheticSkillIdentity = {
    kind: 'skill' as const,
    contentDigest: 'a'.repeat(64),
    manifestDigest: 'b'.repeat(64),
  };

  function scope(agentPaths: string[] = []): UninstallBatchScope {
    return {
      agentAssets: agentPaths.map((path) => ({ path, disposition: 'remove', identity: syntheticSkillIdentity })),
      codexRoleAgents: [],
      codexRoleInventoryStatus: 'missing',
      genieHomeIdentity: null,
      genieHomeRemovalDigest: null,
      ownedRules: null,
      removeMarketplace: false,
      runtimeClients: { codex: false, claude: false },
      runtimePlugins: { codex: false, claude: false },
      symlinks: [],
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
    const firstAsset = join(root, 'claude', 'skills', 'wish');
    const secondAsset = join(root, 'claude', 'skills', 'review');
    mkdirSync(firstAsset, { recursive: true });
    mkdirSync(secondAsset, { recursive: true });
    const plannedScope = scope([firstAsset, secondAsset]);
    const firstMember = uninstallBatchMemberId('asset', firstAsset);
    const secondMember = uninstallBatchMemberId('asset', secondAsset);
    const first = executeUninstallBatch(genieHome, plannedScope, (decisionScope, progress) => {
      events.push('cleanup-failed');
      expect(decisionScope.agentAssets.map((asset) => asset.path)).toEqual([firstAsset, secondAsset]);
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
    mkdirSync(firstAsset, { recursive: true });
    writeFileSync(join(firstAsset, 'later-user-data'), 'preserve me\n');

    const retried = executeUninstallBatch(
      genieHome,
      plannedScope,
      (decisionScope, progress) => {
        events.push('cleanup-retried');
        expect(existsSync(journalPath)).toBe(true);
        expect(decisionScope.agentAssets.map((asset) => asset.path)).toEqual([firstAsset, secondAsset]);
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
    expect(readFileSync(join(firstAsset, 'later-user-data'), 'utf8')).toBe('preserve me\n');
    expect(existsSync(journalPath)).toBe(false);
  });

  test('an interrupted member remains active and is never replayed automatically', () => {
    const asset = join(root, 'interrupted-asset');
    const member = uninstallBatchMemberId('asset', asset);
    const interruptedScope = scope([asset]);
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

  test('a returned partial flat-agent failure clears its active receipt so retry can converge', () => {
    const firstAsset = join(root, 'claude', 'agents', 'reviewer.md');
    const secondAsset = join(root, 'claude', 'agents', 'scout.md');
    mkdirSync(dirname(firstAsset), { recursive: true });
    writeFileSync(firstAsset, '# reviewer\n');
    writeFileSync(secondAsset, '# scout\n');
    const plannedScope = scope();
    plannedScope.agentAssets = [firstAsset, secondAsset].map((path) => ({
      path,
      disposition: 'remove' as const,
      identity: {
        kind: 'agent' as const,
        ownedDigest: 'a'.repeat(64),
        snapshot: { kind: 'file' as const, digest: 'a'.repeat(64), mode: 0o600 },
      },
    }));
    const member = uninstallBatchMemberId('asset', `flat-agents:${[firstAsset, secondAsset].sort().join('\n')}`);

    const first = executeUninstallBatch(genieHome, plannedScope, (_decisionScope, progress) => {
      progress.begin(member);
      rmSync(firstAsset);
      // Mirrors removeFlatAgentBatch after removeAgentSyncAssetsLocked returns a
      // structured partial result: completed effects are durable, no syscall is
      // still in flight, and retry authority must remain available.
      progress.abort(member);
      return { failures: [{ step: 'Removing flat agent', detail: 'injected reviewer failure' }] };
    });

    expect(first.result.failures).toHaveLength(1);
    expect(readUninstallBatchDecision(genieHome)?.progress.active).toBeNull();
    expect(existsSync(firstAsset)).toBe(false);
    expect(existsSync(secondAsset)).toBe(true);

    const retried = executeUninstallBatch(genieHome, plannedScope, (_decisionScope, progress) => {
      progress.begin(member);
      expect(existsSync(firstAsset)).toBe(false); // already-removed slot is an idempotent no-op
      rmSync(secondAsset);
      progress.complete(member);
      return { failures: [] };
    });

    expect(retried.result.failures).toEqual([]);
    expect(existsSync(secondAsset)).toBe(false);
    expect(readUninstallBatchDecision(genieHome)).toBeNull();
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
    const asset = join(root, 'unreceipted-asset');
    const plannedScope = scope([asset]);

    const result = executeUninstallBatch(genieHome, plannedScope, () => ({ failures: [] }));

    expect(result.result.failures[0]?.detail).toContain(
      'requested members lack durable completion or preservation receipts',
    );
    expect(readUninstallBatchDecision(genieHome)).not.toBeNull();
  });

  test('refuses to publish a progress receipt outside the exact recorded scope', () => {
    const planned = join(root, 'planned-asset');
    const unplanned = uninstallBatchMemberId('asset', join(root, 'later-asset'));

    expect(() =>
      executeUninstallBatch(genieHome, scope([planned]), (_decisionScope, progress) => {
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
    const duplicated = scope([join(root, 'asset'), join(root, 'asset')]);

    expect(() => recordUninstallBatchDecision(genieHome, duplicated)).toThrow('duplicate agent-asset paths');
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
    const preservedAsset = join(root, 'preserved-asset');
    const otherAsset = join(root, 'other-asset');
    const preservedMember = uninstallBatchMemberId('asset', preservedAsset);
    const otherMember = uninstallBatchMemberId('asset', otherAsset);

    const outcome = executeUninstallBatch(genieHome, scope([preservedAsset, otherAsset]), (_scope, progress) => {
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
    const preservedAsset = join(root, 'preserved-asset');
    const otherAsset = join(root, 'other-asset');
    const preservedMember = uninstallBatchMemberId('asset', preservedAsset);
    const otherMember = uninstallBatchMemberId('asset', otherAsset);
    const plannedScope = scope([preservedAsset, otherAsset]);
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

  test('an authentic legacy v1 journal is discarded and re-recorded as v3, then execution proceeds', () => {
    const asset = join(root, 'legacy-asset');
    mkdirSync(asset, { recursive: true });
    writeLegacyV1Journal();
    const member = uninstallBatchMemberId('asset', asset);
    const events: string[] = [];

    const outcome = executeUninstallBatch(genieHome, scope([asset]), (decisionScope, progress) => {
      events.push('cleanup');
      // The fresh v3 scope is the CURRENT live scope, not the empty migrated v1 one.
      expect(decisionScope.agentAssets.map((a) => a.path)).toEqual([asset]);
      progress.begin(member);
      progress.complete(member);
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(3);
    expect(outcome.result.failures).toEqual([]);
    expect(events).toEqual(['cleanup']);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
  });

  test('an authentic legacy v2 pathname journal is re-planned as v3 before execution', () => {
    writeLegacyV2Journal();
    const outcome = executeUninstallBatch(genieHome, scope(), (decisionScope) => {
      expect(decisionScope.genieHomeIdentity).toBeNull();
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(3);
    expect(outcome.result.failures).toEqual([]);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
    expect(existsSync(genieHome)).toBe(true);
  });

  test('a migrated legacy v1 journal with an interrupted member surfaces a note', () => {
    const staleMember = uninstallBatchMemberId('asset', join(root, 'stale-asset'));
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
      agentAssets: [],
      codexRoleAgents: [
        { name: 'genie-review.toml', disposition: 'remove', identity: { digest: 'a'.repeat(64), mode: 0o600 } },
      ],
      codexRoleInventoryStatus: 'valid',
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

  test('rejects later plugins, roles, corrupt inventory, and unreadable runtime state before mutation', () => {
    const planned = scope();
    const violations = uninstallBatchIntegrationViolations(
      planned,
      {
        status: 'corrupt',
        entries: [
          {
            name: 'genie-later.toml',
            path: '/tmp/genie-later.toml',
            ownership: 'managed-clean',
          },
        ],
      },
      {
        codex: true,
        claude: true,
        errors: { codex: ['corrupt config'], claude: [] },
      },
    );

    expect(violations).toContain('Codex role-agent ownership inventory is corrupt');
    expect(violations).toContain('unexpected Codex role agents: genie-later.toml');
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
      hasAgentAssets: false,
      codexRoleInventoryStatus: 'missing' as const,
      runtimeEvidence: { codex: false, claude: false },
      removeMarketplace: false,
    };
    expect(hasUninstallWork(base)).toBe(false);
    expect(hasUninstallWork({ ...base, runtimeEvidence: { codex: true, claude: false } })).toBe(true);
    expect(hasUninstallWork({ ...base, removeMarketplace: true })).toBe(true);
    expect(hasUninstallWork({ ...base, hasPendingTransactions: true })).toBe(true);
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
      collectAgentSyncAssets: () => [],
      inspectCodexAgentOwnership: () => ({
        inventoryPath: join(root, 'inventory.json'),
        status: 'missing' as const,
        entries: [],
      }),
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
      hasPendingTransactions: () => false,
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
        hasAgentAssets: false,
        codexRoleInventoryStatus: 'missing',
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
      agentAssets: [],
      codexRoleAgents: [],
      codexRoleInventoryStatus: 'missing',
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

  test('Hermes boundary replacement is kept as an identity mismatch', () => {
    const claudeDir = join(root, 'claude');
    const codexDir = join(root, 'codex');
    const agentsSkillsDir = join(root, 'agents-skills');
    const hermesHome = join(root, 'hermes');
    const genieHome = join(root, 'genie');
    const link = join(hermesHome, 'plugins', 'genie');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), link);
    const targets = { claudeDir, codexDir, agentsSkillsDir, hermesHome, genieHome };
    const identity = collectAgentSyncAssets(targets).find((asset) => asset.path === link)?.identity;
    if (identity?.kind !== 'link') throw new Error('expected Hermes link identity');

    const result = removeAgentSyncAssets(targets, {
      plannedAssets: [{ path: link, identity }],
      beforeManagedLinkCapture(path) {
        renameSync(path, join(root, 'parked-hermes-link'));
        writeFileSync(path, 'foreign-hermes\n');
      },
    });

    expect(result.failures).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.identityMismatch).toEqual([link]);
    expect(readFileSync(link, 'utf8')).toBe('foreign-hermes\n');
  });

  test('authenticated Hermes replacement records preservation and clears the settled batch', () => {
    const claudeDir = join(root, 'claude');
    const codexDir = join(root, 'codex');
    const agentsSkillsDir = join(root, 'agents-skills');
    const hermesHome = join(root, 'hermes');
    const genieHome = join(root, 'genie');
    const link = join(hermesHome, 'plugins', 'genie');
    const ownedTarget = join(genieHome, 'plugins', 'hermes-genie');
    const foreignTarget = join(root, 'foreign-hermes-plugin');
    mkdirSync(dirname(link), { recursive: true });
    mkdirSync(foreignTarget, { recursive: true });
    symlinkSync(ownedTarget, link);
    const targets = { claudeDir, codexDir, agentsSkillsDir, hermesHome, genieHome };
    const identity = collectAgentSyncAssets(targets).find((asset) => asset.path === link)?.identity;
    if (identity?.kind !== 'link') throw new Error('expected Hermes link identity');
    const plannedScope = scope({});
    plannedScope.agentAssets = [{ path: link, disposition: 'remove', identity }];
    const priorEnvironment = {
      GENIE_HOME: process.env.GENIE_HOME,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      HERMES_HOME: process.env.HERMES_HOME,
      GENIE_AGENTS_SKILLS_DIR: process.env.GENIE_AGENTS_SKILLS_DIR,
    };

    try {
      process.env.GENIE_HOME = genieHome;
      process.env.CLAUDE_CONFIG_DIR = claudeDir;
      process.env.CODEX_HOME = codexDir;
      process.env.HERMES_HOME = hermesHome;
      process.env.GENIE_AGENTS_SKILLS_DIR = agentsSkillsDir;
      recordUninstallBatchDecision(genieHome, plannedScope);
      rmSync(link);
      symlinkSync(foreignTarget, link);

      const outcome = performFreshUninstallPlan(genieHome, false);

      expect(outcome.result.failures).toEqual([]);
      expect(outcome.result.preserved?.some((receipt) => receipt.step.includes('Preserving synced asset'))).toBe(true);
      expect(readUninstallBatchDecision(genieHome)).toBeNull();
      expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(foreignTarget);
    } finally {
      for (const [name, value] of Object.entries(priorEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
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
