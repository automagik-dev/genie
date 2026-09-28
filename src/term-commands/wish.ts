/**
 * genie wish — the wish-document verbs, on PATH.
 *
 *   wish lint [--dir <repo>]     # structural lint over <repo>/.genie/wishes
 *   wish report [runId] [--append] [--summary] [--variant <name>] [--record <path>]
 *                                # tokens-and-time report of one workflow run, and its ledger
 *
 * The linter itself stays in `scripts/wishes-lint.ts`: this file is a
 * registration surface over `runWishLintCli`, so `genie wish lint` and
 * `bun run wishes:lint` are one code path, exactly as `genie mikro` fronts the
 * mikro runtime. The script is NOT relocated under `src/` — its formatting and
 * its `validate-wish` neighbour are inherited verbatim from the plugin era, and
 * a move would be a decomposition project rather than a delivery step.
 *
 * The point of the verb is that a repository which is not genie can run the
 * linter its `wish` skill tells it to run. That is why `'wish'` sits in
 * `WORKSPACE_EXEMPT` (`src/lib/interactivity.ts`): without it the v4 workspace
 * gate would prompt for `genie init` in every repository this verb exists for.
 *
 * Exit codes: 0 clean, 1 findings, 2 the runtime refused the root it was handed
 * (a `--dir` that is not a directory, or one carrying no `.genie/wishes`). An
 * unknown FLAG is Commander's own error through genie's global handler and
 * exits 1 — the same path `genie mikro call` with no agent takes.
 *
 * `wish report` reads one saved-workflow run record
 * (`<CLAUDE_CONFIG_DIR>/projects/<project>/<session>/workflows/<runId>.json`) and
 * prints its totals and one row per agent stage — tokens and time only, never
 * money. `--append` adds one row to the machine-local ledger
 * `<GENIE_HOME>/metrics/wish-runs.jsonl`; `--summary` averages that ledger per
 * workflow and variant. Exit 2: an unknown runId, a record missing a required
 * field, or a runId already in the ledger.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from 'commander';
import { runWishLintCli } from '../../scripts/wishes-lint';
import { resolveClaudeDir, resolveGenieHome } from '../lib/genie-home';

const WISH_GROUP_DESCRIPTION = 'Work with wish documents and wish runs (lint, report)';

const LINT_HELP = `
Reads <repo>/.genie/wishes and reports structure: the canonical wish template
sections, the metadata fields (a Status from the lifecycle vocabulary, a valid
YYYY-MM-DD Date), the Execution Strategy routing columns, and every markdown
link into .genie/brainstorms/ that does not resolve on disk. It writes nothing.

Without --dir the root is the git toplevel of the working directory, falling
back to the working directory itself; a checkout that carries no wishes yet is
not an error and reports 0 files. A --dir you TYPED is verified instead: one
that is not a directory, or that holds no .genie/wishes, is refused rather than
scanned, so a typo can never read as a clean bill of health. A file may opt out
with a leading <!-- wishes-lint:ignore --> marker.

Two further rules ride the same pass but stay REPOSITORY-GATE concerns rather
than a promise this verb makes to every checkout: design-review evidence (a
post-2026-07-11 wish must link a DESIGN.md carrying a current SHIP stamp) and
the cross-wish graph (depends-on/blocks must name slugs that exist in this same
corpus and stay acyclic). They are authored for the genie repository's own
\`bun run wishes:lint\` gate, where the whole corpus is present; a repository
that does not follow that contract should treat them there, not here.

Exit codes: 0 clean, 1 findings, 2 the root was refused. An unknown flag is the
parser's own error and exits 1.`;

/** One ledger row — design D9. `state` and `totalToolCalls` are nullable; the rest of the totals are required. */
interface WishRunRow {
  runId: string;
  sessionId: string;
  repo: string | null;
  workflowName: string;
  variant: string;
  state: string | null;
  timestamp: string | null;
  durationMs: number;
  totalTokens: number;
  totalToolCalls: number | null;
  agentCount: number;
  stages: Array<{ label: string; model: string | null; tokens: number; toolCalls: number | null; durationMs: number }>;
}

