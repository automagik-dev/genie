/**
 * Migrate — Convert symlinked agents into physical directories.
 *
 * Provides a plan-then-execute workflow:
 *   1. `planMigration()` scans agents/ for symlinks, evaluates risks
 *   2. `executeMigration()` replaces symlinks with physical copies
 *   3. `rollbackMigration()` reverses the last batch from journal
 *
 * All operations are journaled to `.genie/migration-journal.json` for
 * safe rollback.
 *
 * Used by:
 *   - `genie migrate` (CLI command)
 *   - Future: automated layout migration on `genie init`
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// ============================================================================
// Types
// ============================================================================

export interface MigrationPlan {
  agent: string;
  from: string; // absolute path to real source directory
  to: string; // absolute path to destination in agents/
  method: 'git-mv' | 'copy';
  risks: string[]; // human-readable risk descriptions
}

export interface MigrationJournalEntry {
  agent: string;
  from: string;
  to: string;
  timestamp: string; // ISO 8601
  method: 'git-mv' | 'copy';
  batchId: string; // UUID shared across all entries from one genie migrate run
}

export interface MigrationResult {
  migrated: string[];
  skipped: string[];
  errors: Array<{ agent: string; error: string }>;
  batchId: string;
}

export interface RollbackResult {
  rolledBack: string[];
  errors: Array<{ agent: string; error: string }>;
}

// ============================================================================
// Risk detection helpers
// ============================================================================

/**
 * Check whether a path lives inside a separate git repo from the workspace.
 * Walks up from `path` looking for `.git`. If the git root differs from
 * the workspace's git root, returns true.
 */
export function isInsideSeparateGitRepo(path: string, workspaceRoot: string): boolean {
  const pathGitRoot = findGitRoot(path);
  if (!pathGitRoot) return false;

  const workspaceGitRoot = findGitRoot(workspaceRoot);
  if (!workspaceGitRoot) return false;

  return pathGitRoot !== workspaceGitRoot;
}

