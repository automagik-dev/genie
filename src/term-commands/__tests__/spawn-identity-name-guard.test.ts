/**
 * Regression: fix-spawn-uuid-rename-regression wish (Bug A).
 *
 * Commit 8886e5f0 added a guard in resolveSpawnIdentity that early-returns
 * when the spawn `name` is not UUID-shaped — correct, because the SQL probe
 * downstream would crash trying to cast a role-name string to UUID. But the
 * early-return minted a fresh UUID for `workerId` instead of preserving the
 * human-readable spawn name. That UUID then propagated as custom_name and
 * role through findOrCreateAgent → registerSpawnWorker → hireAgent, breaking
 * every `--to <role-name>` resolver tier on dev-local.
 *
 * The fix preserves `name` as `workerId` for non-UUID inputs (one line at
 * agents.ts:2373). This file is a standalone regression test that does not
 * touch PG — the early-return path is pure (no DB access), so we can verify
 * it without the heavy pgserve fixture in the parent agents.test.ts file.
 */

import { describe, expect, test } from 'bun:test';
import { resolveSpawnIdentity } from '../agents.js';

describe('resolveSpawnIdentity — non-UUID name guard (regression: spawn-uuid-rename)', () => {
  test('non-UUID name preserves name as workerId (Bug A primary fix)', async () => {
    const fixedSessionUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const identity = await resolveSpawnIdentity('engineer', 'team-x', () => fixedSessionUuid);
    expect(identity.kind).toBe('canonical');
    expect(identity.workerId).toBe('engineer');
    expect(identity.sessionUuid).toBe(fixedSessionUuid);
  });

  test('hyphenated role names are preserved verbatim', async () => {
    const identity = await resolveSpawnIdentity(
      'council--architect',
      'team-y',
      () => '11111111-2222-3333-4444-555555555555',
    );
    expect(identity.kind).toBe('canonical');
    expect(identity.workerId).toBe('council--architect');
  });

  test('parallel-suffix worker names (engineer-4-eac7) are preserved', async () => {
    // PR #1627 motivating case: SQL probe used to crash on this input.
    // Post-guard, it must early-return with workerId === name (not a UUID).
    const identity = await resolveSpawnIdentity(
      'engineer-4-eac7',
      'team-z',
      () => '22222222-3333-4444-5555-666666666666',
    );
    expect(identity.kind).toBe('canonical');
    expect(identity.workerId).toBe('engineer-4-eac7');
  });

  test('uuidFactory is called exactly once (sessionUuid only) on the early-return path', async () => {
    // Pre-fix: factory was called twice (workerId + sessionUuid both minted).
    // Post-fix: factory is called once (sessionUuid only); workerId === name.
    let calls = 0;
    const factory = () => {
      calls += 1;
      return `${'0'.repeat(8)}-0000-0000-0000-${String(calls).padStart(12, '0')}`;
    };
    const identity = await resolveSpawnIdentity('reviewer', 'team-w', factory);
    expect(calls).toBe(1);
    expect(identity.workerId).toBe('reviewer');
  });
});
