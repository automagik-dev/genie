/**
 * genie init — idempotent per-repo scaffold.
 *
 * Bootstraps the things a fresh repo needs before the genie lifecycle can run:
 * the plans jar (`.genie/INDEX.md`), the `.gitignore` rules that keep every
 * machine-local `.genie/` artifact (the SQLite state files AND the roadmap sync
 * baseline) out of version control, and retirement of historical
 * Genie-owned MCP registrations. Every
 * step is idempotent — re-running `genie init` on an already-scaffolded repo
 * produces zero diff.
 *
 * No network, no daemon, no database. Refuses politely outside a git repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
import {
  type ArtifactAction,
  type McpConfigResult,
  resolveGitWorktreeRoot,
  retireProjectMcpConfigs,
} from '../lib/codex-project-mcp.js';
import { padRight } from '../lib/term-format.js';

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

/**
 * Machine-local `.genie/` state — the paths the v5 engine itself declares are
 * per-machine materializations, never shared content. Committing ANY of them
 * corrupts a teammate's checkout rather than merely adding noise:
 *
 * - `genie.db` (+ `-wal`/`-shm`, and the `-recovery-lock` sidecar named so the
 *   same stanza hides it — `sqlite-open.ts`) is the local materialization of
 *   the canonical `.genie/roadmap.json`.
 * - `roadmap-sync` is the sync BASELINE: the (file, db) hash pair from this
 *   machine's last synchronized state (`roadmap-sync.ts`). A committed baseline
 *   travels to a fresh clone, where it matches that clone's freshly created
 *   EMPTY database — so the first `genie task sync` reads "the db moved, the
 *   file did not", exports, and overwrites the shared board with nothing. It is
 *   the one ignored path whose absence is silently destructive, which is why
 *   `genie doctor` warns when a repo still tracks it.
 * - `launch/` is legacy residue protection — nothing writes there since the
 *   launch command was removed, but existing kickoff prompts stay ignored.
 *
 * Exported because `genie doctor` observes the same set: the rules below keep
 * a fresh repo clean, and the doctor check catches the repos that committed one
 * before the rule existed (a `.gitignore` rule never untracks a tracked file).
 */
export const MACHINE_LOCAL_GENIE_PATHS = [
  '.genie/genie.db',
  '.genie/genie.db-wal',
  '.genie/genie.db-shm',
  '.genie/genie.db-recovery-lock',
  '.genie/roadmap-sync',
  '.genie/launch/',
] as const;

/**
 * Operational artifacts that must never be committed: every machine-local
 * `.genie/` path above, plus the backup-first copies `genie init` writes beside
 * the two project MCP routes it retires — `.mcp.json.genie-backup-*` and
 * `.codex/config.toml.genie-backup-*`. Both are operational artifacts, not
 * project content, and the Codex one was missing here while the contract docs
 * already claimed it: a `genie init` that removed a marker-only
 * `.codex/config.toml` left its backup as an untracked file in the operator's
 * otherwise clean worktree.
 *
 * Appended idempotently: `scaffoldGitignore` writes only the rules a repo does
 * not already carry, so an existing repo picks up a newly added rule on its
 * next `genie init` and a second run writes nothing.
 */
const GITIGNORE_RULES: readonly string[] = [
  ...MACHINE_LOCAL_GENIE_PATHS,
  '.mcp.json.genie-backup-*',
  '.codex/config.toml.genie-backup-*',
];

// ============================================================================
// Git repo resolution
// ============================================================================

/**
 * Resolve the git working-tree root for `cwd`, or `null` when not inside a
 * repo. Uses `--show-toplevel` so the scaffold always lands at the repo root,
 * even when `genie init` is invoked from a subdirectory.
 */
const resolveGitRoot = resolveGitWorktreeRoot;

// ============================================================================
// Scaffold steps
// ============================================================================

