#!/usr/bin/env bun
/**
 * complexity-budget: drift check for Biome's
 * `lint/complexity/noExcessiveCognitiveComplexity` rule.
 *
 * Reports the current state of the cognitive-complexity budget and exits
 * non-zero when any of the ratcheted ceilings is exceeded:
 *   - retained warning count (functions still scoring above the threshold)
 *   - highest observed complexity score
 *   - explicit `biome-ignore lint/complexity/noExcessiveCognitiveComplexity`
 *     suppression count
 *
 * No database, tmux, TUI, or network access required — only `biome check` and
 * a recursive grep over `src/` and `packages/`.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

/** Budget ceilings — ratcheted from the post-cleanup baseline (2026-05-03). */
export const BUDGET = {
  maxWarningCount: 7,
  maxScore: 42,
  maxSuppressionCount: 8,
} as const;

export interface ComplexityWarning {
  file: string;
  line: number;
  column: number;
  score: number;
  function?: string;
}

export interface BudgetReport {
  warnings: ComplexityWarning[];
  maxScore: number;
  suppressionCount: number;
  suppressions: string[];
}

const HEADER_RE = /^\.\/(\S+?):(\d+):(\d+)\s+lint\/complexity\/noExcessiveCognitiveComplexity\b/;
const SCORE_RE = /Excessive complexity of (\d+) detected/;
const POINTER_RE = /^\s*>\s*\d+\s+│\s*(.*)$/;

/**
 * Parse Biome's default text output for cognitive-complexity diagnostics.
 *
 * Pure function, exported for testing. Robust against unrelated diagnostics
 * interleaved with complexity ones — pairs each `noExcessiveCognitiveComplexity`
 * header with the next `Excessive complexity of N` line and the next pointer
 * (`> NNN │ async function …`) line within the same diagnostic block.
 */
export function parseBiomeOutput(text: string): ComplexityWarning[] {
  const lines = text.split('\n');
  const warnings: ComplexityWarning[] = [];

  for (let i = 0; i < lines.length; i++) {
    const headerMatch = HEADER_RE.exec(lines[i]);
    if (!headerMatch) continue;
    const [, file, lineStr, colStr] = headerMatch;
    let score: number | undefined;
    let funcLine: string | undefined;
    for (let j = i + 1; j < lines.length && j < i + 30; j++) {
      // Stop scanning if we hit the next diagnostic header.
      if (HEADER_RE.test(lines[j])) break;
      if (score === undefined) {
        const sm = SCORE_RE.exec(lines[j]);
        if (sm) score = Number(sm[1]);
      }
      if (funcLine === undefined) {
        const pm = POINTER_RE.exec(lines[j]);
        if (pm) funcLine = pm[1].trim();
      }
      if (score !== undefined && funcLine !== undefined) break;
    }
    if (score === undefined) continue;
    warnings.push({
      file,
      line: Number(lineStr),
      column: Number(colStr),
      score,
      function: extractFunctionName(funcLine),
    });
  }

  return warnings;
}

function extractFunctionName(pointer?: string): string | undefined {
  if (!pointer) return undefined;
  const cleaned = pointer.replace(/^export\s+/, '').replace(/^async\s+/, '');
  const fnMatch = /function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(cleaned);
  if (fnMatch) return fnMatch[1];
  const arrowMatch = /([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?\(/.exec(cleaned);
  if (arrowMatch) return arrowMatch[1];
  return undefined;
}

function runBiome(): string {
  const biomeBin = join(ROOT, 'node_modules/.bin/biome');
  if (!existsSync(biomeBin)) {
    throw new Error(`biome binary not found at ${biomeBin}; run \`bun install\` first`);
  }
  // Biome writes diagnostics to stderr and exits non-zero when warnings exist;
  // both are normal here. Combine streams via `sh -c "biome … 2>&1"` so the
  // captured `stdout` includes diagnostics regardless of biome's exit code.
  const cmd = `"${biomeBin}" check . --diagnostic-level=warn --max-diagnostics=none 2>&1`;
  try {
    return execSync(cmd, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stdout?: Buffer | string };
    if (e?.stdout) return typeof e.stdout === 'string' ? e.stdout : e.stdout.toString('utf8');
    throw err;
  }
}

function countSuppressions(): string[] {
  // Use git grep so we honor .gitignore and stay portable. Scope covers both the
  // CLI (`src/`) and the UI package tree (`packages/`) so the budget sees the whole
  // gated surface — `biome check .` already reports complexity warnings for both.
  try {
    const out = execSync('git grep -nE "biome-ignore lint/complexity/noExcessiveCognitiveComplexity" -- src packages', {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildReport(biomeOutput: string, suppressions: string[]): BudgetReport {
  const warnings = parseBiomeOutput(biomeOutput);
  const maxScore = warnings.reduce((acc, w) => Math.max(acc, w.score), 0);
  return {
    warnings,
    maxScore,
    suppressionCount: suppressions.length,
    suppressions,
  };
}

export interface BudgetVerdict {
  ok: boolean;
  failures: string[];
}

export function evaluateBudget(report: BudgetReport, budget = BUDGET): BudgetVerdict {
  const failures: string[] = [];
  if (report.warnings.length > budget.maxWarningCount) {
    failures.push(`retained warning count ${report.warnings.length} exceeds budget ${budget.maxWarningCount}`);
  }
  if (report.maxScore > budget.maxScore) {
    failures.push(`max score ${report.maxScore} exceeds budget ${budget.maxScore}`);
  }
  if (report.suppressionCount > budget.maxSuppressionCount) {
    failures.push(`suppression count ${report.suppressionCount} exceeds budget ${budget.maxSuppressionCount}`);
  }
  return { ok: failures.length === 0, failures };
}

function formatReport(report: BudgetReport, verdict: BudgetVerdict): string {
  const lines: string[] = [];
  lines.push('Cognitive-complexity budget report');
  lines.push('==================================');
  lines.push('');
  lines.push(`Warnings (score > threshold): ${report.warnings.length} / ${BUDGET.maxWarningCount}`);
  lines.push(`Max observed score:           ${report.maxScore} / ${BUDGET.maxScore}`);
  lines.push(`Explicit suppressions:        ${report.suppressionCount} / ${BUDGET.maxSuppressionCount}`);
  lines.push('');
  if (report.warnings.length) {
    lines.push('Retained hotspots (score, location, function):');
    for (const w of [...report.warnings].sort((a, b) => b.score - a.score)) {
      const fn = w.function ? ` ${w.function}` : '';
      lines.push(`  - ${String(w.score).padStart(3)}  ${w.file}:${w.line}${fn}`);
    }
    lines.push('');
  }
  if (verdict.ok) {
    lines.push('OK: budget intact.');
  } else {
    lines.push('FAIL: budget regressed:');
    for (const f of verdict.failures) lines.push(`  - ${f}`);
    lines.push('');
    lines.push('See .genie/wishes/complexity-budget-simplification/complexity-baseline.md for context.');
  }
  return lines.join('\n');
}

async function main() {
  const biomeOutput = runBiome();
  const suppressions = countSuppressions();
  const report = buildReport(biomeOutput, suppressions);
  const verdict = evaluateBudget(report);
  process.stdout.write(`${formatReport(report, verdict)}\n`);
  process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`complexity-budget: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  });
}
