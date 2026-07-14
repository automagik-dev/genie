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
import {
  constants,
  accessSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  CLAUDE_EXCLUDED_SKILLS,
  MANAGED_BY,
  MANIFEST_NAME,
  TARGET_NAME,
  computeDirDigest,
  resolveAgentsSkillsDir,
  resolveGenieSource,
  resolveHermesConfigPath,
} from '../lib/agent-sync.js';
import { DEAD_GENIE_OTEL_EXPORTER, getCodexConfigPath } from '../lib/codex-config.js';
import {
  type CodexPluginProbe,
  inspectCodexProjectMcp,
  probeCodexGeniePlugin,
  resolveGitProjectRoots,
} from '../lib/codex-project-mcp.js';
import { loadGenieConfig } from '../lib/genie-config.js';
import {
  resolveClaudeDir,
  resolveCodexDir,
  resolveGenieHome as resolveGlobalGenieHome,
  resolveHermesHome,
} from '../lib/genie-home.js';
import { hasDuplicateMcpGenieKeys } from '../lib/hermes-mcp-config.js';
import { hasDuplicateSkillsExternalDirsKeys, resolveProductSkillsRoot } from '../lib/hermes-skills-config.js';
import { resolveOmniRuntimeConfig } from '../lib/omni-config.js';
import {
  CANONICAL_GENIE_SKILL_NAMES,
  inspectCodexAgentOwnership,
  inspectCodexFallbackTier,
} from '../lib/runtime-integrations.js';
import { CURRENT_SCHEMA_VERSION, GenieDbError, openDb } from '../lib/v5/genie-db.js';
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

export const MINIMUM_BUN_VERSION = '1.3.10';

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
    return Bun.which(name);
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

function checkGit(root: string | null): CheckResult[] {
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
  if (root !== null) {
    results.push({ name: 'inside a git repository', status: 'pass', detail: root });
  } else {
    results.push({
      name: 'inside a git repository',
      status: 'warn',
      detail: 'not inside a git repository',
      suggestion: 'Run genie from within a git repo — per-repo state lives under <repo>/.genie/.',
    });
  }
  return results;
}

function checkDatabase(root: string | null): CheckResult[] {
  const dbPath = join(root ?? process.cwd(), '.genie', 'genie.db');
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

function checkSkills(root: string | null): CheckResult[] {
  // skills/ ships alongside the source tree; resolve it relative to the repo
  // root (dev) — an installed plugin bundle exposes the same directory.
  const candidates = [root === null ? null : join(root, 'skills'), join(import.meta.dir, '..', '..', 'skills')].filter(
    (candidate): candidate is string => candidate !== null,
  );
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

interface ParsedSemVer {
  core: [number, number, number];
  prerelease: Array<number | string> | null;
}

function parseSemVer(version: string): ParsedSemVer | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim(),
    );
  if (!match) return null;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]
    ? match[4].split('.').map((part) => {
        if (!/^\d+$/.test(part)) return part;
        if (part.length > 1 && part.startsWith('0')) return Number.NaN;
        return Number(part);
      })
    : null;
  if (prerelease?.some((part) => typeof part === 'number' && !Number.isSafeInteger(part))) return null;
  return { core, prerelease };
}

function compareParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) return (left[index] ?? -1) > (right[index] ?? -1) ? 1 : -1;
  }
  return 0;
}

