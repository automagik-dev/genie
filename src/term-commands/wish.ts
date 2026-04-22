/**
 * `genie wish` command group — wish lifecycle management.
 *
 * Subcommands:
 *   genie wish new <slug>        — Scaffold a new WISH.md from templates/wish-template.md
 *   genie wish lint <slug>       — Structural health check (stub until Group 3 lands)
 *   genie wish parse <slug>      — Parse WISH.md and emit the WishDocument as JSON
 *   genie wish status <slug>     — Pretty-print wish state overview
 *   genie wish done <ref>        — Mark a group as done
 *   genie wish reset <ref>       — Reset a group or an entire wish
 *   genie wish list              — Enumerate all wishes with status/group counts
 *
 * Flat forms (`genie status`, `genie done`, `genie reset`) were removed in
 * Group 2 of wish-command-group-restructure. Handlers are imported from
 * `state.ts` and wired as subcommands here.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import { formatLintReport, lintWish } from '../services/wish-lint.js';
import { WishParseError, parseWish, parseWishFile } from '../services/wish-parser.js';
import { doneCommand, resetAction, statusCommand } from './state.js';

// ============================================================================
// Template resolution
// ============================================================================

/**
 * Locate `templates/wish-template.md` by walking up from cwd until a `templates`
 * directory is found. Falls back to a minimal inline skeleton when the file is
 * not yet present (Group 4 lands the canonical template; Group 2 ships without
 * a hard dependency on it so `wish new` still works during the rollout).
 */
function resolveTemplatePath(cwd: string = process.cwd()): string | null {
  let dir = cwd;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'templates', 'wish-template.md');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const FALLBACK_TEMPLATE = `# Wish: <TODO: title>

| Field | Value |
|-------|-------|
| **Status** | DRAFT |
| **Slug** | \`{{slug}}\` |
| **Date** | {{date}} |
| **Author** | <TODO> |
| **Appetite** | <TODO> |
| **Branch** | \`wish/{{slug}}\` |

## Summary

<TODO: 1–3 sentence summary>

## Scope

### IN

- <TODO>

### OUT

- <TODO>

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | <TODO> | <TODO> |

## Success Criteria

- [ ] <TODO>

## Execution Strategy

| Group | Agent | Description |
|-------|-------|-------------|
| 1 | engineer | <TODO> |

---

## Execution Groups

### Group 1: <TODO title>
**Goal:** <TODO>

**Deliverables:**
1. <TODO>

**Acceptance Criteria:**
- [ ] <TODO>

**Validation:**
\`\`\`bash
<TODO>
\`\`\`

**depends-on:** none
`;

function renderTemplate(raw: string, slug: string, date: string): string {
  return raw.replace(/\{\{slug\}\}/g, slug).replace(/\{\{date\}\}/g, date);
}

function today(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ============================================================================
// Subcommand handlers
// ============================================================================

async function wishNewCommand(slug: string, options: { force?: boolean }): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error(`❌ Invalid slug "${slug}" — use lowercase letters, digits, and hyphens`);
    process.exit(1);
  }

  const wishDir = join(process.cwd(), '.genie', 'wishes', slug);
  const wishPath = join(wishDir, 'WISH.md');

  if (existsSync(wishPath) && !options.force) {
    console.error(`❌ Wish already exists: ${wishPath}`);
    console.error('   Pass --force to overwrite');
    process.exit(1);
  }

  const templatePath = resolveTemplatePath();
  const raw = templatePath ? await readFile(templatePath, 'utf-8') : FALLBACK_TEMPLATE;
  if (!templatePath) {
    console.warn('⚠️  templates/wish-template.md not found — using inline fallback skeleton');
  }

  const rendered = renderTemplate(raw, slug, today());
  await mkdir(wishDir, { recursive: true });
  await writeFile(wishPath, rendered, 'utf-8');

  console.log(`📝 Created wish scaffold: ${wishPath}`);
  console.log(`   Template: ${templatePath ?? '<inline fallback>'}`);
  console.log(`   Next: edit the wish, then run \`genie wish lint ${slug}\` before dispatching`);
}

