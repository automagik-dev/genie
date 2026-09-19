#!/usr/bin/env bun
/**
 * wishes-lint: validate that every markdown link in any wish file
 * whose target points at `.genie/brainstorms/...` resolves to a real file.
 *
 * Exit non-zero if any wish has unresolved brainstorm links.
 * Honors a `<!-- wishes-lint:ignore -->` bailout marker to skip a file.
 *
 * This module is BOTH the repository gate (`bun run wishes:lint`) and the
 * runtime behind `genie wish lint`, so it resolves nothing from
 * `import.meta.url`: in the compiled single-file binary that URL lands under
 * `/$bunfs` and would name a wishes directory that holds nothing at all. The
 * wishes root is a parameter — `--dir <repo>` (→ `<repo>/.genie/wishes`),
 * `--wishes-dir <path>`, or the git toplevel of the working directory — and the
 * entry point RETURNS an exit code rather than calling `process.exit`, so the
 * CLI can own the process. The `import.meta.main` guard below is what keeps
 * `bun scripts/wishes-lint.ts` behaving exactly as it always has.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { designReviewViolations } from '../skills/brainstorm/references/design-review-evidence.mjs';
import { WISH_SLUG_PATTERN, WISH_SLUG_SOURCE } from '../src/lib/wish-status.js';
// The wish validator, rehomed here from the retired `plugins/genie/scripts/src/`
// tree. It stays biome-ignored (its formatting is inherited verbatim from the
// plugin-era original) so a reformat cannot be mistaken for a rule change.
import { validateWish } from './validate-wish.js';

export const WISH_LINT_USAGE = 'usage: wishes-lint [--dir <repo>] [--wishes-dir <path>]';
const EXECUTION_STRATEGY_THRESHOLD = '2026-07-09';
const DESIGN_REVIEW_EVIDENCE_THRESHOLD = '2026-07-11';

const STUB_MARKERS = ['_No brainstorm — direct wish_', '_Design not recovered'];
const CANONICAL_STATUSES = new Set([
  'DRAFT',
  'FIX-FIRST',
  'APPROVED',
  'IN_PROGRESS',
  'BLOCKED',
  'SHIPPED',
  'SUPERSEDED',
]);
// Historical wishes predate the persisted lifecycle state machine. They remain
// readable terminal records, but new/active documents must use canonical state.
const LEGACY_TERMINAL_STATUSES = new Set(['DONE', 'EXECUTED']);
// `<owner-wish>/<slug>` — both halves are ordinary wish slugs.
const QUALIFIED_SLUG_PATTERN = new RegExp(`^${WISH_SLUG_SOURCE}/${WISH_SLUG_SOURCE}$`);

/** Every `.md` file under a wishes root, in directory order. */
export function wishFiles(wishesDir: string): string[] {
  return walk(wishesDir);
}

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

/** One finding, before it is tagged with the family it belongs to. */
interface WishIssue {
  file: string;
  line: number;
  message: string;
}

/**
 * One finding as callers outside this module see it. `link` is an unresolved
 * brainstorm link; `structure` is every other rule (template, metadata,
 * Execution Strategy routing columns, design-review evidence, wish graph).
 */
export interface WishStructureIssue extends WishIssue {
  kind: 'link' | 'structure';
}

interface WishRecord {
  file: string;
  slug: string;
  status: string;
  dependsOn: string[];
  blocks: string[];
}

/** What a parsed argv resolved to: which tree to lint and what paths to print against. */
interface WishLintTarget {
  wishesDir: string;
  /** The root every reported path is printed relative to. */
  reportRoot: string;
  help: boolean;
}

/**
 * The git toplevel of `cwd`, or null when it is not a checkout (or `git` is not
 * on PATH). Never throws: a repository-less directory is an ordinary input here.
 */
