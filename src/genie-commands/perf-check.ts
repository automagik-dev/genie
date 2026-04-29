/**
 * `genie doctor --perf` — surface per-handler P50/P99 from `hook_perf_baseline`
 * and flag regressions or recent fallback-log entries.
 *
 * Group 4 of wish hookify-perf-foundation. Pure consumer of the view created
 * by `src/db/migrations/056_hook_perf_baseline_view.sql`; no PG schema work
 * here, just SELECT + table render.
 *
 * Exit semantics:
 *   - 0 — healthy: no regression > 50% AND no fallback entries in the last 5 min.
 *   - 1 — regression detected OR fallback entries present.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConnection } from '../lib/db.js';

interface BaselineRow {
  event_name: string;
  tool_name: string;
  handler_name: string;
  p50_1h: number | null;
  p99_1h: number | null;
  p50_24h: number | null;
  p99_24h: number | null;
  p50_7d: number | null;
  p99_7d: number | null;
  sample_count_24h: number;
}

interface FallbackEntry {
  ts: string;
  event: string | null;
  tool: string | null;
  command: string | null;
  agent_id: string | null;
  reason: string;
}

/**
 * Severity tag for surfaced findings — matches the wish criterion "Fallback-log
 * entries within last 5 min appear in `genie doctor` output with HIGH severity"
 * (WISH §"Telemetry & regression detection"). Both regressions and recent
 * fallback entries are tagged HIGH; the field is explicit in the JSON output
 * and rendered as a red glyph in human output.
 */
type Severity = 'HIGH' | 'MEDIUM' | 'LOW';
const REGRESSION_SEVERITY: Severity = 'HIGH';
const FALLBACK_SEVERITY: Severity = 'HIGH';

interface PerfReport {
  baseline: BaselineRow[];
  regressions: Array<{
    handler: string;
    tool: string;
    event: string;
    p99_current_ms: number;
    p99_baseline_ms: number;
    delta_pct: number;
    severity: Severity;
  }>;
  recent_fallback_entries: Array<FallbackEntry & { severity: Severity }>;
  fallback_log_path: string;
  generated_at: string;
}

/** P99 regression threshold — flag handlers whose 1h P99 is >50% above their 7d P99. */
const REGRESSION_PCT = 50;
/** Surface fallback entries from the last N seconds. */
const FALLBACK_WINDOW_SECONDS = 300;

function fallbackLogPath(): string {
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  return join(home, 'hook-fallback.log');
}

function readRecentFallbackEntries(): FallbackEntry[] {
  const path = fallbackLogPath();
  if (!existsSync(path)) return [];
  const cutoffMs = Date.now() - FALLBACK_WINDOW_SECONDS * 1000;
  const stat = statSync(path);
  // Read at most the last 256 KB of the log to bound work on large files.
  const readBytes = Math.min(stat.size, 256 * 1024);
  const buf = Buffer.alloc(readBytes);
  const handle = openSync(path, 'r');
  try {
    readSync(handle, buf, 0, readBytes, Math.max(0, stat.size - readBytes));
  } finally {
    closeSync(handle);
  }
  const text = buf.toString('utf-8');
  // Drop the partial first line if we read mid-file.
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const candidates: FallbackEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as FallbackEntry;
      if (Date.parse(entry.ts) >= cutoffMs) candidates.push(entry);
    } catch {
      // skip malformed line — older partial line from mid-buffer truncation
    }
  }
  return candidates;
}

async function loadBaseline(): Promise<BaselineRow[]> {
  const sql = await getConnection();
  const rows = (await sql`
    SELECT
      event_name,
      tool_name,
      handler_name,
      p50_1h,
      p99_1h,
      p50_24h,
      p99_24h,
      p50_7d,
      p99_7d,
      sample_count_24h
    FROM hook_perf_baseline
    ORDER BY p99_1h DESC NULLS LAST, sample_count_24h DESC
  `) as unknown as BaselineRow[];
  return rows.map((r) => ({
    ...r,
    // postgres.js returns numerics as strings — coerce for downstream math.
    p50_1h: r.p50_1h === null ? null : Number(r.p50_1h),
    p99_1h: r.p99_1h === null ? null : Number(r.p99_1h),
    p50_24h: r.p50_24h === null ? null : Number(r.p50_24h),
    p99_24h: r.p99_24h === null ? null : Number(r.p99_24h),
    p50_7d: r.p50_7d === null ? null : Number(r.p50_7d),
    p99_7d: r.p99_7d === null ? null : Number(r.p99_7d),
    sample_count_24h: Number(r.sample_count_24h),
  }));
}