function renderDiff(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const len = Math.max(beforeLines.length, afterLines.length);
  const out: string[] = [];
  for (let i = 0; i < len; i++) {
    const b = beforeLines[i];
    const a = afterLines[i];
    if (b === a) continue;
    if (b !== undefined) out.push(`- ${b}`);
    if (a !== undefined) out.push(`+ ${a}`);
  }
  return out.join('\n');
}

type LintReport = ReturnType<typeof lintWish>;
type WishLintOptions = { json?: boolean; fix?: boolean; dryRun?: boolean; allowTodoPlaceholders?: boolean };

function parseWishOrError(markdown: string): Parameters<typeof lintWish>[0] {
  try {
    return parseWish(markdown) as Parameters<typeof lintWish>[0];
  } catch (err) {
    if (err instanceof WishParseError) return err as Parameters<typeof lintWish>[0];
    throw err;
  }
}

function reportWishFileMissing(slug: string, wishPath: string, jsonMode: boolean): never {
  if (jsonMode) {
    console.log(
      JSON.stringify({ error: `Wish file not found: ${wishPath}`, rule: 'missing-title', wish: slug, file: wishPath }),
    );
  } else {
    console.error(`❌ Wish file not found: ${wishPath}`);
  }
  process.exit(1);
}

function emitLintReport(report: LintReport, wishPath: string, jsonMode: boolean): void {
  if (jsonMode) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatLintReport(report, { color: process.stdout.isTTY ?? false, path: wishPath }));
  }
}

function exitWithErrorCount(report: LintReport): never {
  const errors = report.violations.filter((v) => v.severity === 'error').length;
  process.exit(errors > 0 ? 1 : 0);
}

function handleNoFixableViolations(report: LintReport, wishPath: string, jsonMode: boolean): never {
  if (jsonMode) {
    console.log(JSON.stringify({ ...report, fixedViolations: 0 }));
  } else {
    console.log(formatLintReport(report, { color: process.stdout.isTTY ?? false, path: wishPath }));
    console.log('\nNo fixable violations to apply.');
  }
  process.exit(report.summary.total > 0 ? 1 : 0);
}

function handleDryRunFix(
  report: LintReport,
  markdown: string,
  fixed: string,
  wishPath: string,
  jsonMode: boolean,
): never {
  if (jsonMode) {
    console.log(JSON.stringify({ ...report, dryRun: true, diff: renderDiff(markdown, fixed) }));
  } else {
    console.log(formatLintReport(report, { color: process.stdout.isTTY ?? false, path: wishPath }));
    console.log(`\n--- Dry-run diff (${wishPath}) ---`);
    console.log(renderDiff(markdown, fixed));
    console.log('\nFile not modified (--dry-run).');
  }
  process.exit(report.summary.total > 0 ? 1 : 0);
}

async function applyAndReportFix(
  report: LintReport,
  fixed: string,
  wishPath: string,
  slug: string,
  lintOpts: { allowTodoPlaceholders?: boolean },
  jsonMode: boolean,
): Promise<never> {
  await writeFile(wishPath, fixed, 'utf-8');
  const docOrError2 = parseWishOrError(fixed);
  const report2 = { ...lintWish(docOrError2, fixed, lintOpts), wish: slug, file: wishPath };
  const fixedCount = report.summary.fixable;
  if (jsonMode) {
    console.log(JSON.stringify({ ...report2, fixedViolations: fixedCount }));
  } else {
    console.log(`✅ Applied ${fixedCount} fix(es) to ${wishPath}`);
    console.log('');
    console.log(formatLintReport(report2, { color: process.stdout.isTTY ?? false, path: wishPath }));
  }
  const remainingErrors = report2.violations.filter((v) => v.severity === 'error').length;
  process.exit(remainingErrors > 0 ? 1 : 0);
}

