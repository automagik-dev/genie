/**
 * v4 legacy manifest + detection + cleanup.
 *
 * The v4 daemon-era CLI left artifacts under the user's ~/.claude that v5
 * neither installs nor understands:
 *   - ~/.claude/rules/genie-orchestration.md — global orchestration rules
 *     pushing the dead daemon CLI (`genie spawn`, `genie team create`)
 *   - ~/.claude/plugins/cache/automagik/genie/4.* — v4 plugin cache version
 *     dirs, orphan-flagged by Claude Code with a `.orphaned_at` marker file
 *
 * This module is the ONE place that knows those paths. Both the install-time
 * cleanup (`genie install`, see install.ts) and `genie uninstall` consume it;
 * the literals must never be restated elsewhere (legacy-v4.test.ts enforces
 * this against uninstall.ts and install.sh).
 *
 * Cleanup is conservative by construction:
 *   - rules file: removed only when its content carries a v4 marker; anything
 *     else is treated as user-authored and left in place with a warning
 *   - plugin cache: only version dirs matching `4.*` AND carrying the
 *     `.orphaned_at` marker are removed; unmarked/live versions are untouched,
 *     as is anything outside the automagik/genie cache namespace
 *   - every removed file is backed up under
 *     <genieHome>/state-backups/v4-cleanup-<timestamp>/ preserving its
 *     home-relative structure; removed cache dirs back up a manifest listing
 *     instead of the payload (re-downloadable plugin content, can be large)
 *   - every action is printed to stdout and appended to
 *     <genieHome>/logs/v4-cleanup.log
 *   - a clean machine is a strict no-op: nothing printed, nothing written
 */

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { contractPath } from '../lib/genie-config.js';

// ============================================================================
// Manifest — the shared source of truth for every v4 legacy path
// ============================================================================

export type HomeResidueKind = 'file' | 'dir' | 'glob';

/**
 * A provably-dead v4 artifact under the genie home dir (GENIE_HOME / ~/.genie).
 * Entries are EXACT paths (or a single-`*` glob over direct children of the
 * parent dir) — never recursive guesses. Every entry carries its src-proof.
 */
export interface HomeResidueEntry {
  /** Path segments relative to the genie home dir. For `glob`, the last segment holds one `*`. */
  relPath: readonly string[];
  kind: HomeResidueKind;
  /** src-proof: why v5 provably never reads/writes this path. */
  evidence: string;
}

export interface V4LegacyManifest {
  /** Home-relative path segments of the v4 global orchestration rules file. */
  orchestrationRulesRelPath: readonly string[];
  /** Home-relative path segments of the Claude plugin-cache dir holding genie version dirs. */
  pluginCacheRelPath: readonly string[];
  /** Version-dir name prefix that scopes cleanup to v4 cache entries. */
  v4CacheVersionPrefix: string;
  /** Claude Code's marker file flagging a cache version dir as orphaned. */
  orphanMarkerFile: string;
  /** The rules file is provably genie-installed v4 iff its content contains at least one marker. */
  rulesContentMarkers: readonly string[];
  /** Daemon-era residue under the genie home dir. See each entry's src-proof. */
  homeResidue: readonly HomeResidueEntry[];
}

