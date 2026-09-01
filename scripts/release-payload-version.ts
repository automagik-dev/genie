#!/usr/bin/env bun

/**
 * Stamp and verify the version-bearing metadata copied into a release
 * tarball. This operates only on the staged payload: a workflow version
 * override must not mutate the checkout, and must not leave VERSION or the
 * plugin manifests disagreeing inside the artifact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceTopLevelStringProperty } from './json-top-level-string.js';

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/;

const TOP_LEVEL_VERSION_FILES = ['plugins/genie/package.json', 'plugins/genie/orca-plugin.json'] as const;

/**
 * Committed files whose version must already equal package.json before a
 * release is staged. The native Orca manifest is deliberately NOT gated here:
 * its shipped copy is stamped by `--stamp` (and re-verified by `--verify`)
 * inside the payload, which is the only copy Orca ever loads, so the committed
 * value is advisory. Gating it would also couple dev CI to the auto-version
 * bump list of the workflow on `main` — `workflow_run` jobs execute main's
 * `version.yml`, so a bump field added on dev is inert until promotion, and
 * every dev child in between failed this gate (observed 2026-08-30, dev
 * releases 5.260829.5–.8 never shipped).
 */
const COMMITTED_VERSION_FILES = ['package.json', 'plugins/genie/package.json'] as const;

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
  assertVersion(expectedVersion);

  for (const relativePath of COMMITTED_VERSION_FILES) {
    const path = join(repoRoot, relativePath);
    const actual = readObject(path).version;
    if (actual !== expectedVersion) {
      throw new Error(`committed version mismatch in ${path}: expected ${expectedVersion}, got ${actual}`);
    }
  }

  return expectedVersion;
}

/** Stamp every version-bearing file in an already-copied release payload. */
export function stampReleasePayloadVersion(payloadRoot: string, version: string): void {
  assertVersion(version);
  for (const relativePath of TOP_LEVEL_VERSION_FILES) {
    replaceTopLevelVersion(join(payloadRoot, relativePath), version);
  }

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