async function runLintFix(
  report: LintReport,
  markdown: string,
  wishPath: string,
  slug: string,
  lintOpts: { allowTodoPlaceholders?: boolean },
  options: WishLintOptions,
): Promise<never> {
  const { applyFixes } = await import('../services/wish-lint.js');
  const fixed = applyFixes(markdown, report);
  const jsonMode = options.json ?? false;
  if (fixed === markdown) handleNoFixableViolations(report, wishPath, jsonMode);
  if (options.dryRun) handleDryRunFix(report, markdown, fixed, wishPath, jsonMode);
  return applyAndReportFix(report, fixed, wishPath, slug, lintOpts, jsonMode);
}

async function wishLintCommand(slug: string, options: WishLintOptions): Promise<void> {
  const wishPath = join(process.cwd(), '.genie', 'wishes', slug, 'WISH.md');
  const jsonMode = options.json ?? false;
  if (!existsSync(wishPath)) reportWishFileMissing(slug, wishPath, jsonMode);

  const markdown = await readFile(wishPath, 'utf-8');
  const lintOpts = { allowTodoPlaceholders: options.allowTodoPlaceholders };
  const docOrError = parseWishOrError(markdown);
  const report: LintReport = { ...lintWish(docOrError, markdown, lintOpts), wish: slug, file: wishPath };

  if (options.fix) {
    await runLintFix(report, markdown, wishPath, slug, lintOpts, options);
    return;
  }

  emitLintReport(report, wishPath, jsonMode);
  exitWithErrorCount(report);
}

function reportWishParseError(error: WishParseError, jsonMode: boolean): void {
  const payload = {
    error: error.message,
    rule: error.rule,
    line: error.line,
    column: error.column ?? null,
    file: error.file ?? null,
  };
  if (jsonMode) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.error(`❌ Parse failed (${payload.rule}): ${payload.error}`);
  if (payload.file) console.error(`   File: ${payload.file}`);
  if (payload.line) console.error(`   Line: ${payload.line}`);
}

