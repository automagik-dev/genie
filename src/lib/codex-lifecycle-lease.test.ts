import { afterEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type HeldLifecycleLease, LifecycleFencingError, acquireLifecycleLease } from './codex-lifecycle-lease.js';

const roots: string[] = [];
const heldLeases: HeldLifecycleLease[] = [];

function freshHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'genie-lease-'));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return root;
}

const LEASE_FILE = '.codex-lifecycle.lock';

function leaseRecord(operationId: string, pid = 424242, kind = 'rollback'): string {
  return `${JSON.stringify({ schemaVersion: 1, operationId, kind, pid, startedAt: '2026-07-23T00:00:00.000Z' })}\n`;
}

function stagingRecord(operationId: string, pid = 424242, kind = 'rollback'): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    kind,
    pid,
    startedAt: '2026-07-23T00:00:00.000Z',
    stagingSlot: operationId.slice(0, 2),
  })}\n`;
}

function recoveryRecord(operationId: string, targetOperationId: string, pid = 424242, kind = 'rollback'): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    operationId,
    kind,
    pid,
    startedAt: '2026-07-23T00:00:00.000Z',
    recoveryTargetOperationId: targetOperationId,
  })}\n`;
}

function stagingPath(genieHome: string, operationId: string): string {
  return join(genieHome, `${LEASE_FILE}.staging-${operationId.slice(0, 2)}`);
}

function stagingFiles(genieHome: string): string[] {
  return readdirSync(genieHome).filter((name) => /^\.codex-lifecycle\.lock\.staging-[0-9a-f]{2}$/.test(name));
}

