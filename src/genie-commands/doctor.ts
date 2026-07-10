/**
 * doctor — minimal diagnostic checks for a genie install.
 *
 * v5 is zero-daemon: no PostgreSQL, no pm2, no tmux supervision. The doctor
 * therefore only checks the handful of things genie actually depends on:
 *   1. the genie binary + its version (and whether it is on PATH)
 *   2. git present + repo detection
 *   3. the shared .genie/genie.db is openable at the expected schema version
 *   4. the skills prompts are present
 *   5. bun present (genie runs under bun)
 *
 * Human-readable by default; `--json` emits the raw check results. Exits
 * non-zero if any check is a hard failure.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { MANAGED_BY, MANIFEST_NAME, TARGET_NAME, computeDirDigest, resolveGenieSource } from '../lib/agent-sync.js';
import { DEAD_GENIE_OTEL_EXPORTER, getCodexConfigPath, getCodexHome } from '../lib/codex-config.js';
import { loadGenieConfig } from '../lib/genie-config.js';
import {
  resolveClaudeDir,
  resolveCodexDir,
  resolveGenieHome as resolveGlobalGenieHome,
  resolveHermesHome,
} from '../lib/genie-home.js';
import { resolveOmniRuntimeConfig } from '../lib/omni-config.js';
import { codexPluginState, resolveBundleRoot } from '../lib/runtime-integrations.js';
import { CURRENT_SCHEMA_VERSION, GenieDbError, openDb, resolveDbPath, resolveRepoRoot } from '../lib/v5/genie-db.js';
import { VERSION } from '../lib/version.js';
import {
  cleanupV4,
  detectUncertainKeeps,
  detectV4HomeResidue,
  detectV4Install,
  resolveGenieHome,
  sizeOfPathTree,
} from './legacy-v4.js';

type CheckStatus = 'pass' | 'warn' | 'fail';

interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  suggestion?: string;
}

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in v5 source)
// ============================================================================

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const GLYPH: Record<CheckStatus, string> = {
  pass: '\x1b[32m✔\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✖\x1b[0m',
};

function whichBinary(name: string): string | null {
  try {
    const bunWhich = (Bun as unknown as { which?: (n: string) => string | null }).which;
    if (typeof bunWhich === 'function') return bunWhich(name);
  } catch {
    /* fall through to execFileSync */
  }
  try {
    return execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// ============================================================================
// Individual checks
// ============================================================================

function checkGenieBinary(): CheckResult[] {
  const results: CheckResult[] = [{ name: `genie version ${VERSION}`, status: 'pass' }];
  const onPath = whichBinary('genie');
  if (onPath) {
    results.push({ name: 'genie on PATH', status: 'pass', detail: onPath });
  } else {
    results.push({
      name: 'genie on PATH',
      status: 'warn',
      detail: 'not found on PATH',
      suggestion: 'Run `genie setup` (or add the install dir to PATH) to invoke genie without an explicit path.',
    });
  }
  return results;
}

function checkGit(): CheckResult[] {
  const gitPath = whichBinary('git');
  if (!gitPath) {
    return [
      {
        name: 'git present',
        status: 'fail',
        detail: 'git not found on PATH',
        suggestion: 'Install git — genie resolves the repo root and shared genie.db via git.',
      },
    ];
  }
  const results: CheckResult[] = [{ name: 'git present', status: 'pass', detail: gitPath }];
  try {
    const inside = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (inside === 'true') {
      results.push({ name: 'inside a git repository', status: 'pass', detail: resolveRepoRoot() });
    } else {
      results.push({ name: 'inside a git repository', status: 'warn', detail: 'not a work tree' });
    }
  } catch {
    results.push({
      name: 'inside a git repository',
      status: 'warn',
      detail: 'not inside a git repository',
      suggestion: 'Run genie from within a git repo — per-repo state lives under <repo>/.genie/.',
    });
  }
  return results;
}

function checkDatabase(): CheckResult[] {
  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    return [
      {
        name: 'genie.db',
        status: 'pass',
        detail: `absent at ${dbPath} (created on first task/board use)`,
      },
    ];
  }
  try {
    const db = openDb({ path: dbPath });
    try {
      const row = db.query('PRAGMA user_version').get() as { user_version: number } | null;
      const version = row?.user_version ?? 0;
      if (version === CURRENT_SCHEMA_VERSION) {
        return [{ name: 'genie.db', status: 'pass', detail: `${dbPath} (schema v${version})` }];
      }
      return [
        {
          name: 'genie.db',
          status: 'fail',
          detail: `${dbPath} reports schema v${version}, expected v${CURRENT_SCHEMA_VERSION}`,
        },
      ];
    } finally {
      db.close();
    }
  } catch (err) {
    const detail = err instanceof GenieDbError ? err.message : err instanceof Error ? err.message : String(err);
    return [{ name: 'genie.db', status: 'fail', detail }];
  }
}

