/**
 * scripts/list-tests.ts shard-split contract.
 *
 * Verifies:
 *  1. Sharding is exhaustive (every PG file lands in exactly one shard).
 *  2. Sharding is disjoint (no file in two shards).
 *  3. Sharding is deterministic across runs (sorted file list + LPT/round-
 *     robin packing — same input must produce same output).
 *  4. Bad inputs are rejected with non-zero exit.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'list-tests.ts');

function run(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bun', ['run', SCRIPT, ...args], { encoding: 'utf-8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status ?? 0 };
}

test('--pg without --shard lists every PG file', () => {
  const r = run(['--pg']);
  expect(r.status).toBe(0);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  expect(lines.length).toBeGreaterThan(0);
});

test('--pg --shard 1/4 + 2/4 + 3/4 + 4/4 == --pg (exhaustive + disjoint)', () => {
  const all = new Set(run(['--pg']).stdout.trim().split('\n').filter(Boolean));
  const shards = [1, 2, 3, 4].map((i) =>
    run(['--pg', '--shard', `${i}/4`])
      .stdout.trim()
      .split('\n')
      .filter(Boolean),
  );
  // Exhaustive
  const union = new Set(shards.flat());
  expect(union).toEqual(all);
  // Disjoint
  const total = shards.reduce((acc, s) => acc + s.length, 0);
  expect(total).toBe(all.size);
});

test('--pg --shard 1/4 is deterministic across runs', () => {
  const a = run(['--pg', '--shard', '1/4']).stdout;
  const b = run(['--pg', '--shard', '1/4']).stdout;
  expect(a).toBe(b);
});

test('--pg --shard 5/4 fails (out of range)', () => {
  const r = run(['--pg', '--shard', '5/4']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('1 ≤ i ≤ K');
});

test('--non-pg --shard 1/4 fails (sharding is PG-only)', () => {
  const r = run(['--non-pg', '--shard', '1/4']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('--shard is only meaningful with --pg');
});

test('--shard with malformed value fails', () => {
  const r = run(['--pg', '--shard', 'abc']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('must be i/K');
});
