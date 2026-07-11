#!/usr/bin/env bun

/**
 * Stamp and verify the version-bearing metadata copied into a release
 * tarball. This operates only on the staged payload: a workflow version
 * override must not mutate the checkout, and must not leave VERSION, plugin
 * manifests, or marketplace metadata disagreeing inside the artifact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

const TOP_LEVEL_VERSION_FILES = [
  'plugins/genie/package.json',
  'plugins/genie/.claude-plugin/plugin.json',
  'plugins/genie/.codex-plugin/plugin.json',
] as const;

const COMMITTED_VERSION_FILES = ['package.json', ...TOP_LEVEL_VERSION_FILES] as const;

interface JsonObject {
  [key: string]: unknown;
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`invalid release version: ${JSON.stringify(version)}`);
}

function readObject(path: string): JsonObject {
  if (!existsSync(path)) throw new Error(`release payload metadata is missing: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`release payload metadata must be a JSON object: ${path}`);
  }
  return parsed as JsonObject;
}

function replaceTopLevelVersion(path: string, version: string): void {
  const parsed = readObject(path);
  const source = readFileSync(path, 'utf8');
  if (typeof parsed.version !== 'string') throw new Error(`metadata has no top-level string version: ${path}`);
  const updated = source.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
  if (updated === source && parsed.version !== version) throw new Error(`could not stamp top-level version: ${path}`);
  JSON.parse(updated);
  writeFileSync(path, updated);
}

function marketplaceEntry(path: string): { manifest: JsonObject; entry: JsonObject } {
  const manifest = readObject(path);
  const plugins = manifest.plugins;
  if (!Array.isArray(plugins)) throw new Error(`marketplace has no plugins array: ${path}`);
  const matches = plugins.filter((candidate): candidate is JsonObject =>
    Boolean(
      candidate &&
        typeof candidate === 'object' &&
        !Array.isArray(candidate) &&
        (candidate as JsonObject).name === 'genie',
    ),
  );
  if (matches.length !== 1) throw new Error(`marketplace must contain exactly one genie entry: ${path}`);
  return { manifest, entry: matches[0] };
}

function writeObject(path: string, value: JsonObject): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function verifyCodexMarketplaceEntry(path: string, expectedVersion: string): void {
  const { entry } = marketplaceEntry(path);
  const source = entry.source as JsonObject | undefined;
  if (!source || source.source !== 'local' || source.path !== './plugins/genie') {
    throw new Error(`Codex marketplace genie entry must target local ./plugins/genie: ${path}`);
  }
  // Current Codex local-marketplace schema is source-addressed and does not
  // require a version. If a future manifest adds one, it may not diverge.
  if (entry.version !== undefined && entry.version !== expectedVersion) {
    throw new Error(`release payload version mismatch in ${path}: expected ${expectedVersion}, got ${entry.version}`);
  }
}

/**
 * Verify the checkout's authoritative metadata before a workflow override is
 * allowed to stamp a staged payload. This prevents packaging from repairing
 * and thereby concealing a partially committed version bump.
 */
export function verifyCommittedReleaseVersions(repoRoot: string): string {
  const packagePath = join(repoRoot, 'package.json');
  const expectedVersion = readObject(packagePath).version;
  if (typeof expectedVersion !== 'string') throw new Error(`metadata has no top-level string version: ${packagePath}`);
  assertVersion(expectedVersion);

  for (const relativePath of COMMITTED_VERSION_FILES) {
    const path = join(repoRoot, relativePath);
    const actual = readObject(path).version;
    if (actual !== expectedVersion) {
      throw new Error(`committed version mismatch in ${path}: expected ${expectedVersion}, got ${actual}`);
    }
  }

  const claudeMarketplacePath = join(repoRoot, '.claude-plugin', 'marketplace.json');
  const claudeVersion = marketplaceEntry(claudeMarketplacePath).entry.version;
  if (claudeVersion !== expectedVersion) {
    throw new Error(
      `committed version mismatch in ${claudeMarketplacePath}: expected ${expectedVersion}, got ${claudeVersion}`,
    );
  }
  verifyCodexMarketplaceEntry(join(repoRoot, '.agents', 'plugins', 'marketplace.json'), expectedVersion);
  return expectedVersion;
}