function checkSkills(): CheckResult[] {
  // skills/ ships alongside the source tree; resolve it relative to the repo
  // root (dev) — an installed plugin bundle exposes the same directory.
  const candidates = [join(resolveRepoRoot(), 'skills'), join(import.meta.dir, '..', '..', 'skills')];
  const found = candidates.find((p) => existsSync(join(p, 'wish', 'SKILL.md')) || existsSync(join(p, 'wish.md')));
  if (found) {
    return [{ name: 'skills present', status: 'pass', detail: found }];
  }
  return [
    {
      name: 'skills present',
      status: 'warn',
      detail: 'skills/ directory not found',
      suggestion: 'Reinstall genie or run from the repo root so skill prompts resolve.',
    },
  ];
}

function checkBun(): CheckResult[] {
  const bunVersion = typeof Bun !== 'undefined' ? Bun.version : null;
  const onPath = whichBinary('bun');
  if (bunVersion) {
    return [
      {
        name: `bun ${bunVersion}`,
        status: 'pass',
        detail: onPath ?? 'running under bun',
      },
    ];
  }
  return [
    {
      name: 'bun present',
      status: 'fail',
      detail: 'bun runtime not detected',
      suggestion: 'Install bun (https://bun.sh) — genie is a bun single-file binary.',
    },
  ];
}

