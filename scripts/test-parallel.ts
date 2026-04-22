#!/usr/bin/env bun
/**
 * test-parallel — run the bun test suite across K parallel shard workers.
 *
 * Why: `bun test` has no native `--shard=i/K` flag (as of 1.3.x), so we
 * enumerate test files ourselves, split them deterministically, and launch K
 * children with explicit file lists. Each child inherits GENIE_TEST_SHARD_INDEX
 * so src/lib/test-db.ts can prefix per-test DB names with `test_shard<N>_…`,
 * eliminating any chance of identifier collision between workers sharing the
 * pgserve daemon.
 *
 * Scheduling (Group 8): if a durations cache is available (CI downloads the
 * artifact, or `GENIE_TEST_DURATIONS_PATH` / `--durations=<path>` points at a
 * local file), files are assigned to shards via Longest-Processing-Time (LPT)
 * greedy packing — sort descending by duration, then drop each file into the
 * currently-smallest shard. LPT has a known (4/3 - 1/(3K))·OPT bound, and is
 * within 15% of optimal for the shapes our suite produces. Files missing from
 * the cache get the median of known durations so new tests don't all pile onto
 * shard 0. When no cache is available, every file is weighted equal, which
 * degenerates to round-robin.
 *
 * Before any worker spawns we warm the daemon in a single sacrificial child so
 * the K real shards observe the lockfile on startup and reuse the same
 * pgserve rather than racing to bind different ports. Inside each shard,
 * `CREATE DATABASE … TEMPLATE genie_template` is serialized via
 * pg_advisory_lock (see src/lib/test-setup.ts :: createTestDatabase).
 *
 * Knobs:
 *   GENIE_TEST_SHARDS=N              override the default 4-worker split
 *   GENIE_TEST_DURATIONS_PATH=path   JSON map of file→ms for LPT scheduling
 *   --shards=N                       CLI equivalent of GENIE_TEST_SHARDS
 *   --durations=path                 CLI equivalent of GENIE_TEST_DURATIONS_PATH
 *   --emit-durations=path            run each file in its own bun-test spawn
 *                                    and write a fresh durations JSON to path
 *   --report-shard-times             print per-shard wall-clocks + max/min
 *                                    ratio (the LPT balance target)
 *
 * Exit code: max of all shard exit codes (0 iff every shard passed).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_SHARDS = 4;

/** Parse `GENIE_TEST_SHARDS` / `--shards=N`, fall back to DEFAULT_SHARDS on any bogus value. */
function resolveShardCount(): number {
  const cliFlag = process.argv.find((a) => a.startsWith('--shards='));
  const cliRaw = cliFlag ? cliFlag.slice('--shards='.length) : null;
  const raw = cliRaw ?? process.env.GENIE_TEST_SHARDS ?? '';
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SHARDS;
}

function resolveDurationsPath(): string | null {
  const cliFlag = process.argv.find((a) => a.startsWith('--durations='));
  const cliRaw = cliFlag ? cliFlag.slice('--durations='.length) : null;
  return cliRaw ?? process.env.GENIE_TEST_DURATIONS_PATH ?? null;
}

function resolveEmitPath(): string | null {
  const cliFlag = process.argv.find((a) => a.startsWith('--emit-durations='));
  return cliFlag ? cliFlag.slice('--emit-durations='.length) : null;
}

function resolveReportShards(): boolean {
  return process.argv.includes('--report-shard-times');
}

/** Recursive walk for `*.test.ts` files, skipping node_modules and dotted dirs. */
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

/**
 * Enumerate every test file bun would load by default (src/ + scripts/). The
 * returned list is sorted alphabetically so shard assignment is reproducible
 * across runs, machines, and filesystems with non-deterministic readdir order.
 */
export function discoverTestFiles(root: string = ROOT): string[] {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'scripts'))];
  files.sort();
  return files;
}

/**
 * Load a file→duration(ms) map from a JSON file. Returns null if the file is
 * missing or malformed so the caller can cleanly fall back to median-estimate.
 * Non-numeric / negative entries are silently discarded — a half-corrupt cache
 * is still useful.
 */
export function loadDurations(path: string | null): Record<string, number> | null {
  if (!path) return null;
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Median of a non-empty numeric array; 0 on empty input. */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2 : (s[mid] ?? 0);
}

