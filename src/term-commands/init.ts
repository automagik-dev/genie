/**
 * genie init — idempotent per-repo scaffold.
 *
 * Bootstraps the things a fresh repo needs before the genie lifecycle can run:
 * the plans jar (`.genie/INDEX.md`), the `.gitignore` rules that keep the
 * SQLite state files out of version control, and the MCP server registration
 * that lets Warp + Claude Code discover the read-only `genie mcp` server. Every
 * step is idempotent — re-running `genie init` on an already-scaffolded repo
 * produces zero diff.
 *
 * No network, no daemon, no database. Refuses politely outside a git repo.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Command } from 'commander';
// Group D consumes B's stable observation/reporting facade — never A's internals
// directly — to gate init's project-fallback reconciliation on a fresh
// `verified-current` observation.
import { classifyCodexActivation, observeCodexActivation } from '../lib/codex-activation-executor.js';
import type { CodexActivationSnapshot } from '../lib/codex-activation.js';
import {
  type ArtifactAction,
  type CodexPluginProbe,
  type McpConfigResult,
  type RegisterProjectMcpOptions,
  mergeCodexMcpFallback,
  registerProjectMcpConfigs,
  removeCodexMcpFallback,
  resolveGitWorktreeRoot,
} from '../lib/codex-project-mcp.js';

export { mergeCodexMcpFallback, removeCodexMcpFallback };

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

/**
 * Register the `genie mcp` server into both project-scope config files under
 * `root`: `<root>/.mcp.json` (Claude Code) and `<root>/.warp/.mcp.json` (Warp).
 * Both get the identical entry; the merge is idempotent and preserves existing
 * servers. Exported so `genie launch` can register the same server per worktree.
 */
export function registerMcpConfigs(root: string, options: RegisterProjectMcpOptions = {}): McpConfigResult[] {
  return registerProjectMcpConfigs(root, options);
}

// ============================================================================
// Verified-current fallback gate (Group D, D5)
// ============================================================================

/** Test/observation seams for the read-only, permit-free verified-current gate. */
export interface InitCodexObservationDeps {
  /** Injected activation observer (defaults to B's facade over the resolved codex CLI). */
  observeCodexActivation?: (options: { command: string | null }) => CodexActivationSnapshot;
  /** Resolve the codex executable (defaults to `Bun.which('codex')`, null on failure). */
  resolveCodexCommand?: () => string | null;
}

function defaultResolveCodexCommand(): string | null {
  try {
    return Bun.which('codex');
  } catch {
    return null;
  }
}

/**
 * Decide whether init may reconcile the project fallback (trust the plugin,
 * remove the marker-owned `.codex/config.toml` route). ONLY a fresh, unambiguous
 * `verified-current` activation observation grants that — the classifier's
 * `current` state, which requires the installed cache digest to equal the
 * canonical payload with no unresolved refresh intent. Pending, broken,
 * indeterminate, and current-LOOKING recovery states (e.g. `intent-target-current`)
 * all return false so the fallback is retained. This is a pure, read-only
 * observation: it never mints an assertion/permit, runs a plugin/cache mutator,
 * or touches the lifecycle lease. It never treats a prior/current-looking
 * snapshot as fresh authority — the observation is taken here, now.
 */
export function isCodexVerifiedCurrent(deps: InitCodexObservationDeps = {}): boolean {
  const resolveCommand = deps.resolveCodexCommand ?? defaultResolveCodexCommand;
  const observe = deps.observeCodexActivation ?? ((options) => observeCodexActivation(options));
  const snapshot = observe({ command: resolveCommand() });
  return classifyCodexActivation(snapshot).kind === 'current';
}

/**
 * Project the verified-current verdict onto the codex-fallback decision
 * `registerProjectMcpConfigs` consumes: a verified-current observation is the
 * only usable-plugin signal (removes the fallback); everything else keeps
 * `isUsableCodexPlugin` false so the marker-owned fallback is retained.
 */
function verifiedCurrentProbe(verifiedCurrent: boolean): CodexPluginProbe {
  return verifiedCurrent
    ? {
        cliAvailable: true,
        status: 'ok',
        installed: true,
        enabled: true,
        usable: true,
        detail: 'activation observer: verified-current (plugin trusted, project fallback removed)',
      }
    : {
        cliAvailable: false,
        status: 'unavailable',
        installed: false,
        detail: 'activation observer: not verified-current; project fallback retained',
      };
}

// ============================================================================
// Reporting
// ============================================================================

function actionLabel(action: ArtifactAction): string {
  return action === 'skipped' ? 'already present' : action;
}

/** Short, repo-relative label for an MCP config path (`.mcp.json`, `.warp/.mcp.json`). */
function mcpConfigLabel(configPath: string): string {
  if (configPath.endsWith(join('.codex', 'config.toml'))) return '.codex/config.toml';
  return configPath.endsWith(join('.warp', '.mcp.json')) ? '.warp/.mcp.json' : '.mcp.json';
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
  for (const cfg of result.mcp) {
    out(`  ${mcpConfigLabel(cfg.path)}        ${actionLabel(cfg.action)}`);
  }
  out('');
  out('Warp, Claude Code, and Codex will discover the read-only `genie mcp` server.');
  out('');
  out('Next steps — Claude uses /<skill>; the Codex plugin uses owner-qualified $genie:<skill>:');
  out('  1. /brainstorm or $genie:brainstorm   Explore a fuzzy idea into a DESIGN.md');
  out('  2. /wish or $genie:wish               Turn the design into an executable wish plan');
  out('  3. /review or $genie:review           Validate and persist an APPROVED plan');
  out('  4. /work or $genie:work               Execute the approved plan in dispatched waves');
  out('  5. /review or $genie:review           Validate the implementation against its criteria');
  out('');
  out('Track progress any time with:  genie board');
}

// ============================================================================
// Handler
// ============================================================================

interface InitOptions {
  json?: boolean;
}

function handleInit(opts: InitOptions, deps: InitCodexObservationDeps = {}): void {
  run(() => {
    const root = resolveGitRoot(process.cwd());
    if (!root) throw new NotAGitRepoError();

    // Init reconciles the Codex project fallback ONLY when a fresh observation is
    // exactly `verified-current`; pending/broken/indeterminate/recovery states
    // retain the fallback and make zero plugin/cache mutation. The observation is
    // read-only and never mints an assertion/permit or acquires the lease.
    const verifiedCurrent = isCodexVerifiedCurrent(deps);

    // MCP config is planned and schema-checked before any scaffold mutation.
    // A wrong-shaped existing JSON file therefore fails without leaving a new
    // INDEX or gitignore rules behind.
    const mcp = registerMcpConfigs(root, { pluginProbe: verifiedCurrentProbe(verifiedCurrent) });
    const index = scaffoldIndex(root);
    const gitignore = scaffoldGitignore(root);
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
      'Initialize Genie state and reconcile project MCP routing (.mcp.json, .warp/.mcp.json, optional .codex/config.toml)',
    )
    .option('--json', 'Emit the created/skipped result as JSON')
    .action((opts: InitOptions) => handleInit(opts));
}
