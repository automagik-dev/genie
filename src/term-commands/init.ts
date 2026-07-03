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

// ============================================================================
// MCP server registration (.mcp.json + .warp/.mcp.json)
// ============================================================================

/**
 * A stdio MCP server entry, as both Warp and Claude Code read it. `type:"stdio"`
 * is optional (a `command` present defaults to stdio), so it is omitted.
 */
interface McpServerEntry {
  command: string;
  args: string[];
}

/** Arbitrary JSON object (an already-parsed config we merge into). */
type JsonObject = Record<string, unknown>;

/**
 * Wrapper keys Warp recognizes for the server map, in order of preference.
 * `mcpServers` is what we write for a fresh file; if an existing file already
 * holds its servers under one of the alternates, that key is preserved.
 */
const MCP_WRAPPER_KEYS = ['mcpServers', 'mcp_servers', 'servers'] as const;

/**
 * The genie server entry written under the `genie` key. The command is the
 * ABSOLUTE path to the currently-running genie executable — for the shipped
 * bun-compiled single-file binary that is {@link process.execPath}. Bare
 * `"genie"` is NOT used: genie is not reliably on the spawning process's PATH
 * (on macOS it lives only at `~/.genie/bin/genie`). Resolving at write time is
 * self-consistent under Warp-over-SSH — `genie init` runs on the box that owns
 * the repo, so it records that box's genie path, and Warp spawns there too.
 */
function genieMcpEntry(): McpServerEntry {
  return { command: process.execPath, args: ['mcp'] };
}

/** True for a plain (non-array) JSON object. */
function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parse an existing config's raw bytes into an object, or start from `{}` when
 * the file is absent. A file that exists but is not a JSON object is a real
 * problem worth surfacing (we must not silently clobber it), so it throws.
 */
function parseMcpConfig(raw: string | null, path: string): JsonObject {
  if (raw === null || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot register genie MCP server: ${path} is not valid JSON.`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`Cannot register genie MCP server: ${path} is not a JSON object.`);
  }
  return parsed;
}

/**
 * Locate the server map inside a parsed config, preserving whatever wrapper key
 * an existing file already uses (`mcpServers`, `mcp_servers`, `servers`, or a
 * nested `mcp.servers`). When none is present the `mcpServers` key is created —
 * the preferred shape for a new file.
 */
function locateServerMap(config: JsonObject): JsonObject {
  for (const key of MCP_WRAPPER_KEYS) {
    const existing = config[key];
    if (isJsonObject(existing)) return existing;
  }
  const nested = config.mcp;
  if (isJsonObject(nested) && isJsonObject(nested.servers)) return nested.servers;

  const created: JsonObject = {};
  config.mcpServers = created;
  return created;
}

/**
 * Merge the genie MCP server entry into the config at `configPath`, creating the
 * file (and its parent dir) when absent. Only the `genie` key under the server
 * map is added/updated — every other server AND every other top-level key is
 * preserved. Serialization is deterministic (2-space JSON + trailing newline)
 * so a rerun that changes nothing is byte-identical and reports `skipped`.
 */
function mergeMcpConfig(configPath: string, entry: McpServerEntry): ArtifactAction {
  const raw = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : null;
  const config = parseMcpConfig(raw, configPath);
  const servers = locateServerMap(config);
  servers.genie = entry;

  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  if (raw !== null && raw === serialized) return 'skipped';

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, serialized);
  return raw === null ? 'created' : 'updated';
}

interface McpConfigResult {
  path: string;
  action: ArtifactAction;
}

/**
 * Register the `genie mcp` server into both project-scope config files under
 * `root`: `<root>/.mcp.json` (Claude Code) and `<root>/.warp/.mcp.json` (Warp).
 * Both get the identical entry; the merge is idempotent and preserves existing
 * servers. Exported so `genie launch` can register the same server per worktree.
 */
export function registerMcpConfigs(root: string): McpConfigResult[] {
  const entry = genieMcpEntry();
  const targets = [join(root, '.mcp.json'), join(root, '.warp', '.mcp.json')];
  return targets.map((path) => ({ path, action: mergeMcpConfig(path, entry) }));
}

// ============================================================================
// Reporting
// ============================================================================

function actionLabel(action: ArtifactAction): string {
  return action === 'skipped' ? 'already present' : action;
}

/** Short, repo-relative label for an MCP config path (`.mcp.json`, `.warp/.mcp.json`). */
function mcpConfigLabel(configPath: string): string {
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
  out('Warp + Claude Code will discover the read-only `genie mcp` server from those files.');
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
    const mcp = registerMcpConfigs(root);
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
    .description('Scaffold the per-repo genie state (idempotent): .genie/INDEX.md + .gitignore rules')
    .option('--json', 'Emit the created/skipped result as JSON')
    .action((opts: InitOptions) => handleInit(opts));
}
