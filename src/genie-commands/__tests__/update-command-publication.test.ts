import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPhysicalTree } from '../../lib/codex-activation.js';
import type { DeliveryEvidencePlatformId } from '../../lib/codex-delivery-evidence.js';
import { buildTestDeliveryEvidencePack } from '../../lib/codex-delivery-evidence.test-support.js';
import { VERSION } from '../../lib/version.js';

const RUNNER = join(import.meta.dir, '..', '..', '..', 'tests', 'support', 'update-publication-failure-runner.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `genie-${label}-`));
  roots.push(root);
  return root;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writeExecutable(path: string, source: string): void {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function platformId(): DeliveryEvidencePlatformId {
  if (process.platform === 'darwin') return 'darwin-arm64';
  if (process.arch === 'arm64') return 'linux-arm64';
  return 'linux-x64-glibc';
}

function buildReleasePayload(
  root: string,
  version: string,
): {
  tarball: string;
  binarySha256: string;
  payloadSha256: string;
} {
  const payload = join(root, 'payload');
  for (const directory of ['.agents', '.claude-plugin', 'plugins/genie', 'skills/review', 'templates']) {
    mkdirSync(join(payload, directory), { recursive: true });
  }
  writeFileSync(join(payload, '.agents', 'plugin.json'), '{}\n');
  writeFileSync(join(payload, '.claude-plugin', 'marketplace.json'), '{}\n');
  writeFileSync(join(payload, 'LICENSE'), 'test fixture\n');
  writeFileSync(join(payload, 'VERSION'), `${version}\n`);
  writeFileSync(join(payload, 'plugins', 'genie', 'plugin.txt'), 'authenticated plugin payload\n');
  writeFileSync(join(payload, 'skills', 'review', 'SKILL.md'), '# Review\n');
  writeFileSync(join(payload, 'templates', 'template.txt'), 'template\n');
  writeExecutable(
    join(payload, 'genie'),
    `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf 'genie ${version}\\n'; exit 0; fi\nexit 0\n`,
  );
  const tree = scanPhysicalTree(join(payload, 'plugins', 'genie'));
  if (tree.status !== 'ok' || tree.digest === undefined) throw new Error(`fixture tree is ${tree.status}`);
  const tarball = join(root, `genie-${version}-${platformId()}.tar.gz`);
  const archived = Bun.spawnSync(['tar', '-czf', tarball, '-C', payload, '.'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (archived.exitCode !== 0) throw new Error(archived.stderr.toString());
  return { tarball, binarySha256: sha256(join(payload, 'genie')), payloadSha256: tree.digest };
}

describe('updateCommand publication boundary', () => {
  test('real promotion plus an unwritable record store exits nonzero and preserves retry metadata', () => {
    const root = tempRoot('update-command-publication');
    const genieHome = join(root, 'genie-home');
    const bin = join(genieHome, 'bin');
    const fakeBin = join(root, 'fake-bin');
    const fixture = join(root, 'fixture');
    mkdirSync(bin, { recursive: true });
    mkdirSync(fakeBin);
    mkdirSync(fixture);

    const oldVersion = '1.1.1';
    writeExecutable(
      join(bin, 'genie'),
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then printf 'genie ${oldVersion}\\n'; exit 0; fi\nexit 0\n`,
    );
    writeExecutable(
      join(fakeBin, 'codex'),
      '#!/bin/sh\nif [ "$1" = "plugin" ] && [ "$2" = "list" ]; then printf \'{"installed":[]}\\n\'; exit 0; fi\nexit 1\n',
    );
    writeFileSync(
      join(genieHome, '.integration-consent.json'),
      `${JSON.stringify({
        schemaVersion: 3,
        selection: 'codex',
        state: 'committed',
        revision: 1,
        updatedAt: '2026-07-23T00:00:00.000Z',
      })}\n`,
    );
    const marker = join(genieHome, '.install-version');
    writeFileSync(marker, `${oldVersion}\n`);
    const recordPath = join(genieHome, '.codex-plugin-delivery-record.json');
    mkdirSync(recordPath);

    const release = buildReleasePayload(fixture, VERSION);
    const pack = buildTestDeliveryEvidencePack({
      descriptor: {
        version: VERSION,
        channel: 'stable',
        platformId: platformId(),
        platformTriple: `${process.platform}-${process.arch}`,
        releaseTag: `v${VERSION}`,
        releaseName: `genie-${VERSION}-${platformId()}.tar.gz`,
        artifactSha256: sha256(release.tarball),
        installedBinarySha256: release.binarySha256,
        canonicalPayloadSha256: release.payloadSha256,
      },
    });
    const manifestPath = join(fixture, 'manifest.json');
    const descriptorPath = join(fixture, 'descriptor.json');
    const bundlePath = join(fixture, 'bundle.json');
    writeFileSync(manifestPath, pack.manifestBytes);
    writeFileSync(descriptorPath, pack.descriptorBytes);
    writeFileSync(bundlePath, pack.bundleBytes);

    const env = { ...process.env };
    env.GENIE_BUNDLE_ROOT = undefined;
    env.GENIE_LIFECYCLE_LEASE_PATH = undefined;
    env.GENIE_LIFECYCLE_LEASE_OWNER = undefined;
    env.GENIE_UPDATE_ROLLBACK = undefined;
    env.GENIE_UPDATE_SYNC_ONLY = undefined;
    Object.assign(env, {
      HOME: join(root, 'user-home'),
      CODEX_HOME: join(root, 'codex-home'),
      GENIE_HOME: genieHome,
      GENIE_CHANNEL: 'stable',
      GENIE_TEST_TARBALL: release.tarball,
      GENIE_TEST_MANIFEST: manifestPath,
      GENIE_TEST_DESCRIPTOR: descriptorPath,
      GENIE_TEST_BUNDLE: bundlePath,
      NO_COLOR: '1',
      PATH: `${bin}:${fakeBin}:${process.env.PATH ?? ''}`,
    });

    const result = Bun.spawnSync(['bun', RUNNER], { env, stdout: 'pipe', stderr: 'pipe' });
    const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    expect(result.exitCode).toBe(1);
    expect(output).toContain('authenticated Codex delivery publication incomplete');
    expect(output.match(/"deliveryComplete":false/g)).toHaveLength(1);
    expect(output).not.toContain('"deliveryComplete":true');
    expect(existsSync(marker)).toBe(true);
    expect(readFileSync(marker, 'utf8')).toBe(`${oldVersion}\n`);
    expect(existsSync(recordPath) && statSync(recordPath).isDirectory()).toBe(true);

    const installed = Bun.spawnSync([join(bin, 'genie'), '--version'], { stdout: 'pipe', stderr: 'pipe' });
    expect(installed.exitCode).toBe(0);
    expect(installed.stdout.toString()).toContain(VERSION);
  });
});
