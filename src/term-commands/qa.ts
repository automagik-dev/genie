/**
 * QA Command — Self-testing system for genie CLI.
 *
 * Usage:
 *   genie qa                        # Run all QA specs
 *   genie qa nats-streaming         # Run one spec by name
 *   genie qa --timeout 120          # Custom timeout per spec
 *   genie qa --verbose              # Show all collected events
 *   genie qa --ndjson               # Machine-readable output
 */

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseQaSpec } from '../lib/qa-parser.js';
import {
  type ExpectReport,
  type QaRunnerOptions,
  type SpecReport,
  defaultSpecDir,
  runAllSpecs,
  runSpec,
} from '../lib/qa-runner.js';

// ============================================================================
// Types
// ============================================================================

export interface QaOptions {
  timeout?: number;
  verbose?: boolean;
  ndjson?: boolean;
}

// ============================================================================
// Command Handler
// ============================================================================

export async function qaCommand(specName: string | undefined, options: QaOptions): Promise<void> {
  const specDir = defaultSpecDir();
  const runnerOpts: QaRunnerOptions = {
    timeout: options.timeout ?? 60,
    verbose: options.verbose ?? false,
    repoPath: process.cwd(),
  };

  let reports: SpecReport[];

  if (specName) {
    const specPath = await resolveSpecPath(specDir, specName);
    if (!specPath) {
      console.error(`\x1b[31mSpec not found: ${specName}\x1b[0m`);
      console.error(`Available specs in ${specDir}:`);
      await listAvailableSpecs(specDir);
      process.exitCode = 1;
      return;
    }
    const spec = await parseQaSpec(specPath);
    const report = await runSpec(spec, runnerOpts);
    reports = [report];
  } else {
    reports = await runAllSpecs(specDir, runnerOpts);
  }

  if (reports.length === 0) {
    console.error(`\x1b[33mNo QA specs found in ${specDir}\x1b[0m`);
    process.exitCode = 1;
    return;
  }

  if (options.ndjson) {
    for (const report of reports) console.log(JSON.stringify(report));
  } else {
    printHuman(reports, options.verbose ?? false);
  }

  const allPassed = reports.every((r) => r.result === 'pass');
  if (!allPassed) process.exitCode = 1;
}

// ============================================================================
// Output Formatters
// ============================================================================

function resultIcon(result: string): string {
  if (result === 'pass') return '\x1b[32m✓\x1b[0m';
  if (result === 'fail') return '\x1b[31m✗\x1b[0m';
  return '\x1b[33m!\x1b[0m';
}

function printExpectation(exp: ExpectReport): void {
  console.log(`    ${resultIcon(exp.result)} ${exp.description}`);
  if (exp.result === 'pass' && exp.evidence) {
    console.log(`      \x1b[2m${exp.evidence}\x1b[0m`);
  }
  if (exp.result === 'fail' && exp.reason) {
    console.log(`      \x1b[31m${exp.reason}\x1b[0m`);
  }
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

function printHuman(reports: SpecReport[], verbose: boolean): void {
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

// ============================================================================
// Helpers
// ============================================================================

async function resolveSpecPath(specDir: string, name: string): Promise<string | null> {
  const candidates = [join(specDir, name), join(specDir, `${name}.md`)];

  for (const path of candidates) {
    try {
      const s = await stat(path);
      if (s.isFile()) return path;
    } catch {
      // Not found, try next
    }
  }
  return null;
}

async function listAvailableSpecs(specDir: string): Promise<void> {
  try {
    const files = await readdir(specDir);
    const specs = files.filter((f) => f.endsWith('.md'));
    for (const spec of specs) {
      console.error(`  - ${spec.replace(/\.md$/, '')}`);
    }
  } catch {
    console.error('  (directory not found)');
  }
}
