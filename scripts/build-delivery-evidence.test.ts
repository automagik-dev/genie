import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPhysicalTree } from '../src/lib/codex-activation.ts';

const SCRIPT = join(import.meta.dir, 'build-delivery-evidence.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'genie-delivery-builder-'));
  roots.push(root);
  const payload = join(root, 'payload');
  mkdirSync(join(payload, 'plugins', 'genie', 'nested'), { recursive: true });
  writeFileSync(join(payload, 'genie'), 'binary bytes');
  chmodSync(join(payload, 'genie'), 0o755);
  writeFileSync(join(payload, 'plugins', 'genie', 'plugin.txt'), 'plugin bytes');
  writeFileSync(join(payload, 'plugins', 'genie', 'nested', 'data.json'), '{}\n');
  const version = '5.260723.7';
  const tarball = join(root, `genie-${version}-linux-x64-glibc.tar.gz`);
  const tar = Bun.spawnSync(['tar', '-czf', tarball, '-C', payload, '.']);
  expect(tar.exitCode).toBe(0);
  const manifest = join(root, 'dev.json');
  writeFileSync(
    manifest,
    '{"schema_version":1,"channel":"dev","version":"5.260723.7","released_at":"2026-07-23T00:00:00Z","tarball_base":"https://github.com/automagik-dev/genie/releases/download/v5.260723.7","platforms":["linux-x64-glibc","linux-x64-musl","linux-arm64","darwin-arm64"]}\n',
  );
  return { root, version, tarball, manifest, output: join(root, 'descriptor.json') };
}

function run(f: ReturnType<typeof fixture>, output = f.output) {
  return Bun.spawnSync(
    [
      'bun',
      SCRIPT,
      '--tarball',
      f.tarball,
      '--manifest',
      f.manifest,
      '--output',
      output,
      '--repository',
      'automagik-dev/genie',
      '--version',
      f.version,
      '--channel',
      'dev',
      '--platform-id',
      'linux-x64-glibc',
      '--source-sha',
      'a'.repeat(40),
      '--source-branch',
      'dev',
      '--source-ci-run-id',
      '12345',
      '--control-sha',
      'b'.repeat(40),
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
}

describe('canonical delivery evidence descriptor builder', () => {
  test('derives deterministic raw-manifest, tarball, binary, and physical plugin tree bindings', () => {
    const first = fixture();
    expect(run(first).exitCode).toBe(0);
    const bytes = readFileSync(first.output, 'utf8');
    const descriptor = JSON.parse(bytes);
    expect(Object.keys(descriptor)).toEqual([
      'schemaVersion',
      'repository',
      'version',
      'channel',
      'platformId',
      'platformTriple',
      'releaseTag',
      'releaseName',
      'releaseManifestSha256',
      'artifactSha256',
      'installedBinarySha256',
      'canonicalPayloadSha256',
      'digestAlgorithm',
      'sourceSha',
      'sourceBranch',
      'sourceCiRunId',
      'controlSha',
    ]);
    expect(descriptor).toMatchObject({
      schemaVersion: 1,
      repository: 'automagik-dev/genie',
      version: first.version,
      channel: 'dev',
      platformId: 'linux-x64-glibc',
      platformTriple: 'linux-x64',
      releaseTag: `v${first.version}`,
      releaseName: `genie-${first.version}-linux-x64-glibc.tar.gz`,
      digestAlgorithm: 'genie-physical-tree-v1',
      sourceSha: 'a'.repeat(40),
      sourceBranch: 'dev',
      sourceCiRunId: '12345',
      controlSha: 'b'.repeat(40),
    });
    for (const key of ['releaseManifestSha256', 'artifactSha256', 'installedBinarySha256', 'canonicalPayloadSha256']) {
      expect(descriptor[key]).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(descriptor.canonicalPayloadSha256).toBe(
      scanPhysicalTree(join(first.root, 'payload', 'plugins', 'genie')).digest,
    );
    expect(bytes.endsWith('\n')).toBe(true);

    const replay = join(first.root, 'replay.json');
    expect(run(first, replay).exitCode).toBe(0);
    expect(readFileSync(replay)).toEqual(readFileSync(first.output));
  });

  test('the digest binds exact raw manifest bytes, including formatting', () => {
    const f = fixture();
    expect(run(f).exitCode).toBe(0);
    const before = JSON.parse(readFileSync(f.output, 'utf8')).releaseManifestSha256;
    const parsed = JSON.parse(readFileSync(f.manifest, 'utf8'));
    writeFileSync(f.manifest, `${JSON.stringify(parsed, null, 2)}\n`);
    const changed = join(f.root, 'changed.json');
    expect(run(f, changed).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(changed, 'utf8')).releaseManifestSha256).not.toBe(before);
  });

  test('fails closed on a mismatched asset name or unsafe plugin member', () => {
    const mismatched = fixture();
    const renamed = join(mismatched.root, 'genie-5.260723.7-linux-arm64.tar.gz');
    writeFileSync(renamed, readFileSync(mismatched.tarball));
    mismatched.tarball = renamed;
    expect(run(mismatched).exitCode).toBe(2);

    const unsafe = fixture();
    rmSync(unsafe.tarball);
    const link = join(unsafe.root, 'payload', 'plugins', 'genie', 'link');
    Bun.spawnSync(['ln', '-s', 'plugin.txt', link]);
    Bun.spawnSync(['tar', '-czf', unsafe.tarball, '-C', join(unsafe.root, 'payload'), '.']);
    const result = run(unsafe);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('link or unsupported');

    const hardlink = fixture();
    rmSync(hardlink.tarball);
    const hardlinkPath = join(hardlink.root, 'payload', 'plugins', 'genie', 'hardlink');
    Bun.spawnSync(['ln', join(hardlink.root, 'payload', 'plugins', 'genie', 'plugin.txt'), hardlinkPath]);
    Bun.spawnSync(['tar', '-czf', hardlink.tarball, '-C', join(hardlink.root, 'payload'), '.']);
    const hardlinkResult = run(hardlink);
    expect(hardlinkResult.exitCode).toBe(2);
    expect(hardlinkResult.stderr.toString()).toContain('unsupported member type');
  });
});
