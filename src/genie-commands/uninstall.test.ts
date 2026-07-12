/**
 * Tests for the agent-sync managed-asset removal in `genie uninstall`.
 *
 * The full uninstallCommand is interactive (confirm prompt) and targets the real
 * home; here we only prove the manifest-verified collect/remove seams — the code
 * that decides WHICH external agent assets uninstall is allowed to delete. Every
 * path is injected into a tmpdir, so no test ever touches the real HOME.
 *
 * Ownership contract under test: uninstall deletes only what genie provably
 * shipped — a managed dir whose computeDirDigest still matches its manifest.
 * A digest MISMATCH means the user edited the dir: it is kept byte-identical at
 * the same path. Uninstall cannot rename, disable, or rewrite user data.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import {
  MANAGED_BY,
  PHYSICAL_TREE_IDENTITY_VERSION,
  WORKFLOW_MANIFEST_NAME,
  computeDirDigest,
  stampWorkflow,
} from '../lib/agent-sync.js';
import {
  type UninstallBatchScope,
  clearUninstallBatchDecision,
  collectAgentSyncAssets,
  executeUninstallBatch,
  hasPendingUninstallTransactions,
  hasUninstallWork,
  inspectUninstallPlan,
  isGenieSymlink,
  isSameOrContainedPath,
  readUninstallBatchDecision,
  recordUninstallBatchDecision,
  recoverUninstallTransactions,
  removeAgentSyncAssets,
  removeSymlinks,
  uninstallBatchIntegrationViolations,
  uninstallBatchJournalPath,
  uninstallBatchMemberId,
  uninstallBatchRuntimeTargets,
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

  function targets() {
    return { claudeDir, codexDir, agentsSkillsDir, hermesHome, genieHome };
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
    const recorded = { kind: 'link' as const, target: originalTarget };
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
      genieHomePresent: false,
      ownedRulesPath: null,
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
});

describe('durable uninstall batch', () => {
  let root: string;
  let genieHome: string;

  // The journal-mechanics tests exercise member ids (path-based), not physical
  // removal, so a synthetic-but-valid skill identity satisfies the v2 schema.
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
      genieHomePresent: false,
      ownedRulesPath: null,
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

  test('an authentic legacy v1 journal is discarded and re-recorded as v2, then execution proceeds', () => {
    const asset = join(root, 'legacy-asset');
    mkdirSync(asset, { recursive: true });
    writeLegacyV1Journal();
    const member = uninstallBatchMemberId('asset', asset);
    const events: string[] = [];

    const outcome = executeUninstallBatch(genieHome, scope([asset]), (decisionScope, progress) => {
      events.push('cleanup');
      // The fresh v2 scope is the CURRENT live scope, not the empty migrated v1 one.
      expect(decisionScope.agentAssets.map((a) => a.path)).toEqual([asset]);
      progress.begin(member);
      progress.complete(member);
      return { failures: [] };
    });

    expect(outcome.decision.schemaVersion).toBe(2);
    expect(outcome.result.failures).toEqual([]);
    expect(events).toEqual(['cleanup']);
    expect(existsSync(uninstallBatchJournalPath(genieHome))).toBe(false);
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
});

describe('durable runtime integration allowlist', () => {
  function scope(): UninstallBatchScope {
    return {
      agentAssets: [],
      codexRoleAgents: [
        { name: 'genie-review.toml', disposition: 'remove', identity: { digest: 'a'.repeat(64), mode: 0o600 } },
      ],
      codexRoleInventoryStatus: 'valid',
      genieHomePresent: true,
      ownedRulesPath: null,
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
    expect(result).toEqual({ removed: ['genie'], failures: [] });
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

    expect(removeSymlinks(localBin, genieHome, ['genie'])).toEqual({ removed: ['genie'], failures: [] });
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