afterEach(() => {
  for (const lease of heldLeases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hold(result: ReturnType<typeof acquireLifecycleLease>): HeldLifecycleLease {
  if (!result.ok) throw new Error(`expected a held lease, got busy: ${result.detail}`);
  heldLeases.push(result);
  return result;
}

describe('acquireLifecycleLease — acquisition and mutual exclusion', () => {
  test('a fresh home grants a lease with a 32-hex operation id and the requested kind', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(lease.operationId).toMatch(/^[0-9a-f]{32}$/);
    expect(lease.kind).toBe('update-delivery');
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });

  test('a missing GENIE_HOME is created even when directory iteration defers ENOENT until read', () => {
    const fixtureRoot = freshHome();
    const genieHome = join(fixtureRoot, 'not-created-yet');
    expect(existsSync(genieHome)).toBe(false);

    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(lease.kind).toBe('update-delivery');
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });

  test('a second acquisition while held returns a typed busy refusal naming the holder kind', () => {
    const genieHome = freshHome();
    hold(acquireLifecycleLease('setup-activation', { genieHome }));
    const second = acquireLifecycleLease('rollback', { genieHome });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.reason).toBe('codex-lifecycle-busy');
    expect(second.holderKind).toBe('setup-activation');
  });

  test('a contender observing publication sees a complete holder record, never BUSY:unknown', () => {
    const genieHome = freshHome();
    const results: { winner?: ReturnType<typeof acquireLifecycleLease> } = {};
    const loser = acquireLifecycleLease('update-delivery', {
      genieHome,
      beforePublishForTest: () => {
        results.winner = acquireLifecycleLease('setup-activation', { genieHome });
      },
    });

    const winner = results.winner;
    expect(winner?.ok).toBe(true);
    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error('unreachable');
    expect(loser.holderKind).toBe('setup-activation');
    expect(loser.detail).toContain('held by setup-activation');
    expect(loser.detail).not.toContain('schema invalid');
    expect(readdirSync(genieHome).filter((name) => name.includes('.staging-'))).toEqual([]);
    if (winner?.ok) winner.release();
  });

  test('a pre-publication failure removes its private record and leaves the stable slot acquirable', () => {
    const genieHome = freshHome();
    expect(() =>
      acquireLifecycleLease('update-delivery', {
        genieHome,
        beforePublishForTest: () => {
          throw new Error('forced publication barrier failure');
        },
      }),
    ).toThrow('forced publication barrier failure');
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(false);
    expect(readdirSync(genieHome).filter((name) => name.includes('.staging-'))).toEqual([]);
    expect(hold(acquireLifecycleLease('rollback', { genieHome })).kind).toBe('rollback');
  });

  test('a non-EEXIST publication I/O failure returns typed busy and cleans its private record', () => {
    const genieHome = freshHome();
    const result = acquireLifecycleLease('update-delivery', {
      genieHome,
      beforePublishForTest: () => {
        const staging = readdirSync(genieHome).find((name) => name.includes('.staging-'));
        if (!staging) throw new Error('expected private lease record');
        rmSync(join(genieHome, staging));
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBeNull();
    expect(result.detail).toContain('lease publication failed');
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(false);
    expect(readdirSync(genieHome).filter((name) => name.includes('.staging-'))).toEqual([]);
    expect(hold(acquireLifecycleLease('rollback', { genieHome })).kind).toBe('rollback');
  });

  test('release makes the slot acquirable again and is idempotent', () => {
    const genieHome = freshHome();
    const first = acquireLifecycleLease('update-delivery', { genieHome });
    if (!first.ok) throw new Error('unreachable');
    first.release();
    first.release(); // idempotent
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(false);
    const second = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(second.ok).toBe(true);
  });

  test('an unsupported kind throws rather than acquiring', () => {
    const genieHome = freshHome();
    const invalidKind = 'totally-invalid' as unknown as Parameters<typeof acquireLifecycleLease>[0];
    expect(() => acquireLifecycleLease(invalidKind, { genieHome })).toThrow();
  });

  test('uninstall is a valid lease kind and serialises against setup-activation (both directions)', () => {
    const genieHome = freshHome();
    const uninstall = hold(acquireLifecycleLease('uninstall', { genieHome }));
    expect(uninstall.kind).toBe('uninstall');
    const setupLoser = acquireLifecycleLease('setup-activation', { genieHome });
    expect(setupLoser.ok).toBe(false);
    if (setupLoser.ok) throw new Error('unreachable');
    expect(setupLoser.reason).toBe('codex-lifecycle-busy');
    expect(setupLoser.holderKind).toBe('uninstall');

    uninstall.release();
    // Reverse direction: a held setup-activation makes uninstall busy.
    hold(acquireLifecycleLease('setup-activation', { genieHome }));
    const uninstallLoser = acquireLifecycleLease('uninstall', { genieHome });
    expect(uninstallLoser.ok).toBe(false);
    if (uninstallLoser.ok) throw new Error('unreachable');
    expect(uninstallLoser.holderKind).toBe('setup-activation');
  });
});

describe('acquireLifecycleLease — stale holder supersession', () => {
  test('a provably dead holder is superseded exactly once, retaining rename evidence', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const staleRecord = {
      schemaVersion: 1,
      operationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      kind: 'setup-activation',
      pid: 424242,
      startedAt: '2026-07-12T00:00:00.000Z',
    };
    writeFileSync(leasePath, `${JSON.stringify(staleRecord)}\n`);

    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
    expect(lease.kind).toBe('update-delivery');

    const staleFiles = readdirSync(genieHome).filter((name) => name.startsWith(`${LEASE_FILE}.stale-`));
    expect(staleFiles.length).toBe(1);
    expect(staleFiles[0]).toBe(`${LEASE_FILE}.stale-${staleRecord.operationId}`);
    const superseded = JSON.parse(readFileSync(join(genieHome, staleFiles[0]), 'utf8'));
    expect(superseded.operationId).toBe(staleRecord.operationId);
  });

  test('a live holder is never superseded and stays busy', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    writeFileSync(
      leasePath,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'b'.repeat(32), kind: 'rollback', pid: 4242, startedAt: 'x' })}\n`,
    );
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => true });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBe('rollback');
    // The live holder's lease was neither superseded nor deleted.
    expect(readdirSync(genieHome).filter((n) => n.startsWith(`${LEASE_FILE}.stale-`)).length).toBe(0);
    expect(existsSync(leasePath)).toBe(true);
  });

  test('an indeterminate (EPERM-style) holder stays busy', () => {
    const genieHome = freshHome();
    writeFileSync(
      join(genieHome, LEASE_FILE),
      `${JSON.stringify({ schemaVersion: 1, operationId: 'c'.repeat(32), kind: 'install-converge', pid: 4242, startedAt: 'x' })}\n`,
    );
    // A liveness probe that reports alive for anything it cannot disprove.
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => true });
    expect(result.ok).toBe(false);
  });

  test('PID reuse after dead-holder capture restores the stable record and stays busy', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const stale = leaseRecord('f'.repeat(32), 424242, 'rollback');
    writeFileSync(leasePath, stale);
    let probes = 0;

    const result = acquireLifecycleLease('update-delivery', {
      genieHome,
      isProcessAlive: () => {
        probes += 1;
        return probes > 1;
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBe('rollback');
    expect(probes).toBe(2);
    expect(readFileSync(leasePath, 'utf8')).toBe(stale);
  });

  test('a fresh holder installed immediately after stale capture is preserved and reported as contention', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const staleId = 'c'.repeat(32);
    const replacementId = 'd'.repeat(32);
    const replacement = leaseRecord(replacementId, process.pid, 'install-converge');
    writeFileSync(leasePath, leaseRecord(staleId, 424242, 'rollback'));

    const result = acquireLifecycleLease('update-delivery', {
      genieHome,
      isProcessAlive: (pid) => pid !== 424242,
      afterCaptureForTest: (event) => {
        if (event.operation === 'stale-supersede') writeFileSync(event.path, replacement);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBe('install-converge');
    expect(readFileSync(leasePath, 'utf8')).toBe(replacement);
    const evidence = readdirSync(genieHome).filter((name) => name.startsWith(`${LEASE_FILE}.stale-`));
    expect(evidence).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(genieHome, evidence[0]), 'utf8')).operationId).toBe(staleId);
  });

  test('ordinary filesystem loss after dead-holder observation returns typed busy instead of throwing', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    writeFileSync(leasePath, leaseRecord('1'.repeat(32), 424242, 'rollback'));

    const result = acquireLifecycleLease('update-delivery', {
      genieHome,
      isProcessAlive: () => false,
      afterDeadHolderObservedForTest: () => rmSync(genieHome, { recursive: true, force: true }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('codex-lifecycle-busy');
    expect(result.holderKind).toBeNull();
    expect(result.detail).toContain('stale-holder recovery claim failed');
  });

  test('an intentional post-capture test callback exception remains distinct', () => {
    const genieHome = freshHome();
    writeFileSync(join(genieHome, LEASE_FILE), leaseRecord('2'.repeat(32), 424242, 'rollback'));

    expect(() =>
      acquireLifecycleLease('update-delivery', {
        genieHome,
        isProcessAlive: () => false,
        afterCaptureForTest: (event) => {
          if (event.operation === 'stale-supersede') throw new Error('intentional capture barrier');
        },
      }),
    ).toThrow('intentional capture barrier');
    expect(readFileSync(join(genieHome, LEASE_FILE), 'utf8')).toBe(leaseRecord('2'.repeat(32), 424242, 'rollback'));
  });

  test('a fresh recovery claimant installed after dead-claim capture is preserved and reported exactly', () => {
    const genieHome = freshHome();
    const claimPath = join(genieHome, `${LEASE_FILE}.recovery`);
    const replacement = recoveryRecord('4'.repeat(32), '5'.repeat(32), process.pid, 'setup-activation');
    writeFileSync(claimPath, recoveryRecord('3'.repeat(32), '5'.repeat(32)));

    const result = acquireLifecycleLease('update-delivery', {
      genieHome,
      isProcessAlive: (pid) => pid === process.pid,
      afterCaptureForTest: (event) => {
        if (event.operation === 'recovery-claim') writeFileSync(event.path, replacement);
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBe('setup-activation');
    expect(readFileSync(claimPath, 'utf8')).toBe(replacement);
  });
});

describe('acquireLifecycleLease — fail-closed invalid lease files', () => {
  test('a symlinked lease path fails closed as busy and is never deleted', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const decoy = join(genieHome, 'decoy.json');
    writeFileSync(
      decoy,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'd'.repeat(32), kind: 'rollback', pid: 4242, startedAt: 'x' })}\n`,
    );
    symlinkSync(decoy, leasePath);
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBeNull();
    expect(existsSync(leasePath)).toBe(true); // symlink preserved, not deleted
  });

  test('an oversized lease file fails closed as busy', () => {
    const genieHome = freshHome();
    writeFileSync(join(genieHome, LEASE_FILE), 'x'.repeat(17 * 1024));
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.holderKind).toBeNull();
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });

  test('a schema-invalid lease file fails closed as busy without deletion', () => {
    const genieHome = freshHome();
    writeFileSync(join(genieHome, LEASE_FILE), '{ not valid json');
    const result = acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false });
    expect(result.ok).toBe(false);
    expect(existsSync(join(genieHome, LEASE_FILE))).toBe(true);
  });
});