interface ReportOptions {
  append?: boolean;
  summary?: boolean;
  variant: string;
  record?: string;
}

const REQUIRED = ['runId', 'workflowName', 'durationMs', 'totalTokens', 'agentCount', 'workflowProgress'] as const;

function ledgerPath(): string {
  return join(resolveGenieHome(), 'metrics', 'wish-runs.jsonl');
}

function readLedger(): WishRunRow[] {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  const rows: WishRunRow[] = [];
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '') return;
      try {
        rows.push(JSON.parse(line) as WishRunRow);
      } catch {
        process.stderr.write(`wish report: skipped corrupt line ${index + 1} of ${path}\n`);
      }
    });
  return rows;
}

/** `<claude>/projects/<project>/<session>/workflows/<runId>.json`, or null when no project holds it. */
function findRecord(runId: string): string | null {
  const projects = join(resolveClaudeDir(), 'projects');
  if (!existsSync(projects)) return null;
  for (const project of readdirSync(projects)) {
    const projectDir = join(projects, project);
    let sessions: string[];
    try {
      sessions = readdirSync(projectDir);
    } catch {
      continue; // a file beside the project directories
    }
    for (const session of sessions) {
      const candidate = join(projectDir, session, 'workflows', `${runId}.json`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function gitRepoName(): string | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: 'pipe' }).trim();
    return top ? basename(top) : null;
  } catch {
    return null;
  }
}

/** The D9 row of one record, or the reason it is refused. */
function toRow(record: Record<string, unknown>, path: string, variant: string): WishRunRow | string {
  for (const field of REQUIRED) if (record[field] === undefined || record[field] === null) return `has no ${field}`;
  if (!Array.isArray(record.workflowProgress)) return 'has a workflowProgress that is not an array';
  const result = record.result as { state?: unknown } | null | undefined;
  const agents = (record.workflowProgress as Array<Record<string, unknown>>).filter(
    (entry) => entry?.type === 'workflow_agent',
  );
  for (const entry of agents) {
    for (const field of ['tokens', 'durationMs']) {
      if (typeof entry[field] !== 'number') return `has a stage ${String(entry.label)} with no numeric ${field}`;
    }
  }
  return {
    runId: record.runId as string,
    sessionId: basename(dirname(dirname(path))),
    repo: gitRepoName(),
    workflowName: record.workflowName as string,
    variant,
    state: typeof result?.state === 'string' ? result.state : null,
    timestamp: (record.timestamp as string | undefined) ?? null,
    durationMs: record.durationMs as number,
    totalTokens: record.totalTokens as number,
    totalToolCalls: (record.totalToolCalls as number | undefined) ?? null,
    agentCount: record.agentCount as number,
    stages: agents.map((entry) => ({
      label: entry.label as string,
      model: (entry.model as string | undefined) ?? null,
      tokens: entry.tokens as number,
      toolCalls: (entry.toolCalls as number | undefined) ?? null,
      durationMs: entry.durationMs as number,
    })),
  };
}

function formatRow(row: WishRunRow): string {
  const minutes = (row.durationMs / 60000).toFixed(1);
  const lines = [
    `${row.workflowName} ${row.runId} (session ${row.sessionId}, variant ${row.variant})`,
    `total: ${minutes} min, ${row.totalTokens} tokens, ${row.totalToolCalls ?? '-'} tool calls, ${row.agentCount} agents, state ${row.state ?? 'null'}`,
    'stage\tmodel\ttokens\ttoolCalls\tseconds',
  ];
  for (const stage of row.stages) {
    const seconds = Math.round(stage.durationMs / 1000);
    lines.push(`${stage.label}\t${stage.model ?? '-'}\t${stage.tokens}\t${stage.toolCalls ?? '-'}\t${seconds}`);
  }
  return `${lines.join('\n')}\n`;
}

