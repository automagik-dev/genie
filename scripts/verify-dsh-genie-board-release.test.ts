import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stampReleasePayloadVersion } from './release-payload-version';
import { verifyArtifacts } from './verify-dsh-genie-board-release';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const version = '5.260907.99';
const platforms = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-release-test-'));
  roots.push(root);
  const payload = join(root, 'payload');
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  function put(path: string, data: string) {
    mkdirSync(dirname(join(payload, path)), { recursive: true });
    writeFileSync(join(payload, path), data);
  }
  for (const path of [
    'plugins/genie/package.json',
    'plugins/genie/orca-plugin.json',
    'plugins/dsh-genie-board/package.json',
  ])
    put(path, JSON.stringify({ version, minimumGenieVersion: version }));
  for (const path of ['agent.cordis.yml', 'cordis.patch.yml', 'README.md', 'NOTICE', 'dist/index.js', 'dist/client.js'])
    put(`plugins/dsh-genie-board/${path}`, 'fixture');
  stampReleasePayloadVersion(payload, version);
  function pack() {
    for (const platform of platforms) {
      const path = join(artifacts, `genie-${version}-${platform}.tar.gz`);
      const process = Bun.spawnSync(['tar', '-czf', path, '-C', payload, '.']);
      if (process.exitCode) throw new Error('tar failed');
      writeFileSync(`${path}.bundle`, 'invalid signature');
      writeFileSync(`${path}.intoto.jsonl`, 'invalid provenance');
      writeFileSync(
        `${path}.stable.delivery.json`,
        JSON.stringify({
          artifactSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
          version,
          channel: 'stable',
          releaseName: `genie-${version}-${platform}.tar.gz`,
          releaseTag: `v${version}`,
          repository: 'automagik-dev/genie',
          platformId: platform,
          sourceSha: 'a'.repeat(40),
          sourceBranch: 'main',
        }),
      );
    }
  }
  pack();
  return { root, payload, artifacts, pack, put };
}
test('all four complete unsigned payloads pass; missing and extra platforms fail', () => {
  const f = fixture();
  expect(() => verifyArtifacts(f.artifacts, version)).not.toThrow();
  writeFileSync(join(f.artifacts, 'extra.tar.gz'), 'x');
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow('exactly four');
  rmSync(join(f.artifacts, 'extra.tar.gz'));
  rmSync(join(f.artifacts, `genie-${version}-linux-arm64.tar.gz`));
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow('exactly four');
});
for (const member of [
  'package.json',
  'agent.cordis.yml',
  'cordis.patch.yml',
  'README.md',
  'NOTICE',
  'dist/index.js',
  'dist/client.js',
])
  test(`every platform requires ${member}`, () => {
    const f = fixture();
    rmSync(join(f.payload, 'plugins/dsh-genie-board', member));
    f.pack();
    expect(() => verifyArtifacts(f.artifacts, version)).toThrow();
  });
