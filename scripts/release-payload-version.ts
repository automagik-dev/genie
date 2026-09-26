#!/usr/bin/env bun

/**
 * Stamp and verify the version-bearing metadata copied into a release
 * tarball. This operates only on the staged payload: a workflow version
 * override must not mutate the checkout, and must not leave VERSION or the
 * plugin manifests disagreeing inside the artifact.
 */

import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

const TOP_LEVEL_VERSION_FILES = [
  'plugins/genie/package.json',
  'plugins/genie/orca-plugin.json',
  'plugins/dsh-genie-board/package.json',
  'plugins/dsh-workflow-loader/package.json',
] as const;

/**
 * Payload files stamped and verified only while present: wish
 * `retire-orca-integration` deletes them. Every other member stays required.
 */
const OPTIONAL_PAYLOAD_VERSION_FILES: ReadonlySet<string> = new Set([
  'plugins/genie/package.json',
  'plugins/genie/orca-plugin.json',
]);

/** Present means anything at the path, a dangling symlink included, so it fails loudly like `version.yml`'s `-e || -L`. */
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function presentPayloadVersionFiles(payloadRoot: string): string[] {
  return TOP_LEVEL_VERSION_FILES.filter(
    (relativePath) => !OPTIONAL_PAYLOAD_VERSION_FILES.has(relativePath) || isPresent(join(payloadRoot, relativePath)),
  );
}

interface JsonObject {
  [key: string]: unknown;
}

/** The one release-version shape gate; every release script funnels through it. */
export function assertReleaseVersion(version: string): void {
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
  const updated = replaceTopLevelStringProperty(source, 'version', version);
  writeFileSync(path, updated);
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
  assertReleaseVersion(expectedVersion);
  // Only package.json is gated. The plugin manifests are stamped by `--stamp`
  // (and re-verified by `--verify`) inside the payload, so their committed
  // values are advisory; gating them coupled dev CI to main's `version.yml`
  // (workflow_run runs main's copy) and blocked dev releases 5.260829.5–.8.
  return expectedVersion;
}

/** Stamp every version-bearing file in an already-copied release payload. */
export function stampReleasePayloadVersion(payloadRoot: string, version: string): void {
  assertReleaseVersion(version);
  for (const relativePath of presentPayloadVersionFiles(payloadRoot)) {
    replaceTopLevelVersion(join(payloadRoot, relativePath), version);
  }

  const manifestPath = join(payloadRoot, 'plugins/dsh-genie-board/package.json');
  if (typeof readObject(manifestPath).minimumGenieVersion !== 'string') throw new Error('missing minimumGenieVersion');
  writeFileSync(
    manifestPath,
    replaceTopLevelStringProperty(readFileSync(manifestPath, 'utf8'), 'minimumGenieVersion', version),
  );
  writeFileSync(join(payloadRoot, 'VERSION'), `${version}\n`);
}

/** Fail closed if any copied release metadata disagrees with VERSION. */
export function verifyReleasePayloadVersion(payloadRoot: string, expectedVersion: string): void {
  assertReleaseVersion(expectedVersion);
  const floor = readObject(join(payloadRoot, 'plugins/dsh-genie-board/package.json')).minimumGenieVersion;
  if (floor !== expectedVersion)
    throw new Error(`minimumGenieVersion mismatch: expected ${expectedVersion}, got ${floor}`);
  const stampPath = join(payloadRoot, 'VERSION');
  if (!existsSync(stampPath)) throw new Error(`release payload metadata is missing: ${stampPath}`);
  const stamp = readFileSync(stampPath, 'utf8').trim();
  if (stamp !== expectedVersion) {
    throw new Error(`release payload version mismatch in ${stampPath}: expected ${expectedVersion}, got ${stamp}`);
  }

  for (const relativePath of presentPayloadVersionFiles(payloadRoot)) {
    const path = join(payloadRoot, relativePath);
    const actual = readObject(path).version;
    if (actual !== expectedVersion) {
      throw new Error(`release payload version mismatch in ${path}: expected ${expectedVersion}, got ${actual}`);
    }
  }
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
