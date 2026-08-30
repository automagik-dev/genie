import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ORCA_BUNDLE, assertOrcaBundleParity, renderOrcaBundle } from './orca-bundle-parity.ts';

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

  test('the committed bundle loads as an ESM module and registers the run-list command', async () => {
    const module = (await import(pathToFileURL(resolve(ORCA_BUNDLE.bundle)).href)) as {
      default: (context: { commands: { register(id: string, handler: unknown): void } }) => Promise<void>;
      ORCA_RUN_LIST_COMMAND: string;
    };
    expect(typeof module.default).toBe('function');
    expect(module.ORCA_RUN_LIST_COMMAND).toBe('genie.orca.run-list');

    const registered: string[] = [];
    await module.default({ commands: { register: (id) => registered.push(id) } });
    expect(registered).toEqual(['genie.orca.run-list']);
  });

  test('the Orca manifest points at the gated bundle', async () => {
    const manifest = (await Bun.file(resolve(ORCA_BUNDLE.bundle, '..', 'orca-plugin.json')).json()) as {
      main: string;
    };
    expect(manifest.main).toBe('orca-entrypoint.min.js');
  });
});