test('candidate floor and version drift fail independently', () => {
  const f = fixture();
  f.put('plugins/dsh-genie-board/package.json', JSON.stringify({ version, minimumGenieVersion: '5.0.0' }));
  f.pack();
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow('minimumGenieVersion');
  f.put('plugins/dsh-genie-board/package.json', JSON.stringify({ version: '5.0.0', minimumGenieVersion: version }));
  f.pack();
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow('version mismatch');
});
test('signed mode rejects missing/empty sidecars, descriptor mismatch and invalid trust material', () => {
  const f = fixture();
  const first = join(f.artifacts, `genie-${version}-darwin-arm64.tar.gz`);
  writeFileSync(`${first}.bundle`, '');
  expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow('empty');
  f.pack();
  rmSync(`${first}.intoto.jsonl`);
  expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow();
  f.pack();
  const descriptor = JSON.parse(readFileSync(`${first}.stable.delivery.json`, 'utf8'));
  descriptor.artifactSha256 = '0'.repeat(64);
  writeFileSync(`${first}.stable.delivery.json`, JSON.stringify(descriptor));
  expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow('descriptor');
  f.pack();
  const tools = join(f.root, 'tools');
  mkdirSync(tools);
  writeFileSync(join(tools, 'cosign'), '#!/bin/sh\necho rejected-signature >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(tools, 'slsa-verifier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${tools}:${previousPath}`;
    expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow('cosign signature verification failed');
    writeFileSync(join(tools, 'cosign'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(tools, 'slsa-verifier'), '#!/bin/sh\necho rejected-provenance >&2\nexit 1\n', { mode: 0o755 });
    expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow('SLSA provenance verification failed');
  } finally {
    process.env.PATH = previousPath;
  }
});
test('both publication paths verify signed payloads before reconciliation', () => {
  const workflow = readFileSync(join(import.meta.dir, '../.github/workflows/release-publish.yml'), 'utf8');
  expect(workflow.match(/verify-dsh-genie-board-release.ts --signed-artifact-dir/g)?.length).toBe(2);
});

test('signed orchestration verifies all four signatures, provenance and endorsed descriptors; rejects rewritten source', () => {
  // These deterministic executables prove invocation and failure propagation, not cryptographic validity.
  const f = fixture();
  const tools = join(f.root, 'tools');
  mkdirSync(tools);
  const log = join(f.root, 'calls');
  for (const name of ['cosign', 'slsa-verifier'])
    writeFileSync(join(tools, name), `#!/bin/sh\necho ${name} >> '${log}'\nexit 0\n`, { mode: 0o755 });
  writeFileSync(
    join(tools, 'gh'),
    `#!/usr/bin/env bun
import { readFileSync, appendFileSync, readdirSync, copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--help')) process.exit(1);
if (args[0] === 'release' && args[1] === 'download') {
 const directory = args[args.indexOf('--dir') + 1];
 for (const name of readdirSync(${JSON.stringify(f.artifacts)})) copyFileSync(${JSON.stringify(f.artifacts)} + '/' + name, directory + '/' + name);
 process.exit(0);
}
if (args[0] === 'release' && args[1] === 'view') { console.log(JSON.stringify({ tagName: 'v${version}', isDraft: false, isPrerelease: false })); process.exit(0); }
if (args[0] === 'api') { console.log(JSON.stringify({ sha: process.env.DSH_TEST_TAG_SHA || '${'a'.repeat(40)}' })); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, 'descriptor\\n');
const bundle = args[args.indexOf('--bundle') + 1];
console.log(JSON.stringify([{ verificationResult: { statement: { predicate: JSON.parse(readFileSync(bundle, 'utf8')) } } }]));
`,
    { mode: 0o755 },
  );
  for (const platform of platforms) {
    const descriptor = join(f.artifacts, `genie-${version}-${platform}.tar.gz.stable.delivery.json`);
    writeFileSync(`${descriptor}.sigstore.json`, readFileSync(descriptor));
  }
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = `${tools}:${previousPath}`;
    expect(verifyArtifacts(f.artifacts, version, 'stable')).toBe('a'.repeat(40));
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    for (const name of ['cosign', 'slsa-verifier', 'descriptor'])
      expect(calls.filter((call) => call === name)).toHaveLength(4);
    const cli = join(import.meta.dir, 'verify-dsh-genie-board-release.ts');
    const release = Bun.spawnSync(['bun', cli, '--release', `v${version}`, '--channel', 'stable'], {
      env: { ...process.env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(release.exitCode).toBe(0);
    const wrongTag = Bun.spawnSync(['bun', cli, '--release', `v${version}`, '--channel', 'stable'], {
      env: { ...process.env, DSH_TEST_TAG_SHA: 'b'.repeat(40) },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(wrongTag.exitCode).toBe(1);
    expect(wrongTag.stderr.toString()).toContain('published tag/source binding mismatch');
    // Tamper all descriptors consistently; the cryptographically endorsed predicate still binds original source.
    for (const platform of platforms) {
      const descriptorPath = join(f.artifacts, `genie-${version}-${platform}.tar.gz.stable.delivery.json`);
      const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      descriptor.sourceSha = 'b'.repeat(40);
      writeFileSync(descriptorPath, JSON.stringify(descriptor));
    }
    expect(() => verifyArtifacts(f.artifacts, version, 'stable')).toThrow('verified delivery predicate');
  } finally {
    process.env.PATH = previousPath;
  }
});

test('a missing member on only the final platform fails after the other three complete', () => {
  const f = fixture();
  rmSync(join(f.payload, 'plugins/dsh-genie-board/dist/client.js'));
  const path = join(f.artifacts, `genie-${version}-linux-x64-musl.tar.gz`);
  expect(Bun.spawnSync(['tar', '-czf', path, '-C', f.payload, '.']).exitCode).toBe(0);
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow();
});

test('archive symlinks fail before extraction', () => {
  const f = fixture();
  symlinkSync('/tmp', join(f.payload, 'outside'));
  f.pack();
  expect(() => verifyArtifacts(f.artifacts, version)).toThrow('unsafe archive entry type');
});
