import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'verify-delivery-evidence-pack.ts');

describe('production offline delivery evidence compatibility CLI', () => {
  test('uses the production verifier without a cryptographic seam and rejects an invalid bundle', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('verifyDownloadedDeliveryEvidence({');
    expect(source).not.toContain('verifyBundle:');

    const root = mkdtempSync(join(tmpdir(), 'genie-evidence-compat-'));
    try {
      const manifest = Buffer.from(
        `${JSON.stringify({
          schema_version: 1,
          channel: 'dev',
          version: '5.260723.7',
          released_at: '2026-07-23T00:00:00Z',
          tarball_base: 'https://github.com/automagik-dev/genie/releases/download/v5.260723.7',
          platforms: ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'],
        })}\n`,
      );
      const descriptor = {
        schemaVersion: 1,
        repository: 'automagik-dev/genie',
        version: '5.260723.7',
        channel: 'dev',
        platformId: 'linux-x64-glibc',
        platformTriple: 'linux-x64',
        releaseTag: 'v5.260723.7',
        releaseName: 'genie-5.260723.7-linux-x64-glibc.tar.gz',
        releaseManifestSha256: createHash('sha256').update(manifest).digest('hex'),
        artifactSha256: '1'.repeat(64),
        installedBinarySha256: '2'.repeat(64),
        canonicalPayloadSha256: '3'.repeat(64),
        digestAlgorithm: 'genie-physical-tree-v1',
        sourceSha: 'a'.repeat(40),
        sourceBranch: 'dev',
        sourceCiRunId: '123',
        controlSha: 'b'.repeat(40),
      };
      const descriptorPath = join(root, 'descriptor.json');
      const bundlePath = join(root, 'bundle.json');
      const manifestPath = join(root, 'manifest.json');
      writeFileSync(descriptorPath, `${JSON.stringify(descriptor)}\n`);
      writeFileSync(bundlePath, '{}\n');
      writeFileSync(manifestPath, manifest);
      const result = Bun.spawnSync([
        'bun',
        SCRIPT,
        '--descriptor',
        descriptorPath,
        '--bundle',
        bundlePath,
        '--manifest',
        manifestPath,
      ]);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
