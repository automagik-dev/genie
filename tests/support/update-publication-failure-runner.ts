import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LatestManifest } from '../../src/genie-commands/update.js';
import { updateCommand } from '../../src/genie-commands/update.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const tarballSource = required('GENIE_TEST_TARBALL');
const descriptorBytes = readFileSync(required('GENIE_TEST_DESCRIPTOR'));
const bundleBytes = readFileSync(required('GENIE_TEST_BUNDLE'));
const manifestBytes = readFileSync(required('GENIE_TEST_MANIFEST'), 'utf8');
const parsed = JSON.parse(manifestBytes) as Omit<LatestManifest, 'manifestBytes' | 'manifestSha256'>;
const manifest: LatestManifest = {
  ...parsed,
  manifestBytes,
  manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
};

await updateCommand(
  { stable: true, yes: true, restart: false, verify: false },
  {
    fetchManifest: async () => manifest,
    downloadDeliveryAssets: async (_manifest, _platform, destination) => {
      mkdirSync(destination, { recursive: true });
      const releaseName = `genie-${manifest.version}-${_platform}.tar.gz`;
      const exactTarballPath = join(destination, releaseName);
      copyFileSync(tarballSource, exactTarballPath);
      return { tarballPath: exactTarballPath, descriptorBytes, bundleBytes };
    },
    evidenceVerification: {
      verifyBundle: () => ({ integratedTime: '1753228800' }),
    },
  },
);

process.exit(process.exitCode ?? 0);
