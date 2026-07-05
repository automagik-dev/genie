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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOmniRuntimeConfig } from '../lib/omni-config.js';
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
    ...checkV4Residue(),
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
