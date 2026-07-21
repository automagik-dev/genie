/**
 * Unit tests for the ui-bridge lifetime primitives — the change watcher and the
 * ppid backstop. Both inject their db-read / ppid-read so these are deterministic
 * and process-free: no real reparenting, no clock racing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Stoppable, isOrphaned, startChangeWatcher, startPpidBackstop } from './bridge-watcher.js';

/** Deadline-based wait for a predicate, polling cheaply. Avoids arbitrary sleeps. */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

const started: Stoppable[] = [];
function track<T extends Stoppable>(s: T): T {
  started.push(s);
  return s;
}
afterEach(() => {
  for (const s of started.splice(0)) s.stop();
});

// ============================================================================
// Change watcher
// ============================================================================

describe('startChangeWatcher', () => {
  test('fires onChange only when data_version increments', async () => {
    let version = 10;
    const changes: number[] = [];
    track(
      startChangeWatcher({
        dbPath: join(tmpdir(), 'nonexistent-dir-xyz', 'genie.db'),
        readDataVersion: () => version,
        onChange: (v) => changes.push(v),
        pollMs: 10,
      }),
    );

    // No change yet → no notification.
    await new Promise((r) => setTimeout(r, 40));
    expect(changes).toEqual([]);

    // External commit bumps data_version → exactly one notification.
    version = 11;
    expect(await waitUntil(() => changes.length === 1)).toBe(true);
    expect(changes).toEqual([11]);

    // Steady state → no repeats.
    await new Promise((r) => setTimeout(r, 40));
    expect(changes).toEqual([11]);
  });

  test('null (db unavailable) never fires onChange', async () => {
    const changes: number[] = [];
    track(
      startChangeWatcher({
        dbPath: join(tmpdir(), 'nope', 'genie.db'),
        readDataVersion: () => null,
        onChange: (v) => changes.push(v),
        pollMs: 10,
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(changes).toEqual([]);
  });

  test('fs-watch on the db directory wakes the poll early', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-watch-'));
    const dbPath = join(dir, 'genie.db');
    writeFileSync(dbPath, '');
    let version = 1;
    const changes: number[] = [];
    // Long poll interval: if the change is seen quickly, it must be the fs-watch
    // wake hint firing, not the (500ms) interval.
    track(
      startChangeWatcher({
        dbPath,
        readDataVersion: () => version,
        onChange: (v) => changes.push(v),
        pollMs: 500,
      }),
    );
    version = 2;
    writeFileSync(join(dir, 'genie.db-wal'), 'x'); // touch a sibling → dir event
    const seen = await waitUntil(() => changes.length === 1, 300); // < pollMs
    rmSync(dir, { recursive: true, force: true });
    expect(seen).toBe(true);
    expect(changes).toEqual([2]);
  });

  test('stop() is idempotent and halts further notifications', async () => {
    let version = 0;
    const changes: number[] = [];
    const w = startChangeWatcher({
      dbPath: join(tmpdir(), 'x', 'genie.db'),
      readDataVersion: () => version,
      onChange: (v) => changes.push(v),
      pollMs: 10,
    });
    w.stop();
    w.stop(); // idempotent — no throw
    version = 5;
    await new Promise((r) => setTimeout(r, 40));
    expect(changes).toEqual([]);
  });
});

// ============================================================================
// ppid backstop
// ============================================================================

describe('isOrphaned', () => {
  test('true when ppid changed, false when unchanged, false on the 0 sentinel', () => {
    expect(isOrphaned(4321, 4321)).toBe(false);
    expect(isOrphaned(4321, 9999)).toBe(true);
    // Subreaper-aware: never assume reparent-to-1; and 0 (unknown) is not orphaned.
    expect(isOrphaned(4321, 1)).toBe(true);
    expect(isOrphaned(4321, 0)).toBe(false);
  });
});

describe('startPpidBackstop', () => {
  test('fires onOrphaned exactly once when the parent pid changes', async () => {
    let ppid = 1000;
    let orphaned = 0;
    track(
      startPpidBackstop({
        originalPpid: 1000,
        getPpid: () => ppid,
        onOrphaned: () => {
          orphaned++;
        },
        intervalMs: 10,
      }),
    );
    // Parent alive → no trip.
    await new Promise((r) => setTimeout(r, 40));
    expect(orphaned).toBe(0);

    // Parent changed (died + reparented) → exactly one trip, then latched.
    ppid = 1;
    expect(await waitUntil(() => orphaned === 1)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(orphaned).toBe(1);
  });

  test('stop() halts the backstop', async () => {
    let ppid = 500;
    let orphaned = 0;
    const b = startPpidBackstop({
      originalPpid: 500,
      getPpid: () => ppid,
      onOrphaned: () => {
        orphaned++;
      },
      intervalMs: 10,
    });
    b.stop();
    ppid = 777;
    await new Promise((r) => setTimeout(r, 40));
    expect(orphaned).toBe(0);
  });
});
