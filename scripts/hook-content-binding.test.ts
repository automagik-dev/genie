import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_HOOK_LAUNCHER,
  CODEX_HOOK_MANIFEST,
  CODEX_LAUNCHER_CONTRACT,
  assertHookContentBinding,
  launcherSha256,
  renderBoundManifest,
} from './hook-content-binding.ts';

describe('Codex hook launcher content binding', () => {
  test('the committed H4/H6 definitions bind the current physical launcher', () => {
    expect(() => assertHookContentBinding()).not.toThrow();
    const manifest = readFileSync(CODEX_HOOK_MANIFEST, 'utf8');
    const digest = launcherSha256();
    expect(manifest.match(new RegExp(`--launcher-sha256 ${digest}`, 'g'))).toHaveLength(4);
    expect(manifest.match(new RegExp(`--launcher-contract ${CODEX_LAUNCHER_CONTRACT}`, 'g'))).toHaveLength(4);
  });

  test('launcher byte drift fails until the definitions are regenerated', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-binding-'));
    try {
      const launcher = join(root, 'dispatch-runtime.cjs');
      const manifest = join(root, 'codex-hooks.json');
      copyFileSync(CODEX_HOOK_LAUNCHER, launcher);
      copyFileSync(CODEX_HOOK_MANIFEST, manifest);
      expect(() => assertHookContentBinding(manifest, launcher)).not.toThrow();

      writeFileSync(launcher, `${readFileSync(launcher, 'utf8')}\n// unreviewed drift\n`);
      expect(() => assertHookContentBinding(manifest, launcher)).toThrow('launcher binding drift');

      writeFileSync(manifest, renderBoundManifest(manifest, launcher));
      expect(() => assertHookContentBinding(manifest, launcher)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlinked launcher cannot satisfy the definition binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-binding-link-'));
    try {
      const link = join(root, 'dispatch-runtime.cjs');
      symlinkSync(CODEX_HOOK_LAUNCHER, link);
      expect(() => launcherSha256(link)).toThrow('physical file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
