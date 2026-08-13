#!/usr/bin/env node
/**
 * Validate a wish document against the canonical template before writing.
 * Used by the PreToolUse/PostToolUse hooks to catch broken wish structure.
 *
 * Template-derived, not vibecode: every structural rule is parsed from the
 * canonical template fixture (skills/wish/templates/wish-template.md),
 * embedded in this bundle at build time by esbuild's text loader. When the
 * template changes, the next `bun scripts/hook-bundle-parity.ts --write`
 * regen bakes the new shapes in, and the bundle-parity gate fails CI until
 * that regen lands — so template drift cannot silently wedge wish writes.
 *
 * The read is bounded and refuses symlinks (readBoundedWishFile, the same
 * primitive the board and session-context use) with a 256 KiB size cap.
 *
 * Pure Node.js - no Bun dependency.
 *
 * Usage:
 *   node validate-wish.cjs --file <path-to-wish.md>
 *   node validate-wish.cjs --help
 *
 * Hook integration: receives JSON on stdin from the PreToolUse/PostToolUse
 * event. PreToolUse validates the PROPOSED content (Write tool_input.content,
 * or the simulated result of an Edit), so fixing a broken doc is never
 * blocked — only writes whose RESULT is broken are.
 *
 * Exit codes:
 *   0  Validation passed (or not a wish file, or a new wish being created)
 *   1  Validation failed (missing template structure, symlink/size violation)
 *   2  Invalid arguments
 */

/// <reference path="./wish-template-text.d.ts" />
import { lstatSync, readFileSync } from 'node:fs';
import { parseArgs as parseArgsUtil } from 'node:util';
import { readBoundedWishFile, extractLegacyStatusValue, extractStatusCell } from '../../../../src/lib/wish-status.js';
import wishTemplate from '../../../../skills/wish/templates/wish-template.md' with { type: 'text' };

/** The bounded-read size cap for wish documents (matches the board's budget). */
export const WISH_FILE_SIZE_CAP = 256 * 1024;

export interface WishValidationIssue {
  line: number;
  message: string;
}

export interface WishValidationResult {
  passed: boolean;
  issues: WishValidationIssue[];
}

export type WishFileRead =
  | { kind: 'content'; content: string }
  | { kind: 'missing' }
  | { kind: 'error'; reason: string };

export interface TemplateContract {
  sections: string[];
  subsections: string[];
  groupHeadingSource: string;
  groupHeadingPattern: RegExp;
  checkboxPattern: RegExp;
  titlePattern: RegExp;
}

/**
 * Parse the structural contract out of the canonical template fixture.
 * Everything the validator requires must come from here, so the template is
 * the single source of truth and this file carries no free-standing shapes.
 */
export function parseWishTemplateContract(template: string): TemplateContract {
  const lines = template.split('\n');
  const sections: string[] = [];
  const subsections: string[] = [];
  let groupHeadingSource = '';
  let titlePattern: RegExp | null = null;
  let inScope = false;
  let inFence = false;
  for (const line of lines) {
    if (titlePattern === null) {
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1) {
        // "# Wish: <title>" generalises to any "# Wish:"-prefixed title.
        const prefix = /^Wish:/.exec(h1[1].trim());
        if (prefix) titlePattern = /^#\s+Wish:/m;
        continue;
      }
    }
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2) {
      sections.push(h2[1].trim());
      inScope = h2[1].trim() === 'Scope';
      continue;
    }
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      const heading = h3[1].trim();
      const groupHeading = /^Group\s+(\S+):/.exec(heading);
      if (groupHeading) {
        if (groupHeadingSource === '') groupHeadingSource = `Group ${groupHeading[1]}:`;
        continue;
      }
      // Only the subsections the template nests under ## Scope (IN/OUT) are
      // part of the structural contract.
      if (inScope) subsections.push(heading);
      continue;
    }
  }
  if (sections.length === 0 || groupHeadingSource === '' || titlePattern === null) {
    throw new Error('wish template fixture must define ## sections, a "# Wish:" title, and a "### Group N:" heading');
  }
  // The template's group heading ("### Group 1: <title>") generalises to any
  // non-space group identifier: digit groups (the template's own form) and
  // named groups both occur in current wishes.
  const groupHeadingPattern = new RegExp(`^###\\s+Group\\s+\\S+:`);
  const checkboxPattern = /^-\s+\[[ xX]\]/;
  return { sections, subsections, groupHeadingSource, groupHeadingPattern, checkboxPattern, titlePattern };
}

