/**
 * Tests for the agent-sync managed-asset removal in `genie uninstall`.
 *
 * The full uninstallCommand is interactive (confirm prompt) and targets the real
 * home; here we only prove the manifest-verified collect/remove seams — the code
 * that decides WHICH external agent assets uninstall is allowed to delete. Every
 * path is injected into a tmpdir, so no test ever touches the real HOME.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAgentSyncAssets, removeAgentSyncAssets } from './uninstall.js';

const MANAGED_MANIFEST = JSON.stringify({ managedBy: 'genie-agent-sync', version: '1', digest: 'x', syncedAt: 'now' });

describe('agent-sync managed-asset removal', () => {
  let tmp: string;
  let claudeDir: string;
  let codexDir: string;
  let hermesHome: string;
  let genieHome: string;

  function targets() {
    return { claudeDir, codexDir, hermesHome, genieHome };
  }

  function managedSkill(parent: string, name: string): string {
    const dir = join(parent, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# x\n', 'utf8');
    writeFileSync(join(dir, '.genie-sync.json'), MANAGED_MANIFEST, 'utf8');
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
    const codexManaged = managedSkill(join(codexDir, 'skills', '.curated'), 'review');

    const paths = collectAgentSyncAssets(targets()).map((a) => a.path);
    expect(paths).toContain(managed);
    expect(paths).toContain(codexManaged);
    expect(paths).not.toContain(mine);
  });

  test('removes managed skills but leaves unmanaged dirs intact', () => {
    const managed = managedSkill(join(claudeDir, 'skills'), 'wish');
    const mine = unmanagedSkill(join(claudeDir, 'skills'), 'my-own');

    const removed = removeAgentSyncAssets(targets());
    expect(removed).toContain(managed);
    expect(existsSync(managed)).toBe(false);
    expect(existsSync(mine)).toBe(true);
  });

  test('stamped council.js is removed; a non-stamped one at the same path is kept', () => {
    mkdirSync(join(claudeDir, 'workflows'), { recursive: true });
    const council = join(claudeDir, 'workflows', 'council.js');
    writeFileSync(council, "export const meta = { name: 'council' };\nconst LENS_ROOT = '/x';\n", 'utf8');

    let removed = removeAgentSyncAssets(targets());
    expect(removed).toContain(council);
    expect(existsSync(council)).toBe(false);

    writeFileSync(council, 'console.log("my own workflow");\n', 'utf8');
    removed = removeAgentSyncAssets(targets());
    expect(removed).not.toContain(council);
    expect(existsSync(council)).toBe(true);
  });

  test('hermes symlink into the genie home is removed; one pointing elsewhere is kept', () => {
    mkdirSync(join(hermesHome, 'plugins'), { recursive: true });
    const link = join(hermesHome, 'plugins', 'genie');
    symlinkSync(join(genieHome, 'plugins', 'hermes-genie'), link);

    expect(removeAgentSyncAssets(targets())).toContain(link);
    expect(existsSync(link)).toBe(false);

    const elsewhere = join(tmp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, link);
    expect(removeAgentSyncAssets(targets())).not.toContain(link);
    expect(existsSync(link)).toBe(true);
  });

  test('a real (non-symlink) dir at hermes plugins/genie is never removed', () => {
    const link = join(hermesHome, 'plugins', 'genie');
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, 'plugin.json'), '{}', 'utf8');

    expect(removeAgentSyncAssets(targets())).not.toContain(link);
    expect(existsSync(link)).toBe(true);
  });

  test('empty / agentless home → nothing collected, nothing removed', () => {
    expect(collectAgentSyncAssets(targets())).toEqual([]);
    expect(removeAgentSyncAssets(targets())).toEqual([]);
  });
});
