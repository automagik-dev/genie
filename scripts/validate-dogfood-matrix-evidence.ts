#!/usr/bin/env bun

/**
 * Aggregate the native Group F results for one exact candidate manifest.
 *
 * The per-entry validator owns the deep lifecycle and referenced-input checks.
 * This layer proves the release-level relation: every manifest-derived matrix
 * entry has exactly one host-native result, there are no extra results, and
 * every result binds the same candidate version/channel/source/manifest bytes.
 */

import { createHash } from 'node:crypto';
import { type Dirent, type Stats, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { compareReleaseVersions, parseReleaseVersion } from '../src/lib/codex-release-version.ts';
import { NATIVE_DOGFOOD_TARGETS } from './candidate-dogfood-matrix.ts';
import { LIVE_DOGFOOD_SCHEMA_VERSION, validateLiveDogfoodEvidenceFile } from './validate-live-dogfood-evidence.ts';

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d{6}\.\d+$/;
const CHANNELS = new Set(['dev', 'homolog', 'stable']);

type JsonRecord = Record<string, unknown>;
export type DogfoodEntryValidator = (path: string, inputsRoot: string) => string[];

export interface DogfoodMatrixValidationOptions {
  matrixPath: string;
  evidenceDir: string;
  version: string;
  channel: string;
  sourceSha: string;
  candidateManifestSha256: string;
}

export interface DogfoodMatrixEvidenceSummary {
  schemaVersion: 1;
  kind: 'codex-dogfood-completeness';
  evidenceSchemaVersion: typeof LIVE_DOGFOOD_SCHEMA_VERSION;
  version: string;
  channel: string;
  sourceSha: string;
  candidateManifestSha256: string;
  entries: Array<{
    platformId: string;
    artifactSha256: string;
    evidenceSha256: string;
    evidenceFile: string;
    previousVersion: string;
  }>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readPhysical(path: string, label: string): Buffer {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is unavailable: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical regular file: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`${label} must not be empty: ${path}`);
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJsonObject(bytes: Uint8Array, label: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed;
}

function collectEvidenceFiles(root: string): string[] {
  const requestedRoot = resolve(root);
  const requestedStat = lstatSync(requestedRoot);
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error(`evidence root must be a physical directory: ${root}`);
  }
  const physicalRoot = realpathSync(requestedRoot);
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4) throw new Error(`evidence directory nesting exceeds four levels: ${directory}`);
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > 128) throw new Error(`evidence directory has too many entries: ${directory}`);
    for (const entry of entries) {
      assertSafeEntry(entry, directory, physicalRoot);
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
    }
  };
  visit(physicalRoot, 0);
  return found;
}

function assertSafeEntry(entry: Dirent, directory: string, root: string): void {
  const path = join(directory, entry.name);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new Error(`evidence tree contains a non-physical entry: ${path}`);
  }
  const canonical = realpathSync(path);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) {
    throw new Error(`evidence tree entry escapes its root: ${path}`);
  }
}

function extractEvidenceManifest(markdown: string, path: string): JsonRecord {
  const manifests: JsonRecord[] = [];
  for (const match of markdown.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    try {
      const value: unknown = JSON.parse(match[1]);
      if (isRecord(value) && value.kind === 'live-dogfood-evidence') manifests.push(value);
    } catch {
      // The per-entry validator reports malformed blocks with richer context.
    }
  }
  if (manifests.length !== 1) {
    throw new Error(`${path} must contain exactly one live-dogfood-evidence manifest (got ${manifests.length})`);
  }
  return manifests[0] as JsonRecord;
}

function requiredRecord(parent: JsonRecord, key: string, label: string): JsonRecord {
  const value = parent[key];
  if (!isRecord(value)) throw new Error(`${label}.${key} must be an object`);
  return value;
}

function requiredString(parent: JsonRecord, key: string, label: string): string {
  const value = parent[key];
  if (typeof value !== 'string' || value === '') throw new Error(`${label}.${key} must be a non-empty string`);
  return value;
}