// src-proof method (2026-07-05): `grep -rn <name> src/ scripts/ plugins/genie/scripts/`
// on the v5 tree. "no refs" = zero hits outside tests. Deliberately EXCLUDED as
// live or uncertain: bin/, worktrees/, state-backups/, logs/* (except
// scheduler.log), genie.db*, config.json, keys/, plugins/, skills/, templates/,
// scripts/, tmux.conf (written by setup.ts:437), tmux*.conf.bak + tui-* +
// .generated.theme.conf (TUI/smart-install surface — uncertain, KEEP).
const HOME_RESIDUE: readonly HomeResidueEntry[] = [
  {
    relPath: ['serve.pid'],
    kind: 'file',
    evidence:
      'written only by the deleted v4 serve daemon; sole v5 ref is a tolerant diagnostic safeRead (update.ts) whose absent-path is the fresh-install norm',
  },
  { relPath: ['genie-serve.config.cjs'], kind: 'file', evidence: 'v4 pm2 serve config; no refs in v5 src' },
  { relPath: ['Genie.config.cjs'], kind: 'file', evidence: 'v4 daemon config; no refs in v5 src' },
  { relPath: ['hook-fallback.log'], kind: 'file', evidence: 'v4 hook-fallback writer deleted; no refs in v5 src' },
  { relPath: ['role-cutover-events.jsonl'], kind: 'file', evidence: 'v4 role-cutover log; no refs in v5 src' },
  { relPath: ['.role-cutover-*.json'], kind: 'glob', evidence: 'v4 role-cutover state stamps; no refs in v5 src' },
  {
    relPath: ['config.json.bak-pre-omni'],
    kind: 'file',
    evidence: 'one-shot migration backup of config.json; no refs in v5 src',
  },
  {
    relPath: ['logs', 'scheduler.log'],
    kind: 'file',
    evidence:
      'v4 scheduler daemon log; sole v5 ref is the update diagnostics tail (tolerant of absence, now age-filtered)',
  },
  {
    relPath: ['relay'],
    kind: 'dir',
    evidence: 'v4 relay artifacts; v5 OTel relay is port-only (codex-config.ts), no dir',
  },
  { relPath: ['spawn-scripts'], kind: 'dir', evidence: 'v4 spawn machinery; no refs in v5 src' },
  { relPath: ['state'], kind: 'dir', evidence: 'v4 wish-state JSONs; v5 state lives in genie.db (TAXONOMY.md)' },
  { relPath: ['model-a'], kind: 'dir', evidence: 'v4 experiment dir; no refs in v5 src' },
  { relPath: ['data'], kind: 'dir', evidence: 'v4 data dir; no refs in v5 src' },
];

export const V4_LEGACY_MANIFEST: V4LegacyManifest = {
  orchestrationRulesRelPath: ['.claude', 'rules', 'genie-orchestration.md'],
  pluginCacheRelPath: ['.claude', 'plugins', 'cache', 'automagik', 'genie'],
  v4CacheVersionPrefix: '4.',
  orphanMarkerFile: '.orphaned_at',
  rulesContentMarkers: ['genie spawn', 'genie team create'],
  homeResidue: HOME_RESIDUE,
};

/** Resolve the genie home dir the way the cleanup does everywhere. */
export function resolveGenieHome(home: string = homedir()): string {
  return process.env.GENIE_HOME ?? join(home, '.genie');
}

/** Absolute path of the v4 orchestration rules file for the given home dir. */
export function orchestrationRulesPath(home: string = homedir()): string {
  return join(home, ...V4_LEGACY_MANIFEST.orchestrationRulesRelPath);
}

/** Absolute path of the automagik/genie plugin-cache root for the given home dir. */
export function v4PluginCacheRoot(home: string = homedir()): string {
  return join(home, ...V4_LEGACY_MANIFEST.pluginCacheRelPath);
}

// ============================================================================
// Detection
// ============================================================================

export type RulesFileStatus = 'absent' | 'v4-markers' | 'user-modified';

export interface RulesFileRelic {
  path: string;
  status: RulesFileStatus;
}

export interface V4CacheRelic {
  /** Absolute path of the cache version dir. */
  path: string;
  /** Version dir basename, e.g. `4.260421.17`. */
  version: string;
  /** True when the dir carries the `.orphaned_at` marker (safe to remove). */
  orphaned: boolean;
}

export interface V4DetectionReport {
  rulesFile: RulesFileRelic;
  /** Every `4.*` version dir found under the genie plugin cache, orphaned or not. */
  cacheDirs: V4CacheRelic[];
  /** True when anything v4-era was found (actionable or merely reportable). */
  hasRelics: boolean;
}

/** Detect v4-era leftovers under the given home dir. Read-only. */
export function detectV4Install(home: string = homedir()): V4DetectionReport {
  const rulesPath = orchestrationRulesPath(home);
  let status: RulesFileStatus = 'absent';
  if (existsSync(rulesPath)) {
    try {
      const content = readFileSync(rulesPath, 'utf-8');
      status = V4_LEGACY_MANIFEST.rulesContentMarkers.some((marker) => content.includes(marker))
        ? 'v4-markers'
        : 'user-modified';
    } catch {
      // Unreadable → not provably ours; treat as user-modified so cleanup keeps it.
      status = 'user-modified';
    }
  }

  const cacheDirs: V4CacheRelic[] = [];
  const cacheRoot = v4PluginCacheRoot(home);
  if (existsSync(cacheRoot)) {
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      // isDirectory() is false for symlinks: never follow a link out of the cache.
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(V4_LEGACY_MANIFEST.v4CacheVersionPrefix)) continue;
      const dirPath = join(cacheRoot, entry.name);
      cacheDirs.push({
        path: dirPath,
        version: entry.name,
        orphaned: existsSync(join(dirPath, V4_LEGACY_MANIFEST.orphanMarkerFile)),
      });
    }
  }

  return {
    rulesFile: { path: rulesPath, status },
    cacheDirs,
    hasRelics: status !== 'absent' || cacheDirs.length > 0,
  };
}