function readCodexPluginState(results: CheckResult[]): ReturnType<typeof codexPluginState> {
  try {
    return codexPluginState(
      execFileSync('codex', ['plugin', 'list', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
    );
  } catch {
    results.push({ name: 'Codex plugin query', status: 'warn', detail: 'codex plugin list failed' });
    return { installed: false };
  }
}

function codexPluginCheck(state: ReturnType<typeof codexPluginState>): CheckResult {
  if (!state.installed) {
    return {
      name: 'Codex Genie plugin',
      status: 'warn',
      detail: 'not installed',
      suggestion: 'Run `genie setup --codex` to install or repair it.',
    };
  }
  const current = state.version === VERSION;
  return {
    name: 'Codex Genie plugin',
    status: current ? 'pass' : 'warn',
    detail: `v${state.version ?? 'unknown'}; ${state.enabled ? 'enabled' : 'disabled'} (CLI v${VERSION})`,
    suggestion: current ? undefined : 'Run `genie setup --codex` to refresh the version-matched plugin.',
  };
}

function codexAgentCheck(): CheckResult {
  const agentsDir = join(getCodexHome(), 'agents');
  const count = existsSync(agentsDir)
    ? readdirSync(agentsDir).filter((name) => /^genie-.+\.toml$/.test(name)).length
    : 0;
  return {
    name: 'Codex Genie role agents',
    status: count === 7 ? 'pass' : 'warn',
    detail: `${count}/7 installed`,
    suggestion: count === 7 ? undefined : 'Run `genie setup --codex` to repair marker-owned role agents.',
  };
}

function probeGenieMcp(): CheckResult {
  const genie = whichBinary('genie');
  if (!genie) return { name: 'Genie MCP connectivity', status: 'warn', detail: 'genie executable not on PATH' };
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'genie_board', arguments: {} } },
  ];
  try {
    const stdout = execFileSync(genie, ['mcp'], {
      encoding: 'utf8',
      input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const replies = stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown });
    const healthy = [1, 2, 3].every((id) => replies.some((reply) => reply.id === id && reply.result && !reply.error));
    return {
      name: 'Genie MCP connectivity',
      status: healthy ? 'pass' : 'warn',
      detail: healthy ? 'initialize, tools/list, and genie_board succeeded' : 'incomplete JSON-RPC response',
    };
  } catch (error) {
    return {
      name: 'Genie MCP connectivity',
      status: 'warn',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkCodexIntegration(): Promise<CheckResult[]> {
  const codex = whichBinary('codex');
  if (!codex) return [{ name: 'Codex CLI', status: 'warn', detail: 'not installed (Claude-only mode available)' }];
  const results: CheckResult[] = [{ name: 'Codex CLI', status: 'pass', detail: codex }];
  const state = readCodexPluginState(results);
  results.push(codexPluginCheck(state), codexAgentCheck());
  const configPath = getCodexConfigPath();
  const obsolete = existsSync(configPath) && readFileSync(configPath, 'utf8').includes(DEAD_GENIE_OTEL_EXPORTER);
  results.push({
    name: 'obsolete Genie OTel exporter',
    status: obsolete ? 'warn' : 'pass',
    detail: obsolete ? 'present' : 'absent',
    suggestion: obsolete ? 'Run `genie setup --codex` for backup-first removal.' : undefined,
  });
  const fallback = join(process.cwd(), '.codex', 'config.toml');
  const duplicate =
    state.installed && existsSync(fallback) && readFileSync(fallback, 'utf8').includes('# BEGIN GENIE MCP FALLBACK');
  results.push({
    name: 'Codex Genie MCP registration',
    status: duplicate ? 'warn' : state.installed ? 'pass' : 'warn',
    detail: duplicate
      ? 'plugin plus project fallback (duplicate)'
      : state.installed
        ? 'plugin-bundled'
        : 'plugin unavailable',
  });
  if (state.installed) {
    const manifest = join(resolveBundleRoot(), 'plugins', 'genie', '.codex-plugin', 'plugin.json');
    const declared = existsSync(manifest) && readFileSync(manifest, 'utf8').includes('"genie"');
    results.push({
      name: 'Codex Genie MCP capability',
      status: declared ? 'pass' : 'warn',
      detail: declared ? 'stdio server declared' : 'manifest declaration missing',
    });
    results.push(probeGenieMcp());
    results.push({
      name: 'Codex hook review',
      status: 'warn',
      detail: 'trust is a user decision and cannot be inferred safely',
      suggestion: 'Open /hooks, review Genie commands, then start a new Codex task.',
    });
  }
  const config = await loadGenieConfig();
  results.push({ name: 'preferred agent runtime', status: 'pass', detail: config.runtime.defaultAgent });
  return results;
}

/** Warn only when Claude Code's global subagent-model override is present. */
export function checkSubagentModelOverride(env: NodeJS.ProcessEnv = process.env): CheckResult[] {
  if (env.CLAUDE_CODE_SUBAGENT_MODEL === undefined) return [];
  return [
    {
      name: 'CLAUDE_CODE_SUBAGENT_MODEL override',
      status: 'warn',
      detail: 'set globally; it overrides per-agent model pins',
      suggestion: 'Unset CLAUDE_CODE_SUBAGENT_MODEL to let Genie role and stage model pins take effect.',
    },
  ];
}

// ============================================================================
// v4 residue check (detect-only; --fix runs the backup-first cleanup)
// ============================================================================

function prettyBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function safeSizeOf(path: string): number {
  try {
    return sizeOfPathTree(path);
  } catch {
    return 0;
  }
}

/**
 * Detect v4 daemon-era residue (genie home + ~/.claude rules/caches). Pure
 * read — doctor without --fix must mutate nothing. Exported for tests with an
 * injectable home pair.
 *
 * Accounting contract: "reclaimable" counts and bytes cover ONLY what --fix
 * would actually remove (home residue + marker-matched rules + orphaned
 * caches). A user-modified rules file is reported as kept, never counted.
 * Uncertain-keeps are report-only lines (Decision 2) — absent from the
 * manifest, unreachable by --fix.
 */
export function checkV4Residue(home?: string, genieHome?: string): CheckResult[] {
  const gh = genieHome ?? resolveGenieHome(home ?? homedir());
  const residue = detectV4HomeResidue(gh);
  const claude = detectV4Install(home ?? homedir());
  const orphanedCaches = claude.cacheDirs.filter((d) => d.orphaned);
  const rulesReclaimable = claude.rulesFile.status === 'v4-markers';
  const rulesKeptUserModified = claude.rulesFile.status === 'user-modified';
  const uncertainKeeps = detectUncertainKeeps(gh);

  const results: CheckResult[] = [];
  const claudeCount = orphanedCaches.length + (rulesReclaimable ? 1 : 0);
  if (residue.length === 0 && claudeCount === 0 && !rulesKeptUserModified) {
    results.push({ name: 'v4 residue', status: 'pass', detail: 'none found' });
  } else if (residue.length + claudeCount > 0) {
    const totalBytes =
      residue.reduce((sum, r) => sum + r.sizeBytes, 0) +
      (rulesReclaimable ? safeSizeOf(claude.rulesFile.path) : 0) +
      orphanedCaches.reduce((sum, d) => sum + safeSizeOf(d.path), 0);
    results.push({
      name: 'v4 residue',
      status: 'warn',
      detail: `${residue.length + claudeCount} reclaimable item(s) (${residue.length} genie-home, ${claudeCount} claude), ${prettyBytes(totalBytes)}`,
      suggestion: 'Run `genie doctor --fix` to back up and remove (backups: ~/.genie/state-backups/).',
    });
  }
  for (const relic of residue) {
    results.push({ name: `v4 residue: ${relic.relPath}`, status: 'warn', detail: prettyBytes(relic.sizeBytes) });
  }
  if (rulesReclaimable) {
    results.push({
      name: 'v4 residue: ~/.claude rules file',
      status: 'warn',
      detail: prettyBytes(safeSizeOf(claude.rulesFile.path)),
    });
  } else if (rulesKeptUserModified) {
    results.push({
      name: 'v4 residue: ~/.claude rules file',
      status: 'warn',
      detail: 'kept (user-modified) — not counted as reclaimable; --fix will not touch it',
    });
  }
  for (const dir of orphanedCaches) {
    results.push({
      name: `v4 residue: plugin cache ${dir.version}`,
      status: 'warn',
      detail: `orphaned, ${prettyBytes(safeSizeOf(dir.path))}`,
    });
  }
  // Report-only (Decision 2): uncertain names we deliberately never touch.
  for (const name of uncertainKeeps) {
    results.push({
      name: `kept (uncertain): ${name}`,
      status: 'pass',
      detail: 'not provably v4 — never touched by --fix',
    });
  }
  return results;
}

// ============================================================================
// Omni approval hook-timeout guardrail
// ============================================================================

interface HookCommand {
  command?: unknown;
  timeout?: unknown;
}
interface HookMatcher {
  hooks?: unknown;
}
interface CcSettings {
  hooks?: { PreToolUse?: unknown };
}

/**
 * Smallest `timeout` (SECONDS) among PreToolUse hooks that run `genie hook
 * dispatch` in a Claude Code settings object — that is the ceiling the omni
 * approval handler polls under. null when no such hook is installed. Pure +
 * exported so the guardrail is unit-tested without a settings file on disk.
 */
export function findDispatchHookTimeoutSec(settings: CcSettings): number | null {
  const pre = settings.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return null;
  let min: number | null = null;
  for (const entry of pre as HookMatcher[]) {
    if (!Array.isArray(entry?.hooks)) continue;
    for (const h of entry.hooks as HookCommand[]) {
      if (typeof h?.command === 'string' && h.command.includes('hook dispatch') && typeof h.timeout === 'number') {
        min = min === null ? h.timeout : Math.min(min, h.timeout);
      }
    }
  }
  return min;
}

/**
 * Compare the installed hook timeout against the approval poll budget. Returns
 * null when omni approvals are off (no check emitted). A hook timeout below the
 * budget is a WARN: CC kills `genie hook dispatch` before the omni handler can
 * allow/deny OR reach its timeout→ask fail-safe. Pure + exported for testing.
 */
export function evaluateOmniHookTimeout(params: {
  enabled: boolean;
  pollBudgetMs: number;
  timeoutSec: number | null;
}): CheckResult | null {
  if (!params.enabled) return null;
  const name = 'omni hook timeout > pollBudget';
  // pollBudgetMs MUST stay STRICTLY below the hook timeout (genie-config.ts), so
  // the smallest safe whole-second timeout is the first that exceeds pollBudgetMs.
  const needSec = Math.floor(params.pollBudgetMs / 1000) + 1;
  if (params.timeoutSec === null) {
    return {
      name,
      status: 'warn',
      detail: 'omni approvals enabled but no `genie hook dispatch` PreToolUse timeout found',
      suggestion: `Install the genie PreToolUse hook with a timeout ≥ ${needSec}s so approvals can resolve.`,
    };
  }
  const timeoutMs = params.timeoutSec * 1000;
  // At timeoutMs === pollBudgetMs there is no margin — CC can kill the hook the
  // instant the poll budget expires — so the strict contract warns on equal too.
  if (timeoutMs <= params.pollBudgetMs) {
    return {
      name,
      status: 'warn',
      detail: `hook timeout ${params.timeoutSec}s (${timeoutMs}ms) ≤ pollBudget ${params.pollBudgetMs}ms — CC may kill the hook before it can allow/deny or reach its ask fail-safe`,
      suggestion: `Raise the PreToolUse \`genie hook dispatch\` timeout to ≥ ${needSec}s (e.g. 120) in ~/.claude/settings.json.`,
    };
  }
  return {
    name,
    status: 'pass',
    detail: `hook timeout ${params.timeoutSec}s (${timeoutMs}ms) > pollBudget ${params.pollBudgetMs}ms`,
  };
}

async function checkOmniHookTimeout(): Promise<CheckResult[]> {
  const rt = await resolveOmniRuntimeConfig();
  if (!rt.approvals.enabled) return []; // omni off → stay silent
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  let timeoutSec: number | null = null;
  try {
    if (existsSync(settingsPath)) {
      timeoutSec = findDispatchHookTimeoutSec(JSON.parse(readFileSync(settingsPath, 'utf8')) as CcSettings);
    }
  } catch {
    timeoutSec = null; // unreadable/malformed settings → treated as "not found"
  }
  const result = evaluateOmniHookTimeout({ enabled: true, pollBudgetMs: rt.approvals.pollBudgetMs, timeoutSec });
  return result ? [result] : [];
}

// ============================================================================
// agent-sync freshness (READ-ONLY — never writes; converging is `genie update`'s job)
// ============================================================================

// The managed-dir contract mirrored from src/lib/agent-sync.ts. Kept as local
// Protocol identifiers come from the engine (single source of truth) so a
// rename there can never silently desync this read-only surface.
const SYNC_MANIFEST_NAME = MANIFEST_NAME;
const SYNC_MANAGED_BY = MANAGED_BY;
const COUNCIL_WORKFLOW_FILE = TARGET_NAME;
const SYNC_SUGGESTION = 'Run `genie update` to converge all detected coding agents.';

interface AgentSyncPaths {
  genieHome?: string;
  claudeDir?: string;
  codexDir?: string;
  hermesHome?: string;
  settingsPath?: string;
}

interface ManagedSkillsSummary {
  sourceCount: number;
  current: number;
  stale: number;
}

/** Immediate subdirectories of `parent` (following symlinks); [] when unreadable. */
function listSubdirs(parent: string): string[] {
  try {
    return readdirSync(parent).filter((name) => {
      try {
        return statSync(join(parent, name)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Content digest recorded in a dir's `.genie-sync.json`, or null when not genie-managed. */
function readManagedDigest(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, SYNC_MANIFEST_NAME), 'utf8')) as {
      managedBy?: string;
      digest?: unknown;
    };
    if (parsed.managedBy === SYNC_MANAGED_BY && typeof parsed.digest === 'string') return parsed.digest;
  } catch {
    /* absent / unreadable / not ours */
  }
  return null;
}

/** Source skills = dirs under `<pluginRoot>/skills` carrying a SKILL.md → name → digest. */
function sourceSkillDigests(pluginRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const skillsRoot = join(pluginRoot, 'skills');
  for (const name of listSubdirs(skillsRoot)) {
    const dir = join(skillsRoot, name);
    if (existsSync(join(dir, 'SKILL.md'))) out.set(name, computeDirDigest(dir));
  }
  return out;
}

/**
 * Count managed skill dirs under `targetParent` that a `genie update` would leave
 * untouched (current) vs rewrite (stale). "Current" == a next sync reports
 * `unchanged`: manifest present, on-disk content matches its manifest, and the
 * manifest matches the current source digest. Unmanaged dirs are ignored — genie
 * only speaks for what it provably shipped.
 */
function summarizeManagedSkills(pluginRoot: string, targetParent: string): ManagedSkillsSummary {
  const source = sourceSkillDigests(pluginRoot);
  let current = 0;
  let stale = 0;
  for (const name of listSubdirs(targetParent)) {
    const dir = join(targetParent, name);
    const managedDigest = readManagedDigest(dir);
    if (managedDigest === null) continue;
    const sourceDigest = source.get(name);
    if (sourceDigest !== undefined && sourceDigest === managedDigest && computeDirDigest(dir) === managedDigest) {
      current += 1;
    } else {
      stale += 1;
    }
  }
  return { sourceCount: source.size, current, stale };
}

function skillsFreshness(summary: ManagedSkillsSummary): { detail: string; stale: boolean } {
  const missing = summary.current < summary.sourceCount;
  const stale = summary.stale > 0 || missing;
  const staleNote = summary.stale > 0 ? `, ${summary.stale} stale` : '';
  return { detail: `${summary.current}/${summary.sourceCount} source skills current${staleNote}`, stale };
}

/** Whether `<claudeDir>/workflows/council.js` is stamped for the current stable source root. */
function councilStampState(councilPath: string, pluginRoot: string): { stale: boolean; label: string } {
  let content: string;
  try {
    content = readFileSync(councilPath, 'utf8');
  } catch {
    return { stale: true, label: 'absent' };
  }
  const match = content.match(/const LENS_ROOT = '([^']*)'/);
  const root = match ? match[1] : null;
  if (root === pluginRoot) return { stale: false, label: 'current' };
  return { stale: true, label: `stale (LENS_ROOT ${root ?? 'unreadable'})` };
}

function checkClaudeSync(pluginRoot: string, claudeDir: string): CheckResult[] {
  if (!existsSync(claudeDir)) return [{ name: 'agent sync: claude', status: 'pass', detail: 'not detected' }];
  const skills = skillsFreshness(summarizeManagedSkills(pluginRoot, join(claudeDir, 'skills')));
  const council = councilStampState(join(claudeDir, 'workflows', COUNCIL_WORKFLOW_FILE), pluginRoot);
  const stale = skills.stale || council.stale;
  return [
    {
      name: 'agent sync: claude',
      status: stale ? 'warn' : 'pass',
      detail: `${skills.detail}; council.js ${council.label}`,
      suggestion: stale ? SYNC_SUGGESTION : undefined,
    },
  ];
}

function checkCodexSync(pluginRoot: string, codexDir: string): CheckResult[] {
  if (!existsSync(codexDir)) return [{ name: 'agent sync: codex', status: 'pass', detail: 'not detected' }];
  const summary = summarizeManagedSkills(pluginRoot, join(codexDir, 'skills', '.curated'));
  const populated = summary.current + summary.stale > 0;
  const skills = skillsFreshness(summary);
  const stale = skills.stale || !populated;
  return [
    {
      name: 'agent sync: codex',
      status: stale ? 'warn' : 'pass',
      detail: populated ? skills.detail : '.curated not populated',
      suggestion: stale ? SYNC_SUGGESTION : undefined,
    },
  ];
}

function checkHermesSync(hermesRoot: string | null, hermesHome: string): CheckResult[] {
  if (!existsSync(hermesHome)) return [{ name: 'agent sync: hermes', status: 'pass', detail: 'not detected' }];
  if (hermesRoot === null) {
    return [{ name: 'agent sync: hermes', status: 'pass', detail: 'hermes-genie source absent — link check skipped' }];
  }
  const link = hermesLinkState(join(hermesHome, 'plugins', 'genie'), hermesRoot);
  return [
    {
      name: 'agent sync: hermes',
      status: link.ok ? 'pass' : 'warn',
      detail: link.detail,
      suggestion: link.ok ? undefined : SYNC_SUGGESTION,
    },
  ];
}

function hermesLinkState(linkPath: string, hermesRoot: string): { ok: boolean; detail: string } {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(linkPath);
  } catch {
    return { ok: false, detail: 'plugins/genie link absent' };
  }
  if (!stat.isSymbolicLink()) return { ok: false, detail: 'plugins/genie present but not a symlink' };
  try {
    const target = readlinkSync(linkPath);
    if (resolve(dirname(linkPath), target) === resolve(hermesRoot))
      return { ok: true, detail: `linked → ${hermesRoot}` };
    return { ok: false, detail: `points elsewhere (${target})` };
  } catch {
    return { ok: false, detail: 'plugins/genie symlink unreadable' };
  }
}

/**
 * Report the optional `genie@automagik` marketplace plugin — never mutate it.
 * Enabled → silent; disabled/absent → one optional-note line; settings
 * unreadable → an unknown line. `enabledPlugins` maps `<plugin>@<marketplace>`
 * to a boolean in Claude Code's settings.json.
 */
function checkMarketplacePlugin(settingsPath: string): CheckResult[] {
  const name = 'agent sync: marketplace plugin';
  let enabled: boolean | null;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { enabledPlugins?: Record<string, boolean> };
    const value = settings.enabledPlugins?.['genie@automagik'];
    enabled = typeof value === 'boolean' ? value : false;
  } catch {
    enabled = null;
  }
  if (enabled === true) return [];
  if (enabled === null)
    return [{ name, status: 'pass', detail: 'genie@automagik state unknown (settings.json unreadable)' }];
  return [
    {
      name,
      status: 'pass',
      detail:
        'genie@automagik not enabled — optional; `genie update` converges skills directly (never auto-re-enabled)',
    },
  ];
}

function safeAgentChecks(agent: string, fn: () => CheckResult[]): CheckResult[] {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ name: `agent sync: ${agent}`, status: 'warn', detail: `check failed: ${message}` }];
  }
}

