#!/usr/bin/env bun

/**
 * Convert one exact candidate channel manifest into the native dogfood matrix.
 *
 * The candidate manifest is the inventory authority. The static map below only
 * assigns each admitted platform to a runner/execution adapter; it cannot add a
 * platform that the manifest did not name. Every manifest entry must have one
 * physical same-run tarball, Sigstore bundle, and SLSA provenance file.
 */

import { createHash } from 'node:crypto';
import { type Stats, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const VERSION = /^\d+\.\d{6}\.\d+$/;
const CHANNELS = new Set(['dev', 'homolog', 'stable']);

export const NATIVE_DOGFOOD_TARGETS = Object.freeze({
  'linux-x64-glibc': { runner: 'ubuntu-latest', execution: 'host-native' },
  'linux-x64-musl': { runner: 'ubuntu-latest', execution: 'alpine-container' },
  'linux-arm64': { runner: 'ubuntu-24.04-arm', execution: 'host-native' },
  'darwin-arm64': { runner: 'macos-15', execution: 'host-native' },
} as const);

export type NativeDogfoodPlatform = keyof typeof NATIVE_DOGFOOD_TARGETS;

export interface CandidateDogfoodMatrixEntry {
  platform: NativeDogfoodPlatform;
  runner: (typeof NATIVE_DOGFOOD_TARGETS)[NativeDogfoodPlatform]['runner'];
  execution: (typeof NATIVE_DOGFOOD_TARGETS)[NativeDogfoodPlatform]['execution'];
  version: string;
  channel: 'dev' | 'homolog' | 'stable';
  manifest: string;
  manifestSha256: string;
  artifact: string;
  artifactSha256: string;
  bundle: string;
  provenance: string;
}

export interface CandidateDogfoodMatrix {
  include: CandidateDogfoodMatrixEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readPhysicalFile(path: string, label: string): Buffer {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing: ${path}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical regular file: ${path}`);
  const bytes = readFileSync(path);
  if (bytes.length === 0) throw new Error(`${label} must not be empty: ${path}`);
  return bytes;
}

function parseManifest(bytes: Uint8Array): {
  version: string;
  channel: 'dev' | 'homolog' | 'stable';
  platforms: NativeDogfoodPlatform[];
} {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new Error('candidate manifest is not valid JSON');
  }
  if (!isRecord(value)) throw new Error('candidate manifest must be an object');
  const keys = Object.keys(value).sort();
  const expectedKeys = ['channel', 'platforms', 'released_at', 'schema_version', 'tarball_base', 'version'];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`candidate manifest has unexpected keys: ${keys.join(', ')}`);
  }
  if (value.schema_version !== 1) throw new Error('candidate manifest schema_version must be 1');
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw new Error('candidate manifest version is invalid');
  }
  if (typeof value.channel !== 'string' || !CHANNELS.has(value.channel)) {
    throw new Error('candidate manifest channel is invalid');
  }
  if (!Array.isArray(value.platforms) || value.platforms.some((platform) => typeof platform !== 'string')) {
    throw new Error('candidate manifest platforms must be a string array');
  }
  const platforms = value.platforms as string[];
  if (new Set(platforms).size !== platforms.length) throw new Error('candidate manifest contains duplicate platforms');
  const supported = Object.keys(NATIVE_DOGFOOD_TARGETS);
  const missing = supported.filter((platform) => !platforms.includes(platform));
  const extra = platforms.filter((platform) => !(platform in NATIVE_DOGFOOD_TARGETS));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `candidate manifest/native target mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`,
    );
  }
  if (typeof value.tarball_base !== 'string' || !value.tarball_base.endsWith(`/v${value.version}`)) {
    throw new Error('candidate manifest tarball_base does not bind its version');
  }
  if (typeof value.released_at !== 'string' || Number.isNaN(Date.parse(value.released_at))) {
    throw new Error('candidate manifest released_at is invalid');
  }
  return {
    version: value.version,
    channel: value.channel as 'dev' | 'homolog' | 'stable',
    platforms: platforms as NativeDogfoodPlatform[],
  };
}

export function buildCandidateDogfoodMatrix(manifestPath: string, artifactDir: string): CandidateDogfoodMatrix {
  const physicalManifest = resolve(manifestPath);
  const manifestBytes = readPhysicalFile(physicalManifest, 'candidate manifest');
  const manifest = parseManifest(manifestBytes);
  const manifestSha256 = sha256(manifestBytes);
  const physicalArtifactDir = resolve(artifactDir);
  const include = manifest.platforms.map((platform): CandidateDogfoodMatrixEntry => {
    const artifactName = `genie-${manifest.version}-${platform}.tar.gz`;
    const artifact = join(physicalArtifactDir, artifactName);
    const bundle = `${artifact}.bundle`;
    const provenance = `${artifact}.intoto.jsonl`;
    const artifactBytes = readPhysicalFile(artifact, `candidate artifact ${platform}`);
    readPhysicalFile(bundle, `candidate Sigstore bundle ${platform}`);
    readPhysicalFile(provenance, `candidate SLSA provenance ${platform}`);
    return {
      platform,
      ...NATIVE_DOGFOOD_TARGETS[platform],
      version: manifest.version,
      channel: manifest.channel,
      manifest: basename(physicalManifest),
      manifestSha256,
      artifact: artifactName,
      artifactSha256: sha256(artifactBytes),
      bundle: `${artifactName}.bundle`,
      provenance: `${artifactName}.intoto.jsonl`,
    };
  });
  if (include.length !== manifest.platforms.length) throw new Error('candidate matrix lost manifest entries');
  return { include };
}

function parseArgs(argv: string[]): { manifest: string; artifactDir: string; output: string | null } {
  let manifest = '';
  let artifactDir = '';
  let output: string | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${flag ?? '<argument>'}`);
    if (flag === '--manifest') manifest = value;
    else if (flag === '--artifact-dir') artifactDir = value;
    else if (flag === '--output') output = value;
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!manifest || !artifactDir) {
    throw new Error(
      'usage: bun scripts/candidate-dogfood-matrix.ts --manifest <candidate.json> --artifact-dir <dist> [--output <matrix.json>]',
    );
  }
  return { manifest, artifactDir, output };
}

function main(): void {
  try {
    const args = parseArgs(process.argv.slice(2));
    const matrix = buildCandidateDogfoodMatrix(args.manifest, args.artifactDir);
    const serialized = `${JSON.stringify(matrix)}\n`;
    if (args.output) writeFileSync(args.output, serialized, { flag: 'wx', mode: 0o600 });
    process.stdout.write(serialized);
  } catch (error) {
    console.error(`candidate-dogfood-matrix: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (import.meta.main) main();
