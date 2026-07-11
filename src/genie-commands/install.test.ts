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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { convergeAuxiliaryTree } from './auxiliary-trees.js';
import { type InstallOptions, installCommand, normalizeAuxLayout } from './install.js';
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

  test('rejects an invalid integration option before every finisher side effect', () => {
    const calls: string[] = [];
    const invalid = { integrations: 'codxe' } as unknown as InstallOptions;
    expect(() =>
      installCommand(
        invalid,
        (() => calls.push('cleanup')) as unknown as typeof cleanupV4,
        () => {
          calls.push('normalize');
        },
        () => {
          calls.push('sync');
        },
        () => {
          calls.push('integrations');
          return [];
        },
      ),
    ).toThrow('Invalid --integrations value: codxe');
    expect(calls).toEqual([]);
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

  test('same-version reinstall repairs divergent content instead of trusting VERSION stamps', () => {
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.2.0\n');
    // bin content deliberately differs so a wrongful swap would be visible
    write(join(home, 'bin', 'plugins', 'genie', 'SKILL.md'), 'reextracted');
    write(join(home, 'plugins', 'genie', 'SKILL.md'), 'canonical');

    normalizeAuxLayout(home);
    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'plugins', 'genie', 'SKILL.md'), 'utf8')).toBe('reextracted');
    expect(existsSync(join(home, 'bin', 'plugins'))).toBe(false);
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.2.0');
  });

  test('without VERSION stamps a differing tree is swapped in via the digest fallback', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'fresh skill');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'stale skill');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('fresh skill');
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
  });

  test('a digest-identical extracted tree is removed instead of becoming persistent residue', () => {
    write(join(home, 'bin', 'skills', 'wish', 'SKILL.md'), 'same content');
    write(join(home, 'skills', 'wish', 'SKILL.md'), 'same content');

    normalizeAuxLayout(home);

    expect(readFileSync(join(home, 'skills', 'wish', 'SKILL.md'), 'utf8')).toBe('same content');
    expect(existsSync(join(home, 'bin', 'skills'))).toBe(false);
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

  test('source-removal failure preserves the prior VERSION stamp and extracted recovery tree', () => {
    const source = join(home, 'bin', 'plugins');
    write(join(home, 'bin', 'VERSION'), '5.2.0\n');
    write(join(home, 'VERSION'), '5.1.0\n');
    write(join(source, 'payload.txt'), 'fresh');
    write(join(home, 'plugins', 'payload.txt'), 'old');

    const outcomes = normalizeAuxLayout(home, {
      remove: (path) => {
        if (path === source) throw new Error('source removal failure');
        rmSync(path, { recursive: true, force: true });
      },
    });

    expect(outcomes.find((outcome) => outcome.label === 'plugins')?.status).toBe('failed');
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('5.1.0');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(home, 'plugins', 'payload.txt'), 'utf8')).toBe('fresh');
  });
});