/** n, mean tokens and mean minutes per workflowName + variant; the merge-ready rate for wish rows (null state = not ready). */
function formatSummary(rows: WishRunRow[]): string {
  if (rows.length === 0) return `no runs in ${ledgerPath()}\n`;
  const groups = new Map<string, WishRunRow[]>();
  for (const row of rows) {
    const key = `${row.workflowName}\t${row.variant}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = ['workflow\tvariant\tn\tmeanTokens\tmeanMinutes\tmergeReady'];
  for (const [key, group] of groups) {
    const n = group.length;
    const meanTokens = Math.round(group.reduce((sum, row) => sum + row.totalTokens, 0) / n);
    const meanMinutes = (group.reduce((sum, row) => sum + row.durationMs, 0) / n / 60000).toFixed(1);
    const ready = group.filter((row) => row.state === 'merge-ready').length;
    const rate = group[0]?.workflowName === 'wish' ? `${ready}/${n}` : '-';
    lines.push(`${key}\t${n}\t${meanTokens}\t${meanMinutes}\t${rate}`);
  }
  return `${lines.join('\n')}\n`;
}

function runWishReport(runId: string | undefined, options: ReportOptions): number {
  if (runId === undefined && options.record === undefined) {
    if (options.summary) {
      process.stdout.write(formatSummary(readLedger()));
      return 0;
    }
    process.stderr.write('wish report: name a runId, pass --record <path>, or pass --summary\n');
    return 2;
  }
  const path = options.record ?? findRecord(runId as string);
  if (path === null || !existsSync(path)) {
    const where = options.record ?? `${runId} under ${join(resolveClaudeDir(), 'projects')}`;
    process.stderr.write(`wish report: no run record ${where}\n`);
    return 2;
  }
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    process.stderr.write(`wish report: ${path} is not valid JSON; refused\n`);
    return 2;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    process.stderr.write(`wish report: ${path} is not a JSON object; refused\n`);
    return 2;
  }
  const row = toRow(record as Record<string, unknown>, path, options.variant);
  if (typeof row === 'string') {
    process.stderr.write(`wish report: ${path} ${row}; refused\n`);
    return 2;
  }
  if (runId !== undefined && row.runId !== runId) {
    process.stderr.write(`wish report: ${path} holds runId ${row.runId}, not ${runId}; refused\n`);
    return 2;
  }
  process.stdout.write(formatRow(row));
  if (options.append) {
    if (readLedger().some((existing) => existing.runId === row.runId)) {
      process.stderr.write(`wish report: ${row.runId} is already in ${ledgerPath()}; nothing appended\n`);
      return 2;
    }
    mkdirSync(dirname(ledgerPath()), { recursive: true });
    appendFileSync(ledgerPath(), `${JSON.stringify(row)}\n`);
    process.stdout.write(`appended to ${ledgerPath()}\n`);
  }
  if (options.summary) process.stdout.write(formatSummary(readLedger()));
  return 0;
}

export function registerWishCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'wish');
  const wish = existing ?? program.command('wish').description(WISH_GROUP_DESCRIPTION);

  wish
    .command('lint')
    .description("Lint a repository's wish documents for structure (writes nothing)")
    .option('--dir <repo>', 'Repository whose .genie/wishes is linted (default: the git toplevel of the cwd)')
    .addHelpText('after', LINT_HELP)
    // `!== undefined`, never truthiness: `--dir ""` is a mistake an operator made
    // (an unset shell variable), and a falsy check silently turned it into "lint
    // the working directory instead". The runtime refuses the empty value.
    .action(async (options: { dir?: string }) => {
      process.exitCode = await runWishLintCli(options.dir !== undefined ? ['--dir', options.dir] : []);
    });

  wish
    .command('report [runId]')
    .description('Report tokens and time of one workflow run; --append records it, --summary averages the ledger')
    .option('--append', 'Append one row to <GENIE_HOME>/metrics/wish-runs.jsonl (refuses a runId already there)')
    .option('--summary', 'Print n, mean tokens and mean minutes per workflow and variant from the ledger')
    .option('--variant <name>', 'Variant label for the appended row', 'unlabeled')
    .option('--record <path>', 'Read this run record instead of searching the Claude projects directory')
    .action((runId: string | undefined, options: ReportOptions) => {
      process.exitCode = runWishReport(runId, options);
    });
}