/** Stamp every version-bearing file in an already-copied release payload. */
export function stampReleasePayloadVersion(payloadRoot: string, version: string): void {
  assertVersion(version);
  for (const relativePath of TOP_LEVEL_VERSION_FILES) {
    replaceTopLevelVersion(join(payloadRoot, relativePath), version);
  }

  const claudeMarketplacePath = join(payloadRoot, '.claude-plugin', 'marketplace.json');
  const claudeMarketplace = marketplaceEntry(claudeMarketplacePath);
  if (typeof claudeMarketplace.entry.version !== 'string') {
    throw new Error(`Claude marketplace genie entry has no string version: ${claudeMarketplacePath}`);
  }
  claudeMarketplace.entry.version = version;
  writeObject(claudeMarketplacePath, claudeMarketplace.manifest);

  const codexMarketplacePath = join(payloadRoot, '.agents', 'plugins', 'marketplace.json');
  const codexMarketplace = marketplaceEntry(codexMarketplacePath);
  if (codexMarketplace.entry.version !== undefined) codexMarketplace.entry.version = version;
  writeObject(codexMarketplacePath, codexMarketplace.manifest);

  writeFileSync(join(payloadRoot, 'VERSION'), `${version}\n`);
}

/** Fail closed if any copied release metadata disagrees with VERSION. */
export function verifyReleasePayloadVersion(payloadRoot: string, expectedVersion: string): void {
  assertVersion(expectedVersion);
  const stampPath = join(payloadRoot, 'VERSION');
  if (!existsSync(stampPath)) throw new Error(`release payload metadata is missing: ${stampPath}`);
  const stamp = readFileSync(stampPath, 'utf8').trim();
  if (stamp !== expectedVersion) {
    throw new Error(`release payload version mismatch in ${stampPath}: expected ${expectedVersion}, got ${stamp}`);
  }

  for (const relativePath of TOP_LEVEL_VERSION_FILES) {
    const path = join(payloadRoot, relativePath);
    const actual = readObject(path).version;
    if (actual !== expectedVersion) {
      throw new Error(`release payload version mismatch in ${path}: expected ${expectedVersion}, got ${actual}`);
    }
  }

  const claudeMarketplacePath = join(payloadRoot, '.claude-plugin', 'marketplace.json');
  const claudeVersion = marketplaceEntry(claudeMarketplacePath).entry.version;
  if (claudeVersion !== expectedVersion) {
    throw new Error(
      `release payload version mismatch in ${claudeMarketplacePath}: expected ${expectedVersion}, got ${claudeVersion}`,
    );
  }

  verifyCodexMarketplaceEntry(join(payloadRoot, '.agents', 'plugins', 'marketplace.json'), expectedVersion);
}

function usage(): never {
  throw new Error(
    'usage: bun scripts/release-payload-version.ts --verify-source <repo-root> | --stamp|--verify <payload-root> <version>',
  );
}

function main(): void {
  const [operation, payloadRoot, version, ...extra] = process.argv.slice(2);
  if (!operation || !payloadRoot || extra.length > 0) usage();
  if (operation === '--verify-source') {
    if (version !== undefined) usage();
    const sourceVersion = verifyCommittedReleaseVersions(payloadRoot);
    console.log(`release-payload-version: OK (verify-source ${sourceVersion})`);
    return;
  }
  if (!version) usage();
  if (operation === '--stamp') stampReleasePayloadVersion(payloadRoot, version);
  else if (operation === '--verify') verifyReleasePayloadVersion(payloadRoot, version);
  else usage();
  console.log(`release-payload-version: OK (${operation.slice(2)} ${version})`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`release-payload-version: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
