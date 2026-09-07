#!/usr/bin/env bun
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { verifyReleasePayloadVersion } from './release-payload-version';

const platforms = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];
const members = [
  'package.json',
  'agent.cordis.yml',
  'cordis.patch.yml',
  'README.md',
  'NOTICE',
  'dist/index.js',
  'dist/client.js',
];
const repository = 'automagik-dev/genie';
function run(argv: string[]): string {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: 120_000, env: { ...process.env } });
  if (result.exitCode !== 0) throw new Error(`${argv[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
function nonempty(path: string): void {
  if (!statSync(path).isFile() || !statSync(path).size) throw new Error(`missing/empty regular file: ${path}`);
}
function verifyTarball(path: string, version: string): void {
  // Reject links, special entries and escaping/duplicate names before extraction.
  const names = run(['tar', '-tzf', path]).trim().split('\n');
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = name.replace(/^\.\//, '').replace(/\/$/, '');
    if (name.startsWith('/') || normalized.split('/').includes('..') || seen.has(normalized))
      throw new Error('unsafe archive path');
    seen.add(normalized);
  }
  if (
    run(['tar', '-tvzf', path])
      .trim()
      .split('\n')
      .some((line) => !['-', 'd'].includes(line[0]))
  )
    throw new Error('unsafe archive entry type');
  const root = mkdtempSync(join(tmpdir(), 'genie-dsh-verify-'));
  try {
    run(['tar', '-xzf', path, '-C', root, '--no-same-owner']);
    for (const member of members) nonempty(join(root, 'plugins/dsh-genie-board', member));
    verifyReleasePayloadVersion(root, version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export function verifyArtifacts(directory: string, version: string, channel?: 'stable' | 'dev'): string | undefined {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/.test(version)) throw new Error('invalid version');
  const expected = platforms.map((platform) => `genie-${version}-${platform}.tar.gz`).sort();
  const actual = readdirSync(directory)
    .filter((name) => name.endsWith('.tar.gz'))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('expected exactly four candidate platform tarballs');
  let sourceSha: string | undefined;
  for (const [index, name] of expected.entries()) {
    const path = resolve(directory, name);
    nonempty(path);
    if (channel) {
      nonempty(`${path}.bundle`);
      nonempty(`${path}.intoto.jsonl`);
      const descriptor = JSON.parse(readFileSync(`${path}.${channel}.delivery.json`, 'utf8'));
      const platform = platforms.find((value) => name === `genie-${version}-${value}.tar.gz`);
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (
        descriptor.artifactSha256 !== digest ||
        descriptor.version !== version ||
        descriptor.channel !== channel ||
        descriptor.releaseName !== name ||
        descriptor.releaseTag !== `v${version}` ||
        descriptor.repository !== repository ||
        descriptor.platformId !== platform ||
        !/^[a-f0-9]{40}$/.test(descriptor.sourceSha) ||
        (channel === 'stable' && descriptor.sourceBranch !== 'main')
      )
        throw new Error(`descriptor binding mismatch: ${name}`);
      if (index && sourceSha !== descriptor.sourceSha) throw new Error('candidate source mismatch');
      sourceSha = descriptor.sourceSha;
      run(['bash', join(import.meta.dir, 'verify-release.sh'), '--local', path]);
      const descriptorPath = `${path}.${channel}.delivery.json`;
      nonempty(`${descriptorPath}.sigstore.json`);
      const verified = JSON.parse(
        run([
          'gh',
          'attestation',
          'verify',
          descriptorPath,
          '--bundle',
          `${descriptorPath}.sigstore.json`,
          '--repo',
          repository,
          '--predicate-type',
          `https://github.com/${repository}/delivery-evidence/v1`,
          '--cert-identity',
          `https://github.com/${repository}/.github/workflows/release-publish.yml@refs/heads/main`,
          '--source-ref',
          'refs/heads/main',
          '--format',
          'json',
        ]),
      );
      if (
        !Array.isArray(verified) ||
        verified.length !== 1 ||
        !isDeepStrictEqual(verified[0]?.verificationResult?.statement?.predicate, descriptor)
      ) {
        throw new Error('verified delivery predicate does not equal descriptor');
      }
    }
    verifyTarball(path, version);
  }
  return sourceSha;
}
function main(): void {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !['--unsigned-artifact-dir', '--signed-artifact-dir', '--release', '--version', '--channel'].includes(key) ||
      !value ||
      options.has(key)
    )
      throw new Error('invalid arguments');
    options.set(key, value);
  }
  const modes = ['--unsigned-artifact-dir', '--signed-artifact-dir', '--release'].filter((key) => options.has(key));
  if (modes.length !== 1) throw new Error('choose exactly one artifact/release mode');
  const mode = modes[0];
  const input = options.get(mode) as string;
  const version = mode === '--release' ? input.replace(/^v/, '') : options.get('--version');
  const channel = options.get('--channel') ?? 'stable';
  if (
    !version ||
    !['stable', 'dev'].includes(channel) ||
    (mode === '--release' && input !== `v${version}`) ||
    (options.has('--version') && options.get('--version') !== version)
  )
    throw new Error('invalid candidate/channel');
  const directory = mode === '--release' ? mkdtempSync(join(tmpdir(), 'genie-dsh-release-')) : resolve(input);
  try {
    if (mode === '--release') run(['gh', 'release', 'download', input, '--repo', repository, '--dir', directory]);
    const source = verifyArtifacts(
      directory,
      version,
      mode === '--unsigned-artifact-dir' ? undefined : (channel as 'stable' | 'dev'),
    );
    if (mode === '--release') {
      const release = JSON.parse(
        run(['gh', 'release', 'view', input, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease']),
      );
      const commit = JSON.parse(run(['gh', 'api', `repos/${repository}/commits/${input}`]));
      if (
        release.tagName !== input ||
        release.isDraft ||
        (channel === 'stable' && release.isPrerelease) ||
        commit.sha !== source
      )
        throw new Error('published tag/source binding mismatch');
    }
    console.log(`DSH payload verified (${mode.slice(2)}, ${version}, four platforms)`);
  } finally {
    if (mode === '--release') rmSync(directory, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