function gitToplevel(cwd: string): string | null {
  try {
    const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
    if (result.status !== 0) return null;
    const top = (result.stdout ?? '').trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/**
 * Resolve argv to a wishes root. `--dir <repo>` is the operator-facing form
 * (`<repo>/.genie/wishes`); `--wishes-dir <path>` points straight at a wishes
 * tree and is what the repository's own tests use. With neither, the root is the
 * git toplevel of `cwd`, falling back to `cwd` itself — never `import.meta.url`.
 */
export function resolveWishLintTarget(argv: string[], cwd: string): WishLintTarget {
  let repo: string | undefined;
  let wishesDir: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { wishesDir: '', reportRoot: cwd, help: true };
    if (arg !== '--dir' && arg !== '--wishes-dir') throw new Error(WISH_LINT_USAGE);
    const value = argv[index + 1];
    if (!value || value.startsWith('-')) throw new Error(WISH_LINT_USAGE);
    index += 1;
    if (arg === '--dir') repo = resolve(cwd, value);
    else wishesDir = resolve(cwd, value);
  }
  if (repo !== undefined && wishesDir !== undefined) throw new Error(WISH_LINT_USAGE);
  if (wishesDir !== undefined) return { wishesDir, reportRoot: gitToplevel(cwd) ?? cwd, help: false };
  const root = repo ?? gitToplevel(cwd) ?? cwd;
  return { wishesDir: join(root, '.genie/wishes'), reportRoot: root, help: false };
}

/** A path relative to the report root, or the absolute path when it escapes that root. */
function displayPath(reportRoot: string, file: string): string {
  const rel = relative(reportRoot, file);
  return rel.length > 0 && !rel.startsWith('..') ? rel : file;
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

function lintExecutionStrategy(file: string): WishIssue[] {
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

  const issues: WishIssue[] = [];
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

function lintDesignReviewEvidence(file: string): WishIssue[] {
  if (basename(file) !== 'WISH.md') return [];
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return [];
  const lines = text.split('\n');
  const date = metadataValue(lines, 'Date');
  const newContract = date !== null && date.value >= DESIGN_REVIEW_EVIDENCE_THRESHOLD;
  const design = metadataValue(lines, 'Design');
  if (!design) {
    return newContract ? [{ file, line: 1, message: 'new wish metadata must contain a Design field' }] : [];
  }
  if (design.value === STUB_MARKERS[0]) return [];

  const links = [...design.value.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].split('#')[0].split(' ')[0])
    .filter((target): target is string => Boolean(target?.includes('brainstorms/') && target.endsWith('DESIGN.md')));
  if (links.length === 0) {
    return newContract
      ? [
          {
            file,
            line: design.line,
            message: `Design must be ${STUB_MARKERS[0]} or link at least one brainstorm DESIGN.md`,
          },
        ]
      : [];
  }

  const issues: WishIssue[] = [];
  for (const target of links) {
    if (/^https?:\/\//i.test(target)) {
      issues.push({ file, line: design.line, message: 'design-review evidence requires a local DESIGN.md' });
      continue;
    }
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) continue; // lintFile reports the broken link with its original text.
    const source = readFileSync(resolved, 'utf8');
    if (!newContract && !source.includes('<!-- genie-design-review:start -->')) continue;
    const violations = designReviewViolations(source);
    for (const violation of violations) {
      issues.push({ file, line: design.line, message: `invalid design-review evidence for ${target}: ${violation}` });
    }
  }
  return issues;
}

function dependencyValues(
  file: string,
  lines: string[],
  required: boolean,
): { record?: Pick<WishRecord, 'dependsOn' | 'blocks'>; issues: WishIssue[] } {
  const issues: WishIssue[] = [];
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
      if (!WISH_SLUG_PATTERN.test(value) && !QUALIFIED_SLUG_PATTERN.test(value)) {
        issues.push({ file, line: matches[0].line, message: `invalid ${key} wish slug: ${JSON.stringify(value)}` });
      }
    }
    return values;
  };

  const dependsOn = parseKey('depends-on');
  const blocks = parseKey('blocks');
  return dependsOn && blocks ? { record: { dependsOn, blocks }, issues } : { issues };
}

