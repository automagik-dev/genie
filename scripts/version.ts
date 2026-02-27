#!/usr/bin/env bun

/**
 * Pre-build script: generates date-based version and updates ALL version files
 * Format: 3.YYMMDD.N (e.g., 3.260201.1 = Feb 1, 2026, first publish of the day)
 * N increments per day: .1, .2, .3, etc.
 *
 * Syncs versions across:
 * - package.json (root)
 * - src/lib/version.ts
 * - plugins/automagik-genie/.claude-plugin/plugin.json (Claude Code)
 * - plugins/automagik-genie/openclaw.plugin.json (OpenClaw)
 * - plugins/automagik-genie/package.json (smart-install version checks)
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

// Query npm registry for existing versions published today
function getTodayPublishCount(datePrefix: string): number {
  try {
    const output = execSync('npm view @automagik/genie versions --json', {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const versions: string[] = JSON.parse(output);
    // Count versions matching 3.YYMMDD.* for today's date
    return versions.filter(v => v.startsWith(`3.${datePrefix}.`)).length;
  } catch {
    // Registry unreachable or package not found — start at 0
    return 0;
  }
}

// Generate version: 3.YYMMDD.N where N = daily publish counter
function generateVersion(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const datePrefix = `${yy}${mm}${dd}`;

  const existing = getTodayPublishCount(datePrefix);
  const n = existing + 1;

  return `3.${datePrefix}.${n}`;
}

async function updateJsonVersion(filePath: string, version: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ Skipped (not found): ${filePath}`);
    return false;
  }
  try {
    const json = JSON.parse(await readFile(filePath, 'utf-8'));
    json.version = version;
    await writeFile(filePath, JSON.stringify(json, null, 2) + '\n');
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
      `export const VERSION = '${version}';`
    );
    await writeFile(versionPath, updatedContent);
    console.log(`  ✓ ${versionPath}`);
  }

  // 3. Update Claude Code plugin manifest
  await updateJsonVersion(
    join(rootDir, 'plugins/automagik-genie/.claude-plugin/plugin.json'),
    version
  );

  // 4. Update OpenClaw plugin manifest
  await updateJsonVersion(
    join(rootDir, 'plugins/automagik-genie/openclaw.plugin.json'),
    version
  );

  // 5. Update plugin package.json (used by smart-install.js for version checks)
  await updateJsonVersion(
    join(rootDir, 'plugins/automagik-genie/package.json'),
    version
  );

  console.log('\n✅ All versions synchronized');
}

main().catch((err) => {
  console.error('Version script failed:', err);
  process.exit(1);
});
