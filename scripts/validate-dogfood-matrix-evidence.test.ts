import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DogfoodEntryValidator, validateDogfoodMatrixEvidence } from './validate-dogfood-matrix-evidence.ts';

const SOURCE_SHA = 'a'.repeat(40);
const MANIFEST_SHA = 'b'.repeat(64);
const VERSION = '5.260723.9';
const PLATFORMS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];

function fixture(platforms = PLATFORMS): {
  root: string;
  matrix: string;
  evidenceDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'genie-dogfood-aggregate-'));
  const evidenceDir = join(root, 'evidence');
  mkdirSync(evidenceDir);
  const matrix = join(root, 'matrix.json');
  writeFileSync(
    matrix,
    JSON.stringify({
      include: platforms.map((platform, index) => ({
        platform,
        runner:
          platform === 'linux-arm64' ? 'ubuntu-24.04-arm' : platform === 'darwin-arm64' ? 'macos-15' : 'ubuntu-latest',
        execution: platform.endsWith('musl') ? 'alpine-container' : 'host-native',
        version: VERSION,
        channel: 'homolog',
        manifest: 'homolog.json',
        manifestSha256: MANIFEST_SHA,
        artifact: `genie-${VERSION}-${platform}.tar.gz`,
        artifactSha256: String(index + 1).repeat(64),
        bundle: `genie-${VERSION}-${platform}.tar.gz.bundle`,
        provenance: `genie-${VERSION}-${platform}.tar.gz.intoto.jsonl`,
      })),
    }),
  );
  for (const [index, platform] of platforms.entries()) {
    const directory = join(evidenceDir, platform);
    mkdirSync(directory);
    writeFileSync(
      join(directory, `codex-dogfood-${VERSION}-${platform}.md`),
      evidence(platform, String(index + 1).repeat(64)),
    );
  }
  return { root, matrix, evidenceDir };
}

function evidence(platform: string, artifactSha256: string): string {
  const manifest = {
    kind: 'live-dogfood-evidence',
    schemaVersion: 2,
    entry: {
      platformId: platform,
      evidenceKind: 'host-native',
      availability: 'verified',
    },
    lifecycle: {
      previousVersion: '5.260720.10',
      candidateVersion: VERSION,
      channel: 'homolog',
      sourceCommit: SOURCE_SHA,
      artifacts: {
        previous: { channel: 'stable' },
        candidate: { manifestSha256: MANIFEST_SHA, artifactSha256 },
      },
    },
  };
  return `# evidence\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n`;
}

const accept: DogfoodEntryValidator = () => [];

function validate(fx: ReturnType<typeof fixture>, validator = accept) {
  return validateDogfoodMatrixEvidence(
    {
      matrixPath: fx.matrix,
      evidenceDir: fx.evidenceDir,
      version: VERSION,
      channel: 'homolog',
      sourceSha: SOURCE_SHA,
      candidateManifestSha256: MANIFEST_SHA,
    },
    validator,
  );
}

describe('native dogfood matrix evidence aggregate', () => {
  test('accepts exactly one host-native result per manifest-derived entry', () => {
    const summary = validate(fixture());
    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: 'codex-dogfood-completeness',
      evidenceSchemaVersion: 2,
      version: VERSION,
      sourceSha: SOURCE_SHA,
      candidateManifestSha256: MANIFEST_SHA,
    });
    expect(summary.entries.map((entry) => entry.platformId)).toEqual([
      'darwin-arm64',
      'linux-arm64',
      'linux-x64-glibc',
      'linux-x64-musl',
    ]);
    expect(summary.entries.every((entry) => entry.previousVersion === '5.260720.10')).toBe(true);
  });

  test('rejects missing, extra, and duplicate native evidence', () => {
    const missing = fixture();
    writeFileSync(
      missing.matrix,
      JSON.stringify({ include: JSON.parse(readText(missing.matrix)).include.slice(0, 1) }),
    );
    expect(() => validate(missing)).toThrow(/native entries|count/);

    const extra = fixture();
    const extraDir = join(extra.evidenceDir, 'extra');
    mkdirSync(extraDir);
    writeFileSync(join(extraDir, 'extra.md'), evidence('windows-x64', '1'.repeat(64)));
    expect(() => validate(extra)).toThrow(/count|non-manifest/);

    const duplicate = fixture();
    const duplicateDir = join(duplicate.evidenceDir, 'duplicate');
    mkdirSync(duplicateDir);
    writeFileSync(join(duplicateDir, 'duplicate.md'), evidence('linux-x64-glibc', '1'.repeat(64)));
    expect(() => validate(duplicate)).toThrow(/count|duplicate/);
  });

  test('rejects candidate identity, digest, availability, and prior-channel drift', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        (value.lifecycle as Record<string, unknown>).sourceCommit = 'c'.repeat(40);
      },
      (value: Record<string, unknown>) => {
        const lifecycle = value.lifecycle as Record<string, unknown>;
        const artifacts = lifecycle.artifacts as Record<string, Record<string, unknown>>;
        artifacts.candidate.artifactSha256 = 'f'.repeat(64);
      },
      (value: Record<string, unknown>) => {
        (value.entry as Record<string, unknown>).availability = 'unavailable';
      },
      (value: Record<string, unknown>) => {
        const lifecycle = value.lifecycle as Record<string, unknown>;
        const artifacts = lifecycle.artifacts as Record<string, Record<string, unknown>>;
        artifacts.previous.channel = 'dev';
      },
      (value: Record<string, unknown>) => {
        (value.lifecycle as Record<string, unknown>).previousVersion = '5.260724.1';
      },
    ]) {
      const fx = fixture();
      const file = join(fx.evidenceDir, 'linux-x64-glibc', `codex-dogfood-${VERSION}-linux-x64-glibc.md`);
      const value = JSON.parse(evidenceJson(readText(file))) as Record<string, unknown>;
      mutate(value);
      writeFileSync(file, `# evidence\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`);
      expect(() => validate(fx)).toThrow();
    }
  });

  test('propagates deep per-entry validation failures', () => {
    expect(() => validate(fixture(), () => ['referenced candidate artifact digest mismatch'])).toThrow(
      /referenced candidate artifact digest mismatch/,
    );
  });
});

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function evidenceJson(markdown: string): string {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
  if (!match?.[1]) throw new Error('missing fixture manifest');
  return match[1];
}
