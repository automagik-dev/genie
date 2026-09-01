/**
 * Tests for the shared lifecycle lease. Split verbatim out of the per-agent
 * convergence engine's suite when the lock moved into its own module; the blocks
 * below are unchanged apart from their imports and the minimal tmpdir fixture
 * they need.
 *
 * Run with: bun test src/lib/lifecycle-lease.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  LIFECYCLE_LEASE_OWNER_ENV,
  LIFECYCLE_LEASE_PATH_ENV,
  type LifecycleLeaseSkip,
  acquireLifecycleLease,
  acquireLifecycleLeaseWithWait,
  currentSyncLockHostId,
  lifecycleLockPath,
} from './lifecycle-lease';

interface Fixture {
  root: string;
  genieHome: string;
}

let fixture: Fixture;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lifecycle-lease-')));
  const genieHome = join(root, 'genie');
  mkdirSync(genieHome, { recursive: true });
  fixture = { root, genieHome };
});

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true });
});

describe('shared lifecycle lease', () => {
  test('lives beside GENIE_HOME and is reentrant within one lifecycle process', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    expect(dirname(path)).toBe(dirname(fixture.genieHome));
    expect(path.startsWith(`${fixture.genieHome}/`)).toBe(false);
    const first = acquireLifecycleLease(fixture.genieHome);
    expect('skipped' in first).toBe(false);
    if ('skipped' in first) throw new Error(first.skipped);
    const second = acquireLifecycleLease(fixture.genieHome);
    expect('skipped' in second).toBe(false);
    if ('skipped' in second) throw new Error(second.skipped);
    expect(existsSync(path)).toBe(true);
    second.release();
    expect(existsSync(path)).toBe(true);
    first.release();
    expect(existsSync(path)).toBe(false);
  });

  test('a child borrows only the exact shell-owned lifecycle lease and never releases it', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    const owner = `${process.pid}:${'a'.repeat(32)}:${'b'.repeat(64)}`;
    writeFile(path, `${owner}\n`);
    process.env[LIFECYCLE_LEASE_PATH_ENV] = path;
    process.env[LIFECYCLE_LEASE_OWNER_ENV] = owner;
    try {
      const borrowed = acquireLifecycleLease(fixture.genieHome);
      expect('skipped' in borrowed).toBe(false);
      if ('skipped' in borrowed) throw new Error(borrowed.skipped);
      borrowed.release();
      expect(readFileSync(path, 'utf8')).toBe(`${owner}\n`);
    } finally {
      delete process.env[LIFECYCLE_LEASE_PATH_ENV];
      delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
      rmSync(path, { force: true });
    }
  });

  test('forged or path-mismatched borrowed lifecycle leases fail closed', () => {
    const path = lifecycleLockPath(fixture.genieHome);
    const owner = `${process.pid}:${'c'.repeat(32)}:${'d'.repeat(64)}`;
    writeFile(path, `${owner}\n`);
    try {
      for (const [borrowedPath, borrowedOwner] of [
        [path, `${process.pid}:${'e'.repeat(32)}:${'d'.repeat(64)}`],
        [`${path}.forged`, owner],
      ]) {
        process.env[LIFECYCLE_LEASE_PATH_ENV] = borrowedPath;
        process.env[LIFECYCLE_LEASE_OWNER_ENV] = borrowedOwner;
        const result = acquireLifecycleLease(fixture.genieHome);
        expect('skipped' in result ? result.skipped : '').toContain('did not exactly match');
        expect(readFileSync(path, 'utf8')).toBe(`${owner}\n`);
      }
    } finally {
      delete process.env[LIFECYCLE_LEASE_PATH_ENV];
      delete process.env[LIFECYCLE_LEASE_OWNER_ENV];
      rmSync(path, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Lifecycle-lease busy grace: the same-host dead-holder early steal and the
// bounded wait that replaced the ten-minute staleness hang. Every lock forged
// here has a FRESH mtime — that is the whole point: before this change a
// lifecycle command that crashed one second ago blocked every subsequent
// update/install/setup/uninstall for LOCK_STALE_MS.
// ---------------------------------------------------------------------------

describe('lifecycle lease same-host dead-holder steal', () => {
  const HOST = currentSyncLockHostId();
  const TOKEN = 'abcdef0123456789abcdef0123456789';
  /** Above every plausible live pid on Linux/macOS, so `kill -0` reports ESRCH. */
  const DEAD_PID = 2147483647;
  const STALE_MS = 10 * 60 * 1000;

  /** Write a hand-built owner record at the lifecycle lock path with a fresh mtime. */
  function forge(record: string): string {
    const path = lifecycleLockPath(fixture.genieHome);
    writeFile(path, record);
    // Pin the premise: nothing below is reachable through the staleness rule.
    expect(Date.now() - statSync(path).mtimeMs).toBeLessThan(STALE_MS);
    return path;
  }

  /**
   * The process-start identity THIS process stamps into its own lock records,
   * read back from a real acquisition at an unrelated path. `unknown` means the
   * platform could not resolve one, in which case PID reuse is unprovable.
   */
  function selfLockIdentity(): string {
    const probeHome = join(fixture.root, 'identity-probe', 'genie');
    mkdirSync(dirname(probeHome), { recursive: true });
    const lease = acquireLifecycleLease(probeHome);
    if ('skipped' in lease) throw new Error(lease.skipped);
    const record = readFileSync(lifecycleLockPath(probeHome), 'utf8').trim();
    lease.release();
    return record.split(':')[2] as string;
  }

  function expectRefused(result: ReturnType<typeof acquireLifecycleLease>, path: string): LifecycleLeaseSkip {
    if (!('skipped' in result)) {
      result.release();
      throw new Error('lease was acquired but the holder must never have been displaced');
    }
    expect(result.skipped).toContain(`holds the lock at ${path}`);
    expect(result.cause).toBe('held');
    return result;
  }

  test('a FRESH same-host lock whose owner is provably dead is stolen on the first attempt', () => {
    // Identity is irrelevant to a death proof: the shell installer's
    // `unknown` form and a full 64-hex identity are both stolen.
    for (const identity of ['unknown', 'a'.repeat(64)]) {
      const path = forge(`${DEAD_PID}:${TOKEN}:${identity}:${HOST}\n`);
      const lease = acquireLifecycleLease(fixture.genieHome);
      if ('skipped' in lease) throw new Error(`fresh dead holder was not stolen: ${lease.skipped}`);
      // The lock now carries OUR record, and no steal guard was left behind.
      expect(readFileSync(path, 'utf8').startsWith(`${process.pid}:`)).toBe(true);
      expect(existsSync(`${path}.steal`)).toBe(false);
      lease.release();
      expect(existsSync(path)).toBe(false);
    }
  });

  test('a FRESH same-host lock whose live pid no longer matches its start identity is stolen (pid reuse)', () => {
    const self = selfLockIdentity();
    const mismatched = self === 'b'.repeat(64) ? 'c'.repeat(64) : 'b'.repeat(64);
    const path = forge(`${process.pid}:${TOKEN}:${mismatched}:${HOST}\n`);

    const lease = acquireLifecycleLease(fixture.genieHome);

    if ('skipped' in lease) {
      // Only legitimate on a platform that cannot resolve a start identity at
      // all: PID reuse is then unprovable and the record must be kept.
      expect(self).toBe('unknown');
      expectRefused(lease, path);
      return;
    }
    expect(self).not.toBe('unknown');
    expect(readFileSync(path, 'utf8').startsWith(`${process.pid}:`)).toBe(true);
    lease.release();
  });

  test('a FRESH same-host lock held by this very live process is never stolen', () => {
    const record = `${process.pid}:${TOKEN}:${selfLockIdentity()}:${HOST}\n`;
    const path = forge(record);

    const refusal = expectRefused(acquireLifecycleLease(fixture.genieHome), path);

    // The wording an operator actually reads: actionable, and no longer the
    // retired sync report's reassurance (false for an unrelated lifecycle holder).
    expect(refusal.skipped).toContain('retry shortly, or remove the file if its owner has crashed');
    expect(refusal.skipped).not.toContain('the holder converges the same targets');
    expect(readFileSync(path, 'utf8')).toBe(record); // untouched
  });

  test('a FRESH cross-host record with a locally-dead pid is never stolen', () => {
    const record = `${DEAD_PID}:${TOKEN}:unknown:${'f'.repeat(64)}\n`;
    const path = forge(record);

    expectRefused(acquireLifecycleLease(fixture.genieHome), path);

    expect(readFileSync(path, 'utf8')).toBe(record); // a peer host's lock is not ours
  });

  test('a FRESH unparsable or empty record yields no death proof and is never stolen', () => {
    for (const record of ['', 'not-a-lock-record\n', `${DEAD_PID}:garbage:${HOST}\n`]) {
      const path = forge(record);
      expectRefused(acquireLifecycleLease(fixture.genieHome), path);
      expect(readFileSync(path, 'utf8')).toBe(record);
      rmSync(path, { force: true });
    }
  });

  /**
   * Drive the exact interleaving the under-guard re-verification exists to
   * close: the observed record is replaced AFTER the caller proved it dead but
   * BEFORE the `.steal` guard is taken. Made deterministic by hooking the death
   * probe itself — `kill -0` on the observed pid is the last thing the acquirer
   * does with that record before it reaches the guard.
   */
  function acquireWithRecordReplacedUnderUs(path: string, replacement: string): LifecycleLeaseSkip {
    const realKill = process.kill.bind(process);
    let publishedUnderUs = false;
    process.kill = ((pid: number, signal?: string | number) => {
      if (!publishedUnderUs) {
        publishedUnderUs = true;
        writeFileSync(path, replacement);
      }
      return realKill(pid, signal as never);
    }) as typeof process.kill;
    try {
      const refusal = expectRefused(acquireLifecycleLease(fixture.genieHome), path);
      expect(publishedUnderUs).toBe(true);
      return refusal;
    } finally {
      process.kill = realKill;
    }
  }

  test('a dead record replaced before the guarded steal survives byte-for-byte, live or dead', () => {
    const deadRecord = `${DEAD_PID}:${TOKEN}:unknown:${HOST}\n`;
    const replacements = [
      // A new LIVE owner published under us.
      `${process.pid}:${TOKEN}:${selfLockIdentity()}:${HOST}\n`,
      // A DIFFERENT same-host dead owner: only the byte-identical record
      // re-read can refuse this one — a liveness re-probe alone would clear it.
      `${DEAD_PID - 1}:${TOKEN}:unknown:${HOST}\n`,
    ];

    for (const replacement of replacements) {
      const path = forge(deadRecord);

      acquireWithRecordReplacedUnderUs(path, replacement);

      expect(readFileSync(path, 'utf8')).toBe(replacement); // the new record survives intact
      expect(existsSync(`${path}.steal`)).toBe(false); // the guard was released
      rmSync(path, { force: true });
    }
  });
});

