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
 * - plugins/genie/.claude-plugin/plugin.json (Claude Code)
 * - plugins/genie/.codex-plugin/plugin.json (Codex)
 * - plugins/genie/package.json (smart-install version checks)
 * - .claude-plugin/marketplace.json (marketplace listing)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

async function updateJsonVersion(filePath: string, version: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ Skipped (not found): ${filePath}`);
    return false;
  }
  try {
    const json = JSON.parse(await readFile(filePath, 'utf-8'));
    json.version = version;
    await writeFile(filePath, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`  ✓ ${filePath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed: ${filePath}`, err);
    return false;
  }
}

// JSON.stringify(_, null, 2) expands short arrays that Biome (120 width)
// collapses, so a raw stamp leaves the tree lint-red until the next manual
// format. Re-format every stamped file so a version bump can never break
// `biome check`. Non-fatal: without Biome the stamp still lands.
function formatStampedFiles(rootDir: string, files: string[]): void {
  const targets = files.filter((file) => existsSync(file));
  if (targets.length === 0) {
    return;
  }
  try {
    execSync(`bunx biome format --write ${targets.map((file) => `"${file}"`).join(' ')}`, {
      cwd: rootDir,
      stdio: 'pipe',
      timeout: 60000,
    });
    console.log('  ✓ biome format applied to stamped files');
  } catch {
    console.warn('  ⚠ biome format unavailable — run `bunx biome format --write` on the stamped files');
  }
}

async function main() {
  const version = generateVersion();
  const rootDir = join(dirname(import.meta.path), '..');

  console.log(`Version: ${version}`);
  console.log('Updating files:');

  // 1. Update package.json (root). src/lib/version.ts is NOT stamped here —
  // it resolves the version at runtime from package.json (see that file's
  // header). The old `export const VERSION = '...'` literal it used to
  // rewrite no longer exists, so the former stamp step was a dead no-op.
  await updateJsonVersion(join(rootDir, 'package.json'), version);

  // 2. Update Claude Code plugin manifest
  await updateJsonVersion(join(rootDir, 'plugins/genie/.claude-plugin/plugin.json'), version);

  // 2b. Update Codex plugin manifest — must track .claude-plugin/plugin.json exactly
  await updateJsonVersion(join(rootDir, 'plugins/genie/.codex-plugin/plugin.json'), version);

  // 3. Update plugin package.json (used by smart-install.js for version checks)
  await updateJsonVersion(join(rootDir, 'plugins/genie/package.json'), version);

  // 4. Update marketplace.json plugin version
  const marketplacePath = join(rootDir, '.claude-plugin/marketplace.json');
  if (existsSync(marketplacePath)) {
    try {
      const json = JSON.parse(await readFile(marketplacePath, 'utf-8'));
      if (json.plugins?.[0]) {
        json.plugins[0].version = version;
      }
      await writeFile(marketplacePath, `${JSON.stringify(json, null, 2)}\n`);
      console.log(`  ✓ ${marketplacePath}`);
    } catch (err) {
      console.error(`  ✗ Failed: ${marketplacePath}`, err);
    }
  }

  formatStampedFiles(rootDir, [
    join(rootDir, 'package.json'),
    join(rootDir, 'plugins/genie/.claude-plugin/plugin.json'),
    join(rootDir, 'plugins/genie/.codex-plugin/plugin.json'),
    join(rootDir, 'plugins/genie/package.json'),
    marketplacePath,
  ]);

  console.log('\n✅ All versions synchronized');
}

main().catch((err) => {
  console.error('Version script failed:', err);
  process.exit(1);
});
