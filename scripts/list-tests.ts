#!/usr/bin/env bun
/**
 * list-tests — enumerate test files partitioned by PG-harness usage.
 *
 * Used by the `unit-tests` CI job (Group 9) to produce the file list for
 * `GENIE_TEST_SKIP_PGSERVE=1 bun test …`. A PG-dependent file referencing
 * `test-db` / `test-setup` / `getConnection` / `GENIE_TEST_PG` would boot
 * pgserve on import, defeating the no-pgserve contract of the unit-tests
 * runner; excluding them keeps that runner truly hermetic.
 *
 * Keep PG_HARNESS_MARKERS in sync with src/lib/test-setup.ts — a marker
 * added there but not here will cause a PG-dependent test to land on the
 * unit-tests runner and fail with "connection refused".
 *
 *   scripts/list-tests.ts --pg                 # all PG-dependent test files
 *   scripts/list-tests.ts --non-pg             # all non-PG test files
 *   scripts/list-tests.ts --pg --shard 1/4     # files for shard 1 of 4
 *
 * `--shard <i>/<K>` (1-indexed `i`, total `K`) deterministically splits the
 * sorted PG file list across K disjoint shards. The split uses LPT (longest-
 * processing-time) packing when a duration cache is available at
 * `.genie/state/test-durations.json`, falling back to round-robin when the
 * cache is missing — same algorithm as `scripts/test-parallel.ts`.
 *
 * Output: one relative path per line, sorted for deterministic sharding.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { loadDurations, packLPT, shardFiles } from './test-parallel.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

// Mirror of src/lib/test-setup.ts :: PG_HARNESS_MARKERS. Duplicated because
// importing test-setup.ts would trigger its preload side effects (pgserve
// boot, lockfile write) in a context where we only want to grep filenames.
const PG_HARNESS_MARKERS = ['test-db', 'test-setup', 'getConnection', 'GENIE_TEST_PG'];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      out.push(...walk(p));
    } else if (entry.endsWith('.test.ts') || entry.endsWith('.test.tsx')) {
      out.push(p);
    }
  }
  return out;
}

// Conservative bias: unreadable files are classified as PG so they run on
// the pg-tests runner (which has full harness), not the hermetic one.
function needsPgserve(file: string): boolean {
  let src: string;
  try {
    src = readFileSync(file, 'utf-8');
  } catch {
    return true;
  }
  return PG_HARNESS_MARKERS.some((marker) => src.includes(marker));
}

function parseShardArg(): { index: number; total: number } | null {
  const idx = process.argv.indexOf('--shard');
  if (idx === -1) return null;
  const raw = process.argv[idx + 1];
  if (!raw) {
    process.stderr.write('error: --shard requires a value of the form i/K\n');
    process.exit(2);
  }
  const m = /^(\d+)\/(\d+)$/.exec(raw);
  if (!m) {
    process.stderr.write(`error: --shard value "${raw}" must be i/K (e.g. 1/4)\n`);
    process.exit(2);
  }
  const index = Number.parseInt(m[1], 10);
  const total = Number.parseInt(m[2], 10);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    process.stderr.write(`error: --shard "${raw}" must satisfy 1 ≤ i ≤ K\n`);
    process.exit(2);
  }
  return { index, total };
}

function main(): void {
  const pgOnly = process.argv.includes('--pg');
  const nonPgOnly = process.argv.includes('--non-pg');
  if (pgOnly === nonPgOnly) {
    process.stderr.write('usage: list-tests.ts --pg | --non-pg [--shard i/K]\n');
    process.exit(2);
  }
  const shard = parseShardArg();
  if (shard && nonPgOnly) {
    process.stderr.write(
      'error: --shard is only meaningful with --pg (the non-PG list runs on a single hermetic runner)\n',
    );
    process.exit(2);
  }

  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))].sort();
  const selected = files.filter((f) => (pgOnly ? needsPgserve(f) : !needsPgserve(f))).map((f) => relative(ROOT, f));

  if (!shard) {
    for (const f of selected) process.stdout.write(`${f}\n`);
    return;
  }

  // LPT-pack across `total` shards, then emit only the requested shard's
  // file list. Same algorithm as scripts/test-parallel.ts so the local
  // dev experience and CI shard composition stay consistent.
  const durationsPath = join(ROOT, '.genie', 'state', 'test-durations.json');
  const durations = loadDurations(existsSync(durationsPath) ? durationsPath : null);
  const packed = durations ? packLPT(selected, durations, shard.total) : shardFiles(selected, shard.total);
  const myShard = packed[shard.index - 1] ?? [];
  for (const f of myShard) process.stdout.write(`${f}\n`);
}

main();
