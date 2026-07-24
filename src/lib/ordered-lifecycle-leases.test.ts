import { describe, expect, test } from 'bun:test';
import { acquireOrderedLifecycleLeases, releaseOrderedLifecycleLeases } from './ordered-lifecycle-leases.js';

function heldCodexLease(release: () => void = () => undefined) {
  return {
    ok: true as const,
    operationId: 'a'.repeat(32),
    kind: 'update-delivery' as const,
    assertOperation: () => undefined,
    release,
  };
}

describe('ordered lifecycle leases', () => {
  test('acquires agent-sync before Codex and releases in reverse order', () => {
    const events: string[] = [];
    const acquired = acquireOrderedLifecycleLeases(
      () => {
        events.push('acquire-agent-sync');
        return { path: '/fixture/agent-sync.lock', release: () => events.push('release-agent-sync') };
      },
      () => {
        events.push('acquire-codex');
        return heldCodexLease(() => events.push('release-codex'));
      },
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) throw new Error('fixture acquisition unexpectedly busy');
    releaseOrderedLifecycleLeases(acquired.codexLease, acquired.agentSyncLease);
    expect(events).toEqual(['acquire-agent-sync', 'acquire-codex', 'release-codex', 'release-agent-sync']);
  });

  test('returns a discriminated agent-sync busy result without acquiring Codex', () => {
    let codexAcquisitions = 0;
    const acquired = acquireOrderedLifecycleLeases(
      () => ({ skipped: 'outer busy' }),
      () => {
        codexAcquisitions += 1;
        return heldCodexLease();
      },
    );

    expect(acquired).toEqual({ ok: false, busy: 'agent-sync', detail: 'outer busy' });
    expect(codexAcquisitions).toBe(0);
  });

  test('returns a discriminated Codex busy result after releasing agent-sync', () => {
    const events: string[] = [];
    const acquired = acquireOrderedLifecycleLeases(
      () => ({ path: '/fixture/agent-sync.lock', release: () => events.push('release-agent-sync') }),
      () => ({
        ok: false as const,
        reason: 'codex-lifecycle-busy' as const,
        holderKind: 'setup-activation' as const,
        detail: 'inner busy',
      }),
    );

    expect(acquired).toEqual({
      ok: false,
      busy: 'codex',
      refusal: {
        ok: false,
        reason: 'codex-lifecycle-busy',
        holderKind: 'setup-activation',
        detail: 'inner busy',
      },
    });
    expect(events).toEqual(['release-agent-sync']);
  });

  test('releases agent-sync when Codex acquisition throws', () => {
    const acquisitionError = new Error('Codex acquisition fixture');
    const events: string[] = [];

    expect(() =>
      acquireOrderedLifecycleLeases(
        () => {
          events.push('acquire-agent-sync');
          return { path: '/fixture/agent-sync.lock', release: () => events.push('release-agent-sync') };
        },
        () => {
          events.push('acquire-codex');
          throw acquisitionError;
        },
      ),
    ).toThrow(acquisitionError);
    expect(events).toEqual(['acquire-agent-sync', 'acquire-codex', 'release-agent-sync']);
  });

  test('aggregates Codex acquisition and agent-sync release failures in causal order', () => {
    const acquisitionError = new Error('Codex acquisition fixture');
    const releaseError = new Error('agent-sync release fixture');
    const events: string[] = [];
    let thrown: unknown;

    try {
      acquireOrderedLifecycleLeases(
        () => {
          events.push('acquire-agent-sync');
          return {
            path: '/fixture/agent-sync.lock',
            release: () => {
              events.push('release-agent-sync');
              throw releaseError;
            },
          };
        },
        () => {
          events.push('acquire-codex');
          throw acquisitionError;
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(events).toEqual(['acquire-agent-sync', 'acquire-codex', 'release-agent-sync']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([acquisitionError, releaseError]);
  });

  test('an inner-only release failure is preserved after the outer release runs', () => {
    const innerError = new Error('inner release fixture');
    const events: string[] = [];

    expect(() =>
      releaseOrderedLifecycleLeases(
        {
          release: () => {
            events.push('release-codex');
            throw innerError;
          },
        },
        { release: () => events.push('release-agent-sync') },
      ),
    ).toThrow(innerError);
    expect(events).toEqual(['release-codex', 'release-agent-sync']);
  });

  test('an outer-only release failure is preserved after the inner release runs', () => {
    const outerError = new Error('outer release fixture');
    const events: string[] = [];

    expect(() =>
      releaseOrderedLifecycleLeases(
        { release: () => events.push('release-codex') },
        {
          release: () => {
            events.push('release-agent-sync');
            throw outerError;
          },
        },
      ),
    ).toThrow(outerError);
    expect(events).toEqual(['release-codex', 'release-agent-sync']);
  });

  test('dual release failures are aggregated deterministically after both run', () => {
    const innerError = new Error('inner release fixture');
    const outerError = new Error('outer release fixture');
    const events: string[] = [];
    let thrown: unknown;

    try {
      releaseOrderedLifecycleLeases(
        {
          release: () => {
            events.push('release-codex');
            throw innerError;
          },
        },
        {
          release: () => {
            events.push('release-agent-sync');
            throw outerError;
          },
        },
      );
    } catch (error) {
      thrown = error;
    }

    expect(events).toEqual(['release-codex', 'release-agent-sync']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([innerError, outerError]);
  });
});
