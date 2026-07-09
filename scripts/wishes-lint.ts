#!/usr/bin/env bun
/**
 * wishes-lint: validate that every markdown link in any wish file
 * whose target points at `.genie/brainstorms/...` resolves to a real file.
 *
 * Exit non-zero if any wish has unresolved brainstorm links.
 * Honors a `<!-- wishes-lint:ignore -->` bailout marker to skip a file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_WISHES_DIR = join(ROOT, '.genie/wishes');
const EXECUTION_STRATEGY_THRESHOLD = '2026-07-09';

const STUB_MARKERS = ['_No brainstorm — direct wish_', '_Design not recovered'];

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

interface BrokenLink {
  file: string;
  line: number;
  text: string;
  target: string;
  resolved: string;
}

interface WishStructureIssue {
  file: string;
  line: number;
  message: string;
}

function wishesDirFromArgs(args: string[]): string {
  if (args.length === 0) return DEFAULT_WISHES_DIR;
  if (args.length === 2 && args[0] === '--wishes-dir' && args[1]) return resolve(process.cwd(), args[1]);
  throw new Error('usage: wishes-lint [--wishes-dir <path>]');
}

function stripInlineCode(line: string): string {
  // Replace backtick-wrapped spans with spaces of equal length so
  // column positions are preserved but links inside code are ignored.
  return line.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));
}

function fencedLines(lines: string[]): boolean[] {
  const inFence: boolean[] = new Array(lines.length).fill(false);
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      fenced = !fenced;
      inFence[i] = true;
      continue;
    }
    inFence[i] = fenced;
  }
  return inFence;
}

function lintFile(file: string): BrokenLink[] {
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return [];

  const broken: BrokenLink[] = [];
  const rawLines = text.split('\n');
  const fileDir = dirname(file);
  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;

  // Skip fenced code blocks entirely.
  const inFence = fencedLines(rawLines);

  for (let i = 0; i < rawLines.length; i++) {
    if (inFence[i]) continue;
    const line = stripInlineCode(rawLines[i]);
    if (STUB_MARKERS.some((m) => line.includes(m))) continue;
    let m: RegExpExecArray | null = linkRe.exec(line);
    while (m !== null) {
      const linkText = m[1];
      const target = m[2].split('#')[0].split(' ')[0];
      if (target?.includes('brainstorms/')) {
        if (/^https?:\/\//i.test(target)) {
          m = linkRe.exec(line);
          continue;
        }
        const resolved = resolve(fileDir, target);
        if (!existsSync(resolved)) {
          broken.push({
            file,
            line: i + 1,
            text: linkText,
            target,
            resolved,
          });
        }
      }
      m = linkRe.exec(line);
    }
    linkRe.lastIndex = 0;
  }

  return broken;
}

function tableCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  return trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim().replaceAll('**', ''));
}

function isTableDelimiter(cells: string[] | null): boolean {
  return cells !== null && cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function lintExecutionStrategy(file: string): WishStructureIssue[] {
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return [];

  const lines = text.split('\n');
  const dateMatch = text.match(/^\|\s*(?:\*\*)?Date(?:\*\*)?\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/im);
  if (!dateMatch || dateMatch[1] < EXECUTION_STRATEGY_THRESHOLD) return [];

  const inFence = fencedLines(lines);
  const tableHeaders: number[] = [];
  let strategyHeading: number | undefined;
  let inExecutionStrategy = false;

  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (/^##\s+Execution Strategy\s*$/i.test(lines[i])) {
      strategyHeading ??= i;
      inExecutionStrategy = true;
      continue;
    }
    if (/^#{1,2}\s+/.test(lines[i])) {
      inExecutionStrategy = false;
      continue;
    }
    if (!inExecutionStrategy) continue;

    const header = tableCells(lines[i]);
    const delimiter = tableCells(lines[i + 1] ?? '');
    if (header && isTableDelimiter(delimiter)) tableHeaders.push(i);
  }

  if (tableHeaders.length === 0) {
    return [
      {
        file,
        line: (strategyHeading ?? 0) + 1,
        message: 'wish dated 2026-07-09 or later must contain an Execution Strategy markdown table',
      },
    ];
  }

  const issues: WishStructureIssue[] = [];
  for (const headerLine of tableHeaders) {
    const headers = tableCells(lines[headerLine]) ?? [];
    const missing = ['Complexity', 'Model'].filter((required) => !headers.includes(required));
    if (missing.length > 0) {
      issues.push({
        file,
        line: headerLine + 1,
        message: `Execution Strategy table is missing required column(s): ${missing.join(', ')}`,
      });
    }
  }
  return issues;
}

function main() {
  let wishesDir: string;
  try {
    wishesDir = wishesDirFromArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  const files = walk(wishesDir);
  const allBroken: BrokenLink[] = [];
  const allStructureIssues: WishStructureIssue[] = [];

  for (const file of files) {
    allBroken.push(...lintFile(file));
    allStructureIssues.push(...lintExecutionStrategy(file));
  }

  if (allBroken.length > 0 || allStructureIssues.length > 0) {
    for (const b of allBroken) {
      console.error(`${relative(ROOT, b.file)}:${b.line}: ${b.text} → ${b.target}`);
    }
    if (allBroken.length > 0) {
      console.error(`\nwishes-lint: ${allBroken.length} broken brainstorm link(s) across ${files.length} wish file(s)`);
    }
    for (const issue of allStructureIssues) {
      console.error(`${relative(ROOT, issue.file)}:${issue.line}: ${issue.message}`);
    }
    if (allStructureIssues.length > 0) {
      console.error(`\nwishes-lint: ${allStructureIssues.length} Execution Strategy issue(s)`);
    }
    process.exit(1);
  }

  console.error(`wishes-lint: OK (${files.length} files scanned, 0 broken brainstorm links)`);
}

main();
