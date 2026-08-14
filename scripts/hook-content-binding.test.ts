import { describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CLAUDE_HOOK_MANIFEST,
  CLAUDE_LAUNCHER_CONTRACT,
  CODEX_HOOK_LAUNCHER,
  CODEX_HOOK_MANIFEST,
  CODEX_LAUNCHER_CONTRACT,
  KIMI_HOOK_MANIFEST,
  assertClaudeHookContentBinding,
  assertHookContentBinding,
  assertKimiHookContentBinding,
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

const CLAUDE_PIN_SUFFIX = /\s+--launcher-contract\s+\S+\s+--launcher-sha256\s+[a-f0-9]{64}$/;

describe('Claude + Kimi hook launcher content binding', () => {
  test('the committed Claude and Kimi dispatch definitions bind the current physical launcher', () => {
    expect(() => assertClaudeHookContentBinding()).not.toThrow();
    expect(() => assertKimiHookContentBinding()).not.toThrow();
    const digest = launcherSha256();
    const claude = readFileSync(CLAUDE_HOOK_MANIFEST, 'utf8');
    // command AND commandWindows are both pinned — an unpinned Windows
    // variant must fail the gate just like the POSIX one.
    expect(claude.match(new RegExp(`--launcher-sha256 ${digest}`, 'g'))).toHaveLength(2);
    expect(claude.match(new RegExp(`--launcher-contract ${CLAUDE_LAUNCHER_CONTRACT}`, 'g'))).toHaveLength(2);
    const kimi = readFileSync(KIMI_HOOK_MANIFEST, 'utf8');
    expect(kimi.match(new RegExp(`--launcher-sha256 ${digest}`, 'g'))).toHaveLength(1);
    expect(kimi.match(new RegExp(`--launcher-contract ${CLAUDE_LAUNCHER_CONTRACT}`, 'g'))).toHaveLength(1);
  });

  test('claude binding fails when either dispatch variant lacks the sha256 pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-binding-claude-'));
    try {
      const launcher = join(root, 'dispatch-runtime.cjs');
      const manifest = join(root, 'hooks.json');
      copyFileSync(CODEX_HOOK_LAUNCHER, launcher);
      copyFileSync(CLAUDE_HOOK_MANIFEST, manifest);
      expect(() => assertClaudeHookContentBinding(manifest, launcher)).not.toThrow();

      const strippedWindows = JSON.parse(readFileSync(manifest, 'utf8'));
      const windowsHook = strippedWindows.hooks.PreToolUse[0].hooks.find((hook: { command: string }) =>
        hook.command.includes('dispatch-runtime.cjs'),
      );
      windowsHook.commandWindows = windowsHook.commandWindows.replace(CLAUDE_PIN_SUFFIX, '');
      writeFileSync(manifest, `${JSON.stringify(strippedWindows, null, 2)}\n`);
      expect(() => assertClaudeHookContentBinding(manifest, launcher)).toThrow('Claude hook launcher binding drift');

      const strippedCommand = JSON.parse(readFileSync(manifest, 'utf8'));
      const commandHook = strippedCommand.hooks.PreToolUse[0].hooks.find((hook: { command: string }) =>
        hook.command.includes('dispatch-runtime.cjs'),
      );
      commandHook.command = commandHook.command.replace(CLAUDE_PIN_SUFFIX, '');
      writeFileSync(manifest, `${JSON.stringify(strippedCommand, null, 2)}\n`);
      expect(() => assertClaudeHookContentBinding(manifest, launcher)).toThrow('Claude hook launcher binding drift');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('kimi binding fails when the dispatch command lacks or corrupts the sha256 pin', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-binding-kimi-'));
    try {
      const launcher = join(root, 'dispatch-runtime.cjs');
      const manifest = join(root, 'plugin.json');
      copyFileSync(CODEX_HOOK_LAUNCHER, launcher);
      copyFileSync(KIMI_HOOK_MANIFEST, manifest);
      expect(() => assertKimiHookContentBinding(manifest, launcher)).not.toThrow();

      const stripped = JSON.parse(readFileSync(manifest, 'utf8'));
      const hook = stripped.hooks.find((entry: { command: string }) => entry.command.includes('dispatch-runtime.cjs'));
      hook.command = hook.command.replace(CLAUDE_PIN_SUFFIX, '');
      writeFileSync(manifest, `${JSON.stringify(stripped, null, 2)}\n`);
      expect(() => assertKimiHookContentBinding(manifest, launcher)).toThrow('Kimi hook launcher binding drift');

      const corrupted = JSON.parse(readFileSync(manifest, 'utf8'));
      const corruptHook = corrupted.hooks.find((entry: { command: string }) =>
        entry.command.includes('dispatch-runtime.cjs'),
      );
      corruptHook.command = corruptHook.command.replace(/[a-f0-9]{64}$/, '0'.repeat(64));
      writeFileSync(manifest, `${JSON.stringify(corrupted, null, 2)}\n`);
      expect(() => assertKimiHookContentBinding(manifest, launcher)).toThrow('Kimi hook launcher binding drift');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('launcher byte drift fails the Claude and Kimi gates too (one shared launcher)', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-binding-shared-'));
    try {
      const launcher = join(root, 'dispatch-runtime.cjs');
      const claudeManifest = join(root, 'hooks.json');
      const kimiManifest = join(root, 'plugin.json');
      copyFileSync(CODEX_HOOK_LAUNCHER, launcher);
      copyFileSync(CLAUDE_HOOK_MANIFEST, claudeManifest);
      copyFileSync(KIMI_HOOK_MANIFEST, kimiManifest);
      expect(() => assertClaudeHookContentBinding(claudeManifest, launcher)).not.toThrow();
      expect(() => assertKimiHookContentBinding(kimiManifest, launcher)).not.toThrow();

      writeFileSync(launcher, `${readFileSync(launcher, 'utf8')}\n// unreviewed drift\n`);
      expect(() => assertClaudeHookContentBinding(claudeManifest, launcher)).toThrow(
        'Claude hook launcher binding drift',
      );
      expect(() => assertKimiHookContentBinding(kimiManifest, launcher)).toThrow('Kimi hook launcher binding drift');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