describe('acquireLifecycleLeaseWithWait', () => {
  const fakeLease = () => ({ path: '/fixture/lifecycle.lock', release: () => undefined });

  test('a refusal that cannot clear on its own makes exactly one attempt and never sleeps', () => {
    // `borrow-mismatch` and `io` are permanent for this invocation; a
    // cause-less skip (hand-built fixtures, pre-existing callers) is treated as
    // non-retryable so nobody silently inherits a wait they never asked for.
    for (const cause of ['borrow-mismatch', 'io', undefined] as const) {
      let attempts = 0;
      const startedAt = Date.now();
      const result = acquireLifecycleLeaseWithWait(() => {
        attempts += 1;
        return { skipped: 'permanent refusal', cause };
      }, 5_000);

      expect(attempts).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect('skipped' in result && result.skipped).toBe('permanent refusal');
    }
  });

  test('GENIE_LIFECYCLE_LEASE_WAIT_MS=0 restores the historical single-attempt fail-fast', () => {
    const prior = process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS;
    process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = '0';
    try {
      let attempts = 0;
      const result = acquireLifecycleLeaseWithWait(() => {
        attempts += 1;
        return { skipped: 'held', cause: 'held' };
      });

      expect(attempts).toBe(1);
      expect('skipped' in result).toBe(true);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, 'GENIE_LIFECYCLE_LEASE_WAIT_MS');
      else process.env.GENIE_LIFECYCLE_LEASE_WAIT_MS = prior;
    }
  });

  test('a held or contended holder is polled until the deadline, then the skip is returned', () => {
    for (const cause of ['held', 'contended'] as const) {
      let attempts = 0;
      const startedAt = Date.now();
      const result = acquireLifecycleLeaseWithWait(() => {
        attempts += 1;
        return { skipped: 'still busy', cause };
      }, 120);

      expect(attempts).toBeGreaterThan(1);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(120);
      expect('skipped' in result && result.skipped).toBe('still busy');
    }
  });

  test('a holder that releases mid-wait yields the lease instead of a refusal', () => {
    let attempts = 0;
    const result = acquireLifecycleLeaseWithWait(() => {
      attempts += 1;
      return attempts < 3 ? { skipped: 'held', cause: 'held' as const } : fakeLease();
    }, 5_000);

    expect(attempts).toBe(3);
    expect('skipped' in result).toBe(false);
  });
});