async function wishParseCommand(slug: string, options: { json?: boolean }): Promise<void> {
  try {
    const doc = parseWishFile(slug);
    console.log(options.json ? JSON.stringify(doc) : JSON.stringify(doc, null, 2));
    return;
  } catch (error) {
    if (error instanceof WishParseError) {
      reportWishParseError(error, options.json ?? false);
      process.exit(1);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ ${message}`);
    process.exit(1);
  }
}

interface WishListRow {
  slug: string;
  status: string;
  groupCount: string;
  ready: number;
  inProgress: number;
  done: number;
}

async function isWishFile(wishPath: string): Promise<boolean> {
  try {
    const st = await stat(wishPath);
    return st.isFile();
  } catch {
    return false;
  }
}

function parseWishSummary(slug: string): { status: string; groupCount: string } {
  try {
    const doc = parseWishFile(slug);
    return { status: doc.metadata.status ?? '-', groupCount: String(doc.executionGroups.length) };
  } catch (error) {
    return { status: error instanceof WishParseError ? 'malformed' : 'error', groupCount: '-' };
  }
}

async function loadStateCounts(slug: string): Promise<{ ready: number; inProgress: number; done: number }> {
  try {
    const wishState = await import('../lib/wish-state.js');
    const state = await wishState.getState(slug);
    if (!state) return { ready: 0, inProgress: 0, done: 0 };
    let ready = 0;
    let inProgress = 0;
    let done = 0;
    for (const g of Object.values(state.groups)) {
      if (g.status === 'ready') ready++;
      else if (g.status === 'in_progress') inProgress++;
      else if (g.status === 'done') done++;
    }
    return { ready, inProgress, done };
  } catch {
    return { ready: 0, inProgress: 0, done: 0 };
  }
}

async function wishListCommand(): Promise<void> {
  const wishesRoot = join(process.cwd(), '.genie', 'wishes');
  if (!existsSync(wishesRoot)) {
    console.error(`❌ Wishes directory not found: ${wishesRoot}`);
    process.exit(1);
  }

  const entries = await readdir(wishesRoot);
  const rows: WishListRow[] = [];

  for (const entry of entries.sort()) {
    if (entry.startsWith('_') || entry.startsWith('.')) continue;
    if (!(await isWishFile(join(wishesRoot, entry, 'WISH.md')))) continue;

    const { status, groupCount } = parseWishSummary(entry);
    const { ready, inProgress, done } = await loadStateCounts(entry);
    rows.push({ slug: entry, status, groupCount, ready, inProgress, done });
  }

  if (rows.length === 0) {
    console.log('No wishes found under .genie/wishes/');
    return;
  }

  const slugW = Math.max(4, ...rows.map((r) => r.slug.length));
  const statusW = Math.max(6, ...rows.map((r) => r.status.length));
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));

  console.log(`  ${pad('SLUG', slugW)}  ${pad('STATUS', statusW)}  GROUPS  READY  IN-PROG  DONE`);
  console.log(`  ${'─'.repeat(slugW + statusW + 32)}`);
  for (const r of rows) {
    console.log(
      `  ${pad(r.slug, slugW)}  ${pad(r.status, statusW)}  ${pad(r.groupCount, 6)}  ${pad(String(r.ready), 5)}  ${pad(String(r.inProgress), 7)}  ${r.done}`,
    );
  }
  console.log('');
  console.log(`  Total: ${rows.length} wishes`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerWishCommands(program: Command): void {
  const wish = program.command('wish').description('Wish lifecycle management');

  wish
    .command('new <slug>')
    .description('Scaffold a new WISH.md from templates/wish-template.md')
    .option('--force', 'Overwrite an existing wish directory')
    .action(async (slug: string, options: { force?: boolean }) => {
      await wishNewCommand(slug, options);
    });

  wish
    .command('lint <slug>')
    .description('Structural health check (stub — full implementation in Group 3)')
    .option('--json', 'Emit machine-readable JSON output')
    .option('--fix', 'Auto-repair deterministic violations')
    .option('--dry-run', 'With --fix: print diff without writing')
    .option('--allow-todo-placeholders', 'Pass <TODO> placeholders without emitting todo-placeholder-remaining')
    .action(
      async (
        slug: string,
        options: { json?: boolean; fix?: boolean; dryRun?: boolean; allowTodoPlaceholders?: boolean },
      ) => {
        await wishLintCommand(slug, options);
      },
    );

  wish
    .command('parse <slug>')
    .description('Parse WISH.md and emit the WishDocument as JSON')
    .option('--json', 'One-line JSON output (default: pretty-printed)')
    .action(async (slug: string, options: { json?: boolean }) => {
      await wishParseCommand(slug, options);
    });

  wish
    .command('status <slug>')
    .description('Show wish state overview for all groups')
    .action(async (slug: string) => {
      await statusCommand(slug);
    });

  wish
    .command('done <ref>')
    .description('Mark a wish group as done (format: <slug>#<group>)')
    .action(async (ref: string) => {
      await doneCommand(ref);
    });

  wish
    .command('reset <ref>')
    .option('-y, --yes', 'Skip confirmation prompt (required in non-interactive mode)')
    .description(
      'Reset wish state. <slug>#<group> resets one in-progress group; bare <slug> wipes the wish and recreates from current WISH.md',
    )
    .action(async (ref: string, options: { yes?: boolean }) => {
      await resetAction(ref, options);
    });

  wish
    .command('list')
    .description('Enumerate all wishes with status, group counts, and progress')
    .action(async () => {
      await wishListCommand();
    });
}