/**
 * Pack files into K shards via Longest-Processing-Time (LPT) greedy:
 *   1. Sort files descending by duration (tiebreak: path, for determinism).
 *   2. For each file, assign it to the shard with the smallest current total.
 * Files without a duration entry get the median of known durations so the
 * scheduler doesn't treat them as zero-weight (which would bucket every new
 * test into shard 0).
 *
 * Exported so scripts/test-parallel.test.ts can unit-test the balance bound.
 */
export function packLPT(files: string[], durations: Record<string, number> | null, shards: number): string[][] {
  if (shards < 1) throw new Error('shards must be >= 1');
  const buckets: string[][] = Array.from({ length: shards }, () => []);
  const totals: number[] = new Array(shards).fill(0);

  const known = durations ? files.map((f) => durations[f]).filter((v): v is number => typeof v === 'number') : [];
  const fallback = known.length > 0 ? medianOf(known) : 1;

  const weighted = files
    .map((file) => ({ file, duration: durations?.[file] ?? fallback }))
    .sort((a, b) => {
      if (b.duration !== a.duration) return b.duration - a.duration;
      return a.file.localeCompare(b.file);
    });

  for (const { file, duration } of weighted) {
    let minIdx = 0;
    for (let i = 1; i < shards; i++) {
      if ((totals[i] ?? 0) < (totals[minIdx] ?? 0)) minIdx = i;
    }
    buckets[minIdx]?.push(file);
    totals[minIdx] = (totals[minIdx] ?? 0) + duration;
  }

  return buckets;
}

/**
 * Legacy deterministic round-robin split. Kept exported for the existing unit
 * tests and as a last-ditch fallback — LPT with `durations=null` already
 * degenerates to a balanced split, but round-robin preserves the file ordering
 * callers might expect.
 */
export function shardFiles(files: string[], shards: number): string[][] {
  const buckets: string[][] = Array.from({ length: shards }, () => []);
  files.forEach((f, idx) => {
    buckets[idx % shards]?.push(f);
  });
  return buckets;
}

/**
 * Tee a child pipe into a parent stream, prepending `<prefix> ` to every line.
 * Handles partial-line chunks by buffering until the next newline.
 */
function prefixStream(stream: NodeJS.ReadableStream | null, prefix: string, target: NodeJS.WriteStream): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) target.write(`${prefix} ${line}\n`);
  });
  stream.on('end', () => {
    if (buf) target.write(`${prefix} ${buf}\n`);
  });
}

/**
 * Boot the shared pgserve daemon exactly once BEFORE launching workers. This
 * avoids the race where K simultaneous preloads each try to spawn their own
 * daemon on different ports (first one wins, the others silently waste
 * seconds binding, building a template, and then tearing down). After this
 * call the lockfile exists and all K workers take the reuse fast-path.
 *
 * GENIE_TEST_FORCE_PGSERVE=1 bypasses the lazy-skip heuristic — `bun -e` has
 * no positional test files, which would otherwise trip the "skip when no PG
 * files are loaded" short-circuit and defeat the warmup.
 *
 * We must call process.exit(0) after the import: test-setup.ts opens a
 * long-lived shared admin postgres.js client (idle_timeout=0) and never
 * registers an exit hook, so `bun -e` wouldn't return on its own. The
 * pgserve child is spawned unref'd and survives parent exit as an orphan
 * (documented quirk in test-setup.ts :: reapOrphanedTestPgservers); the
 * written lockfile points at that orphan so the K shards reuse it.
 */
function warmupDaemon(): number {
  const warmupScript = 'await import("./src/lib/test-setup.ts"); process.exit(0);';
  const r = spawnSync('bun', ['-e', warmupScript], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, GENIE_TEST_FORCE_PGSERVE: '1' },
    timeout: 60_000,
  });
  return r.status ?? 1;
}

type ShardResult = {
  code: number;
  durationMs: number;
  perFile: Record<string, number>;
};

/**
 * Spawn one shard child and resolve with its exit code + wall-clock.
 *
 * In `emit=true` mode we spawn one `bun test` per file so we can time them
 * individually; this mode is strictly for producing the durations cache (CI
 * artifact on main-branch push) and only runs on that infrequent path. In
 * `emit=false` (the normal test:parallel path) we spawn a single `bun test
 * <files...>` and rely on the shared daemon + template cache to amortize
 * startup across the file list.
 */
