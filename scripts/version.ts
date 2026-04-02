#!/usr/bin/env bun

/**
 * Pre-build script: generates date-based version and updates ALL version files
 * Format: 4.YYMMDD.N (e.g., 4.260201.1 = Feb 1, 2026, first publish of the day)
 * N increments per day: .1, .2, .3, etc.
 *
 * Syncs versions across:
 * - package.json (root)
 * - src/lib/version.ts
 * - plugins/genie/.claude-plugin/plugin.json (Claude Code)
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
    const output = execSync(`git tag --list "v4.${datePrefix}.*"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

// Generate version: 4.YYMMDD.N where N = daily publish counter
function generateVersion(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;

  const existing = getTodayPublishCount(datePrefix);
  const n = existing + 1;

  return `4.${datePrefix}.${n}`;
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

async function main() {
  const version = generateVersion();
  const rootDir = join(dirname(import.meta.path), '..');

  console.log(`Version: ${version}`);
  console.log('Updating files:');

  // 1. Update package.json (root)
  await updateJsonVersion(join(rootDir, 'package.json'), version);

  // 2. Update src/lib/version.ts
  const versionPath = join(rootDir, 'src/lib/version.ts');
  if (existsSync(versionPath)) {
    const versionContent = await readFile(versionPath, 'utf-8');
    const updatedContent = versionContent.replace(
      /export const VERSION = '[^']+';/,
      `export const VERSION = '${version}';`,
    );
    await writeFile(versionPath, updatedContent);
    console.log(`  ✓ ${versionPath}`);
  }

  // 3. Update Claude Code plugin manifest
  await updateJsonVersion(join(rootDir, 'plugins/genie/.claude-plugin/plugin.json'), version);

  // 4. Update plugin package.json (used by smart-install.js for version checks)
  await updateJsonVersion(join(rootDir, 'plugins/genie/package.json'), version);

  // 5. Update marketplace.json plugin version
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

  console.log('\n✅ All versions synchronized');
}

main().catch((err) => {
  console.error('Version script failed:', err);
  process.exit(1);
});