function parseMatrix(path: string): JsonRecord[] {
  const matrix = parseJsonObject(readPhysical(path, 'candidate dogfood matrix'), 'candidate dogfood matrix');
  if (!Array.isArray(matrix.include) || matrix.include.length === 0) {
    throw new Error('candidate dogfood matrix include must be a non-empty array');
  }
  if (matrix.include.some((entry) => !isRecord(entry))) {
    throw new Error('candidate dogfood matrix entries must be objects');
  }
  return matrix.include as JsonRecord[];
}

export function validateDogfoodMatrixEvidence(
  options: DogfoodMatrixValidationOptions,
  validateEntry: DogfoodEntryValidator = validateLiveDogfoodEvidenceFile,
): DogfoodMatrixEvidenceSummary {
  if (!VERSION.test(options.version)) throw new Error('candidate version is invalid');
  if (!CHANNELS.has(options.channel)) throw new Error('candidate channel is invalid');
  if (!SOURCE_SHA.test(options.sourceSha)) throw new Error('candidate source SHA is invalid');
  if (!SHA256.test(options.candidateManifestSha256)) throw new Error('candidate manifest SHA-256 is invalid');

  const matrix = parseMatrix(resolve(options.matrixPath));
  const expectedPlatforms = Object.keys(NATIVE_DOGFOOD_TARGETS);
  if (matrix.length !== expectedPlatforms.length) {
    throw new Error(`candidate dogfood matrix must contain exactly ${expectedPlatforms.length} native entries`);
  }
  const byPlatform = new Map<string, JsonRecord>();
  for (const entry of matrix) {
    const platform = requiredString(entry, 'platform', 'matrix entry');
    const target = NATIVE_DOGFOOD_TARGETS[platform as keyof typeof NATIVE_DOGFOOD_TARGETS];
    if (target === undefined) throw new Error(`candidate dogfood matrix contains unsupported platform ${platform}`);
    if (byPlatform.has(platform)) throw new Error(`candidate dogfood matrix contains duplicate platform ${platform}`);
    if (entry.runner !== target.runner || entry.execution !== target.execution) {
      throw new Error(`candidate dogfood matrix runner mapping mismatch for ${platform}`);
    }
    if (entry.version !== options.version || entry.channel !== options.channel) {
      throw new Error(`matrix entry ${platform} does not bind candidate ${options.version}/${options.channel}`);
    }
    if (entry.manifestSha256 !== options.candidateManifestSha256) {
      throw new Error(`matrix entry ${platform} candidate manifest digest mismatch`);
    }
    if (typeof entry.artifactSha256 !== 'string' || !SHA256.test(entry.artifactSha256)) {
      throw new Error(`matrix entry ${platform} artifact digest is invalid`);
    }
    byPlatform.set(platform, entry);
  }
  const missingMatrixPlatforms = expectedPlatforms.filter((platform) => !byPlatform.has(platform));
  if (missingMatrixPlatforms.length > 0) {
    throw new Error(`candidate dogfood matrix is missing native platforms: ${missingMatrixPlatforms.join(', ')}`);
  }

  const evidenceFiles = collectEvidenceFiles(options.evidenceDir);
  if (evidenceFiles.length !== matrix.length) {
    throw new Error(`native evidence count ${evidenceFiles.length} does not equal matrix count ${matrix.length}`);
  }
  const seen = new Set<string>();
  const summaries: DogfoodMatrixEvidenceSummary['entries'] = [];
  for (const file of evidenceFiles) {
    const bytes = readPhysical(file, 'native dogfood evidence');
    const errors = validateEntry(file, dirname(file));
    if (errors.length > 0) throw new Error(`${file} failed entry validation:\n${errors.join('\n')}`);
    const manifest = extractEvidenceManifest(bytes.toString('utf8'), file);
    if (manifest.schemaVersion !== LIVE_DOGFOOD_SCHEMA_VERSION) {
      throw new Error(`${file} has unsupported evidence schema ${String(manifest.schemaVersion)}`);
    }
    const entry = requiredRecord(manifest, 'entry', 'evidence');
    const lifecycle = requiredRecord(manifest, 'lifecycle', 'evidence');
    const artifacts = requiredRecord(lifecycle, 'artifacts', 'evidence.lifecycle');
    const previous = requiredRecord(artifacts, 'previous', 'evidence.lifecycle.artifacts');
    const candidate = requiredRecord(artifacts, 'candidate', 'evidence.lifecycle.artifacts');
    const platform = requiredString(entry, 'platformId', 'evidence.entry');
    if (seen.has(platform)) throw new Error(`native evidence contains duplicate platform ${platform}`);
    seen.add(platform);
    const matrixEntry = byPlatform.get(platform);
    if (matrixEntry === undefined) throw new Error(`native evidence contains non-manifest platform ${platform}`);
    if (entry.evidenceKind !== 'host-native' || entry.availability !== 'verified') {
      throw new Error(`native evidence ${platform} is unavailable or not host-native`);
    }
    if (
      lifecycle.candidateVersion !== options.version ||
      lifecycle.channel !== options.channel ||
      lifecycle.sourceCommit !== options.sourceSha
    ) {
      throw new Error(`native evidence ${platform} candidate identity mismatch`);
    }
    if (candidate.manifestSha256 !== options.candidateManifestSha256) {
      throw new Error(`native evidence ${platform} candidate manifest digest mismatch`);
    }
    if (candidate.artifactSha256 !== matrixEntry.artifactSha256) {
      throw new Error(`native evidence ${platform} candidate artifact digest mismatch`);
    }
    if (previous.channel !== 'stable') throw new Error(`native evidence ${platform} previous generation is not stable`);
    const previousVersion = requiredString(lifecycle, 'previousVersion', 'evidence.lifecycle');
    const parsedPrevious = parseReleaseVersion(previousVersion);
    const parsedCandidate = parseReleaseVersion(options.version);
    if (
      parsedPrevious === null ||
      parsedCandidate === null ||
      compareReleaseVersions(parsedPrevious, parsedCandidate) >= 0
    ) {
      throw new Error(`native evidence ${platform} previous stable N is not older than candidate T`);
    }
    summaries.push({
      platformId: platform,
      artifactSha256: String(matrixEntry.artifactSha256),
      evidenceSha256: sha256(bytes),
      evidenceFile: basename(file),
      previousVersion,
    });
  }
  const missing = [...byPlatform.keys()].filter((platform) => !seen.has(platform));
  if (missing.length > 0) throw new Error(`native evidence is missing matrix platforms: ${missing.join(', ')}`);
  const previousVersions = new Set(summaries.map((entry) => entry.previousVersion));
  if (previousVersions.size !== 1) throw new Error('native evidence entries do not share one previous stable version');
  return {
    schemaVersion: 1,
    kind: 'codex-dogfood-completeness',
    evidenceSchemaVersion: LIVE_DOGFOOD_SCHEMA_VERSION,
    version: options.version,
    channel: options.channel,
    sourceSha: options.sourceSha,
    candidateManifestSha256: options.candidateManifestSha256,
    entries: summaries.sort((a, b) => a.platformId.localeCompare(b.platformId)),
  };
}

function parseArgs(argv: string[]): DogfoodMatrixValidationOptions & { output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || !value || values.has(flag)) throw new Error(`invalid argument: ${flag ?? ''}`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`missing ${flag}`);
    return value;
  };
  const allowed = new Set([
    '--matrix',
    '--evidence-dir',
    '--version',
    '--channel',
    '--source-sha',
    '--candidate-manifest-sha256',
    '--output',
  ]);
  for (const flag of values.keys()) if (!allowed.has(flag)) throw new Error(`unknown argument: ${flag}`);
  return {
    matrixPath: required('--matrix'),
    evidenceDir: required('--evidence-dir'),
    version: required('--version'),
    channel: required('--channel'),
    sourceSha: required('--source-sha'),
    candidateManifestSha256: required('--candidate-manifest-sha256'),
    output: required('--output'),
  };
}

function main(): void {
  try {
    const { output, ...options } = parseArgs(process.argv.slice(2));
    const summary = validateDogfoodMatrixEvidence(options);
    writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`validate-dogfood-matrix-evidence: OK (${summary.entries.length} native entries)\n`);
  } catch (error) {
    process.stderr.write(
      `validate-dogfood-matrix-evidence: FAIL — ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) main();