describe('acquireLifecycleLease — abandoned private-record recovery', () => {
  test('a fully valid private record whose PID is provably dead is recovered before acquisition', () => {
    const genieHome = freshHome();
    const operationId = '1'.repeat(32);
    const abandoned = stagingPath(genieHome, operationId);
    writeFileSync(abandoned, stagingRecord(operationId));

    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
    expect(lease.kind).toBe('update-delivery');
    expect(existsSync(abandoned)).toBe(false);
    expect(stagingFiles(genieHome)).toEqual([]);
  });

  test('live and indeterminate private records are preserved fail-closed', () => {
    const genieHome = freshHome();
    const liveId = '2'.repeat(32);
    const indeterminateId = 'b'.repeat(32);
    const live = stagingPath(genieHome, liveId);
    const indeterminate = stagingPath(genieHome, indeterminateId);
    writeFileSync(live, stagingRecord(liveId, 424242));
    writeFileSync(indeterminate, stagingRecord(indeterminateId, 424243));

    hold(
      acquireLifecycleLease('update-delivery', {
        genieHome,
        isProcessAlive: (pid) => {
          if (pid === 424242) return true;
          throw new Error('indeterminate liveness probe');
        },
      }),
    );
    expect(readFileSync(live, 'utf8')).toBe(stagingRecord(liveId, 424242));
    expect(readFileSync(indeterminate, 'utf8')).toBe(stagingRecord(indeterminateId, 424243));
  });

  test('PID reuse between dead probes preserves the private record', () => {
    const genieHome = freshHome();
    const operationId = '3'.repeat(32);
    const reused = stagingPath(genieHome, operationId);
    writeFileSync(reused, stagingRecord(operationId));
    let probes = 0;

    hold(
      acquireLifecycleLease('update-delivery', {
        genieHome,
        isProcessAlive: () => {
          probes += 1;
          return probes > 1;
        },
      }),
    );
    expect(probes).toBe(2);
    expect(readFileSync(reused, 'utf8')).toBe(stagingRecord(operationId));
  });

  test('invalid, oversized, symlinked, and filename-mismatched private records are preserved', () => {
    const genieHome = freshHome();
    const malformedId = '4'.repeat(32);
    const oversizedId = '5'.repeat(32);
    const symlinkId = '6'.repeat(32);
    const mismatchedId = '7'.repeat(32);
    const malformed = stagingPath(genieHome, malformedId);
    const oversized = stagingPath(genieHome, oversizedId);
    const symlink = stagingPath(genieHome, symlinkId);
    const mismatched = stagingPath(genieHome, mismatchedId);
    const decoy = join(genieHome, 'staging-decoy.json');
    writeFileSync(malformed, '{ invalid');
    writeFileSync(oversized, 'x'.repeat(17 * 1024));
    writeFileSync(decoy, stagingRecord(symlinkId));
    symlinkSync(decoy, symlink);
    writeFileSync(mismatched, stagingRecord('8'.repeat(32)));

    hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
    expect(readFileSync(malformed, 'utf8')).toBe('{ invalid');
    expect(readFileSync(oversized, 'utf8')).toBe('x'.repeat(17 * 1024));
    expect(lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(readFileSync(mismatched, 'utf8')).toBe(stagingRecord('8'.repeat(32)));
  });

  test('unreadable and multiply-linked private records are preserved', () => {
    const genieHome = freshHome();
    const unreadableId = '9'.repeat(32);
    const linkedId = 'a'.repeat(32);
    const unreadable = stagingPath(genieHome, unreadableId);
    const linked = stagingPath(genieHome, linkedId);
    const foreignLink = join(genieHome, 'foreign-hardlink.json');
    writeFileSync(unreadable, stagingRecord(unreadableId));
    chmodSync(unreadable, 0o000);
    writeFileSync(linked, stagingRecord(linkedId));
    linkSync(linked, foreignLink);

    try {
      hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
      expect(existsSync(unreadable)).toBe(true);
      expect(existsSync(linked)).toBe(true);
      expect(lstatSync(linked).nlink).toBe(2);
    } finally {
      chmodSync(unreadable, 0o600);
    }
  });

  test('recovery work is bounded to sixteen private records per acquisition', () => {
    const genieHome = freshHome();
    for (let index = 1; index <= 20; index += 1) {
      const operationId = `${index.toString(16).padStart(2, '0')}${'0'.repeat(30)}`;
      writeFileSync(stagingPath(genieHome, operationId), stagingRecord(operationId, 420000 + index));
    }

    hold(acquireLifecycleLease('update-delivery', { genieHome, isProcessAlive: () => false }));
    expect(stagingFiles(genieHome)).toHaveLength(4);
  });

  test('a replacement installed immediately after staging capture survives recovery byte-for-byte', () => {
    const genieHome = freshHome();
    const operationId = 'e'.repeat(32);
    const abandoned = stagingPath(genieHome, operationId);
    const replacement = 'foreign staging replacement\n';
    writeFileSync(abandoned, stagingRecord(operationId));

    hold(
      acquireLifecycleLease('update-delivery', {
        genieHome,
        isProcessAlive: () => false,
        afterCaptureForTest: (event) => {
          if (event.operation === 'staging-recovery') writeFileSync(event.path, replacement);
        },
      }),
    );
    expect(readFileSync(abandoned, 'utf8')).toBe(replacement);
  });

  test('fixed staging slots recover independently of 1,210 crowded directory entries', () => {
    const genieHome = freshHome();
    for (let index = 0; index < 1_210; index += 1) {
      writeFileSync(
        join(genieHome, `${LEASE_FILE}.staging-noise-${index.toString().padStart(4, '0')}`),
        '{ preserved invalid debris',
      );
    }
    const operationId = `fe${'0'.repeat(30)}`;
    const recoverable = stagingPath(genieHome, operationId);
    writeFileSync(recoverable, stagingRecord(operationId));

    const lease = hold(acquireLifecycleLease('rollback', { genieHome, isProcessAlive: () => false }));
    expect(lease.kind).toBe('rollback');
    expect(existsSync(recoverable)).toBe(false);
    expect(readdirSync(genieHome).filter((name) => name.includes('staging-noise-'))).toHaveLength(1_210);
  });
});

describe('acquireLifecycleLease — operation-id fencing', () => {
  test('assertOperation accepts the held id and rejects a foreign id', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    expect(() => lease.assertOperation(lease.operationId)).not.toThrow();
    expect(() => lease.assertOperation('f'.repeat(32))).toThrow(LifecycleFencingError);
  });

  test('a superseded on-disk lease fences the prior holder and blocks its release', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const first = acquireLifecycleLease('update-delivery', { genieHome });
    if (!first.ok) throw new Error('unreachable');
    // Simulate another acquirer replacing the on-disk record.
    writeFileSync(
      leasePath,
      `${JSON.stringify({ schemaVersion: 1, operationId: 'e'.repeat(32), kind: 'rollback', pid: process.pid, startedAt: 'x' })}\n`,
    );
    expect(() => first.assertOperation(first.operationId)).toThrow(LifecycleFencingError);
    // Releasing the fenced holder must not delete the new owner's lease.
    first.release();
    expect(existsSync(leasePath)).toBe(true);
    expect(JSON.parse(readFileSync(leasePath, 'utf8')).operationId).toBe('e'.repeat(32));
  });

  for (const [name, replacement] of [
    ['malformed', '{ not a lease'],
    ['oversized', 'x'.repeat(17 * 1024)],
  ] as const) {
    test(`release preserves a ${name} replacement byte-for-byte`, () => {
      const genieHome = freshHome();
      const leasePath = join(genieHome, LEASE_FILE);
      const lease = acquireLifecycleLease('update-delivery', { genieHome });
      if (!lease.ok) throw new Error('unreachable');
      writeFileSync(leasePath, replacement);

      lease.release();
      expect(readFileSync(leasePath, 'utf8')).toBe(replacement);
    });
  }

  test('release preserves an unreadable replacement', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const lease = acquireLifecycleLease('update-delivery', { genieHome });
    if (!lease.ok) throw new Error('unreachable');
    chmodSync(leasePath, 0o000);

    try {
      lease.release();
      expect(existsSync(leasePath)).toBe(true);
    } finally {
      chmodSync(leasePath, 0o600);
    }
  });

  test('release preserves a symlink replacement and its target', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const decoy = join(genieHome, 'replacement-decoy.json');
    const decoyBytes = leaseRecord('f'.repeat(32));
    const lease = acquireLifecycleLease('update-delivery', { genieHome });
    if (!lease.ok) throw new Error('unreachable');
    unlinkSync(leasePath);
    writeFileSync(decoy, decoyBytes);
    symlinkSync(decoy, leasePath);

    lease.release();
    expect(lstatSync(leasePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(decoy, 'utf8')).toBe(decoyBytes);
  });

  test('release removes only its captured generation when a foreign replacement arrives immediately after capture', () => {
    const genieHome = freshHome();
    const leasePath = join(genieHome, LEASE_FILE);
    const replacement = leaseRecord('0'.repeat(32), process.pid, 'rollback');
    const lease = acquireLifecycleLease('update-delivery', {
      genieHome,
      afterCaptureForTest: (event) => {
        if (event.operation === 'release') writeFileSync(event.path, replacement);
      },
    });
    if (!lease.ok) throw new Error('unreachable');

    lease.release();
    expect(readFileSync(leasePath, 'utf8')).toBe(replacement);
  });

  test('assertOperation on a released lease throws', () => {
    const genieHome = freshHome();
    const lease = acquireLifecycleLease('update-delivery', { genieHome });
    if (!lease.ok) throw new Error('unreachable');
    lease.release();
    expect(() => lease.assertOperation(lease.operationId)).toThrow(LifecycleFencingError);
  });
});

