/**
 * Tests for cleanupLegacyArtifacts registry primitive (wish update-unify-stages, Group 2).
 *
 * Run with: bun test src/genie-commands/__tests__/legacy-cleanup.test.ts
 */

import { describe, expect, test } from 'bun:test';
import {
  type CleanupReport,
  type LegacyArtifact,
  REGISTRY,
  cleanupLegacyArtifacts,
  parseSkipCleanupFlag,
} from '../legacy-cleanup.js';

function makeSyntheticArtifact(
  name: string,
  opts: {
    present?: boolean;
    removed?: string[];
    warnings?: string[];
    onCall?: (event: 'detect' | 'cleanup' | 'summary') => void;
  } = {},
): LegacyArtifact {
  const present = opts.present ?? true;
  const removed = opts.removed ?? [`${name}.removed`];
  const warnings = opts.warnings ?? [];
  return {
    name,
    async detect() {
      opts.onCall?.('detect');
      return present;
    },
    async cleanup() {
      opts.onCall?.('cleanup');
      return { removed: [...removed], warnings: [...warnings] };
    },
    summary() {
      opts.onCall?.('summary');
      return `${name} summary`;
    },
  };
}

describe('cleanupLegacyArtifacts — default (empty) registry', () => {
  test('REGISTRY is empty by default for genie day-one', () => {
    expect(REGISTRY).toEqual([]);
  });

  test('returns { entries: [] } with empty registry and no skips', async () => {
    const report = await cleanupLegacyArtifacts(new Set());
    expect(report).toEqual({ entries: [] });
  });

  test('returns { entries: [] } with empty registry even when skipList has names', async () => {
    const report = await cleanupLegacyArtifacts(new Set(['nats-reply-sidecar', 'foo']));
    expect(report).toEqual({ entries: [] });
  });
});

describe('cleanupLegacyArtifacts — synthetic registry via dependency injection', () => {
  test('detect → cleanup are invoked in order on a present artifact', async () => {
    const calls: Array<'detect' | 'cleanup' | 'summary'> = [];
    const artifact = makeSyntheticArtifact('foo', {
      present: true,
      removed: ['/tmp/foo'],
      warnings: ['was deprecated'],
      onCall: (e) => calls.push(e),
    });

    const report = await cleanupLegacyArtifacts(new Set(), [artifact]);

    expect(calls).toEqual(['detect', 'cleanup']);
    expect(report.entries).toEqual([
      {
        name: 'foo',
        outcome: 'cleaned',
        removed: ['/tmp/foo'],
        warnings: ['was deprecated'],
      },
    ]);
  });

  test('absent artifact yields outcome=absent, cleanup never called', async () => {
    const calls: Array<'detect' | 'cleanup' | 'summary'> = [];
    const artifact = makeSyntheticArtifact('ghost', { present: false, onCall: (e) => calls.push(e) });

    const report = await cleanupLegacyArtifacts(new Set(), [artifact]);

    expect(calls).toEqual(['detect']);
    expect(report.entries).toEqual([{ name: 'ghost', outcome: 'absent', removed: [], warnings: [] }]);
  });

  test('skipList honored: artifact present + skipList=[name] → outcome=skipped, detect never called', async () => {
    const calls: Array<'detect' | 'cleanup' | 'summary'> = [];
    const artifact = makeSyntheticArtifact('x', { present: true, onCall: (e) => calls.push(e) });

    const report = await cleanupLegacyArtifacts(new Set(['x']), [artifact]);

    expect(calls).toEqual([]);
    expect(report.entries).toEqual([{ name: 'x', outcome: 'skipped', removed: [], warnings: [] }]);
  });

  test('mixed registry — cleaned, absent, skipped — preserves declaration order', async () => {
    const a = makeSyntheticArtifact('alpha', { present: true, removed: ['a1'] });
    const b = makeSyntheticArtifact('beta', { present: false });
    const c = makeSyntheticArtifact('gamma', { present: true, removed: ['c1'] });

    const report = await cleanupLegacyArtifacts(new Set(['gamma']), [a, b, c]);

    expect(report.entries.map((e) => [e.name, e.outcome])).toEqual([
      ['alpha', 'cleaned'],
      ['beta', 'absent'],
      ['gamma', 'skipped'],
    ]);
  });

  test('CleanupReport shape matches the cross-CLI contract', async () => {
    const report: CleanupReport = await cleanupLegacyArtifacts(new Set());
    expect(report).toHaveProperty('entries');
    expect(Array.isArray(report.entries)).toBe(true);
  });
});

describe('parseSkipCleanupFlag', () => {
  test('undefined → empty set', () => {
    expect(parseSkipCleanupFlag(undefined)).toEqual(new Set());
  });

  test('empty string → empty set', () => {
    expect(parseSkipCleanupFlag('')).toEqual(new Set());
  });

  test('single name', () => {
    expect(parseSkipCleanupFlag('nats-reply-sidecar')).toEqual(new Set(['nats-reply-sidecar']));
  });

  test('comma-separated names with whitespace', () => {
    expect(parseSkipCleanupFlag('a, b ,c')).toEqual(new Set(['a', 'b', 'c']));
  });

  test('drops empty fragments from trailing commas', () => {
    expect(parseSkipCleanupFlag('a,,b,')).toEqual(new Set(['a', 'b']));
  });
});