// ============================================================================
// Home-residue detection (GENIE_HOME / ~/.genie)
// ============================================================================

export interface V4HomeResidueRelic {
  /** Absolute path of the found artifact. */
  path: string;
  /** Genie-home-relative display path, e.g. `logs/scheduler.log`. */
  relPath: string;
  kind: 'file' | 'dir';
  /** Bytes on disk (recursive for dirs; symlinks never followed). */
  sizeBytes: number;
  /** The manifest entry's src-proof. */
  evidence: string;
}

/** Bytes on disk for a file or tree (recursive; symlinks contribute 0, never followed). */
export function sizeOfPathTree(path: string): number {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += sizeOfPathTree(join(path, entry.name));
  }
  return total;
}

/** Expand a single-`*` glob entry against the DIRECT children of its parent dir. */
function expandGlobEntry(genieHome: string, entry: HomeResidueEntry): string[] {
  const parent = join(genieHome, ...entry.relPath.slice(0, -1));
  const pattern = entry.relPath[entry.relPath.length - 1];
  const [prefix, suffix] = pattern.split('*');
  try {
    if (!statSync(parent).isDirectory()) return [];
  } catch {
    return []; // parent absent or unreadable — nothing to expand
  }
  return readdirSync(parent)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
    .map((name) => join(parent, name));
}

/**
 * Detect v4 daemon-era residue under the genie home dir. Read-only — never
 * creates, writes, or logs anything (doctor without --fix relies on this).
 */
export function detectV4HomeResidue(genieHome: string = resolveGenieHome()): V4HomeResidueRelic[] {
  const relics: V4HomeResidueRelic[] = [];
  try {
    if (!statSync(genieHome).isDirectory()) return relics; // absent or not a dir — nothing to scan
  } catch {
    return relics;
  }
  for (const entry of V4_LEGACY_MANIFEST.homeResidue) {
    const paths = entry.kind === 'glob' ? expandGlobEntry(genieHome, entry) : [join(genieHome, ...entry.relPath)];
    for (const path of paths) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(path);
      } catch {
        continue; // absent — the v5-normal case
      }
      if (stat.isSymbolicLink()) continue; // never follow a link out of the home
      const isDir = stat.isDirectory();
      if (entry.kind === 'dir' && !isDir) continue; // shape mismatch → not ours, keep
      if (entry.kind === 'file' && isDir) continue;
      relics.push({
        path,
        relPath: relative(genieHome, path),
        kind: isDir ? 'dir' : 'file',
        sizeBytes: sizeOfPathTree(path),
        evidence: entry.evidence,
      });
    }
  }
  return relics;
}

// ============================================================================
// Uncertain keeps — observed v4-era names we deliberately NEVER touch
// (Decision 2: uncertain → KEEP, log-only report). Listed here so doctor can
// surface them; absent from the residue manifest so --fix cannot reach them.
// ============================================================================

export const HOME_UNCERTAIN_KEEPS: readonly string[] = [
  'tmux.conf.bak', // tmux*.conf surface is smart-install/TUI-managed
  'tui-tmux.conf.bak', // tui-* surface is TUI-managed
  '.generated.theme.conf', // theme artifact of unknown ownership
  '.genie', // nested ~/.genie/.genie oddity (possible GENIE_HOME misresolution)
];

/** Report-only: which uncertain-keep names exist under the genie home. Pure read. */
export function detectUncertainKeeps(genieHome: string = resolveGenieHome()): string[] {
  try {
    if (!statSync(genieHome).isDirectory()) return [];
  } catch {
    return [];
  }
  return HOME_UNCERTAIN_KEEPS.filter((name) => existsSync(join(genieHome, name)));
}

// ============================================================================
// Cleanup
// ============================================================================