/**
 * Per-agent agent-sync freshness. Pure read: reports whether each detected agent
 * (claude/codex/hermes) carries current genie-managed skills, whether Claude's
 * council.js is stamped for the current source root, and whether the Hermes link
 * is correct — advising `genie update` when anything is stale. Exported with
 * injectable paths so tests never touch the real HOME.
 */
export function checkAgentSync(paths: AgentSyncPaths = {}): CheckResult[] {
  const genieHome = paths.genieHome ?? resolveGlobalGenieHome();
  const claudeDir = paths.claudeDir ?? resolveClaudeDir();
  const codexDir = paths.codexDir ?? resolveCodexDir();
  const hermesHome = paths.hermesHome ?? resolveHermesHome();
  const settingsPath = paths.settingsPath ?? join(claudeDir, 'settings.json');
  const source = resolveGenieSource(genieHome);
  if (source.pluginRoot === null) {
    return [
      {
        name: 'agent sync',
        status: 'pass',
        detail: `no genie plugin source at ${join(genieHome, 'plugins', 'genie')} — run \`genie update\` after install`,
      },
    ];
  }
  const pluginRoot = source.pluginRoot;
  return [
    ...safeAgentChecks('claude', () => checkClaudeSync(pluginRoot, claudeDir)),
    ...safeAgentChecks('codex', () => checkCodexSync(pluginRoot, codexDir)),
    ...safeAgentChecks('hermes', () => checkHermesSync(source.hermesRoot, hermesHome)),
    ...safeAgentChecks('marketplace', () => checkMarketplacePlugin(settingsPath)),
  ];
}

