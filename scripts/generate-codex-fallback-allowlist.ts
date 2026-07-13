#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import frozenCodexFallbackRelease from '../src/fixtures/codex-fallback-release-5.260712.1.json';
import { type CodexFallbackHistoricalTuple, computeDirDigest } from '../src/lib/agent-sync';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'src', 'fixtures', 'codex-fallback-allowlist.json');
const SHA256 = /^[a-f0-9]{64}$/;
const VERIFIED_FROZEN_RELEASE = {
  releaseTag: 'v5.260712.1',
  sourceCommit: '22aa27e4f32f183d1530b2d62b3174a557e5af3e',
  markerVersion: '5.260712.1',
  verifiedSkillsDigest: '349c93ce8e927c355768bbd39fb9321b6b34ec41f473152af65166549215b80e',
} as const;

interface FrozenReleaseFile {
  path: string;
  mode: number;
  content: string;
}

interface FrozenReleasePayload {
  files: FrozenReleaseFile[];
}

interface FrozenReleaseFixture {
  version: number;
  releaseTag: string;
  sourceCommit: string;
  markerVersion: string;
  verifiedSkillsDigest: string;
  payloadEncoding: string;
  payloadSha256: string;
  payloadChunks: string[];
}

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

function safeFrozenReleasePath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.length > 0 &&
    !path.includes('\\') &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && basename(part) === part)
  );
}

function decodeFrozenReleasePayload(release: FrozenReleaseFixture): FrozenReleasePayload {
  if (
    release.version !== 1 ||
    release.releaseTag !== VERIFIED_FROZEN_RELEASE.releaseTag ||
    release.sourceCommit !== VERIFIED_FROZEN_RELEASE.sourceCommit ||
    release.markerVersion !== VERIFIED_FROZEN_RELEASE.markerVersion ||
    release.verifiedSkillsDigest !== VERIFIED_FROZEN_RELEASE.verifiedSkillsDigest ||
    release.payloadEncoding !== 'br+base64-json-utf8' ||
    !SHA256.test(release.payloadSha256) ||
    !Array.isArray(release.payloadChunks)
  ) {
    throw new Error('invalid frozen Codex fallback release identity');
  }
  const encoded = release.payloadChunks.join('');
  const compressed = Buffer.from(encoded, 'base64');
  if (compressed.toString('base64') !== encoded) throw new Error('invalid frozen Codex fallback release encoding');
  const bytes = brotliDecompressSync(compressed);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== release.payloadSha256) throw new Error('frozen Codex fallback release payload digest mismatch');
  const payload = JSON.parse(bytes.toString('utf8')) as FrozenReleasePayload;
  if (!Array.isArray(payload.files)) throw new Error('invalid frozen Codex fallback release payload');
  return payload;
}

/** Materialize the immutable, verified 5.260712.1 release fixture without consulting current `skills/`. */
export function materializeFrozenCodexFallbackRelease(destinationRoot: string): CanonicallyVerifiedReleasePayload {
  const root = resolve(destinationRoot);
  if (existsSync(root)) throw new Error(`frozen release destination already exists: ${root}`);
  const release = frozenCodexFallbackRelease as FrozenReleaseFixture;
  const payload = decodeFrozenReleasePayload(release);
  const skillsRoot = join(root, 'skills');
  const seen = new Set<string>();
  mkdirSync(skillsRoot, { recursive: true, mode: 0o755 });
  try {
    for (const file of payload.files) {
      if (!safeFrozenReleasePath(file.path) || file.mode !== 0o644 || seen.has(file.path)) {
        throw new Error(`invalid frozen Codex fallback release file: ${JSON.stringify(file)}`);
      }
      seen.add(file.path);
      let parent = skillsRoot;
      for (const segment of file.path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        mkdirSync(parent, { recursive: true, mode: 0o755 });
        chmodSync(parent, 0o755);
      }
      const destination = join(skillsRoot, file.path);
      writeFileSync(destination, file.content, { encoding: 'utf8', flag: 'wx', mode: file.mode });
      chmodSync(destination, file.mode);
    }
    chmodSync(skillsRoot, 0o755);
    const actualDigest = computeDirDigest(skillsRoot);
    if (actualDigest !== release.verifiedSkillsDigest) {
      throw new Error(
        `frozen Codex fallback release skills digest mismatch: expected ${release.verifiedSkillsDigest}, got ${actualDigest}`,
      );
    }
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    payloadRoot: root,
    markerVersion: release.markerVersion,
    verifiedSkillsDigest: release.verifiedSkillsDigest,
    canonicalVerified: true,
  };
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
  const temporary = mkdtempSync(join(tmpdir(), 'genie-codex-fallback-release-'));
  try {
    const verifiedRelease = materializeFrozenCodexFallbackRelease(join(temporary, 'release'));
    const generated = generateCodexFallbackAllowlist(verifiedRelease);
    if (serializedCodexFallbackAllowlist(generated) !== serializedCodexFallbackAllowlist(parsed)) {
      throw new Error('committed fallback allowlist diverges from frozen verified release fixture');
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function main(args: string[]): void {
  if (args.includes('--check')) {
    validateCommittedAllowlist();
    process.stdout.write(
      'codex fallback allowlist: 23 deterministic exact-content retirement tuples OK (not authenticated provenance)\n',
    );
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