interface InitResult {
  root: string;
  index: ArtifactAction;
  gitignore: ArtifactAction;
  rulesAdded: string[];
  mcp: McpConfigResult[];
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
 * Append any missing operational ignore rules to `.gitignore`, creating the file
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

/** Retire only project MCP registrations whose Genie ownership is proven. */
export function retireMcpConfigs(root: string): McpConfigResult[] {
  return retireProjectMcpConfigs(root);
}

// ============================================================================
// Reporting
// ============================================================================

/** Column the human report's action words line up in (widest label + 2). */
const REPORT_COLUMN = 20;

function actionLabel(action: ArtifactAction): string {
  return action === 'skipped' ? 'already present' : action;
}

/** Short, repo-relative label for an MCP config path (`.mcp.json` or `.codex/config.toml`). */
function mcpConfigLabel(configPath: string): string {
  if (configPath.endsWith(join('.codex', 'config.toml'))) return '.codex/config.toml';
  return '.mcp.json';
}

function printHumanReport(result: InitResult): void {
  out('Initialized genie in this repository.');
  out('');
  out(`  ${padRight('.genie/INDEX.md', REPORT_COLUMN)}${actionLabel(result.index)}`);
  const rules = result.rulesAdded.length > 0 ? ` (${result.rulesAdded.join(', ')})` : '';
  out(`  ${padRight('.gitignore', REPORT_COLUMN)}${actionLabel(result.gitignore)}${rules}`);
  for (const cfg of result.mcp) {
    // `skipped` on an MCP config means "nothing of Genie's was there", not
    // "already scaffolded" — and the detail is the only place a skip reason
    // (symlink, unreadable file, failed rewrite) or a backup filename ever
    // reaches the operator.
    const label = cfg.action === 'skipped' ? 'unchanged' : cfg.action;
    out(`  ${padRight(mcpConfigLabel(cfg.path), REPORT_COLUMN)}${label}${cfg.detail ? ` — ${cfg.detail}` : ''}`);
  }
  out('');
  out('Legacy Genie-owned MCP registrations are retired; standalone `genie task` and `genie board` remain available.');
  out('');
  out('Next steps — Claude uses /<skill>; the Codex plugin uses owner-qualified $genie:<skill>:');
  out('  1. /brainstorm or $genie:brainstorm   Explore a fuzzy idea into a DESIGN.md');
  out('  2. /wish or $genie:wish               Deliver one task end to end; plan a bigger one');
  out('  3. /review or $genie:review           Validate the plan; the caller records APPROVED');
  out('  4. /work or $genie:work               Execute the approved plan in dispatched waves');
  out('  5. /review or $genie:review           Validate the implementation against its criteria');
  out('');
  out('  Steps 3-5 are the plan path; a task delivered at step 2 ends there.');
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

    // Init RETIRES historical Genie MCP registrations and never creates one —
    // independent of plugin and delivery state, and never touching delivery,
    // journal, plugin-enabled, agent, or cache state. In `.codex/config.toml`
    // only the explicit marker block is eligible: a route NAME is not proof of
    // ownership, so an unmanaged same-key route is preserved and reported.
    //
    // `.mcp.json` has no ownership marker, so exactly ONE entry is eligible:
    // a `genie` server that launches the retired `genie mcp` command (the
    // registration a pre-retirement `genie init` wrote, which now renders as a
    // permanently failed MCP server). It is backed up before removal, every
    // other server and key is preserved, and a symlinked or unreadable file is
    // skipped with a reported reason — this step never fails init.
    //
    // Scaffolding runs FIRST so a repo whose Codex marker block is corrupt (a
    // deliberate fail-closed) still gets its `.genie/` state.
    const index = scaffoldIndex(root);
    const gitignore = scaffoldGitignore(root);
    const mcp = retireMcpConfigs(root);
    const result: InitResult = { root, index, gitignore: gitignore.action, rulesAdded: gitignore.added, mcp };

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
    .description(
      'Initialize Genie state and retire the dead genie mcp entry in .mcp.json plus marker-owned .codex/config.toml routing',
    )
    .option('--json', 'Emit the created/skipped result as JSON')
    .action((opts: InitOptions) => handleInit(opts));
}
