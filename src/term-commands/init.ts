/**
 * genie init — idempotent per-repo scaffold.
 *
 * Bootstraps the two things a fresh repo needs before the genie lifecycle can
 * run: the plans jar (`.genie/INDEX.md`) and the `.gitignore` rules that keep
 * the SQLite state files out of version control. Both steps are idempotent —
 * re-running `genie init` on an already-scaffolded repo produces zero diff.
 *
 * No network, no daemon, no database. Refuses politely outside a git repo.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in source)
// ============================================================================

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/** Wrap a handler so typed errors become clean stderr + non-zero exit. */
function run(handler: () => void): void {
  try {
    handler();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Raised when `genie init` is invoked outside a git working tree. */
export class NotAGitRepoError extends Error {
  constructor() {
    super('genie init must be run inside a git repository. Run `git init` first, then re-run `genie init`.');
    this.name = 'NotAGitRepoError';
  }
}

// ============================================================================
// Scaffold content
// ============================================================================

/** The jar skeleton written to a fresh `.genie/INDEX.md`. */
const INDEX_SKELETON = `# Plans Index

## Raw

## Simmering

## Ready

## Poured
`;

/** SQLite state artifacts that must never be committed. */
const GITIGNORE_RULES = ['.genie/genie.db', '.genie/genie.db-wal', '.genie/genie.db-shm'];

// ============================================================================
// Git repo resolution
// ============================================================================

/**
 * Resolve the git working-tree root for `cwd`, or `null` when not inside a
 * repo. Uses `--show-toplevel` so the scaffold always lands at the repo root,
 * even when `genie init` is invoked from a subdirectory.
 */
function resolveGitRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Scaffold steps
// ============================================================================

type ArtifactAction = 'created' | 'updated' | 'skipped';

interface InitResult {
  root: string;
  index: ArtifactAction;
  gitignore: ArtifactAction;
  rulesAdded: string[];
}

/** Create `.genie/INDEX.md` with the jar skeleton if it does not exist. */
function scaffoldIndex(root: string): ArtifactAction {
  const indexPath = join(root, '.genie', 'INDEX.md');
  if (existsSync(indexPath)) return 'skipped';
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileSync(indexPath, INDEX_SKELETON);
  return 'created';
}

/**
 * Append any missing SQLite ignore rules to `.gitignore`, creating the file
 * when absent. Existing content is preserved byte-for-byte; rules already
 * present are left untouched, so a second run writes nothing.
 */
function scaffoldGitignore(root: string): { action: ArtifactAction; added: string[] } {
  const gitignorePath = join(root, '.gitignore');
  const exists = existsSync(gitignorePath);
  const existing = exists ? readFileSync(gitignorePath, 'utf-8') : '';
  const present = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = GITIGNORE_RULES.filter((rule) => !present.has(rule));

  if (missing.length === 0) return { action: 'skipped', added: [] };

  // Preserve existing content; ensure a newline boundary before appending.
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? `${existing}\n` : existing;
  writeFileSync(gitignorePath, `${prefix}${missing.join('\n')}\n`);
  return { action: exists ? 'updated' : 'created', added: missing };
}

// ============================================================================
// Reporting
// ============================================================================

function actionLabel(action: ArtifactAction): string {
  return action === 'skipped' ? 'already present' : action;
}

function printHumanReport(result: InitResult): void {
  out('Initialized genie in this repository.');
  out('');
  out(`  .genie/INDEX.md   ${actionLabel(result.index)}`);
  if (result.rulesAdded.length > 0) {
    out(`  .gitignore        ${actionLabel(result.gitignore)} (${result.rulesAdded.join(', ')})`);
  } else {
    out(`  .gitignore        ${actionLabel(result.gitignore)}`);
  }
  out('');
  out('Next steps — the plan/work lifecycle (run inside Claude Code):');
  out('  /brainstorm   Explore a fuzzy idea into a DESIGN.md');
  out('  /wish         Turn the design into an executable wish plan');
  out('  /work         Execute the wish plan in dispatched waves');
  out('  /review       Validate the result against its acceptance criteria');
  out('');
  out('Track progress any time with:  genie board');
}

// ============================================================================
// Handler
// ============================================================================

interface InitOptions {
  json?: boolean;
}

function handleInit(opts: InitOptions): void {
  run(() => {
    const root = resolveGitRoot(process.cwd());
    if (!root) throw new NotAGitRepoError();

    const index = scaffoldIndex(root);
    const gitignore = scaffoldGitignore(root);
    const result: InitResult = { root, index, gitignore: gitignore.action, rulesAdded: gitignore.added };

    if (opts.json) {
      out(JSON.stringify(result, null, 2));
      return;
    }
    printHumanReport(result);
  });
}

// ============================================================================
// Registration
// ============================================================================

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Scaffold the per-repo genie state (idempotent): .genie/INDEX.md + .gitignore rules')
    .option('--json', 'Emit the created/skipped result as JSON')
    .action((opts: InitOptions) => handleInit(opts));
}