const CONTRACT = parseWishTemplateContract(wishTemplate);

/**
 * The date the current template form shipped — the template's most recent
 * revision (b0e77cd15, 2026-07-29). Wishes dated on or after it are held to
 * the full template-derived contract; earlier documents are legacy formats
 * and are tolerated. Measured 2026-08-13: every current wish in both corpora
 * dated on/after this boundary conforms (24 docs), so the gate can arm over
 * the corpus as it stands.
 */
export const TEMPLATE_CONTRACT_DATE = '2026-07-29';

/** Terminal statuses — a doc in one of these is completed. */
const COMPLETED_STATUSES = new Set(['SHIPPED', 'DONE', 'EXECUTED']);

/** Normalise a status cell the way the corpus linter does: first token, annotations stripped. */
export function normaliseStatus(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const token = raw.split(/\s+[—-]\s+/)[0].replace(/\s+\([^)]*\)\s*$/, '').trim();
  return token === '' ? null : token;
}

/**
 * Where a wish's status lives, in precedence order: the canonical metadata
 * table row (template-derived), then the legacy `**Status:** ...` line.
 */
export function readWishStatus(content: string): string | null {
  const cell = extractStatusCell(content, 'row-end');
  if (cell !== null) return normaliseStatus(cell);
  return normaliseStatus(extractLegacyStatusValue(content));
}

/** A wish's Date, in the same precedence order: template table row, then the legacy `**Date:**` line. */
export function readWishDate(content: string): string | null {
  const row = /^\|\s*\*\*Date\*\*\s*\|\s*(\S*?)\s*\|\s*$/m.exec(content);
  if (row) return row[1].trim();
  const legacy = /^\*\*Date:\*\*(\s*.*)$/m.exec(content);
  if (legacy) return legacy[1].trim();
  return null;
}

/**
 * Legacy tolerance is date-gated, the same shape as the corpus linter's
 * lifecycle thresholds: a wish dated before the current template form is a
 * legacy format and is validated leniently instead of being rewritten. A
 * missing or invalid date cannot bypass the contract — it is treated as new.
 */
export function isLegacyWish(content: string): boolean {
  const date = readWishDate(content);
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date < TEMPLATE_CONTRACT_DATE;
}

interface SectionRange {
  start: number;
  end: number;
}

