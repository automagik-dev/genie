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

import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DEAD_GENIE_OTEL_EXPORTER, getCodexConfigPath } from '../lib/codex-config.js';
import {
  type CodexPluginProbe,
  type RouteLayerFinding,
  classifyRouteLayers,
  inspectCodexProjectMcp,
  inspectRetiredJsonMcpEntry,
  probeCodexGeniePlugin,
  resolveGitProjectRoots,
} from '../lib/codex-project-mcp.js';
import { loadGenieConfig, resolveConfigKey } from '../lib/genie-config.js';
import { resolveClaudeDir, resolveGenieHome as resolveGlobalGenieHome } from '../lib/genie-home.js';
import { classifyLegacyIntegrations } from '../lib/legacy-integration-retirement.js';
import { type OrcaPluginCompatibilityResult, inspectOrcaPluginLifecycle } from '../lib/orca-plugin-lifecycle.js';
import { MACHINE_LOCAL_GENIE_PATHS } from '../term-commands/init.js';

import { findLegacySkillLeftovers, legacyScanHomes } from '../lib/legacy-skills.js';
import {
  type AgentSkillHomeSpec,
  KNOWN_AGENT_SKILL_HOMES,
  type SkillsInstallRecord,
  type SkillsWorkflowsInstall,
  inspectSkillsInstallRecord,
  inventoryFromSkillsDir,
  isSafeSkillName,
  isSafeWorkflowFileName,
  releaseTag,
} from '../lib/skills-installer.js';
import { writeErr, writeOut } from '../lib/term-output.js';
import {
  CURRENT_SCHEMA_VERSION,
  GenieDbError,
  type ProjectContext,
  openDb,
  resolveProjectContext,
} from '../lib/v5/genie-db.js';
import { VERSION } from '../lib/version.js';
import {
  classifyWorkflowFile,
  inspectOnDiskWorkflow,
  shippedWorkflowNames,
  shippedWorkflowsRoot,
} from '../lib/workflows-installer.js';
import { type ModeDriftReportEntry, checkWorktreeModes, modeDriftLines, repairWorktreeModes } from './doctor-modes.js';
import { checkLaunchWorktrees, cleanupLaunchWorktrees } from './doctor-worktrees.js';
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

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  suggestion?: string;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].indexLane`).
   * Only the `jar: index-lane drift` check sets it; see {@link IndexLaneEntry}
   * for the stable per-entry state contract.
   */
  indexLane?: { entries: IndexLaneEntry[] };
  /**
   * Machine-readable payload rider (survives `--json` as
   * `checks[].modeDrift.entries`). Only the aggregated `mode drift` check sets
   * it: EVERY classified entry, uncapped, because the human report names at
   * most `MAX_NAMED_MODE_DRIFT_ENTRIES` of them. Each entry carries its own
   * `suggestion` where one exists, so the remedy survives the cap.
   */
  modeDrift?: { entries: ModeDriftReportEntry[] };
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].routeLayers`).
   * Only the `Codex Genie MCP registration` check sets it: the typed config-layer
   * findings (collision, shadowing, global same-key, trust states) from the
   * Group E route-layer classifier.
   */
  routeLayers?: RouteLayerFinding[];
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].advisory`).
   * Only the `Codex CLI` check sets it: the sanitized bounded advisory stderr
   * (e.g. the real sandbox PATH advisory) from the single host observation.
   * Diagnostic metadata only — never a policy decision (Decision 11).
   */
  advisory?: string;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].skillsChannel`).
   * Only the per-agent `skills: <agent>` lines set it; the record-less
   * `skills: channel` line carries no agent and therefore no rider.
   */
  skillsChannel?: SkillsChannelStatus;
  /**
   * Machine-readable payload rider (survives `--json` as `checks[].legacyIntegrations`).
   * Only the `legacy integrations` check sets it: the marker-owned assets still
   * awaiting retirement. Doctor only OBSERVES them — retirement is `genie update`'s.
   */
  legacyIntegrations?: {
    pending: Array<{ surface: string; path: string }>;
    /**
     * A classifier actually ran. `false` means the check could not observe
     * anything, so an empty `pending` is ignorance, not proof of retirement.
     */
    available: boolean;
  };
}

// ============================================================================
// Output helpers (process.stdout/stderr — no console.* in v5 source)
// ============================================================================

function out(line = ''): void {
  writeOut(`${line}\n`);
}

const GLYPH: Record<CheckStatus, string> = {
  pass: '\x1b[32m✔\x1b[0m',
  warn: '\x1b[33m!\x1b[0m',
  fail: '\x1b[31m✖\x1b[0m',
};

/** How many `unlinked` INDEX entries `renderCheckLines` names before summarizing the rest. */
const MAX_UNLINKED_LINES = 5;

/**
 * The human lines for one check: its status line, its suggestion, and — for
 * `jar: index-lane drift` — the INDEX entries an operator must open by name,
 * since a `broken`/`unlinked` count alone cannot be acted on. Every `broken`
 * entry is named; `unlinked` is the benign majority (a fresh clone has no
 * roadmap cards at all), so it is capped and the remainder counted. `mode
 * drift` names its own capped entries the same way, from its own rider.
 */
function renderCheckLines(r: CheckResult): string[] {
  const suffix = r.detail ? ` — ${r.detail}` : '';
  const lines = [`  ${GLYPH[r.status]} ${r.name}${suffix}`];
  if (r.suggestion) lines.push(`      ↳ ${r.suggestion}`);
  let unlinked = 0;
  for (const e of r.indexLane?.entries ?? []) {
    if (e.state === 'broken') lines.push(`      · broken: ${e.entry}`);
    else if (e.state === 'unlinked' && unlinked++ < MAX_UNLINKED_LINES) lines.push(`      · unlinked: ${e.entry}`);
  }
  if (unlinked > MAX_UNLINKED_LINES) lines.push(`      · …and ${unlinked - MAX_UNLINKED_LINES} more unlinked`);
  lines.push(...modeDriftLines(r.modeDrift?.entries ?? []));
  return lines;
}

function whichBinary(name: string): string | null {
  if (typeof Bun !== 'undefined') {
    try {
      return Bun.which(name);
    } catch {
      return null;
    }
  }
  // Node fallback — the same policy the retired per-agent binary detectors used.
  try {
    const found = execFileSync('which', [name], { encoding: 'utf8' }).trim();
    return found === '' ? null : found;
  } catch {
    return null;
  }
}

// ============================================================================
// Individual checks
// ============================================================================

