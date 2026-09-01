import { describe, expect, test } from 'bun:test';
import {
  acquireOrderedLifecycleLeases,
  lifecycleBusyMessage,
  releaseOrderedLifecycleLeases,
} from './ordered-lifecycle-leases.js';

/**
 * The ordered pair collapsed to a single lease when the Codex lifecycle lease
 * left with the Codex plugin subsystem. What survives is the one busy
 * projection every lifecycle command shares, and the acquire/release shape
 * install/update/uninstall/setup still call.
 */
describe('lifecycle lease acquisition', () => {
  test('acquires the lease and returns the held handle', () => {
    const events: string[] = [];
    const acquired = acquireOrderedLifecycleLeases(() => {
      events.push('acquire');
      return { path: '/tmp/lease.lock', release: () => events.push('release') };
    });

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    releaseOrderedLifecycleLeases(acquired.lifecycleLease);
    expect(events).toEqual(['acquire', 'release']);
  });

  test('a skipped acquisition is a busy refusal carrying the acquirer detail', () => {
    const acquired = acquireOrderedLifecycleLeases(() => ({ skipped: 'held by pid 4242' }));

    expect(acquired.ok).toBe(false);
    if (acquired.ok) return;
    expect(acquired.busy).toBe('lifecycle');
    expect(acquired.detail).toBe('held by pid 4242');
  });

  test('the busy sentence stays byte-identical with and without a suffix', () => {
    expect(lifecycleBusyMessage('held by pid 7')).toBe('Another Genie lifecycle command is active: held by pid 7');
    expect(lifecycleBusyMessage('held by pid 7', ' No files were removed; retry once it completes.')).toBe(
      'Another Genie lifecycle command is active: held by pid 7 No files were removed; retry once it completes.',
    );
  });

  test('a release failure propagates to the caller', () => {
    const acquired = acquireOrderedLifecycleLeases(() => ({
      path: '/tmp/lease.lock',
      release: () => {
        throw new Error('release failed');
      },
    }));

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(() => releaseOrderedLifecycleLeases(acquired.lifecycleLease)).toThrow('release failed');
  });
});
