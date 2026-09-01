#!/usr/bin/env bun

/**
 * Pre-build script: generates date-based version and updates ALL version files
 * Format: 5.YYMMDD.N (e.g., 5.260201.1 = Feb 1, 2026, first publish of the day)
 * N increments per day: .1, .2, .3, etc.
 *
 * v5 kept the daily-counter scheme from v4 — only the leading major moved
 * 4.→5.. The counter is derived by counting existing `v5.<date>.*` git tags,
 * so the first v5 build of a day is .1 regardless of how many v4 builds
 * preceded it.
 *
 * Syncs versions across:
 * - package.json (root)
 * - plugins/genie/orca-plugin.json (Orca)
 * - plugins/genie/package.json (runtime payload metadata)
 *
 * `--check` is the read-only mode: it reports that exact target set and whether
 * each file is bump-ready, then exits 0 without writing. The BARE command always
 * performs a real bump, so `--check` is the only form safe to run as validation.
 *
 * CI staging (GITHUB_ACTIONS only): after rewriting, this script `git add`s every
 * file it actually touched. This exists because the release workflow's own
 * `git add -A '*.json' 'src/lib/version.ts'` list re-guesses the version-carrying
 * file set instead of reading it from here, so a bump could ship with a stale
 * manifest (defect D2). The list of version files lives here, not in the
 * workflow, so this is the one place that always knows the full set. Keeping the
 * fix here (rather than in the workflow) matters because `.github/workflows/**`
 * can't always be updated in the same change — some environments lack
 * workflow-scoped push credentials.
 */

import { execFileSync, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';

// Count existing versions for today from git tags
function getTodayPublishCount(datePrefix: string): number {
  try {
    const output = execSync(`git tag --list "v5.${datePrefix}.*"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Generate version: 5.YYMMDD.N where N = daily publish counter
function generateVersion(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;

  const existing = getTodayPublishCount(datePrefix);
  const n = existing + 1;

  return `5.${datePrefix}.${n}`;
}

export async function updateJsonVersion(filePath: string, version: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ Skipped (not found): ${filePath}`);
    return false;
  }
  try {
    const source = await readFile(filePath, 'utf-8');
    const json = JSON.parse(source) as { version?: unknown };
    if (typeof json.version !== 'string') throw new Error('top-level version must be a string');
    const updated = replaceTopLevelStringProperty(source, 'version', version);
    await writeFile(filePath, updated);
    console.log(`  ✓ ${filePath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed: ${filePath}`, err);
    return false;
  }
}

async function assertVersionFileShape(filePath: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error('file is missing');
  const source = await readFile(filePath, 'utf-8');
  const parsed: unknown = JSON.parse(source);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('metadata must be an object');
  if (typeof Reflect.get(parsed, 'version') !== 'string') throw new Error('top-level version must be a string');
  replaceTopLevelStringProperty(source, 'version', Reflect.get(parsed, 'version') as string);
}

/**
 * In CI only, stage the files this sync actually rewrote so the auto-version
 * commit ships them. Under GITHUB_ACTIONS a git failure must fail the sync —
 * silently warning and continuing re-introduces the version-skew defect this
 * staging exists to prevent (the workflow's own `git add` list is stale and
 * re-guesses the set). Uses an arg-array (never a shell string) so paths
 * can't be interpolated into a command line.
 */
function stageRewrittenFilesInCi(rootDir: string, paths: string[]): void {
  if (process.env.GITHUB_ACTIONS !== 'true' || paths.length === 0) return;
  try {
    execFileSync('git', ['add', '--', ...paths], { cwd: rootDir, stdio: 'pipe' });
  } catch (err) {
    throw new Error(`CI staging failed (git add): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * The authoritative version-file set, in stamping order. Three files since wish
 * `skills-everywhere-b` retired the Codex/Claude/Kimi/Hermes/pi manifests; the
 * same list is enumerated by `scripts/release-payload-version.ts`,
 * `scripts/release-guard.sh` and `.github/workflows/version.yml`, which is why
 * `--check` exists: it is the only way to read this set without bumping.
 */
export const VERSION_FILES = ['package.json', 'plugins/genie/orca-plugin.json', 'plugins/genie/package.json'] as const;

export function versionFilePaths(rootDir: string): string[] {
  return VERSION_FILES.map((relativePath) => join(rootDir, relativePath));
}

export interface VersionCheckReport {
  targets: string[];
  failures: string[];
}

/**
 * Read-only companion to `synchronizeVersionFiles`: report the exact bump
 * targets and whether each is shaped so a bump could stamp it, WITHOUT writing
 * anything and without deriving a new version. The bare command performs a real
 * bump, so this is the only runnable verification of the version-file set.
 */
export async function versionCheckReport(rootDir: string): Promise<VersionCheckReport> {
  const targets = versionFilePaths(rootDir);
  const failures: string[] = [];
  for (const path of targets) {
    try {
      await assertVersionFileShape(path);
    } catch (error) {
      failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { targets, failures };
}

/** Update every authoritative version file and fail the command on any partial write. */
export async function synchronizeVersionFiles(rootDir: string, version: string): Promise<void> {
  const paths = versionFilePaths(rootDir);
  const preflightFailures: string[] = [];
  for (const path of paths) {
    try {
      await assertVersionFileShape(path);
    } catch (error) {
      preflightFailures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (preflightFailures.length > 0) {
    throw new Error(`version synchronization preflight failed for: ${preflightFailures.join('; ')}`);
  }

  const outcomes: Array<{ path: string; ok: boolean }> = [];
  for (const path of paths) outcomes.push({ path, ok: await updateJsonVersion(path, version) });

  // Stage every file we actually rewrote so CI commits the full set.
  stageRewrittenFilesInCi(
    rootDir,
    outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.path),
  );

  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.path);
  if (failed.length > 0) throw new Error(`version synchronization failed for: ${failed.join(', ')}`);
}

async function runCheck(rootDir: string): Promise<void> {
  const report = await versionCheckReport(rootDir);
  console.log(`version --check: ${report.targets.length} version file(s), no writes performed`);
  for (const relativePath of VERSION_FILES) console.log(`  • ${relativePath}`);
  if (report.failures.length > 0) {
    throw new Error(`version files are not bump-ready:\n  ${report.failures.join('\n  ')}`);
  }
  console.log('\n✅ Every version file is present and bump-ready');
}

async function main() {
  const rootDir = join(dirname(import.meta.path), '..');
  const argv = process.argv.slice(2);

  // Argument handling is deliberately strict and comes BEFORE any mutation: the
  // bare command performs a real, irreversible bump, so an unrecognized flag
  // must never degrade into one.
  if (argv.length > 0) {
    if (argv.length === 1 && argv[0] === '--check') {
      await runCheck(rootDir);
      return;
    }
    throw new Error(`usage: bun scripts/version.ts [--check]  (got: ${argv.join(' ')})`);
  }

  const version = generateVersion();

  console.log(`Version: ${version}`);
  console.log('Updating files:');

  await synchronizeVersionFiles(rootDir, version);

  console.log('\n✅ All versions synchronized');
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('Version script failed:', err);
    process.exit(1);
  });
}
