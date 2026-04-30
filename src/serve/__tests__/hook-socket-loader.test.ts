/**
 * hook-socket boot-loader integration tests — Group 1 D5 of
 * hookify-third-party-absorption.
 *
 * Asserts that startHookSocket runs the loader BEFORE listening (single-writer
 * at boot), surfaces outcomes via the returned handle, and honors strict
 * mode.
 *
 * Trust file + repoRoot are temp dirs so these tests don't touch the host's
 * `~/.genie/hooks/` or `~/.claude/teams/<team>/hooks/`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRegistry, setRegistry } from '../../hooks/index.js';
import { sha256OfFile } from '../../hooks/trust.js';
import { startHookSocket } from '../hook-socket.js';

let tmpRoot: string;
let socketDir: string;
let savedHookSock: string | undefined;
let savedHome: string | undefined;
let savedRegistry: ReturnType<typeof getRegistry>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'genie-hook-loader-int-'));
  socketDir = join(tmpRoot, 'sock');
  mkdirSync(socketDir, { recursive: true });

  savedHookSock = process.env.GENIE_HOOK_SOCK;
  savedHome = process.env.GENIE_HOME;
  process.env.GENIE_HOOK_SOCK = join(socketDir, 'hook.sock');
  // Redirect HOME-derived paths so loader scans empty team + global tiers.
  process.env.GENIE_HOME = join(tmpRoot, 'genie-home');

  savedRegistry = getRegistry();
});

afterEach(() => {
  if (savedHookSock === undefined) delete process.env.GENIE_HOOK_SOCK;
  else process.env.GENIE_HOOK_SOCK = savedHookSock;
  if (savedHome === undefined) delete process.env.GENIE_HOME;
  else process.env.GENIE_HOME = savedHome;
  setRegistry(savedRegistry);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('startHookSocket boot-loader integration', () => {
  test('loadExternal: false skips the boot scan entirely', async () => {
    const handle = await startHookSocket({ loadExternal: false });
    try {
      expect(handle.loaderOutcomes).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  test('loaderOutcomes is empty when no external hooks exist', async () => {
    // No repoRoot → only team + global tiers are scanned, both pointing at
    // empty directories under our temp HOME redirect.
    const handle = await startHookSocket({ loadExternal: true });
    try {
      expect(handle.loaderOutcomes).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  test('loaderOutcomes records untrusted files (filesystem-presence is not consent)', async () => {
    // Per-repo tier scan finds an untrusted file.
    const repoRoot = join(tmpRoot, 'repo');
    mkdirSync(join(repoRoot, '.genie', 'hooks'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.genie', 'hooks', 'untrusted.ts'),
      'export default {};', // missing trust entry
      'utf-8',
    );

    const handle = await startHookSocket({ loadExternal: true, repoRoot });
    try {
      expect(handle.loaderOutcomes.length).toBeGreaterThanOrEqual(1);
      const outcome = handle.loaderOutcomes[0];
      expect(outcome.kind).toBe('untrusted');
    } finally {
      await handle.stop();
    }
  });

  test('strict: true throws on a same-name collision (refuses to start)', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const hooksDir = join(repoRoot, '.genie', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const sample = `
      const handler = {
        version: '1', source: 'global', manifest_path: '<placeholder>',
        name: 'collision', event: 'PreToolUse', matcher: /^Bash$/,
        priority: 50, fn: async () => undefined,
      };
      export default handler;
    `;
    const a = join(hooksDir, 'a.ts');
    const b = join(hooksDir, 'b.ts');
    writeFileSync(a, sample, 'utf-8');
    writeFileSync(b, sample, 'utf-8');

    // Trust both files at their actual SHAs so they pass the trust gate.
    const trustPath = join(tmpRoot, 'genie-home', 'hooks', 'trusted.json');
    mkdirSync(join(tmpRoot, 'genie-home', 'hooks'), { recursive: true });
    writeFileSync(
      trustPath,
      JSON.stringify({
        version: 1,
        entries: [
          { path: a, sha256: sha256OfFile(a), scope: 'global', trustedAt: '2026-04-30T00:00:00Z' },
          { path: b, sha256: sha256OfFile(b), scope: 'global', trustedAt: '2026-04-30T00:00:00Z' },
        ],
      }),
      'utf-8',
    );

    await expect(startHookSocket({ loadExternal: true, repoRoot, strict: true })).rejects.toThrow(/--strict-hooks/);
  });

  test('non-strict mode accepts collision (warn + continue, daemon starts)', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    const hooksDir = join(repoRoot, '.genie', 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    const sample = `
      const handler = {
        version: '1', source: 'global', manifest_path: '<placeholder>',
        name: 'duplicate', event: 'PreToolUse', matcher: /^Bash$/,
        priority: 50, fn: async () => undefined,
      };
      export default handler;
    `;
    const a = join(hooksDir, 'a.ts');
    const b = join(hooksDir, 'b.ts');
    writeFileSync(a, sample, 'utf-8');
    writeFileSync(b, sample, 'utf-8');

    const trustPath = join(tmpRoot, 'genie-home', 'hooks', 'trusted.json');
    mkdirSync(join(tmpRoot, 'genie-home', 'hooks'), { recursive: true });
    writeFileSync(
      trustPath,
      JSON.stringify({
        version: 1,
        entries: [
          { path: a, sha256: sha256OfFile(a), scope: 'global', trustedAt: '2026-04-30T00:00:00Z' },
          { path: b, sha256: sha256OfFile(b), scope: 'global', trustedAt: '2026-04-30T00:00:00Z' },
        ],
      }),
      'utf-8',
    );

    const handle = await startHookSocket({ loadExternal: true, repoRoot });
    try {
      expect(handle.loaderOutcomes.length).toBe(2);
      expect(handle.loaderOutcomes.find((o) => o.kind === 'loaded')).toBeDefined();
      expect(handle.loaderOutcomes.find((o) => o.kind === 'shadowed')).toBeDefined();
    } finally {
      await handle.stop();
    }
  });
});