function lintWishMetadata(file: string): { record?: WishRecord; issues: WishIssue[] } {
  if (basename(file) !== 'WISH.md') return { issues: [] };
  const text = readFileSync(file, 'utf8');
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return { issues: [] };
  const lines = text.split('\n');
  const statusField = metadataValue(lines, 'Status');
  const dateField = metadataValue(lines, 'Date');
  const issues: WishIssue[] = [];
  if (!statusField) {
    issues.push({ file, line: 1, message: 'wish metadata must contain a Status field' });
    return { issues };
  }
  if (!dateField) issues.push({ file, line: 1, message: 'wish metadata must contain a Date field' });
  else if (
    !/^\d{4}-\d{2}-\d{2}$/.test(dateField.value) ||
    Number.isNaN(Date.parse(`${dateField.value}T00:00:00Z`)) ||
    new Date(`${dateField.value}T00:00:00Z`).toISOString().slice(0, 10) !== dateField.value
  ) {
    issues.push({ file, line: dateField.line, message: 'wish Date field must use a valid YYYY-MM-DD value' });
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

/**
 * Run the template-derived wish validator (the blocking write check) over a
 * WISH.md. This is the drift gate: when the canonical template changes, the
 * corpus must follow, or every repo carrying wishes fails CI here.
 */
function lintWishTemplate(file: string, text: string): WishIssue[] {
  if (basename(file) !== 'WISH.md') return [];
  if (/^<!-- wishes-lint:ignore -->/m.test(text)) return [];
  const result = validateWish(text);
  return result.issues.map((issue) => ({
    file,
    line: issue.line,
    message: `wish template violation: ${issue.message}`,
  }));
}

function lintWishGraph(records: WishRecord[]): WishIssue[] {
  const issues: WishIssue[] = [];
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

/**
 * Every finding over one wishes tree, links first and then structure, in the
 * order the report prints them. The root is injected — this function reads no
 * ambient location, which is what lets the compiled binary lint a tree that is
 * not the genie checkout.
 */
export function lintWishes(options: { wishesDir: string; files?: string[] }): WishStructureIssue[] {
  const files = options.files ?? walk(options.wishesDir);
  const links: WishStructureIssue[] = [];
  const structure: WishStructureIssue[] = [];
  const wishRecords: WishRecord[] = [];
  const add = (issues: WishIssue[]): void => {
    for (const issue of issues) structure.push({ ...issue, kind: 'structure' });
  };

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const broken of lintFile(file)) {
      links.push({ file: broken.file, line: broken.line, message: `${broken.text} → ${broken.target}`, kind: 'link' });
    }
    add(lintWishTemplate(file, text));
    add(lintExecutionStrategy(file));
    add(lintDesignReviewEvidence(file));
    const metadata = lintWishMetadata(file);
    add(metadata.issues);
    if (metadata.record) wishRecords.push(metadata.record);
  }
  add(lintWishGraph(wishRecords));
  return [...links, ...structure];
}

/**
 * The one entry point both `bun run wishes:lint` and `genie wish lint` run.
 * It RETURNS an exit code — 0 clean, 1 findings, 2 the argv was refused — and
 * never calls `process.exit`, so the CLI keeps ownership of the process.
 */
export async function runWishLintCli(argv: string[]): Promise<number> {
  let target: WishLintTarget;
  try {
    target = resolveWishLintTarget(argv, process.cwd());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (target.help) {
    console.error(WISH_LINT_USAGE);
    return 0;
  }

  const files = wishFiles(target.wishesDir);
  const issues = lintWishes({ wishesDir: target.wishesDir, files });
  const broken = issues.filter((issue) => issue.kind === 'link');
  const structure = issues.filter((issue) => issue.kind === 'structure');

  if (issues.length > 0) {
    for (const b of broken) {
      console.error(`${displayPath(target.reportRoot, b.file)}:${b.line}: ${b.message}`);
    }
    if (broken.length > 0) {
      console.error(`\nwishes-lint: ${broken.length} broken brainstorm link(s) across ${files.length} wish file(s)`);
    }
    for (const issue of structure) {
      console.error(`${displayPath(target.reportRoot, issue.file)}:${issue.line}: ${issue.message}`);
    }
    if (structure.length > 0) {
      console.error(`\nwishes-lint: ${structure.length} wish structure/graph issue(s)`);
    }
    return 1;
  }

  console.error(`wishes-lint: OK (${files.length} files scanned, 0 broken brainstorm links, template validator green)`);
  return 0;
}

// Imported by `src/term-commands/wish.ts`; when this module is imported rather
// than run, `import.meta.main` is false and nothing below must run. No top-level
// await, so the bundled binary's module graph stays synchronous.
if (import.meta.main) {
  void runWishLintCli(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