/** Walk up from `dir` to find the nearest `.git` directory. Returns the parent of `.git` or null. */
function findGitRoot(dir: string): string | null {
  let current = resolve(dir);
  const root = resolve('/');

  while (current !== root) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Check whether an agent directory has uncommitted changes.
 * Runs `git status --porcelain` in the directory.
 */
export function hasDirtyWorkingTree(agentDir: string): boolean {
  try {
    const output = execSync(`git -C "${agentDir}" status --porcelain`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim().length > 0;
  } catch {
    // Not a git repo or git not available — not dirty
    return false;
  }
}

// ============================================================================
// Internal symlink recalculation
// ============================================================================

/**
 * Recursively scan `dir` for symlinks and recompute their relative targets.
 *
 * When a directory moves from `oldBase` to `newBase`, any relative symlinks
 * inside it may break because the relationship between the link location
 * and the target has changed. This function resolves each symlink's intended
 * target (relative to oldBase) and rewrites it relative to newBase.
 */
export function recalculateInternalSymlinks(dir: string, oldBase: string, newBase: string): void {
  if (!existsSync(dir)) return;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = safeLstat(fullPath);
    if (!stat) continue;

    if (stat.isSymbolicLink()) {
      rewriteRelativeSymlink(fullPath, oldBase, newBase);
    } else if (stat.isDirectory()) {
      recalculateInternalSymlinks(fullPath, oldBase, newBase);
    }
  }
}

/** Rewrite a single relative symlink after its parent directory has moved. */
function rewriteRelativeSymlink(fullPath: string, oldBase: string, newBase: string): void {
  const linkTarget = readlinkSync(fullPath);

  // Only recalculate relative symlinks — leave absolute ones untouched
  if (linkTarget.startsWith('/')) return;

  // Resolve where this symlink pointed when it lived under oldBase
  const relativeInDir = relative(newBase, fullPath);
  const oldLinkLocation = join(oldBase, relativeInDir);
  const absoluteTarget = resolve(dirname(oldLinkLocation), linkTarget);

  // Check if resolved target exists; if not, it's a broken symlink
  if (!existsSync(absoluteTarget)) {
    process.stderr.write(`[migrate] warning: broken symlink at ${fullPath} -> ${linkTarget}\n`);
    return;
  }

  // Recompute relative path from the new link location
  const newRelativeTarget = relative(dirname(fullPath), absoluteTarget);
  if (newRelativeTarget !== linkTarget) {
    try {
      unlinkSync(fullPath);
      symlinkSync(newRelativeTarget, fullPath);
    } catch (err) {
      process.stderr.write(
        `[migrate] warning: failed to recalculate symlink at ${fullPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** Safe lstat — returns null on error instead of throwing. */
function safeLstat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// ============================================================================
// Copy helper — preserves relative symlinks (Bun's cpSync does not)
// ============================================================================

/**
 * Recursively copy a directory, preserving relative symlinks as-is.
 * Bun's `cpSync` rewrites symlink targets to absolute paths, which breaks
 * portable layouts. This helper copies files and dirs normally but recreates
 * symlinks with their original target string.
 */
function copyDirPreservingSymlinks(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });

  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    const stat = lstatSync(srcPath);

    if (stat.isSymbolicLink()) {
      const target = readlinkSync(srcPath);
      symlinkSync(target, destPath);
    } else if (stat.isDirectory()) {
      copyDirPreservingSymlinks(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

// ============================================================================
// Journal management
// ============================================================================

function journalPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.genie', 'migration-journal.json');
}

function readJournal(workspaceRoot: string): MigrationJournalEntry[] {
  const path = journalPath(workspaceRoot);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return [];
  }
}

function writeJournal(workspaceRoot: string, entries: MigrationJournalEntry[]): void {
  const path = journalPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries, null, 2), 'utf-8');
}

function appendJournalEntry(workspaceRoot: string, entry: MigrationJournalEntry): void {
  const entries = readJournal(workspaceRoot);
  entries.push(entry);
  writeJournal(workspaceRoot, entries);
}

// ============================================================================
// Git tracking check
// ============================================================================

/** Check if a file/directory is tracked by git. */
function isGitTracked(path: string): boolean {
  try {
    execSync(`git ls-files --error-unmatch "${path}"`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: dirname(path),
    });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Plan
// ============================================================================

/**
 * Scan the agents/ directory and build a migration plan for each symlinked agent.
 *
 * Non-symlink directories are skipped (already physical). For each symlink,
 * resolves the real path and checks for risks (cross-repo, dirty tree).
 */
export function planMigration(workspaceRoot: string): MigrationPlan[] {
  const agentsDir = join(workspaceRoot, 'agents');
  if (!existsSync(agentsDir)) return [];

  const plans: MigrationPlan[] = [];
  let entries: string[];

  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }

  for (const name of entries) {
    const linkPath = join(agentsDir, name);
    const stat = safeLstat(linkPath);
    if (!stat) continue;

    // Only process symlinks — physical dirs don't need migration
    if (!stat.isSymbolicLink()) continue;

    let realPath: string;
    try {
      realPath = realpathSync(linkPath);
    } catch {
      continue; // Broken symlink — skip
    }

    const risks: string[] = [];

    if (isInsideSeparateGitRepo(realPath, workspaceRoot)) {
      risks.push('Cross-repo agent');
    }

    if (hasDirtyWorkingTree(realPath)) {
      risks.push('Uncommitted changes');
    }

    const method = isGitTracked(realPath) ? 'git-mv' : 'copy';

    plans.push({
      agent: name,
      from: realPath,
      to: linkPath,
      method,
      risks,
    });
  }

  return plans;
}

// ============================================================================
// Execute
// ============================================================================

/**
 * Execute a migration plan — replace symlinks with physical directories.
 *
 * For each plan entry:
 *   1. Check risks (skip cross-repo without force, abort on dirty)
 *   2. Remove symlink
 *   3. Copy or git-mv the source to destination
 *   4. Recalculate internal symlinks
 *   5. Journal the migration
 *
 * On failure for any agent, cleans up and records the error.
 */
export function executeMigration(
  workspaceRoot: string,
  plan: MigrationPlan[],
  opts: { force?: boolean; noGit?: boolean } = {},
): MigrationResult {
  const batchId = crypto.randomUUID();
  const result: MigrationResult = { migrated: [], skipped: [], errors: [], batchId };

  for (const entry of plan) {
    if (entry.risks.includes('Cross-repo agent') && !opts.force) {
      result.skipped.push(entry.agent);
      continue;
    }
    if (entry.risks.includes('Uncommitted changes')) {
      result.errors.push({ agent: entry.agent, error: 'Uncommitted changes in source directory' });
      continue;
    }
    migrateOneAgent(workspaceRoot, entry, opts, batchId, result);
  }

  return result;
}

/** Migrate a single agent entry — move files, recalculate symlinks, journal. */
function migrateOneAgent(
  workspaceRoot: string,
  entry: MigrationPlan,
  opts: { force?: boolean; noGit?: boolean },
  batchId: string,
  result: MigrationResult,
): void {
  try {
    unlinkSync(entry.to);
    moveAgentFiles(workspaceRoot, entry, opts);
    recalculateInternalSymlinks(entry.to, entry.from, entry.to);

    appendJournalEntry(workspaceRoot, {
      agent: entry.agent,
      from: entry.from,
      to: entry.to,
      timestamp: new Date().toISOString(),
      method: entry.method,
      batchId,
    });
    result.migrated.push(entry.agent);
  } catch (err) {
    cleanupFailedMigration(entry);
    result.errors.push({
      agent: entry.agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Move agent files via git-mv or copy, depending on method and options. */
function moveAgentFiles(workspaceRoot: string, entry: MigrationPlan, opts: { noGit?: boolean }): void {
  if (entry.method === 'git-mv' && !opts.noGit) {
    try {
      execSync(`git mv "${entry.from}" "${entry.to}"`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: workspaceRoot,
      });
      return;
    } catch {
      // git mv failed — fall back to copy
    }
  }
  copyDirPreservingSymlinks(entry.from, entry.to);
  rmSync(entry.from, { recursive: true, force: true });
}

/** Clean up a failed migration attempt — remove partial dest, restore symlink. */
function cleanupFailedMigration(entry: MigrationPlan): void {
  try {
    if (existsSync(entry.to)) {
      rmSync(entry.to, { recursive: true, force: true });
    }
    symlinkSync(relative(dirname(entry.to), entry.from), entry.to);
  } catch {
    // Best-effort cleanup
  }
}

// ============================================================================
// Rollback
// ============================================================================

/**
 * Rollback the most recent migration batch.
 *
 * Reads the journal, finds the latest batch, and reverses each move:
 *   1. Copy the destination back to the source
 *   2. Remove the destination
 *   3. Recreate the symlink (relative)
 *
 * Removes rolled-back entries from the journal.
 */
export function rollbackMigration(workspaceRoot: string): RollbackResult {
  const result: RollbackResult = { rolledBack: [], errors: [] };
  const entries = readJournal(workspaceRoot);
  if (entries.length === 0) return result;

  const latestBatchId = findLatestBatchId(entries);
  const batchEntries = entries.filter((e) => e.batchId === latestBatchId);

  // Process in reverse order
  for (const entry of [...batchEntries].reverse()) {
    rollbackOneEntry(entry, result);
  }

  // Remove rolled-back entries from journal
  const remaining = entries.filter((e) => e.batchId !== latestBatchId);
  writeJournal(workspaceRoot, remaining);

  return result;
}

/** Find the batchId with the most recent timestamp across all journal entries. */
function findLatestBatchId(entries: MigrationJournalEntry[]): string {
  let latestBatchId = '';
  let latestTimestamp = '';
  for (const entry of entries) {
    if (entry.timestamp > latestTimestamp) {
      latestTimestamp = entry.timestamp;
      latestBatchId = entry.batchId;
    }
  }
  return latestBatchId;
}

/** Rollback a single journal entry — restore source, recreate symlink. */
function rollbackOneEntry(entry: MigrationJournalEntry, result: RollbackResult): void {
  try {
    if (existsSync(entry.to)) {
      mkdirSync(dirname(entry.from), { recursive: true });
      copyDirPreservingSymlinks(entry.to, entry.from);
      rmSync(entry.to, { recursive: true, force: true });
    }
    symlinkSync(relative(dirname(entry.to), entry.from), entry.to);
    result.rolledBack.push(entry.agent);
  } catch (err) {
    result.errors.push({
      agent: entry.agent,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
