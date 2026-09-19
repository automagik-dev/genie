import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCA_BUNDLE, assertOrcaBundleParity, renderOrcaBundle } from './orca-bundle-parity.ts';

interface OrcaManifest {
  main: string;
  contributes: {
    commands: { id: string; title: string; context?: string }[];
    keybindings?: { command: string; key: string; when?: string }[];
  };
}

const MANIFEST: OrcaManifest = JSON.parse(readFileSync(resolve(ORCA_BUNDLE.bundle, '..', 'orca-plugin.json'), 'utf8'));

describe('committed native Orca bundle parity', () => {
  test('the shipped bundle is byte-deterministic from its TypeScript source', async () => {
    await expect(assertOrcaBundleParity()).resolves.toBeUndefined();
  });

  test('content drift fails closed and names the regeneration command', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-orca-parity-'));
    try {
      const bundle = join(root, 'orca-entrypoint.min.js');
      writeFileSync(bundle, `${await renderOrcaBundle(ORCA_BUNDLE.source)}\n// drift\n`);
      await expect(assertOrcaBundleParity({ ...ORCA_BUNDLE, bundle })).rejects.toThrow(/Orca bundle drift.*--write/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * Orca's manifest validator rejects a keybinding naming an uncontributed
   * command, and its worker answers `no handler registered for <id>` when a
   * contributed command has none. Both directions are checked here, so a ninth
   * manifest entry, or a handler with no entry, fails before release.
   */
  test('the committed bundle loads as ESM and registers exactly the contributed command ids', async () => {
    const module = (await import(pathToFileURL(resolve(ORCA_BUNDLE.bundle)).href)) as {
      default: (context: { commands: { register(id: string, handler: unknown): void } }) => Promise<void>;
      createOrcaPluginEntrypoint: unknown;
      GENIE_PALETTE_COMMANDS: { id: string }[];
    };
    expect(typeof module.default).toBe('function');
    expect(typeof module.createOrcaPluginEntrypoint).toBe('function');

    const registered: string[] = [];
    await module.default({ commands: { register: (id) => registered.push(id) } });

    const contributed = MANIFEST.contributes.commands.map((command) => command.id);
    expect(registered).toEqual(contributed);
    expect(new Set(registered)).toEqual(new Set(contributed));
    expect(module.GENIE_PALETTE_COMMANDS.map((command) => command.id)).toEqual(contributed);
  });

  test('every keybinding names a contributed command and matches its context', () => {
    const keybindings = MANIFEST.contributes.keybindings ?? [];
    expect(keybindings.length).toBe(MANIFEST.contributes.commands.length);
    for (const binding of keybindings) {
      const command = MANIFEST.contributes.commands.find((entry) => entry.id === binding.command);
      expect(command, binding.command).toBeDefined();
      expect(binding.when, binding.command).toBe(command?.context as string);
      expect(binding.key.length).toBeGreaterThan(0);
    }
    expect(new Set(keybindings.map((binding) => binding.key)).size).toBe(keybindings.length);
  });

  test('the Orca manifest points at the gated bundle', () => {
    expect(MANIFEST.main).toBe('orca-entrypoint.min.js');
  });
});
