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
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { contractPath } from '../lib/genie-config.js';

// ============================================================================
// Manifest — the shared source of truth for every v4 legacy path
// ============================================================================

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
}

export const V4_LEGACY_MANIFEST: V4LegacyManifest = {
  orchestrationRulesRelPath: ['.claude', 'rules', 'genie-orchestration.md'],
  pluginCacheRelPath: ['.claude', 'plugins', 'cache', 'automagik', 'genie'],
  v4CacheVersionPrefix: '4.',
  orphanMarkerFile: '.orphaned_at',
  rulesContentMarkers: ['genie spawn', 'genie team create'],
};

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
// Cleanup
// ============================================================================

export interface V4CleanupOptions {
  /** User home dir containing `.claude` (tests: fixture dir). Default: os.homedir(). */
  home?: string;
  /** Genie state dir for backups + logs. Default: $GENIE_HOME, else `<home>/.genie`. */
  genieHome?: string;
}

export type V4CleanupActionKind =
  | 'removed-rules'
  | 'kept-rules-user-modified'
  | 'removed-cache'
  | 'kept-cache-unmarked'
  | 'error';

export interface V4CleanupAction {
  kind: V4CleanupActionKind;
  path: string;
  backupPath?: string;
  detail?: string;
}

export interface V4CleanupResult {
  report: V4DetectionReport;
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
}

function recordAction(ctx: CleanupContext, action: V4CleanupAction): void {
  ctx.actions.push(action);
  const backup = action.backupPath ? ` backup=${action.backupPath}` : '';
  const detail = action.detail ? ` detail=${action.detail}` : '';
  ctx.logLines.push(`${new Date().toISOString()} ${action.kind} ${action.path}${backup}${detail}`);
}

function warnFailure(ctx: CleanupContext, path: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`  \x1b[33m!\x1b[0m Failed to clean ${contractPath(path)}: ${message}`);
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
    console.log(`  \x1b[33m!\x1b[0m Kept ${display} — no v4 markers found (user-modified?); not removing`);
    recordAction(ctx, { kind: 'kept-rules-user-modified', path: relic.path });
    return;
  }

  try {
    const backupPath = backupFile(ctx, relic.path);
    unlinkSync(relic.path);
    console.log(`  \x1b[32m+\x1b[0m Removed ${display} (v4 orchestration rules)`);
    recordAction(ctx, { kind: 'removed-rules', path: relic.path, backupPath });
  } catch (error) {
    warnFailure(ctx, relic.path, error);
  }
}

function cleanupCacheDirs(ctx: CleanupContext, relics: V4CacheRelic[]): void {
  for (const relic of relics) {
    const display = contractPath(relic.path);
    if (!relic.orphaned) {
      console.log(
        `  \x1b[2mKept ${display} — no ${V4_LEGACY_MANIFEST.orphanMarkerFile} marker (not provably orphaned)\x1b[0m`,
      );
      recordAction(ctx, { kind: 'kept-cache-unmarked', path: relic.path });
      continue;
    }
    try {
      const backupPath = backupCacheManifest(ctx, relic);
      rmSync(relic.path, { recursive: true, force: true });
      console.log(`  \x1b[32m+\x1b[0m Removed orphaned v4 plugin cache ${relic.version}`);
      recordAction(ctx, { kind: 'removed-cache', path: relic.path, backupPath });
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
  if (!report.hasRelics) {
    return { report, actions: [], backupDir: null, logFile: null, noOp: true };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const ctx: CleanupContext = {
    home,
    backupRoot: join(genieHome, 'state-backups', `v4-cleanup-${stamp}`),
    backupDirUsed: false,
    actions: [],
    logLines: [],
  };

  console.log('\x1b[2mCleaning up v4 leftovers...\x1b[0m');
  cleanupRulesFile(ctx, report.rulesFile);
  cleanupCacheDirs(ctx, report.cacheDirs);

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
    console.log(`  \x1b[2mBackups: ${contractPath(ctx.backupRoot)}\x1b[0m`);
  }
  if (logFile) {
    console.log(`  \x1b[2mLog: ${contractPath(logFile)}\x1b[0m`);
  }

  return {
    report,
    actions: ctx.actions,
    backupDir: ctx.backupDirUsed ? ctx.backupRoot : null,
    logFile,
    noOp: false,
  };
}
