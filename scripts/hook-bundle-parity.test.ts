import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HOOK_BUNDLES,
  assertHookBundleParity,
  assertHookBundlesParity,
  renderHookBundle,
} from './hook-bundle-parity.ts';

describe('committed hook bundle parity', () => {
  test('all three build outputs are byte-deterministic and mode 755', async () => {
    expect(HOOK_BUNDLES.map((target) => target.name)).toEqual(['validate-wish', 'session-context']);
    await expect(assertHookBundlesParity()).resolves.toBeUndefined();
  });

  test('content and executable-mode drift both fail closed for every output', async () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-hook-parity-'));
    try {
      for (const target of HOOK_BUNDLES) {
        const bundle = join(root, `${target.name}.cjs`);
        const fixture = { ...target, bundle };
        writeFileSync(bundle, `${await renderHookBundle(target.source)}\n// drift\n`);
        chmodSync(bundle, 0o755);
        await expect(assertHookBundleParity(fixture)).rejects.toThrow('Hook bundle drift');

        writeFileSync(bundle, await renderHookBundle(target.source));
        // 744 is STRICTER than 755: the tighten-only doctor cannot restore
        // the lost executable bits, so the message names regeneration.
        chmodSync(bundle, 0o744);
        await expect(assertHookBundleParity(fixture)).rejects.toThrow(/must have mode 755.*--write/);
        // 777 is WIDER than 755: exactly the group/world-writable drift the
        // doctor's tighten-only repair exists for.
        chmodSync(bundle, 0o777);
        await expect(assertHookBundleParity(fixture)).rejects.toThrow(/must have mode 755.*genie doctor --fix/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
