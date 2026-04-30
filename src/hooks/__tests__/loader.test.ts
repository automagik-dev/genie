/**
 * Loader tests — Group 1 of hookify-third-party-absorption.
 *
 * Asserts the boot-scan flow: discover three S3 tiers → trust-gate every file
 * → dynamic-import survivors → validate exports → register. Untrusted files
 * are rejected; broken files are quarantined; same-name collisions emit warn
 * (or throw under --strict).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineHook } from '../define-hook.js';
import { getRegistry, setRegistry } from '../index.js';
import { discoverHooks, loadExternalHooks } from '../loader.js';
import { type TrustFile, sha256OfFile } from '../trust.js';

let tmpRoot: string;
let trustPath: string;
let savedRegistry: ReturnType<typeof getRegistry>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'genie-loader-test-'));
  trustPath = join(tmpRoot, 'trusted.json');
  savedRegistry = getRegistry();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  // Restore the canonical registry so other test files see builtins only.
  setRegistry(savedRegistry);
});

function writeHookFile(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body, 'utf-8');
  return path;
}

function writeTrust(entries: TrustFile['entries']): void {
  mkdirSync(join(tmpRoot, 'trust'), { recursive: true });
  writeFileSync(trustPath, JSON.stringify({ version: 1, entries }, null, 2), 'utf-8');
}

const sampleHookSource = `
const handler = {
  version: '1',
  source: 'global',
  manifest_path: '<placeholder>',
  name: 'sample',
  event: 'PreToolUse',
  matcher: /^Bash$/,
  priority: 50,
  fn: async () => undefined,
};
export default handler;
`;

describe('discoverHooks', () => {
  test('finds .ts files under repoRoot/.genie/hooks/', () => {
    const repoRoot = join(tmpRoot, 'repo');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'one.ts', 'export default {};');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'two.ts', 'export default {};');
    const found = discoverHooks({ repoRoot });
    const repoEntries = found.filter((d) => d.scope === 'repo');
    expect(repoEntries).toHaveLength(2);
  });

  test('skips _quarantine and dotfiles', () => {
    const repoRoot = join(tmpRoot, 'repo');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), '_skip.ts', 'export default {};');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'real.ts', 'export default {};');
    const found = discoverHooks({ repoRoot });
    const names = found.filter((d) => d.scope === 'repo').map((d) => d.path.split('/').pop());
    expect(names).toEqual(['real.ts']);
  });

  test('skips test files', () => {
    const repoRoot = join(tmpRoot, 'repo');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'real.ts', 'export default {};');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'real.test.ts', 'export default {};');
    const found = discoverHooks({ repoRoot });
    const names = found.filter((d) => d.scope === 'repo').map((d) => d.path.split('/').pop());
    expect(names).toEqual(['real.ts']);
  });
});

describe('loadExternalHooks — trust gate', () => {
  test('rejects untrusted files (filesystem-presence is not consent)', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    writeHookFile(join(repoRoot, '.genie', 'hooks'), 'untrusted.ts', sampleHookSource);
    writeTrust([]);

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('untrusted');
    if (outcomes[0].kind === 'untrusted') expect(outcomes[0].reason).toBe('not_in_trust_file');

    // Registry only has builtins after rejection.
    const registry = getRegistry();
    expect(registry.every((h) => h.source === 'builtin')).toBe(true);
  });

  test('loads a trusted file with matching SHA', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const filePath = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'trusted.ts', sampleHookSource);
    writeTrust([
      { path: filePath, sha256: sha256OfFile(filePath), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
    ]);

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('loaded');

    const registry = getRegistry();
    const sample = registry.find((h) => h.name === 'sample');
    expect(sample).toBeDefined();
    expect(sample?.source).toBe('repo'); // loader stamps tier source over author-supplied placeholder
    expect(sample?.manifest_path).toBe(filePath);
  });

  test('rejects a trusted file after its SHA changes (post-edit)', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const filePath = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'edited.ts', sampleHookSource);
    const originalSha = sha256OfFile(filePath);
    writeTrust([{ path: filePath, sha256: originalSha, scope: 'global', trustedAt: '2026-04-29T00:00:00Z' }]);
    writeFileSync(filePath, `${sampleHookSource}\n// added a comment after trusting`, 'utf-8');

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('untrusted');
    if (outcomes[0].kind === 'untrusted') expect(outcomes[0].reason).toBe('sha256_mismatch');
  });
});

describe('loadExternalHooks — validation + quarantine', () => {
  test('quarantines a file whose default export is invalid', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const filePath = writeHookFile(
      join(repoRoot, '.genie', 'hooks'),
      'invalid.ts',
      `export default { name: 'x' };`, // missing version, event, priority, fn
    );
    writeTrust([
      { path: filePath, sha256: sha256OfFile(filePath), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
    ]);

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('broken');

    const quarantineDir = join(repoRoot, '.genie', 'hooks', '_quarantine');
    expect(existsSync(quarantineDir)).toBe(true);
    expect(existsSync(join(quarantineDir, 'invalid.ts'))).toBe(true);
    expect(existsSync(join(quarantineDir, 'invalid.ts.error'))).toBe(true);
  });

  test('rejects unknown handler.version', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const filePath = writeHookFile(
      join(repoRoot, '.genie', 'hooks'),
      'wrong-version.ts',
      `export default { version: '99', name: 'x', event: 'PreToolUse', priority: 1, fn: async () => undefined };`,
    );
    writeTrust([
      { path: filePath, sha256: sha256OfFile(filePath), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
    ]);

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].kind).toBe('broken');
    if (outcomes[0].kind === 'broken') expect(outcomes[0].error).toContain('unknown handler version');
  });
});

describe('loadExternalHooks — name collision shadowing', () => {
  test('warns and reports shadowed when same name appears in two files', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const f1 = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'a.ts', sampleHookSource);
    const f2 = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'b.ts', sampleHookSource);
    writeTrust([
      { path: f1, sha256: sha256OfFile(f1), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
      { path: f2, sha256: sha256OfFile(f2), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
    ]);

    const outcomes = await loadExternalHooks({ repoRoot, trustPath });
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].kind).toBe('loaded');
    expect(outcomes[1].kind).toBe('shadowed');

    const registry = getRegistry();
    expect(registry.filter((h) => h.name === 'sample')).toHaveLength(1);
  });

  test('--strict-hooks throws on collision', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const f1 = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'a.ts', sampleHookSource);
    const f2 = writeHookFile(join(repoRoot, '.genie', 'hooks'), 'b.ts', sampleHookSource);
    writeTrust([
      { path: f1, sha256: sha256OfFile(f1), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
      { path: f2, sha256: sha256OfFile(f2), scope: 'global', trustedAt: '2026-04-29T00:00:00Z' },
    ]);

    await expect(loadExternalHooks({ repoRoot, trustPath, strict: true })).rejects.toThrow(/--strict-hooks/);
  });
});

describe('loadExternalHooks — defineHook integration', () => {
  test('handlers built via defineHook validate and register', async () => {
    // Sanity: a defineHook-produced object passes the loader's validateHandler.
    const handler = defineHook({
      name: 'integration',
      event: 'PreToolUse',
      run: async () => undefined,
    });
    expect(handler.version).toBe('1');
    expect(typeof handler.fn).toBe('function');
  });
});
