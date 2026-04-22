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
 *   scripts/list-tests.ts --pg       # prints PG-dependent test files
 *   scripts/list-tests.ts --non-pg   # prints test files that skip pgserve
 *
 * Output: one relative path per line, sorted for deterministic sharding.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

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

function main(): void {
  const pgOnly = process.argv.includes('--pg');
  const nonPgOnly = process.argv.includes('--non-pg');
  if (pgOnly === nonPgOnly) {
    process.stderr.write('usage: list-tests.ts --pg | --non-pg\n');
    process.exit(2);
  }
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))].sort();
  const selected = files.filter((f) => (pgOnly ? needsPgserve(f) : !needsPgserve(f)));
  for (const f of selected) {
    process.stdout.write(`${relative(ROOT, f)}\n`);
  }
}

main();