function checkGenieBinary(): CheckResult[] {
  // The NAME is version-free on purpose: a cross-release diff of the sorted
  // check names must show only additions and removals, never a false pair from
  // the running version moving. The version rides in the detail (m16).
  const results: CheckResult[] = [{ name: 'genie version', status: 'pass', detail: VERSION }];
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
  const lifecycle = inspectOrcaPluginLifecycle();
  if (lifecycle.mode === 'orca') {
    return [{ name: 'genie.db', status: 'pass', detail: 'not opened — Orca is the selected lifecycle authority' }];
  }
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

/**
 * Tables that belong ONLY to a per-repo `.genie/genie.db`. v6 writes NOTHING to
 * the machine-scope `<GENIE_HOME>/genie.db` — the Omni runner owned every table
 * that file ever held and left with it — so any per-repo table found there is
 * proof that some binary once opened the global path with the per-repo opener
 * (M7). Prevention landed (the per-repo opener refuses the global path), but a
 * host contaminated before that fix stays contaminated forever, and both
 * databases still report `user_version = 1` — so a future numbered migration
 * cannot tell them apart.
 */
const PER_REPO_ONLY_TABLES = [
  'boards',
  'tasks',
  'task_dependencies',
  'task_events',
  'stage_log',
  'wish_groups',
  'hire_roster',
] as const;

/** The check name, exported so the remedy and the test never drift apart. */
export const GLOBAL_DB_CONTAMINATION_CHECK = 'global db';

/**
 * The repair route that exists on a STOCK host: the genie binary itself, which
 * embeds its own SQLite (bun:sqlite) and is on PATH by construction of the
 * installer. Named explicitly and separately from `--fix`, which stays a
 * never-repairing cleanup of v4 residue and launch worktrees.
 */
export const GLOBAL_DB_REPAIR_COMMAND = 'genie doctor --fix-global-db';

/**
 * The `bun -e` spelling of the same repair, named as an ALTERNATIVE only. The
 * supported installer declares its prerequisites as `curl tar uname ln` and the
 * shipped artifact is a `bun --compile` static executable, so `bun` is NOT on a
 * stock host's PATH (dogfood r6 Z10) — this is the spelling for a developer
 * checkout, not for an installed host.
 */
export function globalDbContaminationBunAlternative(dbPath: string, tables: readonly string[]): string {
  const drop =
    'import{Database}from"bun:sqlite";' +
    'const d=new Database(process.argv[1]);' +
    'for(const t of process.argv.slice(2))d.run("DROP TABLE IF EXISTS "+t);' +
    'd.close()';
  return `cp ${dbPath} ${dbPath}.backup-$(date -u +%Y%m%dT%H%M%SZ) && bun -e '${drop}' ${dbPath} ${tables.join(' ')}`;
}

/**
 * The sqlite3 spelling of the same repair, named as an ALTERNATIVE only.
 * sqlite3 is not part of a genie install and was absent on the dogfood host, so
 * pasting it made the backup copy and then died at `sqlite3: command not found`,
 * leaving a stray `.backup-*` file and the contamination unrepaired (r5 Z10).
 */
export function globalDbContaminationSqliteAlternative(dbPath: string, tables: readonly string[]): string {
  const drops = tables.map((name) => `DROP TABLE IF EXISTS ${name};`).join(' ');
  return `sqlite3 ${dbPath} "${drops}"`;
}

/**
 * The remedy doctor hands the operator. It is a genie subcommand, never a third
 * party binary: both earlier spellings depended on a tool a stock install does
 * not ship (`sqlite3`, then `bun`), so pasting them died at `command not found`
 * and left a stray backup behind.
 */
export function globalDbContaminationRemedy(): string {
  return GLOBAL_DB_REPAIR_COMMAND;
}

/** `date -u +%Y%m%dT%H%M%SZ`, so a hand-run backup and this one sort together. */
function compactUtcStamp(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** What {@link repairGlobalDbContamination} did, for both renderers and tests. */
export interface GlobalDbRepairResult {
  status: 'repaired' | 'clean' | 'absent' | 'failed';
  dbPath: string;
  dropped: string[];
  backupPath: string | null;
  message: string;
}

/**
 * The ONE destructive act doctor performs, and only under its own explicit flag.
 * Backup-first and WAL-safe: the write-ahead log is folded back into the main
 * file before the byte copy, so the backup is complete even when another process
 * has been writing to the same database. Only {@link PER_REPO_ONLY_TABLES} that
 * are actually present are dropped; every other table in the file is left
 * byte-for-byte alone — v6 puts none there itself, but the operator's own rows
 * are not doctor's to delete. Idempotent — a repaired database reports `clean`
 * on the next run.
 */
export function repairGlobalDbContamination(options: { genieHome?: string } = {}): GlobalDbRepairResult {
  const dbPath = join(options.genieHome ?? resolveGlobalGenieHome(), 'genie.db');
  if (!existsSync(dbPath)) {
    return {
      status: 'absent',
      dbPath,
      dropped: [],
      backupPath: null,
      message: `${dbPath}: no global database — nothing to repair.`,
    };
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    ).map((row) => row.name);
    const strays = PER_REPO_ONLY_TABLES.filter((name) => names.includes(name));
    if (strays.length === 0) {
      db.close();
      db = null;
      return {
        status: 'clean',
        dbPath,
        dropped: [],
        backupPath: null,
        message: `${dbPath}: already clean (no per-repo tables) — nothing to repair.`,
      };
    }
    db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    db = null;
    const backupPath = `${dbPath}.backup-${compactUtcStamp()}`;
    copyFileSync(dbPath, backupPath);
    db = new Database(dbPath);
    for (const table of strays) db.run(`DROP TABLE IF EXISTS ${table}`);
    db.close();
    db = null;
    return {
      status: 'repaired',
      dbPath,
      dropped: [...strays],
      backupPath,
      message: `${dbPath}: backed up to ${backupPath}, dropped per-repo table(s): ${strays.join(', ')}.`,
    };
  } catch (error) {
    return {
      status: 'failed',
      dbPath,
      dropped: [],
      backupPath: null,
      message: `${dbPath} could not be repaired: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}

/**
 * Read-only detection of a contaminated global database. A doctor RUN never
 * repairs this, not even under `--fix`: dropping a table is a destructive act on
 * a file that also holds the operator's approval history, so the check names the
 * remedy and the human decides. The repair lives behind its own explicit verb,
 * {@link GLOBAL_DB_REPAIR_COMMAND}, so that consent is a separate keystroke.
 */
export function evaluateGlobalDbTables(dbPath: string, tables: readonly string[]): CheckResult {
  const strays = PER_REPO_ONLY_TABLES.filter((name) => tables.includes(name));
  if (strays.length === 0) {
    return { name: GLOBAL_DB_CONTAMINATION_CHECK, status: 'pass', detail: `${dbPath} (no per-repo tables)` };
  }
  const remedy = globalDbContaminationRemedy();
  const detail =
    `${dbPath}: per-repo tables present (${strays.join(', ')}); repair it with \`${remedy}\`` +
    ` (backs the file up first, drops only those tables). In a bun checkout: ${globalDbContaminationBunAlternative(dbPath, strays)}` +
    ` — or with sqlite3, if you have it: ${globalDbContaminationSqliteAlternative(dbPath, strays)}`;
  return { name: GLOBAL_DB_CONTAMINATION_CHECK, status: 'warn', detail, suggestion: remedy };
}

/** Never opens (or creates) anything: an absent global DB is simply not a finding. */
export function checkGlobalDbContamination(options: { genieHome?: string } = {}): CheckResult[] {
  const dbPath = join(options.genieHome ?? resolveGlobalGenieHome(), 'genie.db');
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return [
      evaluateGlobalDbTables(
        dbPath,
        rows.map((row) => row.name),
      ),
    ];
  } catch (error) {
    return [
      {
        name: GLOBAL_DB_CONTAMINATION_CHECK,
        status: 'warn',
        detail: `${dbPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
        suggestion: `Inspect the global database by hand; ${GLOBAL_DB_REPAIR_COMMAND} repairs contamination, never corruption.`,
      },
    ];
  } finally {
    db?.close();
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

// ============================================================================
// skills.sh channel (wish `skills-everywhere`, group 3)
//
// Doctor is a READ-ONLY observer here: it compares what the skills-install
// record claims against what is on disk under each detected agent's skill home
// and reports the drift. It never installs, retires, or repairs anything — not
// even under `--fix`; `genie update` owns every mutation on this surface.
// ============================================================================

/**
 * Machine-readable per-agent skills-channel state (`checks[].skillsChannel`).
 * `detected:false` means the agent's config HOME is absent on this host, which
 * is a perfectly healthy state — it reports `pass`, never a warning.
 */
export interface SkillsChannelStatus {
  agent: string;
  present: number;
  total: number;
  /** Release tag the comparison is made against (the record's, or the binary's). */
  ref: string;
  /** The record's ref no longer matches this binary's release tag. */
  stale: boolean;
  detected: boolean;
  /**
   * An install record exists, so `ref` is the release the skills were actually
   * installed from. When false, `ref` is only this binary's own tag — doctor
   * has no provenance for what is on disk and says so.
   */
  recorded: boolean;
}

const SKILLS_CHANNEL_SUGGESTION = 'Run `genie update` to install the skills.sh channel';

/** `~/.claude` for `['.claude','skills']`, `~/.config/goose` for the goose spec, ... */
function agentConfigHome(spec: AgentSkillHomeSpec, home: string): string {
  return join(home, ...spec.segments.slice(0, -1));
}

/** Home used to resolve agent skill homes. Bun's `homedir()` ignores a mutated `$HOME`. */
function resolveHostHome(explicit?: string): string {
  // `||`, not `??`: an empty `$HOME` is not a home, and joining onto `''`
  // would silently resolve agent skill homes relative to the CWD.
  return explicit ?? (process.env.HOME || homedir());
}

/** Same predicate `existingAgentSkillHomes` uses: a FILE at the path is not a home. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function countInstalledSkills(skillsDir: string, inventory: readonly string[]): number {
  let present = 0;
  for (const name of inventory) {
    // Same traversal floor the record's own consumers use: a name that could
    // climb out of the agent dir is never joined onto it.
    if (!isSafeSkillName(name)) continue;
    if (existsSync(join(skillsDir, name, 'SKILL.md'))) present += 1;
  }
  return present;
}

interface SkillsChannelContext {
  home: string;
  inventory: readonly string[];
  ref: string;
  stale: boolean;
  recorded: boolean;
  binaryTag: string;
}

function evaluateAgentSkillHome(spec: AgentSkillHomeSpec, context: SkillsChannelContext): CheckResult {
  const name = `skills: ${spec.agent}`;
  const total = context.inventory.length;
  if (!isDirectory(agentConfigHome(spec, context.home))) {
    return {
      name,
      status: 'pass',
      detail: 'not detected',
      skillsChannel: {
        agent: spec.agent,
        present: 0,
        total,
        ref: context.ref,
        stale: context.stale,
        detected: false,
        recorded: context.recorded,
      },
    };
  }
  const present = countInstalledSkills(join(context.home, ...spec.segments), context.inventory);
  const rider: SkillsChannelStatus = {
    agent: spec.agent,
    present,
    total,
    ref: context.ref,
    stale: context.stale,
    detected: true,
    recorded: context.recorded,
  };
  // Without a record `ref` is only this binary's tag: the line must not read as
  // if doctor knew which release put those skills on disk.
  const provenanceSuffix = context.recorded
    ? context.stale
      ? ` (stale, binary is ${context.binaryTag})`
      : ''
    : ' (unrecorded)';
  const detail = `${present}/${total} @ ${context.ref}${provenanceSuffix}`;
  if (present === total && !context.stale) return { name, status: 'pass', detail, skillsChannel: rider };
  return { name, status: 'warn', detail, suggestion: SKILLS_CHANNEL_SUGGESTION, skillsChannel: rider };
}

/** How many paths the preserved-retirement and agent-dir checks name before summarizing. */
const MAX_PRESERVED_SKILL_PATHS = 5;

const SKILLS_RETIREMENT_SUGGESTION = 'Review them, remove them, then run `genie update` to retry retirement';

/** `a; b; c; +N more` — the shared rendering of a bounded path list. */
function namedWithRemainder(paths: readonly string[]): string {
  const named = paths.slice(0, MAX_PRESERVED_SKILL_PATHS);
  const rest = paths.length - named.length;
  return `${named.join('; ')}${rest > 0 ? `; +${rest} more` : ''}`;
}

/**
 * Retired skill directories genie could not archive.
 *
 * They ride the install record on purpose: an entry dropped from the record is
 * never retried by `genie update`, never removed by `genie uninstall`, and
 * invisible here — the host reads `skills: claude 14/14` while a retired skill
 * sits in the home forever. Doctor stays a read-only observer; it names them.
 *
 * An entry whose path is no longer on disk is RESOLVED, not outstanding: the
 * check used to reproduce the record verbatim, so a directory the operator had
 * already deleted was still named — byte-identically — until the next
 * `genie update` dropped it from the record.
 */
function evaluatePreservedRetirements(record: SkillsInstallRecord | null): CheckResult | null {
  const preserved = record?.preserved ?? [];
  if (preserved.length === 0) return null;
  const outstanding: string[] = [];
  const resolved: string[] = [];
  for (const entry of preserved) {
    const target = join(entry.agentDir, entry.skill);
    if (isDirectory(target)) outstanding.push(`${target} (${entry.reason})`);
    else resolved.push(target);
  }
  const resolvedSuffix =
    resolved.length === 0
      ? ''
      : `; ${resolved.length} already resolved (gone from disk, dropped from the record by the next \`genie update\`): ${namedWithRemainder(resolved)}`;
  if (outstanding.length === 0) {
    return {
      name: 'skills: retirement',
      status: 'pass',
      detail: `all ${preserved.length} preserved retired skill dir(s) are gone from disk; the next \`genie update\` drops them from the record: ${namedWithRemainder(resolved)}`,
    };
  }
  return {
    name: 'skills: retirement',
    status: 'warn',
    detail: `${outstanding.length} preserved retired skill dir(s): ${namedWithRemainder(outstanding)}${resolvedSuffix}`,
    suggestion: SKILLS_RETIREMENT_SUGGESTION,
  };
}

const SKILLS_LEGACY_LEFTOVERS_SUGGESTION =
  'Run `genie update` — it archives the proven ones under state-backups and moves nothing else; an unproven dir is a name-or-description match genie does not claim, and stays listed until you remove it or it stops matching';

/**
 * Genie skill directories that predate the install record (see
 * `src/lib/legacy-skills.ts`): the record names none of them, so the
 * recorded-agent-dirs line above reads complete while `~/.agents/skills` still
 * holds a 2026-07 `genie-review`. Scans the record's homes plus every skills.sh
 * registry home on disk, so a host with NO record — the host most likely to
 * carry them — is covered too. Read-only: `genie update` is what moves them.
 */
function evaluateLegacyLeftovers(
  record: SkillsInstallRecord | null,
  home: string,
  inventory: readonly string[],
): CheckResult | null {
  const leftovers = findLegacySkillLeftovers(legacyScanHomes(home, record?.agentDirs ?? []), inventory);
  if (leftovers.length === 0) return null;
  const named = leftovers.map((entry) => `${join(entry.agentDir, entry.entry)} (${entry.kind})`);
  // `proven` and `marker` are genie's own; `unproven` is a dir that matches a retired genie NAME or
  // a retired genie DESCRIPTION and not both — `~/.claude/skills/brain` is a live third-party
  // product that shares a name genie once shipped. Calling every row a genie skill dir told the
  // operator their own product was genie's, about a dir genie will never touch.
  const claimed = leftovers.filter((entry) => entry.kind !== 'unproven').length;
  return {
    name: 'skills: legacy leftovers',
    status: 'warn',
    detail: `${leftovers.length} dir(s) predate the install record — ${claimed} genie's own, ${leftovers.length - claimed} unproven (a retired genie name or description, not both; genie claims none of these): ${namedWithRemainder(named)}`,
    suggestion: SKILLS_LEGACY_LEFTOVERS_SUGGESTION,
  };
}

/** A backup root younger than this is news the operator has not seen yet. */
const RECENT_COLLISION_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;

const SKILLS_COLLISION_BACKUP_SUGGESTION =
  'Review the kept copies, then delete the root(s) yourself — genie never removes a state-backups root';

/**
 * Collision backup roots the record still names.
 *
 * `state-backups/` is an archive: nothing genie runs removes a root a previous
 * install wrote, so the record accumulates them and doctor is where an operator
 * learns the bytes are there. It warns only while the newest is younger than a
 * week — fresh enough that the operator has probably not looked yet — and
 * passes afterwards, because an old root is a fact about the host, not a
 * finding. Read-only, like every other line here: a root that is gone from disk
 * is reported as gone, never recreated.
 */
function evaluateCollisionBackups(record: SkillsInstallRecord | null, nowMs: number): CheckResult | null {
  const backups = record?.collisionBackups ?? [];
  if (backups.length === 0) return null;
  const onDisk = backups.filter((entry) => isDirectory(entry.root));
  if (onDisk.length === 0) {
    return {
      name: 'skills: collision backups',
      status: 'pass',
      detail: `${backups.length} recorded root(s), none still on disk`,
    };
  }
  const latest = onDisk[onDisk.length - 1] as { root: string; entries: unknown[] };
  const detail = `${onDisk.length} root(s), latest ${latest.root} (${latest.entries.length} replaced dir(s))`;
  const ageMs = nowMs - backupRootAgeStampMs(latest.root);
  if (ageMs >= RECENT_COLLISION_BACKUP_MS) {
    return { name: 'skills: collision backups', status: 'pass', detail };
  }
  return {
    name: 'skills: collision backups',
    status: 'warn',
    detail,
    suggestion: SKILLS_COLLISION_BACKUP_SUGGESTION,
  };
}

/** When the root was written: its mtime, or 0 when it cannot be read (never a warning). */
function backupRootAgeStampMs(root: string): number {
  try {
    return statSync(root).mtimeMs;
  } catch {
    return 0;
  }
}

const SKILLS_AGENT_DIRS_SUGGESTION = 'Run `genie update` to reinstall the skills channel into every recorded home';

/**
 * Per-recorded-agent-dir inventory drift.
 *
 * The four `KNOWN_AGENT_SKILL_HOMES` rows above are not the removal authority:
 * `agentDirs` is, and it held 57 entries on the 2026-09-15 dogfood host. A home
 * that lost content — or vanished entirely — read `ok: true` there because
 * doctor could only see four of the 57. This line closes that gap: it compares
 * the record's own inventory against each recorded home and says how many are
 * complete, naming up to five that are not. Warn-level and read-only.
 */
function evaluateRecordedAgentDirs(record: SkillsInstallRecord | null): CheckResult | null {
  if (record === null || record.inventory.length === 0) return null;
  const dirs = [...new Set(record.agentDirs)];
  if (dirs.length === 0) return null;
  const incomplete: string[] = [];
  for (const dir of dirs) {
    if (!isDirectory(dir)) {
      incomplete.push(`${dir} (not on disk)`);
      continue;
    }
    const present = countInstalledSkills(dir, record.inventory);
    if (present < record.inventory.length) incomplete.push(`${dir} (${present}/${record.inventory.length})`);
  }
  const complete = dirs.length - incomplete.length;
  const detail = `${complete}/${dirs.length} recorded homes complete @ ${record.ref}`;
  if (incomplete.length === 0) return { name: 'skills: agent dirs', status: 'pass', detail };
  return {
    name: 'skills: agent dirs',
    status: 'warn',
    detail: `${detail}; incomplete: ${namedWithRemainder(incomplete)}`,
    suggestion: SKILLS_AGENT_DIRS_SUGGESTION,
  };
}

/**
 * One line per known agent skill home, plus a `skills: channel` warning when no
 * install record exists at all, plus a `skills: retirement` warning naming
 * every directory the last install preserved instead of archiving.
 *
 * The comparison inventory is the record's when there is one; without a record
 * the delivered tree under `<GENIE_HOME>/skills` is the only remaining truth
 * source, so it is used as the fallback. When BOTH are empty there is nothing
 * to compare against and the single record-less warning is the whole answer.
 */
export function checkSkillsChannel(
  options: { home?: string; genieHome?: string; nowMs?: () => number } = {},
): CheckResult[] {
  const home = resolveHostHome(options.home);
  const genieHome = options.genieHome ?? resolveGlobalGenieHome();
  const read = inspectSkillsInstallRecord(genieHome);
  // A malformed record is NOT "no record": it is a receipt genie can no longer
  // act on, and every consumer now refuses on it, so doctor names the field.
  if (read.status === 'invalid') {
    return [
      {
        name: 'skills: channel',
        status: 'warn',
        detail: read.error.message,
        suggestion: `Repair or remove ${read.error.path}, then run \`genie update\` — until then \`genie uninstall\` refuses to touch the recorded skill dirs.`,
      },
    ];
  }
  const record = read.status === 'ok' ? read.record : null;
  const binaryTag = releaseTag(VERSION);
  const inventory =
    record !== null && record.inventory.length > 0
      ? record.inventory
      : inventoryFromSkillsDir(join(genieHome, 'skills'));
  const results: CheckResult[] = [];
  // Leftovers are scanned BEFORE the no-record early return: a host that never
  // wrote a record is exactly the host that carries pre-record genie dirs.
  const legacy = evaluateLegacyLeftovers(record, home, inventory);
  if (record === null) {
    results.push({
      name: 'skills: channel',
      status: 'warn',
      detail: 'no install record',
      suggestion: SKILLS_CHANNEL_SUGGESTION,
    });
    if (inventory.length === 0) {
      if (legacy !== null) results.push(legacy);
      return results;
    }
  }
  const context: SkillsChannelContext = {
    home,
    inventory,
    ref: record?.ref ?? binaryTag,
    stale: record !== null && record.ref !== binaryTag,
    recorded: record !== null,
    binaryTag,
  };
  for (const spec of KNOWN_AGENT_SKILL_HOMES) results.push(evaluateAgentSkillHome(spec, context));
  const agentDirs = evaluateRecordedAgentDirs(record);
  if (agentDirs !== null) results.push(agentDirs);
  const retirement = evaluatePreservedRetirements(record);
  if (retirement !== null) results.push(retirement);
  if (legacy !== null) results.push(legacy);
  const backups = evaluateCollisionBackups(record, (options.nowMs ?? Date.now)());
  if (backups !== null) results.push(backups);
  return results;
}

// ============================================================================
// Workflows channel (wish `global-workflows-local-mikro`, group 3)
// ============================================================================

const WORKFLOWS_CHANNEL_SUGGESTION = 'Run `genie update` to reinstall the workflow catalog';

/**
 * ONE remedy for both unrecorded shapes, because both are answered by the same
 * run: it must be true when files are named AND when none are, so it states the
 * install and the backup rather than only the replacement.
 */
const WORKFLOWS_UNRECORDED_SUGGESTION =
  'Run `genie update` to install and record the workflow catalog; a file already there is backed up under `<GENIE_HOME>/state-backups/` before it is replaced';

/** The one name every workflows-channel line carries, in the `skills: …` family. */
const WORKFLOWS_CHECK_NAME = 'workflows: catalog';

/**
 * Every recorded workflow file whose bytes no longer prove the recorded
 * install, named with its state. `replace` is the ONLY verdict that proves the
 * file on disk is still byte-for-byte what genie installed.
 */
function describeWorkflowDrift(recorded: SkillsWorkflowsInstall): { present: number; drift: string[] } {
  let present = 0;
  const drift: string[] = [];
  for (const [name, digest] of Object.entries(recorded.files)) {
    // The same traversal floor every other consumer of the record uses.
    if (!isSafeWorkflowFileName(name)) continue;
    const state = inspectOnDiskWorkflow(join(recorded.dir, name));
    if (state.kind === 'other') {
      drift.push(`${name} (not a regular file)`);
      continue;
    }
    const verdict = classifyWorkflowFile({ recorded: digest, onDisk: state.digest });
    if (verdict === 'replace') present += 1;
    else drift.push(`${name} (${verdict === 'missing' ? 'missing' : 'modified'})`);
  }
  return { present, drift };
}

/**
 * Catalog names sitting in a user scope that NO record accounts for — the
 * 2026-09-15 incident shape, on a host where the channel has not run yet.
 *
 * It walks the SHIPPED names and lstats each one, rather than listing the user
 * directory: a workflow that is not genie's namespace is then structurally
 * invisible here, and a symlink is named rather than resolved.
 */
function describeUnrecordedWorkflows(workflowsDir: string, catalog: readonly string[]): string[] {
  const found: string[] = [];
  for (const name of catalog) {
    const state = inspectOnDiskWorkflow(join(workflowsDir, name));
    if (state.kind === 'absent') continue;
    found.push(state.kind === 'other' ? `${name} (not a regular file)` : name);
  }
  return found;
}

/**
 * The line for a host whose record carries no `workflows` field at all.
 *
 * `(unrecorded)` alone used to be the whole answer, and it was the one place
 * this check was quieter than the skills leg, which lists pre-record leftovers
 * BEFORE its no-record return. A stale `~/.claude/workflows/council.js` from
 * the retired stamped install — exactly what shadowed the project copy on
 * 2026-09-15 — sat in a user scope unnamed, because no record named it.
 */
function unrecordedWorkflowsResult(claudeDir: string, genieHome: string): CheckResult {
  if (!isDirectory(claudeDir)) {
    // No product home: genie creates none, so there is nothing to say and
    // nothing `genie update` would do here.
    return { name: WORKFLOWS_CHECK_NAME, status: 'pass', detail: 'not detected' };
  }
  // The names come from what THIS release ships, never a list written down
  // here: a hardcoded one goes stale the first time the catalog grows. With no
  // shipped catalog on disk the channel cannot run, so nothing is claimed.
  const catalog = shippedWorkflowNames(shippedWorkflowsRoot(genieHome));
  const leftovers = describeUnrecordedWorkflows(join(claudeDir, 'workflows'), catalog);
  if (leftovers.length > 0) {
    return {
      name: WORKFLOWS_CHECK_NAME,
      status: 'warn',
      detail: `(unrecorded) ${leftovers.length} file(s) genie did not record: ${namedWithRemainder(leftovers)}`,
      suggestion: WORKFLOWS_UNRECORDED_SUGGESTION,
    };
  }
  return {
    name: WORKFLOWS_CHECK_NAME,
    status: 'pass',
    detail: '(unrecorded)',
    ...(catalog.length > 0 ? { suggestion: WORKFLOWS_UNRECORDED_SUGGESTION } : {}),
  };
}

/**
 * ONE line for the user-scope workflow catalog, read straight off the install
 * record the workflows channel wrote — the same authority `genie uninstall`
 * removes by, so the two can never disagree about what genie owns.
 *
 * Read-only, like every other doctor check and including under `--fix`: it
 * lstats and digests, and repairs nothing. `genie update` is the only repair.
 */
export function checkWorkflowsChannel(options: { home?: string; genieHome?: string } = {}): CheckResult[] {
  const genieHome = options.genieHome ?? resolveGlobalGenieHome();
  const read = inspectSkillsInstallRecord(genieHome);
  // A malformed record is ONE fault with ONE remedy, and `checkSkillsChannel`
  // already names the offending field and the repair. Doctor says it once.
  if (read.status === 'invalid') return [];
  const recorded = read.status === 'ok' ? read.record.workflows : undefined;
  if (recorded === undefined) {
    const claudeDir = options.home === undefined ? resolveClaudeDir() : join(options.home, '.claude');
    return [unrecordedWorkflowsResult(claudeDir, genieHome)];
  }
  const { present, drift } = describeWorkflowDrift(recorded);
  const binaryTag = releaseTag(VERSION);
  const stale = recorded.ref !== binaryTag;
  const total = Object.keys(recorded.files).length;
  const staleSuffix = stale ? ` (stale, binary is ${binaryTag})` : '';
  const driftSuffix = drift.length === 0 ? '' : `; ${namedWithRemainder(drift)}`;
  const detail = `${present}/${total} in ${recorded.dir} @ ${recorded.ref}${staleSuffix}${driftSuffix}`;
  if (drift.length === 0 && !stale) return [{ name: WORKFLOWS_CHECK_NAME, status: 'pass', detail }];
  return [{ name: WORKFLOWS_CHECK_NAME, status: 'warn', detail, suggestion: WORKFLOWS_CHANNEL_SUGGESTION }];
}

// ============================================================================
// Legacy marker-owned integration assets (wish `skills-everywhere`, group 3)
// ============================================================================

/** Classification of one marker-owned legacy asset. Mirrors the group-2 module. */
export type LegacyIntegrationState = 'managed-clean' | 'managed-modified' | 'unmanaged' | 'absent';

export interface LegacyIntegrationEntry {
  surface: string;
  path: string;
  state: LegacyIntegrationState;
}

/**
 * The narrow shape doctor consumes: structurally satisfied by the real
 * `classifyLegacyIntegrations` (its `surface` union widens to `string` and its
 * extra optional homes are not required here), while staying injectable by
 * tests. Doctor observes the classification; it does not own the engine.
 */
export type LegacyClassifier = (homes: { home: string; genieHome: string }) => { entries: LegacyIntegrationEntry[] };

/**
 * Compile-time proof that the real group-2 export satisfies doctor's seam. If
 * `classifyLegacyIntegrations`'s signature or its `LegacyIntegrationState`
 * union ever drifts from doctor's, this assignment fails to typecheck.
 */
const DEFAULT_LEGACY_CLASSIFIER: LegacyClassifier = classifyLegacyIntegrations;

const LEGACY_RETIREMENT_SUGGESTION = 'Run `genie update` to retire them';
/** How many pending paths the check names before summarizing the rest. */
const MAX_LEGACY_PENDING_PATHS = 5;

/**
 * The retirement module is a permanent fixture of the tree, so it is imported
 * statically: a non-literal dynamic specifier is invisible to `bun build`, and
 * the shipped single-file bundle would have degraded to a silent, permanent
 * "classifier unavailable" pass. `deps.legacyClassifier` remains the only seam
 * — `null` forces the unavailable path for tests of that branch.
 */
function resolveLegacyClassifier(deps: DoctorDeps): LegacyClassifier | null {
  if (deps.legacyClassifier !== undefined) return deps.legacyClassifier;
  return DEFAULT_LEGACY_CLASSIFIER;
}

/**
 * The one shape of the unavailable answer: a pass (doctor never fails on its
 * own blindness) that still carries the rider, with `available:false` so a
 * machine reader can tell "nothing pending" from "nothing observed".
 */
function unavailableLegacyResult(reason?: string): CheckResult {
  return {
    name: 'legacy integrations',
    status: 'pass',
    detail: reason === undefined ? 'classifier unavailable' : `classifier unavailable (${reason})`,
    legacyIntegrations: { pending: [], available: false },
  };
}

/**
 * Read-only classification of marker-owned legacy assets still on disk.
 * `managed-clean` is the ONLY pending state: a modified or unmanaged asset is
 * never genie's to retire, and an absent one is already gone.
 */
export async function checkLegacyIntegrations(
  deps: DoctorDeps = {},
  options: { home?: string; genieHome?: string } = {},
): Promise<CheckResult[]> {
  const classifier = resolveLegacyClassifier(deps);
  if (classifier === null) return [unavailableLegacyResult()];
  let entries: LegacyIntegrationEntry[];
  try {
    entries = classifier({
      home: resolveHostHome(options.home),
      genieHome: options.genieHome ?? resolveGlobalGenieHome(),
    }).entries;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [unavailableLegacyResult(reason)];
  }
  const pending = entries
    .filter((entry) => entry.state === 'managed-clean')
    .map((entry) => ({ surface: entry.surface, path: entry.path }));
  if (pending.length === 0) {
    return [
      {
        name: 'legacy integrations',
        status: 'pass',
        detail: 'retired',
        legacyIntegrations: { pending, available: true },
      },
    ];
  }
  const named = pending.slice(0, MAX_LEGACY_PENDING_PATHS).map((entry) => entry.path);
  const remainder = pending.length - named.length;
  const tail = remainder > 0 ? `${named.join(', ')}, …and ${remainder} more` : named.join(', ');
  return [
    {
      name: 'legacy integrations',
      status: 'warn',
      detail: `${pending.length} marker-owned assets pending: ${tail}`,
      suggestion: LEGACY_RETIREMENT_SUGGESTION,
      legacyIntegrations: { pending, available: true },
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

/**
 * m16 / r2 #7: the check NAME is the cross-release diff key, so it carries no
 * version string — `bun 1.3.11` made every bun upgrade read as one removed and
 * one added check. The running version lives in `detail`, exactly as the
 * `genie version` check already does.
 */
export function evaluateBunVersion(bunVersion: string | null, onPath: string | null): CheckResult[] {
  if (bunVersion) {
    if (!versionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) {
      return [
        {
          name: 'bun present',
          status: 'fail',
          detail: `${bunVersion} unsupported; Genie requires Bun >=${MINIMUM_BUN_VERSION}`,
          suggestion: `Run \`bun upgrade\`, then confirm \`bun --version\` is at least ${MINIMUM_BUN_VERSION}.`,
        },
      ];
    }
    return [
      {
        name: 'bun present',
        status: 'pass',
        detail: `${bunVersion} (${onPath ?? 'running under bun'})`,
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

function codexProjectRouteCheck(root: string | null, probe: CodexPluginProbe, cwd = process.cwd()): CheckResult {
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
    // Group E: distinct typed config-layer findings. Collisions, shadowing, and
    // a global same-key route are hard route defects (preserved, never edited);
    // the trust states block a health CLAIM without failing intact route bytes.
    const findings = classifyRouteLayers({ worktreeRoot: root, cwd, route, globalConfigPath: getCodexConfigPath() });
    const hard = findings.filter(
      (finding) =>
        finding.kind === 'route-collision' ||
        finding.kind === 'route-shadowed' ||
        finding.kind === 'global-route-same-key',
    );
    const trust = findings.filter(
      (finding) => finding.kind === 'untrusted-config' || finding.kind === 'project-trust-required',
    );
    const retired = route.route !== 'none' && route.route !== 'plugin';
    const status: CheckStatus = retired || hard.length > 0 || trust.length > 0 ? 'warn' : 'pass';
    const findingText = findings.map((finding) => `${finding.kind}: ${finding.detail}`).join('; ');
    return {
      name: 'Codex Genie MCP registration',
      status,
      detail: `${retired ? 'retired route remains preserved' : 'retired routes absent'}${findingText.length > 0 ? `; ${findingText}` : ''}`,
      suggestion:
        status === 'pass'
          ? undefined
          : hard.length > 0
            ? 'Resolve the reported user-owned same-key/shadowing layer if desired; Genie never edits it.'
            : trust.length > 0 && route.ok
              ? 'Trust this project in Codex, then start a new Codex task.'
              : 'Run `genie init` to remove a marker-owned historical route; user-owned routes are preserved.',
      ...(findings.length > 0 ? { routeLayers: findings } : {}),
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
 * Group E: report what a Codex MCP child launched in this repository would
 * resolve — the SAME `resolveProjectContext` the MCP server uses, so
 * doctor and the server can never disagree about project context. An absent
 * database mirrors the `genie.db` check's "created on first use" stance as a
 * warn (the MCP returns a typed error, never a healthy empty board); a
 * bare/submodule/external layout or an unresolvable context is a hard fail.
 */
export function checkCodexProjectContext(root: string | null, injected?: ProjectContext | null): CheckResult[] {
  if (root === null || injected === null) return [];
  // Same stance as the `genie.db` check: under Orca the local store is not the
  // lifecycle authority, so doctor neither resolves project context nor opens
  // the database it would name — reporting a live DB there is a false claim,
  // and opening it is exactly what the orca-mode guard forbids.
  if (inspectOrcaPluginLifecycle().mode === 'orca') {
    return [
      {
        name: 'Codex project context',
        status: 'pass',
        detail: 'not resolved — Orca is the selected lifecycle authority',
      },
    ];
  }
  const context = injected ?? resolveProjectContext(root);
  if (context.kind === 'ok') {
    let db: Database | null = null;
    try {
      db = new Database(context.dbPath, { readonly: true });
      db.query('PRAGMA user_version').get();
    } catch {
      return [
        {
          name: 'Codex project context',
          status: 'fail',
          detail: `Codex MCP returns typed 'project-database-unavailable': unable to open Genie database at ${context.dbPath}`,
          suggestion: 'Repair or replace the repository .genie/genie.db, then rerun `genie doctor`.',
        },
      ];
    } finally {
      db?.close();
    }
    return [
      {
        name: 'Codex project context',
        status: 'pass',
        detail: `storage root ${context.genieStorageRoot}; db ${context.dbPath}`,
      },
    ];
  }
  if (context.kind === 'project-database-unavailable') {
    return [
      {
        name: 'Codex project context',
        status: 'warn',
        detail: `Codex MCP returns typed '${context.kind}' (never a healthy empty board): ${context.detail}`,
        suggestion: 'Run `genie init` (or create the first task) to initialize .genie/genie.db.',
      },
    ];
  }
  return [
    {
      name: 'Codex project context',
      status: 'fail',
      detail: `Codex MCP returns typed '${context.kind}': ${context.detail}`,
      suggestion:
        context.kind === 'unsupported-project-layout'
          ? 'Run Codex tasks from an ordinary or linked non-bare worktree; bare/submodule/external-git-dir layouts are a hard boundary.'
          : 'Verify this is an initialized Git worktree, then run `genie init`.',
    },
  ];
}

/**
 * The surviving MCP-capability surface of an installed Codex plugin cache: the
 * active plugin manifest must declare no `mcpServers` route. Read-only.
 */
function codexPluginSurfaceChecks(probe: CodexPluginProbe): CheckResult[] {
  if (!probe.installed) return [];
  const manifest = probe.activePluginRoot ? join(probe.activePluginRoot, '.codex-plugin', 'plugin.json') : null;
  // Post-Group-A contract (Decisions 1/7): the codex plugin manifest MUST NOT
  // declare mcpServers — a declaration would re-create the second (cache-root)
  // Genie route the wish removed. Absence is the healthy shape.
  let manifestState: 'unproven' | 'unreadable' | 'declares-none' | 'declares-route' = 'unproven';
  if (manifest !== null) {
    manifestState = 'unreadable';
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          manifestState =
            (parsed as Record<string, unknown>).mcpServers === undefined ? 'declares-none' : 'declares-route';
        }
      } catch {
        manifestState = 'unreadable';
      }
    }
  }
  return [
    {
      name: 'Codex Genie MCP capability',
      status: manifestState === 'declares-none' ? 'pass' : 'warn',
      detail:
        manifestState === 'declares-none'
          ? `plugin declares no MCP route; standalone task/board commands are authoritative at ${probe.activePluginRoot}`
          : manifestState === 'declares-route'
            ? `active plugin manifest still declares mcpServers — a second Genie route risks cache-root routing: ${manifest}`
            : manifestState === 'unreadable'
              ? `active plugin manifest is missing or corrupt: ${manifest}`
              : 'active installed plugin root is unproven; source-bundle declarations do not establish runtime health',
      suggestion:
        manifestState === 'declares-none'
          ? undefined
          : manifestState === 'declares-route'
            ? 'Remove the historical Genie plugin from the Codex cache; a second Genie route risks cache-root routing.'
            : 'Remove the historical Genie plugin from the Codex cache.',
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
  const configPath = getCodexConfigPath();
  const obsolete = existsSync(configPath) && readFileSync(configPath, 'utf8').includes(DEAD_GENIE_OTEL_EXPORTER);
  results.push({
    name: 'obsolete Genie OTel exporter',
    status: obsolete ? 'warn' : 'pass',
    detail: obsolete ? 'present' : 'absent',
    suggestion: obsolete ? 'Run `genie update` for backup-first removal.' : undefined,
  });
  results.push(codexProjectRouteCheck(root, probe), ...codexPluginSurfaceChecks(probe));
  const config = await loadGenieConfig();
  results.push({ name: 'preferred agent runtime', status: 'pass', detail: config.runtime.defaultAgent });
  return results;
}

/**
 * Echo the repair budget the fix skill resolves against. Read-only: doctor never
 * repairs, and never writes a config file — a budget an operator has not set is
 * reported as the schema default, not materialized on disk.
 *
 * Its own function rather than a branch inside `doctorCommand`: this is a config
 * read, a different concern from the binary/git/database probes around it.
 */
export async function checkBudgets(): Promise<CheckResult[]> {
  const resolved = await resolveConfigKey('budgets.maxEscalationsPerGroup');
  return [{ name: `budgets: maxEscalationsPerGroup=${String(resolved.value)} (${resolved.source})`, status: 'pass' }];
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
  // ONE row for every orphaned cache dir, never one row per version: a check
  // NAME is the cross-release diff key, so `v4 residue: plugin cache 4.260421.17`
  // reproduced exactly the removed/added pair m16 eliminated — the name
  // appeared and disappeared with the cache, and differed host to host. The
  // versions ride the detail instead (r2 #7).
  if (orphanedCaches.length > 0) {
    const bytes = orphanedCaches.reduce((sum, d) => sum + safeSizeOf(d.path), 0);
    results.push({
      name: 'v4 residue: plugin cache',
      status: 'warn',
      detail: `${orphanedCaches.length} orphaned version dir(s), ${prettyBytes(bytes)}: ${orphanedCaches
        .map((d) => d.version)
        .sort()
        .join(', ')}`,
    });
  }
  // Report-only (Decision 2): uncertain names we deliberately never touch.
  // Summarized for the same reason as the cache row — these names come from
  // whatever the genie home happens to hold, so any of them could carry a
  // version and none of them is a stable diff key.
  if (uncertainKeeps.length > 0) {
    results.push({
      name: 'kept (uncertain)',
      status: 'pass',
      detail: `not provably v4 — never touched by --fix: ${[...uncertainKeeps].sort().join(', ')}`,
    });
  }
  return results;
}

// ============================================================================
// jar: index-lane drift — INDEX.md sections vs roadmap board lanes
//
// One tracker: the `roadmap` board owns placement truth; `.genie/INDEX.md` prose
// stays hand-written. This WARNING-LEVEL check joins each INDEX entry's FIRST
// `brainstorms/<slug>/` or `wishes/<slug>/` link to the roadmap card WHERE
// `tasks.wish = slug`, then verifies that card's lane against the section it sits
// under. It never flips doctor `ok:false`. An entry with no such link, no
// matching card, or a laneless card is 'unlinked' (NEVER 'drift') — drift is
// reserved for a resolved card whose lane contradicts its INDEX section. A link
// whose target no longer exists is 'broken', decided BEFORE any lane comparison.
// ============================================================================

/**
 * One INDEX entry's placement verdict. Rides `--json` as
 * `checks[].indexLane.entries` — deterministic and order-stable (INDEX order).
 * The four state names are the machine-readable contract:
 *   - ok       : the resolved roadmap card's lane agrees with the section.
 *   - drift    : the resolved card's lane contradicts the section.
 *   - broken   : the link resolves to a path that does not exist — decided
 *                before the lane comparison, so it outranks drift.
 *   - unlinked : no first brainstorms/wishes link, no matching roadmap card,
 *                or the card carries no lane — never counted as drift.
 */
export interface IndexLaneEntry {
  /** Stable text prefix: the first link's label, else the trimmed line prefix. */
  entry: string;
  /** Resolved lifecycle slug, or null when the entry has no brainstorms/wishes link. */
  slug: string | null;
  /** INDEX section: Raw | Simmering | Ready | Poured. */
  section: string;
  /** The roadmap card's lane, or null when nothing resolves. */
  lane: string | null;
  state: 'ok' | 'drift' | 'broken' | 'unlinked';
}

/** Section → the set of roadmap lanes that AGREE with it (the group brief's contract). */
const INDEX_SECTION_LANES: Record<string, ReadonlySet<string>> = {
  Raw: new Set(['Idea']),
  Simmering: new Set(['Brainstorm']),
  Ready: new Set(['Brainstorm', 'Wish']),
  Poured: new Set(['Wish', 'Work', 'Review', 'Done']),
};

/**
 * First markdown link into `brainstorms/<slug>/…` or `wishes/<slug>/…`.
 * Groups: 1 label, 2 directory, 3 slug, 4 path remainder (possibly empty).
 * Groups 2–4 rejoin as the `.genie`-relative target handed to the resolver.
 */
const INDEX_ENTRY_LINK = /\[([^\]]*)\]\((?:\.\/)?(brainstorms|wishes)\/([^/)]+)\/([^)]*)\)/;

function truncateIndexEntry(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

/**
 * Parse INDEX.md into per-entry lane verdicts. Pure: the caller supplies
 * `laneForSlug`, which returns the resolving roadmap card's lane or null, and
 * `targetExists`, which answers whether a `.genie`-relative link target is on
 * disk. Both are required: a defaulted resolver would silently fail open and
 * report every dangling link as filed. This function performs no filesystem IO
 * of its own. Only the four lifecycle sections are inspected; any other heading
 * is ignored (its bullets are skipped). Every `- ` bullet under a lifecycle
 * section — including indented sub-bullets — is one entry.
 */
export function evaluateIndexLaneDrift(
  indexText: string,
  laneForSlug: (slug: string) => string | null,
  targetExists: (relativePath: string) => boolean,
): IndexLaneEntry[] {
  const entries: IndexLaneEntry[] = [];
  let section: string | null = null;
  for (const line of indexText.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      // Object.hasOwn, not `in`: a hand-written heading like `## constructor`
      // must not resolve to an Object.prototype member (whose `.has` call
      // below would crash the whole doctor run).
      section = Object.hasOwn(INDEX_SECTION_LANES, heading[1]) ? heading[1] : null;
      continue;
    }
    if (section === null || !/^\s*-\s+/.test(line)) continue;
    const content = line.replace(/^\s*-\s+/, '');
    const link = INDEX_ENTRY_LINK.exec(line);
    if (link === null) {
      entries.push({ entry: truncateIndexEntry(content), slug: null, section, lane: null, state: 'unlinked' });
      continue;
    }
    const [, rawLabel, dir, slug, remainder] = link;
    const label = rawLabel.trim();
    const lane = laneForSlug(slug);
    // A dead target outranks every lane verdict: there is nothing to file.
    const state: IndexLaneEntry['state'] = !targetExists(`${dir}/${slug}/${remainder}`)
      ? 'broken'
      : lane === null
        ? 'unlinked'
        : INDEX_SECTION_LANES[section].has(lane)
          ? 'ok'
          : 'drift';
    entries.push({ entry: label.length > 0 ? label : truncateIndexEntry(content), slug, section, lane, state });
  }
  return entries;
}

/**
 * wish → lane for every `roadmap` card that carries both. Read-only: opens the
 * shared DB read-only (no schema mutation, no write lock), tolerating a missing
 * DB, a missing `lane` column, or any read failure by degrading to an empty map
 * (every linked entry then reports 'unlinked', never 'drift'). First wish wins.
 */
function roadmapLanesByWish(dbPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(dbPath)) return map;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .query(
        "SELECT t.wish AS wish, t.lane AS lane FROM tasks t JOIN boards b ON t.board_id = b.id WHERE b.name = 'roadmap' AND t.wish IS NOT NULL AND t.lane IS NOT NULL",
      )
      .all() as Array<{ wish: string; lane: string }>;
    for (const row of rows) if (!map.has(row.wish)) map.set(row.wish, row.lane);
  } catch {
    return new Map();
  } finally {
    db?.close();
  }
  return map;
}

/**
 * Does a `.genie`-relative INDEX link target exist? `#anchor` suffixes are
 * stripped (the anchor lives inside the document, not on disk) and a trailing
 * slash is tolerated, so a bare `wishes/<slug>/` link resolves against the
 * directory itself. The only filesystem IO in this check's link handling.
 * A target that resolves outside `.genie/` is `broken` without touching disk,
 * so `../` traversal in a link cannot turn `doctor --json` into an oracle for
 * paths elsewhere on the machine.
 */
function indexTargetExists(genieDir: string, relativePath: string): boolean {
  const withoutAnchor = relativePath.split('#')[0].replace(/\/+$/, '');
  if (withoutAnchor.length === 0) return false;
  const full = resolve(genieDir, withoutAnchor);
  const rootDir = resolve(genieDir);
  if (full !== rootDir && !full.startsWith(rootDir + sep)) return false;
  return existsSync(full);
}

/**
 * The `jar: index-lane drift` warning-level check. Absent INDEX.md → a single
 * pass line (nothing to lint). Otherwise one line summarizing
 * ok/drift/broken/unlinked counts, WARN when ≥1 entry drifts or is broken, plus
 * the stable per-entry payload.
 */
export function checkIndexLaneDrift(root: string | null, databaseRoot: string | null): CheckResult[] {
  const name = 'jar: index-lane drift';
  if (inspectOrcaPluginLifecycle().mode === 'orca') {
    return [{ name, status: 'pass', detail: 'not read — Orca is the selected lifecycle authority' }];
  }
  const base = root ?? process.cwd();
  const indexPath = join(base, '.genie', 'INDEX.md');
  if (!existsSync(indexPath)) {
    return [{ name, status: 'pass', detail: `no ${indexPath} (nothing to lint)` }];
  }
  let indexText: string;
  try {
    indexText = readFileSync(indexPath, 'utf8');
  } catch (err) {
    return [
      { name, status: 'pass', detail: `INDEX.md unreadable (${err instanceof Error ? err.message : String(err)})` },
    ];
  }
  const dbPath = join(databaseRoot ?? base, '.genie', 'genie.db');
  const lanes = roadmapLanesByWish(dbPath);
  const genieDir = join(base, '.genie');
  const entries = evaluateIndexLaneDrift(
    indexText,
    (slug) => lanes.get(slug) ?? null,
    (relativePath) => indexTargetExists(genieDir, relativePath),
  );
  const drift = entries.filter((e) => e.state === 'drift').length;
  const broken = entries.filter((e) => e.state === 'broken').length;
  const unlinked = entries.filter((e) => e.state === 'unlinked').length;
  const ok = entries.filter((e) => e.state === 'ok').length;
  const suggestions: string[] = [];
  if (drift > 0) {
    suggestions.push(
      'An INDEX section disagrees with its roadmap card lane — move the card to the matching lane or the entry to the matching section.',
    );
  }
  if (broken > 0) {
    suggestions.push('An INDEX link points at a path that no longer exists — repoint or remove the entry.');
  }
  return [
    {
      name,
      status: drift > 0 || broken > 0 ? 'warn' : 'pass',
      detail: `${entries.length} INDEX entries: ${ok} ok, ${drift} drift, ${broken} broken, ${unlinked} unlinked`,
      suggestion: suggestions.length > 0 ? suggestions.join(' ') : undefined,
      indexLane: { entries },
    },
  ];
}

/**
 * The `mcp: retired \`genie mcp\` registration` check. Every repo that ran
 * `genie init` before the MCP server was retired carries a `genie` entry in
 * `.mcp.json` that launches `genie mcp` — a command that now prints its
 * retirement diagnostic and exits 1, so Claude Code shows it as a permanently
 * failed MCP server. Warning-level: it never flips doctor `ok:false`, because
 * `.mcp.json` is a user-owned file and the repair is one command away.
 */
export function checkRetiredJsonMcpEntry(root: string | null): CheckResult[] {
  const name = 'mcp: retired `genie mcp` registration';
  const finding = inspectRetiredJsonMcpEntry(root ?? process.cwd());
  if (finding.state !== 'present') return [{ name, status: 'pass', detail: finding.detail }];
  return [
    {
      name,
      status: 'warn',
      detail: `${finding.path} still registers the retired \`genie mcp\` server, which Claude Code shows as failed`,
      suggestion:
        'Run `genie init` in this repository to retire that entry (the file is backed up first and every other server is preserved), or delete the "genie" entry from .mcp.json by hand.',
    },
  ];
}

/** The `git: machine-local .genie state` check name — stable across renders and `--json`. */
export const TRACKED_MACHINE_STATE_CHECK = 'git: machine-local .genie state';

/**
 * The remedy for a repo that tracks machine-local `.genie/` state. Two steps,
 * in this order and both required: a `.gitignore` rule does NOT untrack an
 * already-tracked file, and untracking without the rule lets the next
 * `git add -A .genie` put it straight back.
 */
export function trackedMachineStateRemedy(paths: readonly string[]): string {
  return [
    'Run `genie init` to append the missing .gitignore rules, then untrack the files with',
    `\`git rm --cached ${paths.join(' ')}\` and commit —`,
    'ignoring a path never untracks it, and untracking without the rule re-commits it on the next `git add`.',
  ].join(' ');
}

/**
 * What one probe of the git index learned. `observed: false` carries WHICH
 * failure it was, because "git is not installed" and "this is not a work tree"
 * are different facts about the host and the check must not print one for the
 * other.
 */
export type TrackedMachineStateProbe =
  | { observed: true; paths: string[] }
  | { observed: false; reason: 'no-git-binary' | 'unreadable-index' };

/**
 * A spawn that failed because the `git` executable is not on PATH — Node/Bun
 * report that as an ENOENT spawn error with no exit status, while a git that
 * ran and refused (not a work tree, a bare repo, a missing directory) carries
 * the exit status instead.
 */
function isMissingGitBinary(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown } | null;
  return e?.code === 'ENOENT' && (e.status === undefined || e.status === null);
}

/** Is a `git` executable on PATH at all? Asked only to name the reason a probe observed nothing. */
function gitBinaryPresent(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    // Anything other than "not on PATH" leaves git's presence unproven — say
    // present, so the check never invents a missing-binary diagnosis.
    return !isMissingGitBinary(err);
  }
}

/**
 * Probe the git index for tracked machine-local `.genie/` paths. Separated from
 * the check so the classification is testable without a doctor run, and so a
 * git failure (no git, not a work tree, a bare repo) stays an explicit
 * "could not observe" the caller must render as such — never a false clean bill.
 */
export function probeTrackedMachineState(root: string): TrackedMachineStateProbe {
  try {
    const stdout = execFileSync('git', ['-C', root, 'ls-files', '--cached', '-z', '--', ...MACHINE_LOCAL_GENIE_PATHS], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { observed: true, paths: stdout.split('\0').filter((path) => path.length > 0) };
  } catch (err) {
    return { observed: false, reason: isMissingGitBinary(err) ? 'no-git-binary' : 'unreadable-index' };
  }
}

/**
 * The check result for a probe that observed nothing. Warning-level, never
 * `pass`: a consumer reading `status` alone (a dashboard counting pass/warn, or
 * the operator scanning glyphs) must not be handed a clean bill this check
 * never earned. It still never flips `ok:false` — an unobservable index is not
 * a broken installation.
 */
function unobservedMachineState(reason: 'no-git-binary' | 'unreadable-index', root: string | null): CheckResult {
  const name = TRACKED_MACHINE_STATE_CHECK;
  const unchecked = 'the machine-local .genie/ paths could not be checked';
  if (reason === 'no-git-binary') {
    return {
      name,
      status: 'warn',
      detail: `git is not installed (no \`git\` on PATH) — ${unchecked}`,
      suggestion: 'Install git, then rerun `genie doctor`.',
    };
  }
  const where = root === null ? 'not inside a git repository' : `could not query the git index at ${root}`;
  return { name, status: 'warn', detail: `${where} — ${unchecked}` };
}

/**
 * The `git: machine-local .genie state` check.
 *
 * `genie init` only ever APPENDS `.gitignore` rules, so a repo that committed
 * `.genie/roadmap-sync` (or a `genie.db` sidecar) before the rule existed keeps
 * tracking it forever — and a tracked sync baseline is the one that silently
 * destroys shared state: it travels to a fresh clone, matches that clone's
 * freshly created EMPTY database, and the first `genie task sync` publishes the
 * empty board over the committed `roadmap.json`.
 *
 * Warning-level and read-only: the repair rewrites the operator's git index, so
 * doctor names the files and the exact two commands and never flips `ok:false`
 * (and never repairs, not even under `--fix`).
 */
export function checkTrackedMachineState(root: string | null): CheckResult[] {
  const name = TRACKED_MACHINE_STATE_CHECK;
  // A null root is "no worktree to read", and the index of some OTHER directory
  // is not a substitute — but WHY there is no worktree still has to be named:
  // with git absent the root resolves to null for the wrong reason (dogfood r7
  // saw a real work tree reported as "not inside a git repository").
  if (root === null) {
    return [unobservedMachineState(gitBinaryPresent() ? 'unreadable-index' : 'no-git-binary', null)];
  }
  const probe = probeTrackedMachineState(root);
  if (!probe.observed) return [unobservedMachineState(probe.reason, root)];
  if (probe.paths.length === 0) {
    return [{ name, status: 'pass', detail: 'no machine-local .genie/ paths are tracked' }];
  }
  const sorted = [...probe.paths].sort();
  return [
    {
      name,
      status: 'warn',
      detail: `${sorted.length} machine-local path(s) are committed: ${namedWithRemainder(sorted)}`,
      suggestion: trackedMachineStateRemedy(sorted),
    },
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
  /** Injects the typed project-context fact (explicit `null` = skip the check). */
  projectContext?: ProjectContext | null;
  /** A3 public compatibility probe seam for Orca-mode diagnostics. */
  orcaCompatibilityProbe?: () => Promise<OrcaPluginCompatibilityResult>;
  /**
   * Legacy marker-owned asset classifier. Omitted = the real statically-imported
   * group-2 classifier; explicit `null` = force the "classifier unavailable"
   * branch (tests only).
   */
  legacyClassifier?: LegacyClassifier | null;
}

export async function checkOrcaLifecycle(deps: DoctorDeps, probeLiveRuntime = true): Promise<CheckResult[]> {
  const state = inspectOrcaPluginLifecycle();
  const payloadStatus =
    state.payload === 'owned-clean' || (state.mode === 'standalone' && state.payload === 'unmanaged');
  const results: CheckResult[] = [
    {
      name: 'orchestration authority',
      status: state.mode === 'invalid' ? 'fail' : 'pass',
      detail: `mode=${state.mode}; payload=${state.payload}; host_registration=${state.hostRegistration}`,
      suggestion: state.recovery,
    },
  ];
  if (state.mode !== 'orca') return results;
  if (!payloadStatus) {
    const authority = results[0];
    if (authority !== undefined) results[0] = { ...authority, status: 'fail' };
    return results;
  }
  if (!probeLiveRuntime && deps.orcaCompatibilityProbe === undefined) return results;
  try {
    const probe =
      deps.orcaCompatibilityProbe ??
      (async () => {
        const { createOrcaPluginRuntime } = await import('../../plugins/genie/orca-runtime.js');
        return createOrcaPluginRuntime().probe();
      });
    const compatibility = await probe();
    results.push({
      name: 'Orca compatibility',
      status: 'pass',
      detail: `runtime=${compatibility.runtimeVersion}; contract=${compatibility.contract}; runtime_id=${compatibility.runtimeId}`,
    });
  } catch (error) {
    results.push({
      name: 'Orca compatibility',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
      suggestion: 'Use a supported Orca runtime, then retry `genie setup --orchestration-mode orca`.',
    });
  }
  return results;
}

/**
 * --fix: run the cleanups BEFORE the checks so the report reflects the post-fix
 * state, and AFTER the caller's Git resolution because the worktree cleanup is
 * scoped to the resolved repo root. Without --fix, detection only — both residue
 * checks are pure reads and nothing on disk changes. In --json mode stdout
 * belongs to the JSON document, so cleanup chatter goes to stderr.
 */
function runDoctorCleanups(options: { json?: boolean; fix?: boolean } | undefined, root: string | null): void {
  const cleanupOptions = options?.json ? { logSink: (line: string) => writeErr(`${line}\n`) } : {};
  if (options?.fix) {
    cleanupV4(cleanupOptions);
    cleanupLaunchWorktrees(root, cleanupOptions);
    // Mode repair runs AFTER worktree removal: the removal scan decides on the
    // pre-repair state, so a worktree whose only dirt is mode drift is never
    // removed in the same run that tightens it (removal stays fail-closed on
    // the state the user last saw; the next --fix may reclaim it).
    repairWorktreeModes(root, cleanupOptions);
  }
}

/** The `--fix-global-db` verb: repair, report, and decide the exit code alone. */
function renderGlobalDbRepair(json: boolean): void {
  const repair = repairGlobalDbContamination();
  if (json) out(JSON.stringify({ ok: repair.status !== 'failed', repair }, null, 2));
  else out(repair.message);
  if (repair.status === 'failed') process.exitCode = 1;
}

export async function doctorCommand(
  options?: { json?: boolean; fix?: boolean; fixGlobalDb?: boolean },
  deps: DoctorDeps = {},
): Promise<void> {
  // `--fix-global-db` is a repair VERB, not a diagnostic run: it performs the one
  // destructive act doctor owns and returns on its own result. It deliberately
  // does not run the other checks, so its exit code answers exactly one question
  // — "did the repair succeed?" — on a host whose unrelated warnings are not this
  // operator's problem. That is what makes the emitted remedy safe to paste.
  if (options?.fixGlobalDb) return renderGlobalDbRepair(options.json === true);

  // One bounded Git resolution and one bounded Codex plugin query feed every
  // downstream check. No doctor branch independently re-spawns either probe.
  const injectedRoot = deps.root === null || typeof deps.root === 'string';
  const gitRoots = injectedRoot ? null : resolveGitProjectRoots();
  const root = injectedRoot ? (deps.root ?? null) : (gitRoots?.worktreeRoot ?? null);
  const databaseRoot =
    deps.databaseRoot === null || typeof deps.databaseRoot === 'string'
      ? deps.databaseRoot
      : (gitRoots?.commonRoot ?? root);

  runDoctorCleanups(options, root);

  const pluginProbe = deps.pluginProbe?.cliAvailable !== undefined ? deps.pluginProbe : probeCodexGeniePlugin();
  const results: CheckResult[] = [
    ...checkGenieBinary(),
    ...(await checkOrcaLifecycle(deps, !injectedRoot || deps.orcaCompatibilityProbe !== undefined)),
    ...checkGit(root),
    ...checkDatabase(databaseRoot),
    ...checkGlobalDbContamination(),
    ...checkSkills(root),
    ...checkSkillsChannel(),
    ...checkWorkflowsChannel(),
    ...(await checkLegacyIntegrations(deps)),
    ...checkBun(deps.bunVersion, deps.bunPath),
    ...(await checkBudgets()),
    ...checkSubagentModelOverride(),
    ...(await checkCodexIntegration(root, pluginProbe)),
    // Live context resolution only when the root itself was live-resolved: an
    // injected root without an injected context is a unit-test seam, not a repo.
    ...checkCodexProjectContext(
      root,
      deps.projectContext !== undefined ? deps.projectContext : injectedRoot ? null : undefined,
    ),
    ...checkV4Residue(),
    ...checkLaunchWorktrees(root),
    ...checkWorktreeModes(root),
    ...checkIndexLaneDrift(root, databaseRoot),
    ...checkRetiredJsonMcpEntry(root),
    ...checkTrackedMachineState(root),
  ];

  const failed = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  if (options?.json) {
    out(JSON.stringify({ ok: failed.length === 0, checks: results }, null, 2));
  } else {
    out('genie doctor');
    out('');
    for (const line of results.flatMap(renderCheckLines)) out(line);
    out('');
    if (failed.length > 0) out(`\x1b[31m${failed.length} check(s) failed.\x1b[0m`);
    else if (warnings.length > 0) out(`\x1b[33m${warnings.length} warning(s) need attention.\x1b[0m`);
    else out('\x1b[32mAll checks passed.\x1b[0m');
  }

  if (failed.length > 0) process.exitCode = 1;
}
