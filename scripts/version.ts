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
 * - plugins/genie/package.json (runtime payload metadata)
 * - .claude-plugin/marketplace.json (marketplace listing)
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';
import { assertPluginSkillsInSync } from './sync-plugin-skills.ts';

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

export async function updateClaudeMarketplaceVersion(filePath: string, version: string): Promise<boolean> {
  if (!existsSync(filePath)) {
    console.warn(`  ⚠ Skipped (not found): ${filePath}`);
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('marketplace must be an object');
    const plugins = Reflect.get(parsed, 'plugins');
    if (!Array.isArray(plugins)) throw new Error('marketplace must contain a plugins array');
    const matches = plugins.filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === 'object' && !Array.isArray(entry) && Reflect.get(entry, 'name') === 'genie'),
    );
    if (matches.length !== 1) throw new Error('marketplace must contain exactly one genie entry');
    if (typeof matches[0].version !== 'string') throw new Error('genie entry version must be a string');
    matches[0].version = version;
    await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
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

async function assertClaudeMarketplaceShape(filePath: string): Promise<void> {
  if (!existsSync(filePath)) throw new Error('file is missing');
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf-8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('marketplace must be an object');
  const plugins = Reflect.get(parsed, 'plugins');
  if (!Array.isArray(plugins)) throw new Error('marketplace must contain a plugins array');
  const matches = plugins.filter(
    (entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && Reflect.get(entry, 'name') === 'genie',
  );
  if (matches.length !== 1 || typeof Reflect.get(matches[0], 'version') !== 'string') {
    throw new Error('marketplace must contain exactly one versioned genie entry');
  }
}

/** Update every authoritative version file and fail the command on any partial write. */
export async function synchronizeVersionFiles(rootDir: string, version: string): Promise<void> {
  const paths = [
    join(rootDir, 'package.json'),
    join(rootDir, 'plugins/genie/.claude-plugin/plugin.json'),
    join(rootDir, 'plugins/genie/.codex-plugin/plugin.json'),
    join(rootDir, 'plugins/genie/package.json'),
  ];
  const marketplacePath = join(rootDir, '.claude-plugin/marketplace.json');
  const preflightFailures: string[] = [];
  for (const path of paths) {
    try {
      await assertVersionFileShape(path);
    } catch (error) {
      preflightFailures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await assertClaudeMarketplaceShape(marketplacePath);
  } catch (error) {
    preflightFailures.push(`${marketplacePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (preflightFailures.length > 0) {
    throw new Error(`version synchronization preflight failed for: ${preflightFailures.join('; ')}`);
  }

  const outcomes: Array<{ path: string; ok: boolean }> = [];
  for (const path of paths) outcomes.push({ path, ok: await updateJsonVersion(path, version) });

  outcomes.push({ path: marketplacePath, ok: await updateClaudeMarketplaceVersion(marketplacePath, version) });
  const failed = outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.path);
  if (failed.length > 0) throw new Error(`version synchronization failed for: ${failed.join(', ')}`);
}

async function main() {
  assertPluginSkillsInSync();
  const version = generateVersion();
  const rootDir = join(dirname(import.meta.path), '..');

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
