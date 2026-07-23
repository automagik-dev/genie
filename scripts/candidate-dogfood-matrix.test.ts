import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_DOGFOOD_TARGETS, buildCandidateDogfoodMatrix } from './candidate-dogfood-matrix.ts';

function fixture(): { root: string; manifest: string; dist: string; value: Record<string, unknown> } {
  const root = mkdtempSync(join(tmpdir(), 'genie-candidate-dogfood-'));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  const manifest = join(root, 'homolog.json');
  const platforms = Object.keys(NATIVE_DOGFOOD_TARGETS);
  const value = {
    schema_version: 1,
    channel: 'homolog',
    version: '5.260723.9',
    released_at: '2026-07-23T00:00:00Z',
    tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.9',
    platforms,
  };
  writeFileSync(manifest, `${JSON.stringify(value, null, 2)}\n`);
  for (const platform of platforms) {
    const tarball = join(dist, `genie-5.260723.9-${platform}.tar.gz`);
    writeFileSync(tarball, `artifact:${platform}\n`);
    writeFileSync(`${tarball}.bundle`, `bundle:${platform}\n`);
    writeFileSync(`${tarball}.intoto.jsonl`, `provenance:${platform}\n`);
  }
  return { root, manifest, dist, value };
}

describe('candidate dogfood manifest-derived native matrix', () => {
  test('emits exactly one digest-bound native entry per manifest platform', () => {
    const fx = fixture();
    const matrix = buildCandidateDogfoodMatrix(fx.manifest, fx.dist);
    expect(matrix.include.map((entry) => entry.platform)).toEqual(fx.value.platforms);
    expect(new Set(matrix.include.map((entry) => entry.manifestSha256)).size).toBe(1);
    expect(matrix.include.every((entry) => entry.artifactSha256.length === 64)).toBe(true);
    expect(matrix.include.find((entry) => entry.platform === 'linux-arm64')?.runner).toBe('ubuntu-24.04-arm');
    expect(matrix.include.find((entry) => entry.platform === 'linux-x64-musl')?.execution).toBe('alpine-container');
    expect(matrix.include.find((entry) => entry.platform === 'darwin-arm64')?.runner).toBe('macos-15');
    expect(matrix.include.every((entry) => !entry.artifact.includes(fx.root))).toBe(true);
  });

  test('rejects missing, extra, and duplicate manifest entries', () => {
    for (const mutate of [
      (platforms: string[]) => platforms.slice(1),
      (platforms: string[]) => [...platforms, 'windows-x64'],
      (platforms: string[]) => [...platforms, platforms[0]],
    ]) {
      const fx = fixture();
      fx.value.platforms = mutate(fx.value.platforms as string[]);
      writeFileSync(fx.manifest, `${JSON.stringify(fx.value)}\n`);
      expect(() => buildCandidateDogfoodMatrix(fx.manifest, fx.dist)).toThrow(/target mismatch|duplicate/);
    }
  });

  test('rejects a missing artifact, bundle, or provenance entry', () => {
    for (const suffix of ['', '.bundle', '.intoto.jsonl']) {
      const fx = fixture();
      const path = join(fx.dist, `genie-5.260723.9-linux-arm64.tar.gz${suffix}`);
      writeFileSync(path, '');
      expect(() => buildCandidateDogfoodMatrix(fx.manifest, fx.dist)).toThrow(/must not be empty/);
    }
  });

  test('rejects symlinked candidate inputs', () => {
    const fx = fixture();
    const target = join(fx.root, 'replacement');
    writeFileSync(target, 'replacement\n');
    const bundle = join(fx.dist, 'genie-5.260723.9-darwin-arm64.tar.gz.bundle');
    unlinkSync(bundle);
    symlinkSync(target, bundle);
    expect(() => buildCandidateDogfoodMatrix(fx.manifest, fx.dist)).toThrow(/physical regular file/);
  });

  test('rejects manifest version/base disagreement and unexpected fields', () => {
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.tarball_base = 'https://example.invalid/releases/download/v5.260723.8';
      },
      (value: Record<string, unknown>) => {
        value.untrusted = true;
      },
    ]) {
      const fx = fixture();
      mutate(fx.value);
      writeFileSync(fx.manifest, `${JSON.stringify(fx.value)}\n`);
      expect(() => buildCandidateDogfoodMatrix(fx.manifest, fx.dist)).toThrow();
    }
  });
});
