#!/usr/bin/env bun
/**
 * archive-orphan-team-configs — filesystem cleanup for `<claudeConfigDir>/teams/`.
 *
 * Wish: invincible-genie / Group 5.
 *
 * Some team configs land on disk without a `config.json` (only `inboxes/`)
 * because `qa-runner.ts` and other code paths bail mid-way through team
 * creation. The inbox-watcher then logs `Cannot spawn team-lead for <X>
 * — no workingDir in config` until `MAX_SPAWN_FAILURES` silences it. Live
 * evidence (2026-04-26): 13 stale `qa-moak*` directories from a 2026-04-22
 * QA run accumulated this way.
 *
 * Strategy:
 *   For every directory `<claudeConfigDir>/teams/<name>/`:
 *     • If `config.json` exists → leave it alone.
 *     • Else inspect `inboxes/`:
 *         - "Active orphan": at least one inbox file is non-empty AND
 *           was modified within `ACTIVE_THRESHOLD_HOURS`. Leave on disk
 *           and emit on the active-orphan list (so `genie status` can
 *           surface a `genie team repair <name>` action).
 *         - "Stale orphan": no inbox files OR all inbox files are empty
 *           OR no file has been touched in the threshold window.
 *           Move the entire dir to `<claudeConfigDir>/teams/_archive/<name>-<unix-ts>/`.
 *
 * Idempotent: re-running classifies the same dirs the same way, and
 * archived dirs can never become active orphans because they live under
 * `_archive/` (skipped at the entry point).
 *
 * Invoked once by the migration runner via `genie doctor --fix-team-orphans`,
 * and exposed standalone for operators who want to dry-run.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ACTIVE_THRESHOLD_HOURS = 24;
const ACTIVE_THRESHOLD_MS = ACTIVE_THRESHOLD_HOURS * 60 * 60 * 1000;

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
}

function teamsBaseDir(): string {
  return join(claudeConfigDir(), 'teams');
}

function archiveBaseDir(): string {
  return join(teamsBaseDir(), '_archive');
}

export type OrphanClassification = 'active' | 'stale' | 'has-config';

export interface OrphanDecision {
  team: string;
  classification: OrphanClassification;
  /** Reason summary for logs / `genie status` rendering. */
  reason: string;
  /** Path that was archived to (only set for `stale` after dry-run=false). */
  archivedTo?: string;
}

/**
 * Classify a single team directory. Pure — no filesystem mutation.
 */
export function classifyTeamDir(dirPath: string, now: number = Date.now()): OrphanClassification {
  if (!existsSync(dirPath)) return 'stale';
  if (existsSync(join(dirPath, 'config.json'))) return 'has-config';

  const inboxes = join(dirPath, 'inboxes');
  if (!existsSync(inboxes)) return 'stale';

  let entries: string[];
  try {
    entries = readdirSync(inboxes);
  } catch {
    return 'stale';
  }
  if (entries.length === 0) return 'stale';

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const path = join(inboxes, entry);
    try {
      const st = statSync(path);
      if (st.size <= 2) continue; // empty `[]` or `{}`
      if (now - st.mtimeMs > ACTIVE_THRESHOLD_MS) continue;
      return 'active';
    } catch {
      // unreadable — treat as stale-leaning, fall through
    }
  }
  return 'stale';
}

export interface ArchiveOpts {
  /** When true, classify only — do not move anything. */
  dryRun?: boolean;
  /** Override the base for tests. */
  baseDir?: string;
  /** Override `now` for tests. */
  now?: number;
}

/**
 * Walk `<claudeConfigDir>/teams/`, classify each entry, archive stale orphans.
 * Returns the per-dir decision so `genie status` and the migration runner
 * can render whatever they need.
 */
export function archiveOrphanTeamConfigs(opts: ArchiveOpts = {}): OrphanDecision[] {
  const dryRun = opts.dryRun ?? false;
  const base = opts.baseDir ?? teamsBaseDir();
  const now = opts.now ?? Date.now();
  if (!existsSync(base)) return [];

  let entries: string[];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }

  const archiveBase = opts.baseDir ? join(opts.baseDir, '_archive') : archiveBaseDir();
  const decisions: OrphanDecision[] = [];

  for (const name of entries) {
    if (name === '_archive' || name.startsWith('.')) continue;
    const dirPath = join(base, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const classification = classifyTeamDir(dirPath, now);
    if (classification === 'has-config') {
      decisions.push({ team: name, classification, reason: 'config.json present' });
      continue;
    }
    if (classification === 'active') {
      decisions.push({
        team: name,
        classification,
        reason: 'inbox messages newer than 24h — needs `genie team repair`',
      });
      continue;
    }

    // Stale: archive it (unless dry-run).
    if (dryRun) {
      decisions.push({ team: name, classification, reason: 'no recent inbox activity' });
      continue;
    }

    if (!existsSync(archiveBase)) {
      mkdirSync(archiveBase, { recursive: true });
    }
    const ts = Math.floor(now / 1000);
    const archivedTo = join(archiveBase, `${name}-${ts}`);
    try {
      renameSync(dirPath, archivedTo);
      decisions.push({ team: name, classification, reason: 'archived (no recent inbox activity)', archivedTo });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      decisions.push({ team: name, classification, reason: `archive failed: ${msg}` });
    }
  }

  return decisions;
}

// CLI entry: run when invoked directly.
if (import.meta.path === Bun.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const decisions = archiveOrphanTeamConfigs({ dryRun });
  for (const d of decisions) {
    const tag = d.classification === 'stale' ? (dryRun ? 'WOULD ARCHIVE' : 'ARCHIVED') : d.classification.toUpperCase();
    console.log(`  [${tag}] ${d.team}  — ${d.reason}${d.archivedTo ? ` → ${d.archivedTo}` : ''}`);
  }
  console.log(`\n  ${decisions.length} team dir${decisions.length === 1 ? '' : 's'} inspected`);
}