function spawnBunTest(args: string[], index: number, total: number, prefix: string): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn('bun', args, {
      cwd: ROOT,
      env: {
        ...process.env,
        GENIE_TEST_SHARD_INDEX: String(index),
        GENIE_TEST_SHARDS: String(total),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    prefixStream(c.stdout, prefix, process.stdout);
    prefixStream(c.stderr, prefix, process.stderr);
    c.on('exit', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
    c.on('error', (err) => {
      process.stderr.write(`${prefix} spawn error: ${err.message}\n`);
      resolve(1);
    });
  });
}

async function runShard(index: number, total: number, files: string[], emit: boolean): Promise<ShardResult> {
  const prefix = `[shard ${index}/${total}]`;
  if (files.length === 0) {
    process.stderr.write(`${prefix} no files assigned\n`);
    return { code: 0, durationMs: 0, perFile: {} };
  }
  const t0 = Date.now();
  const perFile: Record<string, number> = {};

  if (emit) {
    let worstCode = 0;
    for (const file of files) {
      const ft0 = Date.now();
      const code = await spawnBunTest(['test', file], index, total, prefix);
      perFile[file] = Date.now() - ft0;
      if (code > worstCode) worstCode = code;
    }
    return { code: worstCode, durationMs: Date.now() - t0, perFile };
  }

  const code = await spawnBunTest(['test', ...files], index, total, prefix);
  return { code, durationMs: Date.now() - t0, perFile: {} };
}

async function main(): Promise<void> {
  const shards = resolveShardCount();
  const durationsPath = resolveDurationsPath();
  const emitPath = resolveEmitPath();
  const reportShards = resolveReportShards();
  const files = discoverTestFiles();
  if (files.length === 0) {
    process.stderr.write('[test-parallel] no test files discovered\n');
    process.exit(1);
  }

  const durations = loadDurations(durationsPath);
  let strategy: string;
  if (durations) {
    const cached = files.filter((f) => f in durations).length;
    strategy = `LPT (durations=${durationsPath}, ${cached}/${files.length} files cached)`;
  } else if (durationsPath) {
    strategy = `LPT (median-estimate — ${durationsPath} missing or invalid)`;
  } else {
    strategy = 'LPT (median-estimate — no durations cache)';
  }
  const buckets = packLPT(files, durations, shards);

  process.stderr.write(`[test-parallel] ${files.length} test files split across ${shards} workers via ${strategy}\n`);
  buckets.forEach((b, i) => {
    process.stderr.write(`[test-parallel] shard ${i + 1}/${shards}: ${b.length} files\n`);
  });

  const warmupCode = warmupDaemon();
  if (warmupCode !== 0) {
    process.stderr.write(`[test-parallel] warmup failed (exit ${warmupCode}) — aborting\n`);
    process.exit(warmupCode);
  }

  const t0 = Date.now();
  const results = await Promise.all(buckets.map((f, i) => runShard(i + 1, shards, f, !!emitPath)));
  const wall = ((Date.now() - t0) / 1000).toFixed(1);
  const codes = results.map((r) => r.code);
  const maxCode = Math.max(0, ...codes);

  if (reportShards) {
    const times = results.map((r) => r.durationMs);
    const nonZero = times.filter((t) => t > 0);
    const min = nonZero.length > 0 ? Math.min(...nonZero) : 0;
    const max = Math.max(...times);
    const ratio = min > 0 ? (max / min).toFixed(3) : 'inf';
    const pretty = times.map((t, i) => `${i + 1}=${(t / 1000).toFixed(1)}s`).join(', ');
    process.stderr.write(`[test-parallel] shard wall-clocks: ${pretty} — max/min=${ratio}\n`);
  }

  if (emitPath) {
    const merged: Record<string, number> = {};
    for (const r of results) {
      for (const [f, d] of Object.entries(r.perFile)) merged[f] = d;
    }
    mkdirSync(dirname(emitPath) || '.', { recursive: true });
    writeFileSync(emitPath, `${JSON.stringify(merged, null, 2)}\n`);
    process.stderr.write(`[test-parallel] emitted durations for ${Object.keys(merged).length} files to ${emitPath}\n`);
  }

  process.stderr.write(`[test-parallel] shard exit codes: ${codes.join(', ')} — max=${maxCode} — wall=${wall}s\n`);
  process.exit(maxCode);
}

// Running directly (not imported by a test) — execute the orchestrator.
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[test-parallel] fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