function sectionRange(lines: string[], headingIndex: number): SectionRange {
  const end = lines.findIndex((line, index) => index > headingIndex && /^##\s+/.test(line));
  return { start: headingIndex + 1, end: end < 0 ? lines.length : end };
}

function findHeading(lines: string[], pattern: RegExp): number {
  return lines.findIndex((line) => pattern.test(line));
}

function checkCheckboxes(lines: string[], successHeading: number, contract: TemplateContract): WishValidationIssue[] {
  const issues: WishValidationIssue[] = [];
  const { start, end } = sectionRange(lines, successHeading);
  const bodyLines = lines.slice(start, end);
  if (!bodyLines.some((line) => contract.checkboxPattern.test(line))) {
    issues.push({
      line: successHeading + 2,
      message: 'Success Criteria should have checkbox items (- [ ] or - [x])',
    });
  }
  return issues;
}

function checkGroupSections(lines: string[], execHeading: number, contract: TemplateContract): WishValidationIssue[] {
  const issues: WishValidationIssue[] = [];
  const { start, end } = sectionRange(lines, execHeading);
  const groupLines = lines
    .slice(start, end)
    .map((line, offset) => ({ line, index: start + offset }))
    .filter((entry) => contract.groupHeadingPattern.test(entry.line));
  if (groupLines.length === 0) {
    issues.push({
      line: execHeading + 2,
      message: `Execution Groups must contain at least one group heading matching the template ("${contract.groupHeadingSource}", e.g. "### Group 1:")`,
    });
    return issues;
  }
  for (let i = 0; i < groupLines.length; i++) {
    const groupStart = groupLines[i].index;
    const groupEnd = i + 1 < groupLines.length ? groupLines[i + 1].index : end;
    const body = lines.slice(groupStart, groupEnd).join('\n');
    const line = groupStart + 1;
    if (!body.includes('**Acceptance Criteria:**')) {
      issues.push({ line, message: 'execution group is missing its **Acceptance Criteria:** section' });
    }
    if (!body.includes('**Validation:**')) {
      issues.push({ line, message: 'execution group is missing its **Validation:** command section' });
    }
  }
  return issues;
}

function checkOutScope(lines: string[], outHeading: number): WishValidationIssue[] {
  const issues: WishValidationIssue[] = [];
  const { start, end } = sectionRange(lines, outHeading);
  const bullets = lines.slice(start, end).filter((line) => /^\s*-\s+\S/.test(line));
  if (bullets.length === 0) {
    issues.push({ line: outHeading + 2, message: 'OUT scope should not be empty - add explicit exclusions' });
  }
  return issues;
}

/**
 * The template-derived structural check. Wishes dated on/after the current
 * template form are held to the full template contract; legacy documents are
 * tolerated with a minimal wish signature, so the historical corpus passes
 * without being rewritten.
 */
export function validateWish(content: string): WishValidationResult {
  const issues: WishValidationIssue[] = [];
  if (isLegacyWish(content)) {
    // Legacy formats tolerated: a recorded Status is the whole signature.
    if (readWishStatus(content) === null) {
      issues.push({ line: 1, message: 'wish document must record a Status (metadata table row or **Status:** line)' });
    }
    return { passed: issues.length === 0, issues };
  }

  const lines = content.split('\n');
  const status = readWishStatus(content);
  const completed = status !== null && COMPLETED_STATUSES.has(status);

  if (status === null) {
    issues.push({ line: 1, message: 'wish document must record a Status (metadata table row or **Status:** line)' });
  }
  if (!CONTRACT.titlePattern.test(content)) {
    issues.push({ line: 1, message: 'Missing required section: # Wish: title' });
  }

  for (const section of CONTRACT.sections) {
    if (!new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, 'm').test(content)) {
      issues.push({ line: 1, message: `Missing required section: ## ${section}` });
    }
  }
  for (const subsection of CONTRACT.subsections) {
    if (!new RegExp(`^###\\s+${escapeRegExp(subsection)}\\s*$`, 'm').test(content)) {
      issues.push({ line: 1, message: `Missing required section: ### ${subsection}` });
    }
  }

  const outHeading = findHeading(lines, /^###\s+OUT\s*$/i);
  if (outHeading >= 0) issues.push(...checkOutScope(lines, outHeading));

  const execHeading = findHeading(lines, /^##\s+Execution Groups\s*$/i);
  if (execHeading >= 0) issues.push(...checkGroupSections(lines, execHeading, CONTRACT));

  const successHeading = findHeading(lines, /^##\s+Success Criteria\s*$/i);
  if (successHeading >= 0 && !completed) issues.push(...checkCheckboxes(lines, successHeading, CONTRACT));

  return { passed: issues.length === 0, issues };
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read a wish file under the safety contract: refuse symlinks and files over
 * the size cap with a named error, distinguish a missing file (a new wish
 * being created) so the caller can skip validation.
 */
export function readWishFile(path: string): WishFileRead {
  let stats;
  try {
    // lstat (not stat) so a symlink is seen as itself and rejected.
    stats = lstatSync(path);
  } catch {
    return { kind: 'missing' };
  }
  if (stats.isSymbolicLink()) {
    return { kind: 'error', reason: 'refusing to read a wish file that is a symbolic link' };
  }
  if (!stats.isFile()) {
    return { kind: 'error', reason: 'wish path is not a regular file' };
  }
  if (stats.size > WISH_FILE_SIZE_CAP) {
    return { kind: 'error', reason: `wish file exceeds the ${WISH_FILE_SIZE_CAP}-byte size cap` };
  }
  const content = readBoundedWishFile(path, WISH_FILE_SIZE_CAP);
  if (content === null) {
    return { kind: 'error', reason: 'unable to read wish file' };
  }
  return { kind: 'content', content };
}

export interface HookInput {
  eventName: string | null;
  filePath: string | null;
  proposedContent: string | null | undefined;
  editOldString: string | null | undefined;
  editNewString: string | null | undefined;
  replaceAll: boolean | null | undefined;
}

/** Parse the hook event JSON from stdin; null when stdin is not hook JSON. */
export function parseHookInput(raw: string): HookInput | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const input = parsed as Record<string, unknown>;
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
  if (filePath === null) return null;
  return {
    eventName: typeof input.hook_event_name === 'string' ? input.hook_event_name : null,
    filePath,
    proposedContent: typeof toolInput.content === 'string' ? toolInput.content : undefined,
    editOldString: typeof toolInput.old_string === 'string' ? toolInput.old_string : undefined,
    editNewString: typeof toolInput.new_string === 'string' ? toolInput.new_string : undefined,
    replaceAll: typeof toolInput.replace_all === 'boolean' ? toolInput.replace_all : undefined,
  };
}

/** The content the hook should validate for a PreToolUse event. */
export function proposedWishContent(current: string, hook: HookInput): string | null {
  if (hook.proposedContent !== undefined && hook.proposedContent !== null) return hook.proposedContent;
  if (hook.editOldString !== undefined && hook.editOldString !== null && hook.editNewString !== undefined && hook.editNewString !== null) {
    if (hook.replaceAll === true) {
      return current.split(hook.editOldString).join(hook.editNewString);
    }
    return current.replace(hook.editOldString, hook.editNewString);
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI

interface CliValues {
  file?: string;
  help?: boolean;
}

function parseCliArgs(argv: string[]): CliValues {
  let values: Record<string, unknown> = {};
  try {
    values = parseArgsUtil({
      args: argv,
      options: {
        file: { type: 'string', short: 'f' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: false, // allow unknown flags from hook runners
    }).values;
  } catch {
    const fallback: Record<string, unknown> = {};
    for (let i = 0; i < argv.length; i++) {
      if ((argv[i] === '--file' || argv[i] === '-f') && argv[i + 1]) fallback.file = argv[++i];
      else if (argv[i] === '--help' || argv[i] === '-h') fallback.help = true;
    }
    values = fallback;
  }
  return { file: typeof values.file === 'string' ? values.file : undefined, help: values.help === true };
}

function printHelp(): void {
  console.log(`
validate-wish - Validate wish document structure against the canonical template

Usage:
  node validate-wish.cjs --file <path-to-wish.md>
  node validate-wish.cjs --help

As a PreToolUse/PostToolUse hook, receives JSON on stdin with
hook_event_name and tool_input.file_path.

Options:
  -f, --file   Path to wish document to validate
  -h, --help   Show this help message

Exit codes:
  0  Validation passed (or not a wish file, or a new wish being created)
  1  Validation failed (template structure violated, symlink or size cap)
  2  Invalid arguments
`);
}

function isWishPath(filePath: string): boolean {
  return filePath.includes('.genie/wishes/') && filePath.endsWith('.md');
}

function report(result: WishValidationResult): number {
  if (result.passed) {
    console.error('\u2713 Wish document validation passed');
    return 0;
  }
  console.error('\u26A0 Wish document validation issues:');
  for (const issue of result.issues) {
    console.error(`  - line ${issue.line}: ${issue.message}`);
  }
  return 1;
}

function main(): number {
  const argv = process.argv.slice(2);
  const cli = parseCliArgs(argv);
  if (cli.help) {
    printHelp();
    return 0;
  }

  let hook: HookInput | null = null;
  if (cli.file === undefined) {
    try {
      const stdinData = readFileSync(0, 'utf-8');
      hook = parseHookInput(stdinData);
    } catch {
      // stdin unavailable or not hook JSON - pass silently.
    }
  }

  const filePath = cli.file ?? hook?.filePath ?? null;
  if (!filePath) return 0; // Not a Write/Edit hook event; pass.
  if (!isWishPath(filePath)) return 0;

  const read = readWishFile(filePath);
  if (read.kind === 'missing') {
    // A wish being created (or deleted) — nothing to validate.
    console.error('Wish file not found, skipping validation (new wish)');
    return 0;
  }
  if (read.kind === 'error') {
    console.error(`\u26A0 ${read.reason}: ${filePath}`);
    return 1;
  }

  let content = read.content;
  if (hook !== null && hook.eventName === 'PreToolUse') {
    const proposed = proposedWishContent(read.content, hook);
    if (proposed !== null) content = proposed;
  }
  return report(validateWish(content));
}

// The .cjs bundle is required by tests and by the lint; only run the CLI when
// this module is the invoked entry point (argv[1] names the script itself).
const invokedScript = process.argv[1] ?? '';
const scriptName = invokedScript.split(/[\\/]/).pop() ?? '';
if (scriptName === 'validate-wish.cjs' || scriptName === 'validate-wish.ts') {
  process.exit(main());
}
