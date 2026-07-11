#!/usr/bin/env bun
/**
 * wishes-lint: validate that every markdown link in any wish file
 * whose target points at `.genie/brainstorms/...` resolves to a real file.
 *
 * Exit non-zero if any wish has unresolved brainstorm links.
 * Honors a `<!-- wishes-lint:ignore -->` bailout marker to skip a file.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const DEFAULT_WISHES_DIR = join(ROOT, '.genie/wishes');
const EXECUTION_STRATEGY_THRESHOLD = '2026-07-09';

const STUB_MARKERS = ['_No brainstorm — direct wish_', '_Design not recovered'];
const CANONICAL_STATUSES = new Set(['DRAFT', 'FIX-FIRST', 'APPROVED', 'IN_PROGRESS', 'BLOCKED', 'SHIPPED']);
// Historical wishes predate the persisted lifecycle state machine. They remain
// readable terminal records, but new/active documents must use canonical state.
const LEGACY_TERMINAL_STATUSES = new Set(['DONE', 'EXECUTED']);
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const QUALIFIED_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9-]{0,63}$/;

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

interface WishRecord {
  file: string;
  slug: string;
  status: string;
  dependsOn: string[];
  blocks: string[];
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

function metadataValue(lines: string[], field: string): { line: number; value: string } | null {
  const pattern = new RegExp(`^\\|\\s*\\*\\*${field}\\*\\*\\s*\\|\\s*(.*?)\\s*\\|\\s*$`, 'i');
  for (let index = 0; index < lines.length; index += 1) {
    const match = pattern.exec(lines[index]);
    if (match) return { line: index + 1, value: match[1].trim() };
  }
  return null;
}

function dependencyValues(
  file: string,
  lines: string[],
  required: boolean,
): { record?: Pick<WishRecord, 'dependsOn' | 'blocks'>; issues: WishStructureIssue[] } {
  const issues: WishStructureIssue[] = [];
  const heading = lines.findIndex((line) => /^##\s+Dependencies\s*$/i.test(line));
  if (heading < 0) {
    if (required) issues.push({ file, line: 1, message: 'canonical wish must contain a ## Dependencies section' });
    return required ? { issues } : { record: { dependsOn: [], blocks: [] }, issues };
  }
  const end = lines.findIndex((line, index) => index > heading && /^##\s+/.test(line));
  const section = lines.slice(heading + 1, end < 0 ? undefined : end);

  const parseKey = (key: 'depends-on' | 'blocks'): string[] | null => {
    const matches = section
      .map((line, index) => ({
        line: heading + index + 2,
        match: new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`, 'i').exec(line),
      }))
      .filter((entry) => entry.match !== null);
    if (matches.length !== 1) {
      issues.push({
        file,
        line: heading + 1,
        message: `Dependencies must contain exactly one **${key}:** key`,
      });
      return null;
    }
    const raw = matches[0].match?.[1].trim() ?? '';
    if (raw.toLowerCase() === 'none') return [];
    const values = raw.split(',').map((value) => value.trim());
    for (const value of values) {
      if (!SLUG_PATTERN.test(value) && !QUALIFIED_SLUG_PATTERN.test(value)) {
        issues.push({ file, line: matches[0].line, message: `invalid ${key} wish slug: ${JSON.stringify(value)}` });
      }
    }
    return values;
  };

  const dependsOn = parseKey('depends-on');
  const blocks = parseKey('blocks');
  return dependsOn && blocks ? { record: { dependsOn, blocks }, issues } : { issues };
}

function lintWishMetadata(file: string): { record?: WishRecord; issues: WishStructureIssue[] } {
  if (basename(file) !== 'WISH.md') return { issues: [] };
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return { issues: [] };
  const lines = text.split('\n');
  const statusField = metadataValue(lines, 'Status');
  const issues: WishStructureIssue[] = [];
  if (!statusField) {
    issues.push({ file, line: 1, message: 'wish metadata must contain a Status field' });
    return { issues };
  }
  const status = statusField.value
    .split(/\s+[—-]\s+/)[0]
    .replace(/\s+\([^)]*\)\s*$/, '')
    .trim();
  const canonical = CANONICAL_STATUSES.has(status);
  if (!canonical && !LEGACY_TERMINAL_STATUSES.has(status)) {
    issues.push({
      file,
      line: statusField.line,
      message: `unsupported wish status ${JSON.stringify(status)}; allowed: ${[...CANONICAL_STATUSES, ...LEGACY_TERMINAL_STATUSES].join(', ')}`,
    });
  }
  const dependencies = dependencyValues(file, lines, canonical);
  issues.push(...dependencies.issues);
  if (!dependencies.record || issues.length > 0) return { issues };
  return {
    record: {
      file,
      slug: basename(dirname(file)),
      status,
      dependsOn: dependencies.record.dependsOn,
      blocks: dependencies.record.blocks,
    },
    issues,
  };
}

function lintWishGraph(records: WishRecord[]): WishStructureIssue[] {
  const issues: WishStructureIssue[] = [];
  const bySlug = new Map(records.map((record) => [record.slug, record]));
  const prerequisites = new Map(records.map((record) => [record.slug, new Set<string>()]));
  const addReference = (owner: WishRecord, referenced: string, relation: 'depends-on' | 'blocks'): void => {
    if (referenced.includes('/')) return; // Cross-repository edges are shape-checked but cannot be resolved locally.
    if (!bySlug.has(referenced)) {
      issues.push({
        file: owner.file,
        line: 1,
        message: `${relation} references missing wish slug ${JSON.stringify(referenced)}`,
      });
      return;
    }
    if (referenced === owner.slug) {
      issues.push({ file: owner.file, line: 1, message: `${relation} cannot reference its own wish slug` });
      return;
    }
    if (relation === 'depends-on') prerequisites.get(owner.slug)?.add(referenced);
    else prerequisites.get(referenced)?.add(owner.slug);
  };
  for (const record of records) {
    for (const dependency of record.dependsOn) addReference(record, dependency, 'depends-on');
    for (const blocked of record.blocks) addReference(record, blocked, 'blocks');
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];
  const visit = (slug: string): void => {
    if (visiting.has(slug)) {
      const start = path.indexOf(slug);
      const cycle = [...path.slice(start), slug];
      issues.push({
        file: bySlug.get(slug)?.file ?? records[0].file,
        line: 1,
        message: `wish dependency cycle: ${cycle.join(' -> ')}`,
      });
      return;
    }
    if (visited.has(slug)) return;
    visiting.add(slug);
    path.push(slug);
    for (const dependency of prerequisites.get(slug) ?? []) visit(dependency);
    path.pop();
    visiting.delete(slug);
    visited.add(slug);
  };
  for (const slug of bySlug.keys()) visit(slug);
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
  const wishRecords: WishRecord[] = [];

  for (const file of files) {
    allBroken.push(...lintFile(file));
    allStructureIssues.push(...lintExecutionStrategy(file));
    const metadata = lintWishMetadata(file);
    allStructureIssues.push(...metadata.issues);
    if (metadata.record) wishRecords.push(metadata.record);
  }
  allStructureIssues.push(...lintWishGraph(wishRecords));

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
      console.error(`\nwishes-lint: ${allStructureIssues.length} wish structure/graph issue(s)`);
    }
    process.exit(1);
  }

  console.error(`wishes-lint: OK (${files.length} files scanned, 0 broken brainstorm links)`);
}

main();