// ============================================================================
// Entry point
// ============================================================================

export async function doctorCommand(options?: { json?: boolean; fix?: boolean }): Promise<void> {
  // --fix: run the backup-first v4 cleanup BEFORE the checks so the report
  // below reflects the post-fix state. Without --fix, detection only — the
  // residue check is a pure read and nothing on disk changes. In --json mode
  // stdout belongs to the JSON document, so cleanup chatter goes to stderr.
  if (options?.fix) {
    cleanupV4(options.json ? { logSink: (line) => process.stderr.write(`${line}\n`) } : {});
  }

  const results: CheckResult[] = [
    ...checkGenieBinary(),
    ...checkGit(),
    ...checkDatabase(),
    ...checkSkills(),
    ...checkBun(),
    ...checkSubagentModelOverride(),
    ...(await checkCodexIntegration()),
    ...checkV4Residue(),
    ...checkAgentSync(),
    ...(await checkOmniHookTimeout()),
  ];

  const failed = results.filter((r) => r.status === 'fail');

  if (options?.json) {
    out(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  } else {
    out('genie doctor');
    out('');
    for (const r of results) {
      const suffix = r.detail ? ` — ${r.detail}` : '';
      out(`  ${GLYPH[r.status]} ${r.name}${suffix}`);
      if (r.suggestion) out(`      ↳ ${r.suggestion}`);
    }
    out('');
    out(failed.length === 0 ? '\x1b[32mAll checks passed.\x1b[0m' : `\x1b[31m${failed.length} check(s) failed.\x1b[0m`);
  }

  if (failed.length > 0) process.exitCode = 1;
}
