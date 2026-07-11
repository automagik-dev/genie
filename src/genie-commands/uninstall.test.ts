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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_BY, WORKFLOW_MANIFEST_NAME, computeDirDigest, stampWorkflow } from '../lib/agent-sync.js';
import { collectAgentSyncAssets, removeAgentSyncAssets } from './uninstall.js';

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

  test('a real (non-symlink) dir at hermes plugins/genie is never removed', () => {
    const link = join(hermesHome, 'plugins', 'genie');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'plugin.json'), '{}', 'utf8');

    expect(removeAgentSyncAssets(targets()).removed).not.toContain(link);
    expect(existsSync(link)).toBe(true);
  });

  test('empty / agentless home → nothing collected, nothing removed', () => {
    expect(collectAgentSyncAssets(targets())).toEqual([]);
    expect(removeAgentSyncAssets(targets())).toEqual({ removed: [], kept: [], failures: [] });
  });
});