export function detectRegressions(rows: BaselineRow[]): PerfReport['regressions'] {
  const out: PerfReport['regressions'] = [];
  for (const r of rows) {
    if (r.p99_1h === null || r.p99_7d === null) continue;
    if (r.p99_7d <= 0) continue;
    const deltaPct = ((r.p99_1h - r.p99_7d) / r.p99_7d) * 100;
    if (deltaPct > REGRESSION_PCT) {
      out.push({
        handler: r.handler_name,
        tool: r.tool_name,
        event: r.event_name,
        p99_current_ms: r.p99_1h,
        p99_baseline_ms: r.p99_7d,
        delta_pct: deltaPct,
        severity: REGRESSION_SEVERITY,
      });
    }
  }
  return out;
}

function formatMs(value: number | null): string {
  if (value === null) return '—';
  return `${value.toFixed(2)}ms`;
}

function printBaselineSection(rows: BaselineRow[]): void {
  if (rows.length === 0) {
    console.log('  No `hook.delivery` spans found.');
    console.log(
      '  \x1b[2mEnable telemetry: GENIE_WIDE_EMIT=1 (or wait for the daemon-mode default to take effect).\x1b[0m',
    );
    return;
  }
  console.log('  per-handler P50 / P99 over 1h, 24h, 7d (samples_24h):');
  console.log();
  for (const row of rows) {
    const tag = `${row.event_name}/${row.tool_name}/${row.handler_name}`;
    const win = `1h ${formatMs(row.p50_1h)} / ${formatMs(row.p99_1h)} | 24h ${formatMs(row.p50_24h)} / ${formatMs(row.p99_24h)} | 7d ${formatMs(row.p50_7d)} / ${formatMs(row.p99_7d)}`;
    console.log(`  ${tag.padEnd(46)}  ${win}  (n=${row.sample_count_24h})`);
  }
}

function printRegressionsSection(regressions: PerfReport['regressions']): void {
  if (regressions.length === 0) {
    console.log('  \x1b[32m✓\x1b[0m no P99 regression > 50% vs 7d baseline');
    return;
  }
  console.log(`  \x1b[31m✗ [HIGH]\x1b[0m ${regressions.length} P99 regression(s) > 50% vs 7d baseline:`);
  for (const reg of regressions) {
    console.log(
      `    \x1b[31m•\x1b[0m ${reg.event}/${reg.tool}/${reg.handler}: ${reg.p99_current_ms.toFixed(1)}ms (baseline ${reg.p99_baseline_ms.toFixed(1)}ms, +${reg.delta_pct.toFixed(0)}%)`,
    );
  }
}

function printFallbackSection(entries: FallbackEntry[], logPath: string): void {
  if (entries.length === 0) {
    console.log('  \x1b[32m✓\x1b[0m no hook-socket fallback entries in the last 5 min');
    return;
  }
  console.log(`  \x1b[31m✗ [HIGH]\x1b[0m ${entries.length} hook-socket fallback entry/entries in the last 5 min:`);
  console.log(`    \x1b[2mlog: ${logPath}\x1b[0m`);
  const sample = entries.slice(-5);
  for (const entry of sample) {
    console.log(
      `    \x1b[31m•\x1b[0m ${entry.ts} ${entry.event ?? '?'}/${entry.tool ?? '?'}: ${entry.reason}${entry.command ? ` — ${entry.command}` : ''}`,
    );
  }
  if (entries.length > 5) {
    console.log(`    \x1b[2m… ${entries.length - 5} earlier entr(y/ies) suppressed.\x1b[0m`);
  }
}

function printHumanReport(report: PerfReport): void {
  console.log();
  console.log('\x1b[1mHook Performance Baseline\x1b[0m');
  console.log(`\x1b[2m${'─'.repeat(40)}\x1b[0m`);
  printBaselineSection(report.baseline);
  console.log();
  printRegressionsSection(report.regressions);
  console.log();
  printFallbackSection(report.recent_fallback_entries, report.fallback_log_path);
  console.log();
}

/** Internal exports for tests — not part of the stable surface. */
export const _testExports = { readRecentFallbackEntries, detectRegressions };

export async function runPerfCheck(json: boolean): Promise<void> {
  const baseline = await loadBaseline();
  const regressions = detectRegressions(baseline);
  const fallback = readRecentFallbackEntries().map((entry) => ({ ...entry, severity: FALLBACK_SEVERITY }));
  const report: PerfReport = {
    baseline,
    regressions,
    recent_fallback_entries: fallback,
    fallback_log_path: fallbackLogPath(),
    generated_at: new Date().toISOString(),
  };
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanReport(report);
  }
  if (regressions.length > 0 || fallback.length > 0) process.exit(1);
}
