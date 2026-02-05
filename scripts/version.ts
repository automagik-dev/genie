#!/usr/bin/env bun

/**
 * Pre-build script: generates datetime-based version and updates ALL version files
 * Format: 0.YYMMDD.HHMM (e.g., 0.260201.1430 = Feb 1, 2026 at 14:30)
 * 
 * Syncs versions across:
 * - package.json (root)
 * - src/lib/version.ts
 * - plugins/automagik-genie/.claude-plugin/plugin.json (Claude Code)
 * - plugins/automagik-genie/openclaw.plugin.json (OpenClaw)
 */

import { readFile, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// Generate version from current datetime
function generateVersion(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');

  return `0.${yy}${mm}${dd}.${hh}${min}`;
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

  console.log('\n✅ All versions synchronized');
}

main().catch((err) => {
  console.error('Version script failed:', err);
  process.exit(1);
});