export interface V4CleanupOptions {
  /** User home dir containing `.claude` (tests: fixture dir). Default: os.homedir(). */
  home?: string;
  /** Genie state dir for backups + logs. Default: $GENIE_HOME, else `<home>/.genie`. */
  genieHome?: string;
  /**
   * Where progress chatter goes. Default: stdout (console.log). Callers that
   * own stdout for a document (e.g. `doctor --fix --json`) pass a stderr sink.
   */
  logSink?: (line: string) => void;
}

export type V4CleanupActionKind =
  | 'removed-rules'
  | 'kept-rules-user-modified'
  | 'removed-cache'
  | 'kept-cache-unmarked'
  | 'removed-home-residue'
  | 'error';

export interface V4CleanupAction {
  kind: V4CleanupActionKind;
  path: string;
  backupPath?: string;
  detail?: string;
}

export interface V4CleanupResult {
  report: V4DetectionReport;
  /** v4 residue found under the genie home dir this run (removed unless errored). */
  homeResidue: V4HomeResidueRelic[];
  actions: V4CleanupAction[];
  /** Backup dir for this run, or null when nothing was removed. */
  backupDir: string | null;
  /** Append-only cleanup log; null when there was nothing to report or the log location was unwritable. */
  logFile: string | null;
  /** True when the machine was clean: nothing printed, nothing written. */
  noOp: boolean;
}

interface CleanupContext {
  home: string;
  backupRoot: string;
  backupDirUsed: boolean;
  actions: V4CleanupAction[];
  logLines: string[];
  emit: (line: string) => void;
}

function recordAction(ctx: CleanupContext, action: V4CleanupAction): void {
  ctx.actions.push(action);
  const backup = action.backupPath ? ` backup=${action.backupPath}` : '';
  const detail = action.detail ? ` detail=${action.detail}` : '';
  ctx.logLines.push(`${new Date().toISOString()} ${action.kind} ${action.path}${backup}${detail}`);
}

function warnFailure(ctx: CleanupContext, path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  ctx.emit(`  \x1b[33m!\x1b[0m Failed to clean ${contractPath(path)}: ${message}`);
  recordAction(ctx, { kind: 'error', path, detail: message });
}

/** Copy a home-relative file into the run's backup dir, preserving structure. */
function backupFile(ctx: CleanupContext, filePath: string): string {
  const dest = join(ctx.backupRoot, relative(ctx.home, filePath));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(filePath, dest);
  ctx.backupDirUsed = true;
  return dest;
}

function listRelativeFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else out.push(relative(root, entryPath));
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Back up a manifest (file listing + orphan timestamp) of a cache dir instead
 * of its payload — the payload is re-downloadable plugin content.
 */
function backupCacheManifest(ctx: CleanupContext, relic: V4CacheRelic): string {
  const dest = join(ctx.backupRoot, 'cache-manifests', `genie-${relic.version}.txt`);
  mkdirSync(dirname(dest), { recursive: true });
  let orphanedAt = '';
  try {
    orphanedAt = readFileSync(join(relic.path, V4_LEGACY_MANIFEST.orphanMarkerFile), 'utf-8').trim();
  } catch {
    // Marker unreadable — listing alone still documents what was removed.
  }
  const lines = [
    `# v4 plugin cache manifest — ${relic.path}`,
    `# removed: ${new Date().toISOString()}`,
    `# orphaned_at: ${orphanedAt}`,
    ...listRelativeFiles(relic.path),
  ];
  writeFileSync(dest, `${lines.join('\n')}\n`, 'utf-8');
  ctx.backupDirUsed = true;
  return dest;
}

function cleanupRulesFile(ctx: CleanupContext, relic: RulesFileRelic): void {
  if (relic.status === 'absent') return;
  const display = contractPath(relic.path);

  if (relic.status === 'user-modified') {
    ctx.emit(`  \x1b[33m!\x1b[0m Kept ${display} — no v4 markers found (user-modified?); not removing`);
    recordAction(ctx, { kind: 'kept-rules-user-modified', path: relic.path });
    return;
  }

  try {
    const backupPath = backupFile(ctx, relic.path);
    unlinkSync(relic.path);
    ctx.emit(`  \x1b[32m+\x1b[0m Removed ${display} (v4 orchestration rules)`);
    recordAction(ctx, { kind: 'removed-rules', path: relic.path, backupPath });
  } catch (error) {
    warnFailure(ctx, relic.path, error);
  }
}

