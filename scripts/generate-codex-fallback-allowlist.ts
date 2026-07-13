#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CodexFallbackHistoricalTuple, computeDirDigest } from '../src/lib/agent-sync';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'src', 'fixtures', 'codex-fallback-allowlist.json');
const SHA256 = /^[a-f0-9]{64}$/;

export interface CanonicallyVerifiedReleasePayload {
  payloadRoot: string;
  markerVersion: string;
  /** Digest of the release payload's complete physical `skills` tree, supplied by canonical verification. */
  verifiedSkillsDigest: string;
  canonicalVerified: true;
}

function assertPhysicalDirectory(path: string, label: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a physical directory: ${path}`);
}

/** Generate tuples only after binding the complete skills tree to canonical release verification. */
export function generateCodexFallbackAllowlist(
  release: CanonicallyVerifiedReleasePayload,
): CodexFallbackHistoricalTuple[] {
  if (release.canonicalVerified !== true || !SHA256.test(release.verifiedSkillsDigest)) {
    throw new Error('release payload is not canonically verified');
  }
  if (typeof release.markerVersion !== 'string' || release.markerVersion.length === 0) {
    throw new Error('verified release marker version is required');
  }
  const skillsRoot = join(resolve(release.payloadRoot), 'skills');
  assertPhysicalDirectory(skillsRoot, 'verified release skills root');
  const actualSkillsDigest = computeDirDigest(skillsRoot);
  if (actualSkillsDigest !== release.verifiedSkillsDigest) {
    throw new Error(
      `verified release payload digest mismatch: expected ${release.verifiedSkillsDigest}, got ${actualSkillsDigest}`,
    );
  }
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`verified release skills root contains a symlink: ${entry.name}`);
      return entry.isDirectory();
    })
    .map((entry) => {
      const path = join(skillsRoot, entry.name);
      assertPhysicalDirectory(path, 'verified release skill');
      return {
        markerVersion: release.markerVersion,
        skillName: entry.name,
        physicalDigest: computeDirDigest(path),
      };
    })
    .sort((left, right) => left.skillName.localeCompare(right.skillName));
}

export function serializedCodexFallbackAllowlist(tuples: readonly CodexFallbackHistoricalTuple[]): string {
  return `${JSON.stringify(tuples, null, 2)}\n`;
}

function validateCommittedAllowlist(): void {
  const parsed = JSON.parse(readFileSync(OUTPUT, 'utf8')) as CodexFallbackHistoricalTuple[];
  if (!Array.isArray(parsed) || parsed.length !== 23)
    throw new Error('committed fallback allowlist must contain 23 tuples');
  const sorted = [...parsed].sort((left, right) => left.skillName.localeCompare(right.skillName));
  if (JSON.stringify(parsed) !== JSON.stringify(sorted))
    throw new Error('committed fallback allowlist is not deterministic');
  const keys = new Set<string>();
  for (const tuple of parsed) {
    if (
      typeof tuple.markerVersion !== 'string' ||
      tuple.markerVersion.length === 0 ||
      typeof tuple.skillName !== 'string' ||
      basename(tuple.skillName) !== tuple.skillName ||
      !SHA256.test(tuple.physicalDigest)
    ) {
      throw new Error(`invalid committed fallback tuple: ${JSON.stringify(tuple)}`);
    }
    const key = `${tuple.markerVersion}\0${tuple.skillName}\0${tuple.physicalDigest}`;
    if (keys.has(key)) throw new Error(`duplicate committed fallback tuple: ${tuple.skillName}`);
    keys.add(key);
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function main(args: string[]): void {
  if (args.includes('--check')) {
    validateCommittedAllowlist();
    process.stdout.write('codex fallback allowlist: 23 deterministic tuples OK\n');
    return;
  }
  const payloadRoot = option(args, '--payload');
  const markerVersion = option(args, '--marker-version');
  const verifiedSkillsDigest = option(args, '--verified-skills-digest');
  if (payloadRoot === undefined || markerVersion === undefined || verifiedSkillsDigest === undefined) {
    throw new Error('generation requires --payload, --marker-version, and --verified-skills-digest');
  }
  if (!existsSync(payloadRoot)) throw new Error(`release payload does not exist: ${payloadRoot}`);
  const tuples = generateCodexFallbackAllowlist({
    payloadRoot,
    markerVersion,
    verifiedSkillsDigest,
    canonicalVerified: true,
  });
  const serialized = serializedCodexFallbackAllowlist(tuples);
  if (args.includes('--write')) writeFileSync(OUTPUT, serialized, 'utf8');
  else process.stdout.write(serialized);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
