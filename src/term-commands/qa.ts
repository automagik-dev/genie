/**
 * QA Command — Self-testing system for genie CLI.
 *
 * Usage:
 *   genie qa                        # Run all QA specs
 *   genie qa messaging              # Run a domain
 *   genie qa messaging/round-trip   # Run one spec
 *   genie qa status                 # Dashboard (no execution)
 *   genie qa history                # Recent runs
 *   genie qa --timeout 120          # Custom timeout per spec
 *   genie qa --verbose              # Show all collected events
 *   genie qa --ndjson               # Machine-readable output
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as agentRegistry from '../lib/agent-registry.js';
import { parseQaSpec } from '../lib/qa-parser.js';
import {
  type CollectedEvent,
  type ExpectReport,
  type QaRunnerOptions,
  type SpecReport,
  defaultSpecDir,
  runAllSpecs,
  runDomainSpecs,
  runSpec,
} from '../lib/qa-runner.js';
import {
  type SpecEntry,
  type StoredResult,
  formatTimeAgo,
  isStale,
  listAllSpecs,
  loadResults,
  saveResult,
  specKeyFromPath,
} from '../lib/qa-state.js';
import { publishSubjectEvent } from '../lib/runtime-events.js';
import { type LogEvent, readTeamLog } from '../lib/unified-log.js';

// ============================================================================
// Types
// ============================================================================

export interface QaOptions {
  timeout?: number;
  parallel?: number;
  verbose?: boolean;
  ndjson?: boolean;
}

export interface QaCheckOptions {
  team?: string;
  since?: string;
  sinceFile?: string;
}

// ============================================================================
// Command Handlers
// ============================================================================

/** Main `genie qa [target]` handler — run specs. */
export async function qaCommand(target: string | undefined, options: QaOptions): Promise<void> {
  const specDir = defaultSpecDir();
  const runnerOpts: QaRunnerOptions = {
    timeout: options.timeout ?? 3600,
    parallel: options.parallel ?? 5,
    verbose: options.verbose ?? false,
    repoPath: process.cwd(),
    ndjson: options.ndjson ?? false,
  };

  let reports: SpecReport[];

  if (target) {
    reports = await resolveAndRun(specDir, target, runnerOpts);
  } else {
    reports = await runAllSpecs(specDir, runnerOpts);
  }

  if (reports.length === 0) {
    console.error(`\x1b[33mNo QA specs found for "${target ?? 'all'}"\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  if (options.ndjson) {
    for (const report of reports) console.log(JSON.stringify(report));
  } else {
    printRunResults(reports, options.verbose ?? false);
  }

  const allPassed = reports.every((r) => r.result === 'pass');
  if (!allPassed) process.exitCode = 1;
}

export async function qaCheckCommand(specFile: string, options: QaCheckOptions): Promise<void> {
  const team = options.team ?? process.env.GENIE_TEAM;
  if (!team) {
    console.error('Error: QA team not set. Use --team <name> or run inside a QA worker.');
    process.exitCode = 1;
    return;
  }

  const repoPath = process.cwd();
  const spec = await parseQaSpec(specFile);
  const since = options.since ?? (options.sinceFile ? await readSinceValue(options.sinceFile) : undefined);
  const teamAgents = (await agentRegistry.list()).filter((agent) => agent.team === team);
  const events = await readTeamLog(teamAgents, repoPath, team, since ? { since, last: 200 } : { last: 200 });
  const expectations = evaluateExpectations(spec.expect, events);
  const collectedEvents = toCollectedEvents(events);
  const result: SpecReport['result'] = expectations.every((exp) => exp.result === 'pass') ? 'pass' : 'fail';

  await publishSubjectEvent(repoPath, `genie.qa.${team}.result`, {
    kind: 'qa',
    agent: 'qa',
    team,
    text: `QA result: ${result}`,
    data: {
      result,
      expectations,
      collectedEvents,
    },
    source: 'hook',
  });

  console.log(`QA result published to PG event log as genie.qa.${team}.result`);
}

/** `genie qa status` — Dashboard showing all specs with last result. */
export async function qaStatusCommand(options?: { json?: boolean }): Promise<void> {
  const specDir = defaultSpecDir();
  const repoPath = process.cwd();
  const specs = await listAllSpecs(specDir);
  const results = await loadResults(repoPath);

  if (specs.length === 0) {
    if (options?.json) {
      console.log(JSON.stringify({ specs: [], summary: { total: 0, pass: 0, fail: 0, stale: 0, never: 0 } }));
    } else {
      console.error('\x1b[33mNo QA specs found.\x1b[0m');
    }
    return;
  }

  if (options?.json) {
    await printJsonStatus(specs, results, repoPath);
  } else {
    await printHumanStatus(specs, results, repoPath);
  }
}

/** Render QA status as JSON. */
async function printJsonStatus(
  specs: SpecEntry[],
  results: Record<string, StoredResult>,
  repoPath: string,
): Promise<void> {
  const jsonSpecs = [];
  for (const spec of specs) {
    const stored = results[spec.key];
    const stale = stored ? await isStale(repoPath, spec.key, spec.filePath) : false;
    const status = !stored ? 'never' : stale ? 'stale' : stored.result;
    jsonSpecs.push({
      key: spec.key,
      domain: spec.domain,
      name: spec.name,
      status,
      durationMs: stored?.durationMs ?? null,
      lastRun: stored?.lastRun ?? null,
      expectations: stored?.expectations ?? [],
      error: stored?.error ?? null,
    });
  }
  const counts = {
    total: specs.length,
    pass: jsonSpecs.filter((s) => s.status === 'pass').length,
    fail: jsonSpecs.filter((s) => s.status === 'fail' || s.status === 'error').length,
    stale: jsonSpecs.filter((s) => s.status === 'stale').length,
    never: jsonSpecs.filter((s) => s.status === 'never').length,
  };
  console.log(JSON.stringify({ specs: jsonSpecs, summary: counts }));
}

/** Render QA status as a human-readable dashboard. */
async function printHumanStatus(
  specs: SpecEntry[],
  results: Record<string, StoredResult>,
  repoPath: string,
): Promise<void> {
  console.log();
  console.log('\x1b[1m  QA Status\x1b[0m');
  console.log('  \x1b[2m────────────────────────────────────────\x1b[0m');
  console.log();

  let currentDomain = '';
  const counts = { pass: 0, fail: 0, stale: 0, never: 0 };

  for (const spec of specs) {
    if (spec.domain !== currentDomain) {
      currentDomain = spec.domain;
      console.log(`  \x1b[1m${currentDomain}/\x1b[0m`);
    }

    const stored = results[spec.key];
    const stale = stored ? await isStale(repoPath, spec.key, spec.filePath) : false;
    console.log(formatStatusLine(spec, stored, stale));
    tallyResult(counts, stored, stale);
  }

  printStatusSummary(specs.length, counts);
}

function tallyResult(
  counts: { pass: number; fail: number; stale: number; never: number },
  stored: StoredResult | undefined,
  stale: boolean,
): void {
  if (!stored) counts.never++;
  else if (stale) counts.stale++;
  else if (stored.result === 'pass') counts.pass++;
  else counts.fail++;
}

function printStatusSummary(total: number, counts: { pass: number; fail: number; stale: number; never: number }): void {
  console.log();
  const parts = [
    `${counts.pass}/${total} pass`,
    counts.fail ? `${counts.fail} fail` : '',
    counts.stale ? `${counts.stale} stale` : '',
    counts.never ? `${counts.never} never` : '',
  ].filter(Boolean);
  console.log(`  ${parts.join(' | ')}`);
  console.log();
}

async function readSinceValue(path: string): Promise<string | undefined> {
  try {
    const value = (await readFile(path, 'utf-8')).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function evaluateExpectations(
  expectations: Awaited<ReturnType<typeof parseQaSpec>>['expect'],
  events: LogEvent[],
): ExpectReport[] {
  return expectations.map((expectation) => {
    const matched = events.find((event) => eventMatchesExpectation(event, expectation.matchers));
    if (matched) {
      return {
        description: expectation.description,
        result: 'pass',
        evidence: `${matched.kind} ${matched.agent}: ${matched.text.slice(0, 120)}`,
      };
    }

    return {
      description: expectation.description,
      result: 'fail',
      reason: 'No matching event found in team log/transcript snapshot',
    };
  });
}

function eventMatchesExpectation(event: LogEvent, matchers: Record<string, string>): boolean {
  return Object.entries(matchers).every(([field, expected]) =>
    matcherMatches(readEventField(event, field), expected, field),
  );
}

function readEventField(event: LogEvent, field: string): unknown {
  switch (field) {
    case 'timestamp':
      return event.timestamp;
    case 'kind':
      return event.kind;
    case 'agent':
      return event.agent;
    case 'team':
      return event.team;
    case 'direction':
      return event.direction;
    case 'peer':
      return event.peer;
    case 'text':
      return event.text;
    case 'source':
      return event.source;
    default:
      break;
  }
  return event.data?.[field];
}

function matcherMatches(actual: unknown, expected: string, field: string): boolean {
  if (actual == null) return false;

  if (field === 'kind' && expected === 'message') {
    return ['message', 'assistant', 'user'].includes(String(actual));
  }

  const actualText = String(actual);
  if (expected.startsWith('~')) return actualText.includes(expected.slice(1));
  return actualText === expected;
}

function toCollectedEvents(events: LogEvent[]): CollectedEvent[] {
  return events.slice(-50).map((event) => ({
    timestamp: event.timestamp,
    kind: event.kind,
    agent: event.agent,
    text: event.text,
  }));
}

/** `genie qa history` — Show recent runs. */
export async function qaHistoryCommand(): Promise<void> {
  const repoPath = process.cwd();
  const results = await loadResults(repoPath);

  const entries = Object.entries(results)
    .map(([key, r]) => ({ key, ...r }))
    .sort((a, b) => new Date(b.lastRun).getTime() - new Date(a.lastRun).getTime());

  if (entries.length === 0) {
    console.error('\x1b[33mNo QA history found. Run `genie qa` first.\x1b[0m');
    return;
  }

  console.log();
  console.log('\x1b[1m  QA History\x1b[0m');
  console.log();

  const limit = 20;
  for (const entry of entries.slice(0, limit)) {
    const icon = resultIcon(entry.result);
    const duration = entry.durationMs ? `${(entry.durationMs / 1000).toFixed(1)}s` : '-';
    const ago = formatTimeAgo(entry.lastRun);
    console.log(`  ${icon} ${entry.key.padEnd(35)} ${duration.padStart(6)}  \x1b[2m${ago}\x1b[0m`);
  }

  if (entries.length > limit) {
    console.log(`  \x1b[2m... and ${entries.length - limit} more\x1b[0m`);
  }
  console.log();
}

// ============================================================================
// Target Resolution
// ============================================================================

/** Resolve target as: domain directory, spec file path, or spec name. */
async function resolveAndRun(specDir: string, target: string, opts: QaRunnerOptions): Promise<SpecReport[]> {
  // 1. Try as domain directory (e.g. "messaging")
  const domainDir = join(specDir, target);
  if (await isDirectory(domainDir)) {
    return runDomainSpecs(specDir, target, opts);
  }

  // 2. Try as spec path (e.g. "messaging/round-trip-response" or "messaging/round-trip-response.md")
  const specPath = await resolveSpecPath(specDir, target);
  if (specPath) {
    const spec = await parseQaSpec(specPath);
    const key = specKeyFromPath(specDir, specPath);
    const report = await runSpec(spec, { ...opts, specKey: key });
    const repoPath = opts.repoPath ?? process.cwd();
    await saveResult(repoPath, key, report);
    return [report];
  }

  // 3. Not found — show available specs
  console.error(`\x1b[31mSpec or domain not found: ${target}\x1b[0m`);
  console.error('Available:');
  const allSpecs = await listAllSpecs(specDir);
  const domains = [...new Set(allSpecs.map((s) => s.domain))];
  for (const d of domains) console.error(`  \x1b[1m${d}/\x1b[0m`);
  for (const s of allSpecs) console.error(`    ${s.key}`);
  process.exitCode = 1;
  return [];
}

async function resolveSpecPath(specDir: string, name: string): Promise<string | null> {
  const candidates = [join(specDir, name), join(specDir, `${name}.md`)];
  for (const path of candidates) {
    if (await isFile(path)) return path;
  }
  return null;
}

// ============================================================================
// Output Formatters
// ============================================================================

function resultIcon(result: string): string {
  if (result === 'pass') return '\x1b[32m✅\x1b[0m';
  if (result === 'fail') return '\x1b[31m❌\x1b[0m';
  if (result === 'error') return '\x1b[33m⚠️\x1b[0m';
  return '🔘';
}

function formatStatusLine(spec: SpecEntry, stored: StoredResult | undefined, stale: boolean): string {
  if (!stored) {
    return `    🔘 ${spec.name.padEnd(25)} ${'-'.padStart(6)}  \x1b[2mnever\x1b[0m`;
  }
  if (stale) {
    const ago = formatTimeAgo(stored.lastRun);
    return `    ⚠️  ${spec.name.padEnd(25)} ${'-'.padStart(6)}  \x1b[33m${ago} (stale)\x1b[0m`;
  }
  const icon = resultIcon(stored.result);
  const duration = stored.durationMs ? `${(stored.durationMs / 1000).toFixed(0)}s` : '-';
  const ago = formatTimeAgo(stored.lastRun);
  return `    ${icon} ${spec.name.padEnd(25)} ${duration.padStart(6)}  \x1b[2m${ago}\x1b[0m`;
}

function printRunResults(reports: SpecReport[], verbose: boolean): void {
  console.log();
  console.log('\x1b[1m  QA Results\x1b[0m');
  console.log();

  for (const report of reports) printReport(report, verbose);

  const passed = reports.filter((r) => r.result === 'pass').length;
  const failed = reports.filter((r) => r.result === 'fail').length;
  const errors = reports.filter((r) => r.result === 'error').length;
  const total = reports.length;

  const color = failed + errors > 0 ? '\x1b[31m' : '\x1b[32m';
  const failedStr = failed ? ` \x1b[31m${failed} failed\x1b[0m` : '';
  const errorsStr = errors ? ` \x1b[33m${errors} errors\x1b[0m` : '';
  console.log(`  ${color}${passed}/${total} passed\x1b[0m${failedStr}${errorsStr}`);
  console.log();
}

function printReport(report: SpecReport, verbose: boolean): void {
  const duration = `${(report.durationMs / 1000).toFixed(1)}s`;
  console.log(`  ${resultIcon(report.result)} ${report.name} \x1b[2m(${duration})\x1b[0m`);

  if (report.error) console.log(`    \x1b[31mError: ${report.error}\x1b[0m`);
  for (const exp of report.expectations) printExpectation(exp);

  if (verbose && report.collectedEvents.length > 0) {
    console.log(`    \x1b[2m--- Collected events (${report.collectedEvents.length}) ---\x1b[0m`);
    for (const event of report.collectedEvents) {
      console.log(`    \x1b[2m  ${event.timestamp} ${event.kind} ${event.agent}: ${event.text.slice(0, 80)}\x1b[0m`);
    }
  }

  console.log();
}

function printExpectation(exp: { description: string; result: string; evidence?: string; reason?: string }): void {
  const icon = exp.result === 'pass' ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`    ${icon} ${exp.description}`);
  if (exp.result === 'pass' && exp.evidence) {
    console.log(`      \x1b[2m${exp.evidence}\x1b[0m`);
  }
  if (exp.result === 'fail' && exp.reason) {
    console.log(`      \x1b[31m${exp.reason}\x1b[0m`);
  }
}

// ============================================================================
// Filesystem Helpers
// ============================================================================

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
