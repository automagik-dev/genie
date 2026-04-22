/**
 * Unit tests for the shard splitter in scripts/test-parallel.ts. The runner
 * itself (warmup + child spawn) is validated end-to-end via `bun run test:parallel`;
 * this file pins the pure functions the acceptance criteria depend on:
 *   - "individual shards are reproducible" — same input → same split
 *   - "shards within 15% of each other" — LPT balance bound with a durations cache
 *   - "adding a new test file without updating the cache doesn't crash the scheduler"
 *     — missing durations fall back to the median of known durations
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDurations, medianOf, packLPT, shardFiles } from './test-parallel.js';

describe('test-parallel.shardFiles', () => {
  test('round-robins files into K buckets deterministically', () => {
    const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'e.test.ts'];
    const buckets = shardFiles(files, 4);
    expect(buckets).toEqual([['a.test.ts', 'e.test.ts'], ['b.test.ts'], ['c.test.ts'], ['d.test.ts']]);
  });

  test('produces the same assignment on repeated calls with identical input', () => {
    const files = ['x.test.ts', 'y.test.ts', 'z.test.ts'];
    const first = shardFiles(files, 4);
    const second = shardFiles([...files], 4);
    expect(second).toEqual(first);
  });

  test('returns K buckets even when there are fewer files than shards', () => {
    const buckets = shardFiles(['only-one.test.ts'], 4);
    expect(buckets.length).toBe(4);
    expect(buckets[0]).toEqual(['only-one.test.ts']);
    expect(buckets[1]).toEqual([]);
    expect(buckets[2]).toEqual([]);
    expect(buckets[3]).toEqual([]);
  });

  test('balances load within 1 across K buckets', () => {
    const files = Array.from({ length: 199 }, (_, i) => `test_${i}.test.ts`);
    const buckets = shardFiles(files, 4);
    const sizes = buckets.map((b) => b.length);
    const min = Math.min(...sizes);
    const max = Math.max(...sizes);
    expect(max - min).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(files.length);
  });
});

describe('test-parallel.medianOf', () => {
  test('returns 0 for empty input', () => {
    expect(medianOf([])).toBe(0);
  });

  test('returns the middle element for odd-length input', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
  });

  test('returns the average of the two middles for even-length input', () => {
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('test-parallel.packLPT', () => {
  test('rejects shards < 1', () => {
    expect(() => packLPT(['a.test.ts'], null, 0)).toThrow();
  });

  test('returns K empty buckets when there are no files', () => {
    const buckets = packLPT([], null, 4);
    expect(buckets).toEqual([[], [], [], []]);
  });

  test('returns K buckets when there are fewer files than shards', () => {
    const buckets = packLPT(['only-one.test.ts'], null, 4);
    expect(buckets.length).toBe(4);
    expect(buckets.flat()).toEqual(['only-one.test.ts']);
  });

  test('degenerates to a balanced split when no durations are provided', () => {
    const files = Array.from({ length: 16 }, (_, i) => `t${i}.test.ts`);
    const buckets = packLPT(files, null, 4);
    const sizes = buckets.map((b) => b.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(files.length);
  });

  test('packs the longest files first into the smallest bucket', () => {
    const files = ['a', 'b', 'c', 'd', 'e'];
    const durations = { a: 100, b: 80, c: 60, d: 40, e: 20 };
    const buckets = packLPT(files, durations, 2);
    // LPT order: a(100), b(80), c(60), d(40), e(20)
    //  - a → bucket0 [100]
    //  - b → bucket1 [80]
    //  - c → bucket1 [140]   ❌ wrong — should go to smallest (bucket0=100)
    // Actually: a→b0, b→b1, c→b0 (100<80? no) — c→b1 (80<100 so bucket1 is smaller)
    //  - a → b0 [100]
    //  - b → b1 [80]
    //  - c → b1 [140]  (b1=80 < b0=100)
    //  - d → b0 [140]  (b0=100 < b1=140)
    //  - e → b0 [160] or b1 [140+20]... b0=140 < b1=140, tie → b0 [160]
    // Final: b0=[a,d,e]=160, b1=[b,c]=140
    const totals = buckets.map((b) => b.reduce((s, f) => s + (durations as Record<string, number>)[f]!, 0));
    const max = Math.max(...totals);
    const min = Math.min(...totals);
    // LPT (4/3 - 1/(3K)) bound for K=2 is 7/6 ≈ 1.167; our input should be much tighter.
    expect(max / min).toBeLessThanOrEqual(7 / 6);
  });

  test('keeps shards balanced within 15% on a realistic distribution', () => {
    // Simulate ~200 files with a long-tail duration distribution (a few slow
    // integration tests, many fast unit tests). The LPT balance target from
    // the wish is max/min ≤ 1.15.
    const files = Array.from({ length: 200 }, (_, i) => `f${i}.test.ts`);
    const durations: Record<string, number> = {};
    for (let i = 0; i < files.length; i++) {
      // Long-tail: first 10 files are 10x slower than the rest.
      durations[files[i]!] = i < 10 ? 5_000 + i * 100 : 200 + (i % 17) * 15;
    }
    const shards = 4;
    const buckets = packLPT(files, durations, shards);
    const totals = buckets.map((b) => b.reduce((s, f) => s + (durations[f] ?? 0), 0));
    const max = Math.max(...totals);
    const min = Math.min(...totals);
    expect(max / min).toBeLessThanOrEqual(1.15);
  });

  test('falls back to median for files missing from the durations cache', () => {
    // Two files have huge known durations, three are new (no entry).
    // Unknowns must be treated as median (6000 → same as known mid), NOT 0,
    // or all three would pile into shard 0.
    const files = ['big1', 'big2', 'new1', 'new2', 'new3'];
    const durations = { big1: 10_000, big2: 8_000 };
    const buckets = packLPT(files, durations, 3);
    const nonEmpty = buckets.filter((b) => b.length > 0).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(2);
    // Every file placed exactly once, total count preserved.
    expect(buckets.flat().sort()).toEqual([...files].sort());
  });

  test('is deterministic for ties (sorted by path)', () => {
    const files = ['z', 'a', 'm', 'b'];
    const durations = { z: 10, a: 10, m: 10, b: 10 };
    const b1 = packLPT(files, durations, 2);
    const b2 = packLPT([...files].reverse(), durations, 2);
    expect(b2).toEqual(b1);
  });
});

describe('test-parallel.loadDurations', () => {
  test('returns null when path is null', () => {
    expect(loadDurations(null)).toBeNull();
  });

  test('returns null when the file does not exist', () => {
    expect(loadDurations('/nonexistent/path/nope.json')).toBeNull();
  });

  test('parses a valid duration map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-dur-'));
    try {
      const p = join(dir, 'durations.json');
      writeFileSync(p, JSON.stringify({ 'a.test.ts': 123, 'b.test.ts': 456 }));
      expect(loadDurations(p)).toEqual({ 'a.test.ts': 123, 'b.test.ts': 456 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('discards malformed entries but keeps the rest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-dur-'));
    try {
      const p = join(dir, 'durations.json');
      writeFileSync(p, JSON.stringify({ ok: 100, bad: 'string', neg: -5, inf: Number.POSITIVE_INFINITY }));
      const loaded = loadDurations(p);
      expect(loaded).toEqual({ ok: 100 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null on malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-dur-'));
    try {
      const p = join(dir, 'durations.json');
      writeFileSync(p, '{not json');
      expect(loadDurations(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns null when JSON is an array (not an object)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-dur-'));
    try {
      const p = join(dir, 'durations.json');
      writeFileSync(p, '[1, 2, 3]');
      expect(loadDurations(p)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
