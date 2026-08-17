import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPhysicalTree } from '../src/lib/codex-activation.ts';

const MATERIALIZE = join(import.meta.dir, 'materialize-release-subjects.sh');
const BUILD = join(import.meta.dir, 'build-delivery-evidence.ts');
const VERSION = '5.260723.7';
const PLATFORMS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createTarball(root: string, platform: string, marker: string): { tarball: string; payload: string } {
  const payload = join(root, `${marker}-${platform}`);
  mkdirSync(join(payload, 'plugins', 'genie'), { recursive: true });
  writeFileSync(join(payload, 'genie'), `${marker} binary ${platform}`);
  chmodSync(join(payload, 'genie'), 0o755);
  writeFileSync(join(payload, 'plugins', 'genie', 'plugin.txt'), `${marker} plugin ${platform}`);
  const tarball = join(root, `genie-${VERSION}-${platform}.tar.gz`);
  expect(Bun.spawnSync(['tar', '-czf', tarball, '-C', payload, '.']).exitCode).toBe(0);
  writeFileSync(`${tarball}.bundle`, `${marker} bundle`);
  writeFileSync(`${tarball}.intoto.jsonl`, `${marker} provenance`);
  return { tarball, payload };
}

describe('promotion effective release subject selection', () => {
  test('all promoted descriptors bind preserved remote tarballs and extracted members when current bytes differ', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-release-subjects-'));
    roots.push(root);
    const dist = join(root, 'dist');
    const remote = join(root, 'remote');
    const bin = join(root, 'bin');
    mkdirSync(dist);
    mkdirSync(remote);
    mkdirSync(bin);

    const remotePayloads = new Map<string, string>();
    for (const platform of PLATFORMS) {
      createTarball(dist, platform, 'current');
      const built = createTarball(remote, platform, 'preserved');
      remotePayloads.set(platform, built.payload);
      expect(sha256(join(dist, `genie-${VERSION}-${platform}.tar.gz`))).not.toBe(sha256(built.tarball));
    }

    const assets = PLATFORMS.flatMap((platform) => {
      const name = `genie-${VERSION}-${platform}.tar.gz`;
      return [name, `${name}.bundle`, `${name}.intoto.jsonl`];
    }).map((name, index) => ({ name, id: index + 1 }));
    writeFileSync(
      join(bin, 'gh'),
      `#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const assets = ${JSON.stringify(assets)};
if (args[0] === 'api' && /\\/releases\\/tags\\//.test(args[1] ?? '')) {
  console.log(JSON.stringify({ id: 900, tag_name: 'v${VERSION}', draft: false, prerelease: true, assets }));
  process.exit(0);
}
const assetPath = args.find((arg) => /\\/releases\\/assets\\/[0-9]+$/.test(arg));
if (args[0] === 'api' && assetPath) {
  const id = Number(assetPath.split('/').pop());
  const name = assets.find((asset) => asset.id === id)?.name;
  if (!name) process.exit(1);
  process.stdout.write(readFileSync(join(process.env.REMOTE_DIR, name)));
  process.exit(0);
}
if (args[0] === 'attestation' && args[1] === 'verify' && args.includes('--help')) process.exit(1);
process.exit(2);
`,
    );
    for (const tool of ['cosign', 'slsa-verifier']) {
      writeFileSync(join(bin, tool), '#!/usr/bin/env bash\nexit 0\n');
    }
    for (const tool of ['gh', 'cosign', 'slsa-verifier']) chmodSync(join(bin, tool), 0o755);

    const materialized = Bun.spawnSync(['bash', MATERIALIZE], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERSION,
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        DIST_DIR: dist,
        REMOTE_DIR: remote,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(materialized.exitCode).toBe(0);

    const manifest = join(root, 'dev.json');
    writeFileSync(
      manifest,
      `{"schema_version":1,"channel":"dev","version":"${VERSION}","released_at":"2026-07-23T00:00:00Z","tarball_base":"https://github.com/automagik-dev/genie/releases/download/v${VERSION}","platforms":["linux-x64-glibc","linux-x64-musl","linux-arm64","darwin-arm64"]}\n`,
    );
    for (const platform of PLATFORMS) {
      const tarball = join(dist, `genie-${VERSION}-${platform}.tar.gz`);
      const output = join(root, `${platform}.delivery.json`);
      const built = Bun.spawnSync([
        'bun',
        BUILD,
        '--tarball',
        tarball,
        '--manifest',
        manifest,
        '--output',
        output,
        '--repository',
        'automagik-dev/genie',
        '--version',
        VERSION,
        '--channel',
        'dev',
        '--platform-id',
        platform,
        '--source-sha',
        'a'.repeat(40),
        '--source-branch',
        'dev',
        '--source-ci-run-id',
        '123',
        '--control-sha',
        'b'.repeat(40),
      ]);
      expect(built.exitCode).toBe(0);
      const descriptor = JSON.parse(readFileSync(output, 'utf8'));
      const preserved = join(remote, `genie-${VERSION}-${platform}.tar.gz`);
      expect(descriptor.artifactSha256).toBe(sha256(preserved));
      expect(descriptor.installedBinarySha256).toBe(sha256(join(remotePayloads.get(platform)!, 'genie')));
      expect(descriptor.canonicalPayloadSha256).toBe(
        scanPhysicalTree(join(remotePayloads.get(platform)!, 'plugins', 'genie')).digest,
      );
    }
  }, 15_000);

  test('fails closed when the remote release probe cannot be resolved', () => {
    // A transient API outage must never be misread as "no remote subjects":
    // that would silently rebind promoted descriptors to same-run bytes.
    const root = mkdtempSync(join(tmpdir(), 'genie-release-subjects-'));
    roots.push(root);
    const dist = join(root, 'dist');
    const bin = join(root, 'bin');
    mkdirSync(dist);
    mkdirSync(bin);
    for (const platform of PLATFORMS) createTarball(dist, platform, 'current');
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\necho "gh: Internal Server Error (HTTP 502)" >&2\nexit 1\n');
    chmodSync(join(bin, 'gh'), 0o755);
    const materialized = Bun.spawnSync(['bash', MATERIALIZE], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        VERSION,
        RELEASE_REPOSITORY: 'automagik-dev/genie',
        DIST_DIR: dist,
        GH_RETRY_SLEEPS: '0 0 0 0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(materialized.exitCode).toBe(3);
    expect(materialized.stderr.toString()).toContain('could not determine whether');
  }, 15_000);
});
