/**
 * Tests for the `genie install` post-install finisher.
 *
 * The v4 cleanup engine is covered by legacy-v4.test.ts and the agent-sync
 * engine by agent-sync.test.ts; here we only prove the command wiring: v4
 * cleanup is gated by --skip-v4-cleanup, while the layout-normalize and
 * agent-sync steps always run. Every seam is injected — calling the real
 * cleanup/normalize/sync from a test would target the actual home directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installCommand, normalizeAuxLayout } from './install.js';
import type { cleanupV4 } from './legacy-v4.js';

function makeCleanupSpy(): { runner: typeof cleanupV4; calls: () => number } {
  let count = 0;
  const runner: typeof cleanupV4 = () => {
    count += 1;
    return {
      report: { rulesFile: { path: '/fixture', status: 'absent' }, cacheDirs: [], hasRelics: false },
      homeResidue: [],
      actions: [],
      backupDir: null,
      logFile: null,
      noOp: true,
    };
  };
  return { runner, calls: () => count };
}

describe('installCommand', () => {
  test('runs v4 cleanup + layout normalize + agent sync by default', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
      {},
      spy.runner,
      () => {
        normalizeCalls += 1;
      },
      () => {
        syncCalls += 1;
      },
      () => [],
    );
    expect(spy.calls()).toBe(1);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-v4-cleanup skips ONLY the cleanup; normalize + sync still run', () => {
    const spy = makeCleanupSpy();
    let normalizeCalls = 0;
    let syncCalls = 0;
    installCommand(
      { skipV4Cleanup: true },
      spy.runner,
      () => {
        normalizeCalls += 1;
      },
      () => {
        syncCalls += 1;
      },
      () => [],
    );
    expect(spy.calls()).toBe(0);
    expect(normalizeCalls).toBe(1);
    expect(syncCalls).toBe(1);
  });

  test('--skip-integrations maps to none', () => {
    let selection = '';
    installCommand(
      {},
      makeCleanupSpy().runner,
      () => {},
      () => {},
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
    );
    installCommand(
      { skipIntegrations: true },
      makeCleanupSpy().runner,
      () => {},
      () => {},
      (options) => {
        selection = options?.selection ?? '';
        return [];
      },
    );
    expect(selection).toBe('none');
  });

  test('explicit integration failures are fatal while auto failures warn', () => {
    const failing = () => [{ runtime: 'codex' as const, ok: false, detail: 'missing' }];
    expect(() =>
      installCommand(
        {},
        makeCleanupSpy().runner,
        () => {},
        () => {},
        failing,
      ),
    ).not.toThrow();
    expect(() =>
      installCommand(
        { integrations: 'codex' },
        makeCleanupSpy().runner,
        () => {},
        () => {},
        failing,
      ),
    ).toThrow('Requested integration failed');
  });
});

describe('normalizeAuxLayout', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'genie-normalize-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }

  test('moves bin/<dir> to the canonical <dir> when the target is absent', () => {
    mkdirSync(join(home, 'bin', 'plugins', 'genie'), { recursive: true });
    normalizeAuxLayout(home);
    expect(existsSync(join(home, 'plugins', 'genie'))).toBe(true);
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
  });

  test('reinstall over an existing install swaps the fresh trees in — no bin/ residue, no swap debris', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.1.0\n');
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'fresh plugin');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'stale plugin');
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'stale skill');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('fresh plugin');
    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
    for (const name of ['plugins', 'skills']) {
      expect(existsSync(join(home, `${name}.new`))).toBe(false);
      expect(existsSync(join(home, `${name}.old`))).toBe(false);
    }
    // canonical VERSION stamp refreshed so the next run short-circuits
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.2.0');
  });

  test('same-version reinstall is an idempotent no-op — canonical trees are left alone', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.2.0\n');
    // bin content deliberately differs so a wrongful swap would be visible
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'reextracted');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'canonical');

    normalizeAuxLayout(home);
    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('canonical');
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.2.0');
  });

  test('without VERSION stamps a differing tree is swapped in via the digest fallback', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'stale skill');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
  });

  test('without VERSION stamps a digest-identical tree is a no-op', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'same content');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'same content');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('same content');
    expect(existsSync(join(home, 'bin', 'skills', 'wish', 'SKILL.md'))).toBe(true);
  });

  test('is a non-throwing no-op when neither layout is present', () => {
    expect(() => normalizeAuxLayout(home)).not.toThrow();
    expect(existsSync(join(home, 'plugins'))).toBe(false);
  });

  test('marketplace manifest dirs (.agents, .claude-plugin) move next to plugins/ under GENIE_HOME', () => {
    write(join(home, 'bin', 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'), '# Managed by Genie.\n');
    write(join(home, 'bin', '.agents', 'plugins', 'marketplace.json'), '{"name":"automagik"}');
    write(join(home, 'bin', '.claude-plugin', 'marketplace.json'), '{"name":"automagik"}');

    normalizeAuxLayout(home);

    // GENIE_HOME is now a self-consistent `plugin marketplace add` root: the
    // manifests' relative `./plugins/genie` reference resolves under it.
    expect(existsSync(join(home, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(home, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(existsSync(join(home, 'plugins', 'genie', 'codex-agents', 'genie-reviewer.toml'))).toBe(true);
    expect(existsSync(join(home, 'bin', '.agents'))).toBe(false);
    expect(existsSync(join(home, 'bin', '.claude-plugin'))).toBe(false);
  });

  test('a failed tree suppresses the VERSION stamp so a same-version reinstall retries it', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    // No home VERSION → per-tree digest compare. plugins adopts fine…
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'fresh plugin');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'stale plugin');
    // …but skills fails: a FILE squats where the tree should be, so the digest
    // compare throws and this tree cannot converge.
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    writeFileSync(join(home, 'skills'), 'not a directory');

    normalizeAuxLayout(home);

    // The healthy tree was adopted…
    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('fresh plugin');
    // …but the stamp MUST stay absent: stamping a partial adoption would make
    // same-version reinstalls no-op forever while skills/ stays stale.
    expect(existsSync(join(home, 'VERSION'))).toBe(false);
  });
});