describe('transactional auxiliary-tree convergence', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'genie-aux-transaction-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function fixture(): { source: string; destination: string } {
    const source = join(root, 'extract', 'plugins');
    const destination = join(root, 'home', 'plugins');
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(source, 'payload.txt'), 'fresh');
    writeFileSync(join(destination, 'payload.txt'), 'old');
    return { source, destination };
  }

  function copyPayload(source: string, destination: string): void {
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, 'payload.txt'), readFileSync(join(source, 'payload.txt')));
  }

  test('copy failure leaves the prior live tree and complete fresh source untouched', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'copy-failure',
      operations: {
        copyTree: () => {
          throw new Error('copy injected');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') expect(outcome.stage).toBe('copy-fresh');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('partial copy/disk-full never reports the incomplete staging tree as verified fresh', () => {
    const { source, destination } = fixture();
    const staging = `${destination}.new-partial-copy`;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'partial-copy',
      operations: {
        copyTree: (_from, to) => {
          mkdirSync(to, { recursive: true });
          writeFileSync(join(to, 'payload.txt'), 'partial');
          throw new Error('ENOSPC: disk full');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('copy-fresh');
      expect(outcome.freshArtifact).toBe(source);
      expect(outcome.freshArtifact).not.toBe(staging);
      expect(outcome.freshArtifactDigest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(readFileSync(join(staging, 'payload.txt'), 'utf8')).toBe('partial');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
  });

  test('verify-copy mismatch reports only the verified source, never corrupt staging', () => {
    const { source, destination } = fixture();
    const staging = `${destination}.new-verify-mismatch`;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'verify-mismatch',
      operations: {
        copyTree: (_from, to) => {
          mkdirSync(to, { recursive: true });
          writeFileSync(join(to, 'payload.txt'), 'corrupt');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('verify-copy');
      expect(outcome.freshArtifact).toBe(source);
      expect(outcome.freshArtifact).not.toBe(staging);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
  });

  test('live-tree parking failure is non-destructive and retains staged fresh content', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'park-failure',
      operations: {
        rename: () => {
          throw new Error('park injected');
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('park-live');
      expect(outcome.freshArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(existsSync(outcome.freshArtifact)).toBe(true);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('fresh promotion failure restores the prior live tree and retains retry artifacts', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'promote-failure',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames === 2) throw new Error('promote injected');
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.freshArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(existsSync(outcome.freshArtifact)).toBe(true);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('rollback rename failure falls back to a verified copy of the prior tree', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'rollback-copy',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames >= 2) throw new Error(`rename injected ${renames}`);
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.rollbackError).toBeUndefined();
      expect(outcome.previousArtifact).toBeDefined();
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('total rollback failure retains verified fresh and previous artifacts with an actionable error', () => {
    const { source, destination } = fixture();
    let renames = 0;
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      transactionId: 'total-rollback',
      operations: {
        rename: (from, to) => {
          renames += 1;
          if (renames >= 2) throw new Error(`rename failure ${renames}`);
          renameSync(from, to);
        },
        copyTree: (from, to) => {
          if (from.includes('.old-total-rollback')) throw new Error('rollback copy failure');
          copyPayload(from, to);
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('promote-fresh');
      expect(outcome.rollbackError).toContain('rename rollback failed');
      expect(outcome.rollbackError).toContain('copy rollback failed');
      expect(outcome.freshArtifact).toBeDefined();
      expect(outcome.previousArtifact).toBeDefined();
      if (outcome.freshArtifact) expect(readFileSync(join(outcome.freshArtifact, 'payload.txt'), 'utf8')).toBe('fresh');
      if (outcome.previousArtifact)
        expect(readFileSync(join(outcome.previousArtifact, 'payload.txt'), 'utf8')).toBe('old');
    }
    expect(existsSync(destination)).toBe(false);
  });

  test('identical-source removal failure keeps live and verified source and blocks convergence', () => {
    const { source, destination } = fixture();
    writeFileSync(join(destination, 'payload.txt'), 'fresh');
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'identical-remove',
      operations: {
        remove: (path) => {
          if (path === source) throw new Error('source removal failure');
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('remove-identical-source');
      expect(outcome.freshArtifact).toBe(source);
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('post-promotion source-removal failure keeps new live plus old and verified fresh recovery artifacts', () => {
    const { source, destination } = fixture();
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'source-remove',
      operations: {
        remove: (path) => {
          if (path === source) throw new Error('source removal failure');
          rmSync(path, { recursive: true, force: true });
        },
      },
    });
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.stage).toBe('remove-source');
      expect(outcome.freshArtifact).toBeDefined();
      expect(outcome.previousArtifact).toBeDefined();
      if (outcome.previousArtifact)
        expect(readFileSync(join(outcome.previousArtifact, 'payload.txt'), 'utf8')).toBe('old');
    }
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(readFileSync(join(source, 'payload.txt'), 'utf8')).toBe('fresh');
  });

  test('cross-filesystem source is copied and only destination siblings are renamed', () => {
    const { source, destination } = fixture();
    const renameSources: string[] = [];
    const outcome = convergeAuxiliaryTree({
      label: 'plugins',
      source,
      destination,
      removeSourceOnSuccess: true,
      transactionId: 'cross-filesystem',
      operations: {
        rename: (from, to) => {
          renameSources.push(from);
          if (from === source || from.startsWith(`${source}/`)) {
            const error = new Error('cross-device link') as NodeJS.ErrnoException;
            error.code = 'EXDEV';
            throw error;
          }
          renameSync(from, to);
        },
      },
    });
    expect(outcome.status).toBe('refreshed');
    expect(readFileSync(join(destination, 'payload.txt'), 'utf8')).toBe('fresh');
    expect(existsSync(source)).toBe(false);
    expect(renameSources.some((path) => path === source || path.startsWith(`${source}/`))).toBe(false);
  });
});