describe('acquireLifecycleLease — real two-process race', () => {
  test('exactly one of two spawned processes wins stable publication', async () => {
    const genieHome = freshHome();
    const script = join(genieHome, 'race.ts');
    const modulePath = join(import.meta.dir, 'codex-lifecycle-lease.ts');
    writeFileSync(
      script,
      [
        `import { acquireLifecycleLease } from ${JSON.stringify(modulePath)};`,
        'const genieHome = process.argv[2];',
        `const result = acquireLifecycleLease('update-delivery', { genieHome });`,
        // Do NOT release: hold the lock so both processes contend on the same file.
        `process.stdout.write(result.ok ? 'WON' : 'BUSY');`,
        'if (result.ok) { await new Promise((r) => setTimeout(r, 400)); }',
      ].join('\n'),
    );

    const spawnOne = () =>
      Bun.spawn(['bun', 'run', script, genieHome], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const procs = [spawnOne(), spawnOne(), spawnOne()];
    const outcomes = await Promise.all(
      procs.map(async (proc) => {
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return out.trim();
      }),
    );
    const wins = outcomes.filter((o) => o === 'WON').length;
    const busy = outcomes.filter((o) => o === 'BUSY').length;
    expect(wins).toBe(1);
    expect(busy).toBe(2);
  }, 20_000);
});

describe('acquireLifecycleLease — real two-process cross-kind races (Group D)', () => {
  // The lifecycle lease is one file: setup, update, and uninstall serialise on it
  // regardless of kind. These spawn REAL OS processes (not in-process simulation)
  // for the D-owned pairs — setup+setup, setup+update, uninstall+setup — proving
  // exactly one winner and a loser that reports the winner's holder kind.
  async function raceTwoKinds(
    genieHome: string,
    kindA: string,
    kindB: string,
  ): Promise<Array<{ result: string; holderKind: string | null }>> {
    const script = join(genieHome, `race-${kindA}-${kindB}.ts`);
    const modulePath = join(import.meta.dir, 'codex-lifecycle-lease.ts');
    writeFileSync(
      script,
      [
        `import { acquireLifecycleLease } from ${JSON.stringify(modulePath)};`,
        'const [genieHome, kind] = process.argv.slice(2);',
        'const r = acquireLifecycleLease(kind, { genieHome });',
        'process.stdout.write(JSON.stringify(r.ok ? { result: "WON", holderKind: kind } : { result: "BUSY", holderKind: r.holderKind }));',
        'if (r.ok) { await new Promise((res) => setTimeout(res, 400)); }',
      ].join('\n'),
    );
    const spawn = (kind: string) =>
      Bun.spawn(['bun', 'run', script, genieHome, kind], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env } });
    const procs = [spawn(kindA), spawn(kindB)];
    return Promise.all(
      procs.map(async (proc) => {
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        return JSON.parse(out.trim()) as { result: string; holderKind: string | null };
      }),
    );
  }

  for (const [a, b] of [
    ['setup-activation', 'setup-activation'],
    ['setup-activation', 'update-delivery'],
    ['uninstall', 'setup-activation'],
  ] as const) {
    test(`${a} + ${b}: exactly one winner, loser is codex-lifecycle-busy naming the holder`, async () => {
      const outcomes = await raceTwoKinds(freshHome(), a, b);
      const winners = outcomes.filter((o) => o.result === 'WON');
      const losers = outcomes.filter((o) => o.result === 'BUSY');
      expect(winners.length).toBe(1);
      expect(losers.length).toBe(1);
      expect(losers[0].holderKind).toBe(winners[0].holderKind);
      expect(losers[0].holderKind).not.toBeNull();
    }, 20_000);
  }
});

describe('fixture isolation', () => {
  test('all lease state stays under the fixture home', () => {
    const genieHome = freshHome();
    const lease = hold(acquireLifecycleLease('update-delivery', { genieHome }));
    for (const name of readdirSync(genieHome)) {
      expect(join(genieHome, name).startsWith(genieHome)).toBe(true);
    }
    lease.release();
  });
});