function cleanupCacheDirs(ctx: CleanupContext, relics: V4CacheRelic[]): void {
  for (const relic of relics) {
    const display = contractPath(relic.path);
    if (!relic.orphaned) {
      ctx.emit(
        `  \x1b[2mKept ${display} — no ${V4_LEGACY_MANIFEST.orphanMarkerFile} marker (not provably orphaned)\x1b[0m`,
      );
      recordAction(ctx, { kind: 'kept-cache-unmarked', path: relic.path });
      continue;
    }
    try {
      const backupPath = backupCacheManifest(ctx, relic);
      rmSync(relic.path, { recursive: true, force: true });
      ctx.emit(`  \x1b[32m+\x1b[0m Removed orphaned v4 plugin cache ${relic.version}`);
      recordAction(ctx, { kind: 'removed-cache', path: relic.path, backupPath });
    } catch (error) {
      warnFailure(ctx, relic.path, error);
    }
  }
}

/**
 * Remove genie-home residue, backup-first. Unlike plugin caches (re-downloadable,
 * manifest-only backup), home residue is machine-unique — the FULL content is
 * copied to `<backupRoot>/genie-home/<relPath>` before removal.
 */
function cleanupHomeResidue(ctx: CleanupContext, relics: V4HomeResidueRelic[]): void {
  for (const relic of relics) {
    try {
      const backupPath = join(ctx.backupRoot, 'genie-home', relic.relPath);
      mkdirSync(dirname(backupPath), { recursive: true });
      cpSync(relic.path, backupPath, { recursive: true });
      ctx.backupDirUsed = true;
      rmSync(relic.path, { recursive: true, force: true });
      ctx.emit(`  \x1b[32m+\x1b[0m Removed v4 residue ${contractPath(relic.path)}`);
      recordAction(ctx, { kind: 'removed-home-residue', path: relic.path, backupPath });
    } catch (error) {
      warnFailure(ctx, relic.path, error);
    }
  }
}

function writeCleanupLog(genieHome: string, logLines: string[]): string {
  const logsDir = join(genieHome, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const logFile = join(logsDir, 'v4-cleanup.log');
  appendFileSync(logFile, `${logLines.join('\n')}\n`, 'utf-8');
  return logFile;
}

/**
 * Remove v4-era leftovers with backup + log. Idempotent: a machine with no
 * relics is a strict no-op. Independently invokable (used by `genie install`
 * and machine-QA); never throws on per-relic failures — they are reported as
 * `error` actions instead.
 */
export function cleanupV4(options: V4CleanupOptions = {}): V4CleanupResult {
  const home = options.home ?? homedir();
  const genieHome = options.genieHome ?? process.env.GENIE_HOME ?? join(home, '.genie');
  const report = detectV4Install(home);
  const homeResidue = detectV4HomeResidue(genieHome);
  if (!report.hasRelics && homeResidue.length === 0) {
    return { report, homeResidue, actions: [], backupDir: null, logFile: null, noOp: true };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ctx: CleanupContext = {
    home,
    backupRoot: join(genieHome, 'state-backups', `v4-cleanup-${stamp}`),
    backupDirUsed: false,
    actions: [],
    logLines: [],
    emit: options.logSink ?? ((line: string) => console.log(line)),
  };

  ctx.emit('\x1b[2mCleaning up v4 leftovers...\x1b[0m');
  cleanupRulesFile(ctx, report.rulesFile);
  cleanupCacheDirs(ctx, report.cacheDirs);
  cleanupHomeResidue(ctx, homeResidue);

  // An unwritable GENIE_HOME must degrade gracefully (stderr warning, no raw
  // stack) — the cleanup step still reports its actions and exits 0.
  let logFile: string | null = null;
  try {
    logFile = writeCleanupLog(genieHome, ctx.logLines);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  \x1b[33m!\x1b[0m Could not write v4-cleanup log under ${contractPath(genieHome)}: ${message}`);
  }
  if (ctx.backupDirUsed) {
    ctx.emit(`  \x1b[2mBackups: ${contractPath(ctx.backupRoot)}\x1b[0m`);
  }
  if (logFile) {
    ctx.emit(`  \x1b[2mLog: ${contractPath(logFile)}\x1b[0m`);
  }

  return {
    report,
    homeResidue,
    actions: ctx.actions,
    backupDir: ctx.backupDirUsed ? ctx.backupRoot : null,
    logFile,
    noOp: false,
  };
}