function comparePrereleaseIdentifier(left: number | string, right: number | string): number {
  if (left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number') return left > right ? 1 : -1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left > right ? 1 : -1;
}

function comparePrerelease(left: Array<number | string> | null, right: Array<number | string> | null): number {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    const comparison = comparePrereleaseIdentifier(a, b);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareSemVer(left: ParsedSemVer, right: ParsedSemVer): number {
  const core = compareParts(left.core, right.core);
  return core === 0 ? comparePrerelease(left.prerelease, right.prerelease) : core;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = parseSemVer(actual);
  const right = parseSemVer(minimum);
  if (!left || !right) return false;
  return compareSemVer(left, right) >= 0;
}

export function evaluateBunVersion(bunVersion: string | null, onPath: string | null): CheckResult[] {
  if (bunVersion) {
    if (!versionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) {
      return [
        {
          name: `bun ${bunVersion}`,
          status: 'fail',
          detail: `unsupported; Genie requires Bun >=${MINIMUM_BUN_VERSION}`,
          suggestion: `Run \`bun upgrade\`, then confirm \`bun --version\` is at least ${MINIMUM_BUN_VERSION}.`,
        },
      ];
    }
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

function checkBun(versionOverride?: string | null, pathOverride?: string | null): CheckResult[] {
  const bunVersion =
    versionOverride === undefined ? (typeof Bun !== 'undefined' ? Bun.version : null) : versionOverride;
  const onPath = pathOverride === undefined ? whichBinary('bun') : pathOverride;
  return evaluateBunVersion(bunVersion, onPath);
}

function codexPluginCheck(state: CodexPluginProbe): CheckResult {
  if (state.status === 'error') {
    return {
      name: 'Codex Genie plugin',
      status: 'fail',
      detail: state.detail,
      suggestion: 'Retry `genie doctor`; project fallback remains authoritative until plugin state is known.',
    };
  }
  if (!state.installed) {
    return {
      name: 'Codex Genie plugin',
      status: 'warn',
      detail: 'not installed',
      suggestion: 'Run `genie setup --codex` to install or repair it.',
    };
  }
  const current = state.version === VERSION;
  const healthy = current && state.enabled === true && state.usable === true;
  return {
    name: 'Codex Genie plugin',
    status: healthy ? 'pass' : 'warn',
    detail: `v${state.version ?? 'unknown'}; ${state.enabled === true ? 'enabled' : 'disabled or unknown'}; ${state.usable === true ? 'MCP launcher usable' : `MCP launcher unusable (${state.usabilityDetail ?? 'unknown reason'})`} (CLI v${VERSION})`,
    suggestion: healthy
      ? undefined
      : 'Run `genie setup --codex` to refresh it; keep the absolute project fallback until launcher health passes.',
  };
}

function codexAgentCheck(): CheckResult {
  const report = inspectCodexAgentOwnership(resolveCodexDir());
  const counts = {
    clean: report.entries.filter((entry) => entry.ownership === 'managed-clean').length,
    modified: report.entries.filter((entry) => entry.ownership === 'managed-modified').length,
    user: report.entries.filter((entry) => entry.ownership === 'user-owned').length,
    absent: report.entries.filter((entry) => entry.ownership === 'absent').length,
  };
  const healthy = report.status === 'valid' && counts.clean === 7 && counts.modified === 0 && counts.absent === 0;
  return {
    name: 'Codex Genie role agents',
    status: healthy ? 'pass' : 'warn',
    detail: `inventory ${report.status}; clean=${counts.clean}/7, modified=${counts.modified}, user-owned=${counts.user}, absent=${counts.absent}${report.error ? ` (${report.error})` : ''}`,
    suggestion: healthy
      ? undefined
      : 'Review modified/user-owned collisions, then run `genie setup --codex`; Genie will not overwrite them.',
  };
}

function codexProjectRouteCheck(root: string | null, probe: CodexPluginProbe): CheckResult {
  if (root === null) {
    return {
      name: 'Codex Genie MCP registration',
      status: 'warn',
      detail: 'not inside a Git worktree; project route not inspected',
      suggestion: 'Run `genie doctor` from the repository you want Codex to use.',
    };
  }
  try {
    const route = inspectCodexProjectMcp(root, probe);
    return {
      name: 'Codex Genie MCP registration',
      status: route.ok ? 'pass' : 'fail',
      detail: `${route.route}: ${route.detail ?? 'no detail'}`,
      suggestion: route.ok ? undefined : 'Run `genie init` in this worktree to reconcile the project fallback.',
    };
  } catch (error) {
    return {
      name: 'Codex Genie MCP registration',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      suggestion: 'Repair the incomplete marker block, then run `genie init`.',
    };
  }
}

/**
 * Payload completeness (R5): how many of the exact canonical Genie skills the
 * active plugin root physically ships. Pure read of `<activePluginRoot>/skills`
 * — never launches the MCP (A9). A short payload is repairable, not health.
 */
function codexPluginPayloadCheck(probe: CodexPluginProbe): CheckResult | null {
  if (!probe.installed || probe.activePluginRoot === undefined) return null;
  const skillsRoot = join(probe.activePluginRoot, 'skills');
  const present = CANONICAL_GENIE_SKILL_NAMES.filter((name) => {
    try {
      return statSync(join(skillsRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  const complete = present.length === CANONICAL_GENIE_SKILL_NAMES.length;
  const missing = CANONICAL_GENIE_SKILL_NAMES.filter((name) => !present.includes(name));
  return {
    name: 'Codex Genie plugin payload',
    status: complete ? 'pass' : 'warn',
    detail: `${present.length}/${CANONICAL_GENIE_SKILL_NAMES.length} canonical skills present in active plugin${complete ? '' : ` (missing: ${missing.join(', ')})`}`,
    suggestion: complete ? undefined : 'Run `genie setup --codex` to reinstall the active plugin payload.',
  };
}

function codexPluginSurfaceChecks(probe: CodexPluginProbe): CheckResult[] {
  if (!probe.installed) return [];
  const manifest = probe.activePluginRoot ? join(probe.activePluginRoot, '.codex-plugin', 'plugin.json') : null;
  let declared = false;
  if (manifest !== null && existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
      declared =
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).mcpServers === './.mcp.json';
    } catch {
      declared = false;
    }
  }
  const payload = codexPluginPayloadCheck(probe);
  return [
    ...(payload ? [payload] : []),
    {
      name: 'Codex Genie MCP capability',
      status: declared ? 'pass' : 'warn',
      detail: declared
        ? `stdio server declared by active plugin at ${probe.activePluginRoot}`
        : manifest === null
          ? 'active installed plugin root is unproven; source-bundle declarations do not establish runtime health'
          : `active plugin manifest is missing, corrupt, or does not declare ./.mcp.json: ${manifest}`,
      suggestion: declared ? undefined : 'Run `genie setup --codex` to refresh the active plugin cache.',
    },
    {
      name: 'Codex hook review',
      status: 'warn',
      detail: 'trust is a user decision and cannot be inferred safely',
      suggestion: 'Open /hooks, review Genie commands, then start a new Codex task.',
    },
  ];
}

export async function checkCodexIntegration(
  root: string | null,
  probe: CodexPluginProbe = probeCodexGeniePlugin(),
): Promise<CheckResult[]> {
  if (!probe.cliAvailable)
    return [{ name: 'Codex CLI', status: 'warn', detail: 'not installed (Claude-only mode available)' }];
  const codex = whichBinary('codex');
  const results: CheckResult[] = [{ name: 'Codex CLI', status: 'pass', detail: codex ?? 'detected by bounded probe' }];
  results.push(codexPluginCheck(probe), codexAgentCheck());
  const configPath = getCodexConfigPath();
  const obsolete = existsSync(configPath) && readFileSync(configPath, 'utf8').includes(DEAD_GENIE_OTEL_EXPORTER);
  results.push({
    name: 'obsolete Genie OTel exporter',
    status: obsolete ? 'warn' : 'pass',
    detail: obsolete ? 'present' : 'absent',
    suggestion: obsolete ? 'Run `genie setup --codex` for backup-first removal.' : undefined,
  });
  results.push(codexProjectRouteCheck(root, probe), ...codexPluginSurfaceChecks(probe));
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
const HERMES_INLINE_SUGGESTION =
  'Rewrite the inline top-level key as a block mapping so genie can merge without deleting your entries, then run `genie update`.';

interface AgentSyncPaths {
  genieHome?: string;
  claudeDir?: string;
  codexDir?: string;
  /** Shared `~/.agents/skills` tier codex skills are synced into (detection root stays `codexDir`). */
  agentsSkillsDir?: string;
  hermesHome?: string;
  /**
   * Hermes CLI detection override for the best-effort enable probe. `undefined`
   * probes PATH; `null` explicitly skips the probe (hermes CLI absent → silent).
   */
  hermesBinary?: string | null;
  /** Injectable `hermes plugins list` reader so tests never spawn a process. */
  hermesPluginsList?: (binary: string) => string;
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
 *
 * `excluded` names are dropped from the EXPECTED source set so an agent that
 * legitimately never receives a skill (e.g. Claude excludes `council`, whose name
 * the native /council workflow owns) is not reported as one skill short of source.
 */
function summarizeManagedSkills(
  pluginRoot: string,
  targetParent: string,
  excluded?: Set<string>,
): ManagedSkillsSummary {
  const source = sourceSkillDigests(pluginRoot);
  if (excluded) for (const name of excluded) source.delete(name);
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
  // Claude legitimately excludes `council` (the /council native workflow owns
  // that name), so its expected source set is source minus CLAUDE_EXCLUDED_SKILLS
  // — otherwise doctor reports "N-1/N current" and advises `genie update` forever.
  const skills = skillsFreshness(summarizeManagedSkills(pluginRoot, join(claudeDir, 'skills'), CLAUDE_EXCLUDED_SKILLS));
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

/**
 * Codex Genie skills are plugin-only (R5). The shared `~/.agents/skills` tier
 * must therefore hold NO Genie-managed product fallbacks: an empty tier is the
 * healthy plugin-only state, and any managed-clean fallback there is repairable
 * duplicate provider state, not health. Doctor reports the shared classifier's
 * counts (A9: pure read, never launches the plugin MCP) with DISTINCT
 * remediations — a clean fallback is repairable via `genie update`, a
 * well-formed-but-unrecognized fallback is manual review (never `genie update`
 * — the planner refuses it too, so recommending update would be an infinite
 * no-op loop), and a preserved personal collision is manual — and surfaces
 * retained changed-evidence as a manual-recovery line (R8) rather than a raw
 * recovery-sweep error.
 */
function checkCodexSync(codexDir: string, agentsSkillsDir: string, pluginRoot: string | null): CheckResult[] {
  if (!existsSync(codexDir)) return [{ name: 'agent sync: codex', status: 'pass', detail: 'not detected' }];
  const tier = inspectCodexFallbackTier(agentsSkillsDir, pluginRoot);
  if (tier.unreadable) {
    return [
      {
        name: 'agent sync: codex',
        status: 'warn',
        detail: `~/.agents/skills (${agentsSkillsDir}) exists but could not be listed — fallback state is unknown`,
        suggestion:
          'Check read permissions on ~/.agents/skills; genie cannot classify Codex fallback state until it is readable.',
      },
    ];
  }
  const quarantineNote =
    tier.quarantinedTransactions > 0
      ? `; ${tier.quarantinedTransactions} retired quarantine transaction(s) retained`
      : '';
  const results: CheckResult[] = [];
  if (tier.cleanFallbacks.length === 0) {
    results.push({
      name: 'agent sync: codex',
      status: 'pass',
      detail: `plugin-only — no managed ~/.agents/skills fallbacks${quarantineNote}`,
    });
  } else {
    results.push({
      name: 'agent sync: codex',
      status: 'warn',
      detail: `${tier.cleanFallbacks.length} clean managed fallback(s) in ~/.agents/skills — repairable duplicate provider state (${tier.cleanFallbacks.join(', ')})${quarantineNote}`,
      suggestion: 'Run `genie update` to retire these clean fallbacks; the installed plugin already provides them.',
    });
  }
  if (tier.unrecognizedFallbacks.length > 0) {
    // #2575 vocabulary: well-formed identityVersion:2, self-consistent,
    // genie-managed content the planner does not recognize (not in the frozen
    // allowlist and no matching live-plugin payload). Era-A fallbacks (v1
    // legacy digest, no identityVersion) do NOT land here — their marker fails
    // the v2 self-consistency check, so they surface as preservedCollisions.
    // Never user-edited, so NOT a personal collision — but `genie update`
    // refuses to retire it, so recommending that here would be a no-op loop.
    results.push({
      name: 'agent sync: codex unrecognized',
      status: 'warn',
      detail: `${tier.unrecognizedFallbacks.length} unrecognized managed fallback(s) in ~/.agents/skills (review manually): ${tier.unrecognizedFallbacks.join(', ')}`,
      suggestion:
        '`genie update` will NOT retire these — the content is well-formed genie provenance but not in the frozen allowlist and does not match the installed plugin payload. Review each manually; do not expect `genie update` to clear this warning.',
    });
  }
  if (tier.preservedCollisions.length > 0) {
    // Decision 5: report each collision's name + classification + effective precedence + remediation.
    const classified = tier.preservedCollisions
      .map((name) => `${name} (${tier.preservedCollisionClass[name] ?? 'preserved'})`)
      .join(', ');
    results.push({
      name: 'agent sync: codex collisions',
      status: 'warn',
      detail: `${tier.preservedCollisions.length} preserved personal skill(s) collide with plugin names: ${classified}`,
      suggestion:
        'Effective precedence: the installed plugin owns the owner-qualified `genie:<name>` selector; each preserved copy owns bare `<name>`. Personal edits are preserved in place; `genie update` never touches them. Review each and remove or rename it manually.',
    });
  }
  if (tier.retainedEvidence.length > 0) {
    const evidenceList = tier.retainedEvidence
      .map((entry) => `${entry.transactionId} (${entry.evidencePath})`)
      .join(', ');
    results.push({
      name: 'agent sync: codex quarantine evidence',
      status: 'warn',
      detail: `${tier.retainedEvidence.length} retirement transaction(s) retained changed-tree evidence: ${evidenceList}`,
      suggestion:
        'A Codex fallback changed during retirement; the changed copy was archived aside under the quarantine evidence directory. Review the retained evidence and reconcile it manually.',
    });
  }
  return results;
}

interface HermesCheckInput {
  hermesRoot: string | null;
  hermesHome: string;
  genieHome: string;
  pluginRoot: string;
  binary: string | null;
  pluginsList?: (binary: string) => string;
}

/**
 * Independent per-leg Hermes health: the plugin symlink, the `mcp_servers.genie`
 * entry, the skills external-dir (or managed-copy fallback), and a best-effort
 * `hermes plugins list` enable probe. Each leg is a separate {@link CheckResult}
 * so `genie doctor` distinguishes which leg is unhealthy. An inline/flow-style
 * top-level `mcp_servers:`/`skills:` — the shape the merge helpers refuse — is a
 * WARN (never a FAIL) carrying the block-mapping remediation hint.
 */
function checkHermesSync(input: HermesCheckInput): CheckResult[] {
  const { hermesRoot, hermesHome } = input;
  if (!existsSync(hermesHome)) return [{ name: 'agent sync: hermes', status: 'pass', detail: 'not detected' }];
  if (hermesRoot === null) {
    return [{ name: 'agent sync: hermes', status: 'pass', detail: 'hermes-genie source absent — link check skipped' }];
  }
  const link = hermesLinkState(join(hermesHome, 'plugins', 'genie'), hermesRoot);
  const results: CheckResult[] = [
    {
      name: 'agent sync: hermes',
      status: link.ok ? 'pass' : 'warn',
      detail: link.detail,
      suggestion: link.ok ? undefined : SYNC_SUGGESTION,
    },
  ];
  // Config-driven legs read the live profile's config.yaml (sticky-profile-aware),
  // exactly where the agent-sync lane writes it.
  const configPath = resolveHermesConfigPath(hermesHome);
  const configText = readTextOrNull(configPath);
  results.push(checkHermesMcp(configText, configPath));
  results.push(checkHermesSkills(configText, input.genieHome, input.pluginRoot, configPath));
  const enabled = checkHermesPluginEnabled(input.binary, input.pluginsList);
  if (enabled !== null) results.push(enabled);
  return results;
}

/** `mcp_servers.genie.command` must be an absolute path to an existing, executable file. */
function checkHermesMcp(configText: string | null, configPath: string): CheckResult {
  const name = 'agent sync: hermes mcp';
  if (configText === null) {
    return { name, status: 'warn', detail: `config.yaml absent (${configPath})`, suggestion: SYNC_SUGGESTION };
  }
  const inline = detectInlineTopLevelKey(configText, 'mcp_servers');
  if (inline) return { name, status: 'warn', detail: inline, suggestion: HERMES_INLINE_SUGGESTION };
  if (hasDuplicateMcpGenieKeys(configText)) {
    return {
      name,
      status: 'warn',
      detail: `duplicate "mcp_servers.genie" key detected in ${configPath} — a stale duplicate can persist even when the parsed value looks correct`,
      suggestion: SYNC_SUGGESTION,
    };
  }
  const command = readMcpGenieCommand(configText);
  if (command === null) {
    return { name, status: 'warn', detail: 'mcp_servers.genie absent', suggestion: SYNC_SUGGESTION };
  }
  if (!isAbsolute(command)) {
    return {
      name,
      status: 'warn',
      detail: `mcp_servers.genie.command not absolute (${command})`,
      suggestion: SYNC_SUGGESTION,
    };
  }
  if (!isExecutableFile(command)) {
    return {
      name,
      status: 'warn',
      detail: `mcp_servers.genie.command missing or not executable (${command})`,
      suggestion: SYNC_SUGGESTION,
    };
  }
  return { name, status: 'pass', detail: `mcp_servers.genie → ${command}` };
}

/**
 * Skills leg passes when `skills.external_dirs` contains the resolved product
 * skills root, OR the older-Hermes managed copy under `<configHome>/skills` holds
 * at least as many skills as the product source.
 */
function checkHermesSkills(
  configText: string | null,
  genieHome: string,
  pluginRoot: string,
  configPath: string,
): CheckResult {
  const name = 'agent sync: hermes skills';
  if (configText !== null) {
    const inline = detectInlineTopLevelKey(configText, 'skills');
    if (inline) return { name, status: 'warn', detail: inline, suggestion: HERMES_INLINE_SUGGESTION };
    if (hasDuplicateSkillsExternalDirsKeys(configText)) {
      return {
        name,
        status: 'warn',
        detail: `duplicate "skills.external_dirs" key detected in ${configPath} — a stale duplicate can persist even when the parsed value looks correct`,
        suggestion: SYNC_SUGGESTION,
      };
    }
  }
  const skillsRoot = safeResolveProductSkillsRoot(genieHome);
  const externalDirs = configText === null ? [] : readSkillsExternalDirs(configText);
  if (skillsRoot !== null && externalDirs.includes(skillsRoot)) {
    return { name, status: 'pass', detail: `external_dirs → ${skillsRoot}` };
  }
  const productCount = countSkillDirs(join(pluginRoot, 'skills'));
  const copyDir = join(dirname(configPath), 'skills');
  const copyCount = countSkillDirs(copyDir);
  if (productCount > 0 && copyCount >= productCount) {
    return { name, status: 'pass', detail: `managed copy ${copyCount}/${productCount} skills (${copyDir})` };
  }
  const detail =
    skillsRoot === null
      ? `product skills root unresolved; managed copy ${copyCount}/${productCount}`
      : `external_dirs missing ${skillsRoot}; managed copy ${copyCount}/${productCount}`;
  return { name, status: 'warn', detail, suggestion: SYNC_SUGGESTION };
}

/**
 * Best-effort enable probe. Silent (null) when the hermes CLI is absent; otherwise
 * a WARN when `hermes plugins list` shows genie disabled, and a benign pass when
 * the probe is inconclusive or the CLI call fails — never a hard failure.
 */
function checkHermesPluginEnabled(binary: string | null, pluginsList?: (binary: string) => string): CheckResult | null {
  if (binary === null) return null;
  const name = 'agent sync: hermes plugin enabled';
  let output: string;
  try {
    output = (pluginsList ?? defaultHermesPluginsList)(binary);
  } catch {
    return { name, status: 'pass', detail: 'enable state unknown (hermes plugins list unavailable)' };
  }
  const enabled = hermesPluginsListShowsGenieEnabled(output);
  if (enabled === true) return { name, status: 'pass', detail: 'genie enabled' };
  if (enabled === false) {
    return { name, status: 'warn', detail: 'genie present but not enabled', suggestion: SYNC_SUGGESTION };
  }
  return { name, status: 'pass', detail: 'genie enable state unknown (not listed)' };
}

function defaultHermesPluginsList(binary: string): string {
  return execFileSync(binary, ['plugins', 'list'], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Fuzzy, best-effort read of an `enabled`/`disabled` marker on a genie line. */
function hermesPluginsListShowsGenieEnabled(output: string): boolean | null {
  for (const line of output.split('\n')) {
    if (!/genie/i.test(line)) continue;
    if (/disabled/i.test(line)) return false;
    if (/enabled/i.test(line)) return true;
  }
  return null;
}

/**
 * Mirror of the merge helpers' `assertNoInlineTopLevelKey`: returns the WARN hint
 * when a top-level `key:` carries an inline/flow/scalar value on the same line,
 * else null. Read-only — doctor never rewrites config.
 */
function detectInlineTopLevelKey(text: string, key: string): string | null {
  const keyLine = new RegExp(`^${key}:(?:\\s|$)`);
  const blockHeader = new RegExp(`^${key}:\\s*(#.*)?$`);
  for (const line of text.split('\n')) {
    if (keyLine.test(line) && !blockHeader.test(line)) {
      return `top-level "${key}" has an inline value (${line.trim()}); genie cannot merge it`;
    }
  }
  return null;
}

function readMcpGenieCommand(text: string): string | null {
  const genie = readYamlPath(text, ['mcp_servers', 'genie']);
  if (!isPlainObject(genie)) return null;
  return typeof genie.command === 'string' ? genie.command : null;
}

function readSkillsExternalDirs(text: string): string[] {
  const skills = readYamlPath(text, ['skills']);
  if (!isPlainObject(skills) || !Array.isArray(skills.external_dirs)) return [];
  return skills.external_dirs.filter((d): d is string => typeof d === 'string');
}

/** Walk a dotted path through a parsed YAML document; undefined on any miss/parse error. */
function readYamlPath(text: string, path: string[]): unknown {
  let node: unknown;
  try {
    node = Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  for (const key of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

function safeResolveProductSkillsRoot(genieHome: string): string | null {
  try {
    return resolveProductSkillsRoot({ genieHome });
  } catch {
    return null;
  }
}

function countSkillDirs(dir: string): number {
  return listSubdirs(dir).filter((name) => existsSync(join(dir, name, 'SKILL.md'))).length;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
        'genie@automagik not enabled — optional; the installed plugin provides Genie skills (never auto-re-enabled)',
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
  const agentsSkillsDir = paths.agentsSkillsDir ?? resolveAgentsSkillsDir();
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
  const hermesBinary = paths.hermesBinary !== undefined ? paths.hermesBinary : whichBinary('hermes');
  return [
    ...safeAgentChecks('claude', () => checkClaudeSync(pluginRoot, claudeDir)),
    ...safeAgentChecks('codex', () => checkCodexSync(codexDir, agentsSkillsDir, pluginRoot)),
    ...safeAgentChecks('hermes', () =>
      checkHermesSync({
        hermesRoot: source.hermesRoot,
        hermesHome,
        genieHome,
        pluginRoot,
        binary: hermesBinary,
        pluginsList: paths.hermesPluginsList,
      }),
    ),
    ...safeAgentChecks('marketplace', () => checkMarketplacePlugin(settingsPath)),
  ];
}

// ============================================================================
// Entry point
// ============================================================================

export interface DoctorDeps {
  /** Pre-resolved worktree root; explicit null means outside Git. */
  root?: string | null;
  /** Main checkout root that owns the shared genie.db. */
  databaseRoot?: string | null;
  /** Injected one-shot plugin state keeps tests away from the live Codex home. */
  pluginProbe?: CodexPluginProbe;
  /** Runtime-version seam so tests can cover the declared Bun engine boundary. */
  bunVersion?: string | null;
  /** PATH seam paired with bunVersion. */
  bunPath?: string | null;
}

export async function doctorCommand(options?: { json?: boolean; fix?: boolean }, deps: DoctorDeps = {}): Promise<void> {
  // --fix: run the backup-first v4 cleanup BEFORE the checks so the report
  // below reflects the post-fix state. Without --fix, detection only — the
  // residue check is a pure read and nothing on disk changes. In --json mode
  // stdout belongs to the JSON document, so cleanup chatter goes to stderr.
  if (options?.fix) {
    cleanupV4(options.json ? { logSink: (line) => process.stderr.write(`${line}\n`) } : {});
  }

  // One bounded Git resolution and one bounded Codex plugin query feed every
  // downstream check. No doctor branch independently re-spawns either probe.
  const injectedRoot = deps.root === null || typeof deps.root === 'string';
  const gitRoots = injectedRoot ? null : resolveGitProjectRoots();
  const root = injectedRoot ? (deps.root ?? null) : (gitRoots?.worktreeRoot ?? null);
  const databaseRoot =
    deps.databaseRoot === null || typeof deps.databaseRoot === 'string'
      ? deps.databaseRoot
      : (gitRoots?.commonRoot ?? root);
  const pluginProbe = deps.pluginProbe?.cliAvailable !== undefined ? deps.pluginProbe : probeCodexGeniePlugin();
  const results: CheckResult[] = [
    ...checkGenieBinary(),
    ...checkGit(root),
    ...checkDatabase(databaseRoot),
    ...checkSkills(root),
    ...checkBun(deps.bunVersion, deps.bunPath),
    ...checkSubagentModelOverride(),
    ...(await checkCodexIntegration(root, pluginProbe)),
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
