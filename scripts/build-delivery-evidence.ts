#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9]+$/;
const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PLATFORMS = {
  'linux-x64-glibc': 'linux-x64',
  'linux-x64-musl': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'darwin-arm64',
} as const;

interface Arguments {
  tarball: string;
  manifest: string;
  output: string;
  repository: string;
  version: string;
  channel: 'stable' | 'homolog' | 'dev';
  platformId: keyof typeof PLATFORMS;
  sourceSha: string;
  sourceBranch: 'main' | 'homolog' | 'dev';
  sourceCiRunId: string;
  controlSha: string;
}

function fail(message: string): never {
  console.error(`delivery-evidence: ${message}`);
  process.exit(2);
}

function parseArguments(argv: string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`invalid argument near ${key ?? '<end>'}`);
    if (values.has(key)) fail(`duplicate argument ${key}`);
    values.set(key, value);
  }
  const required = (key: string): string => values.get(key) ?? fail(`missing ${key}`);
  const args = {
    tarball: resolve(required('--tarball')),
    manifest: resolve(required('--manifest')),
    output: resolve(required('--output')),
    repository: required('--repository'),
    version: required('--version'),
    channel: required('--channel'),
    platformId: required('--platform-id'),
    sourceSha: required('--source-sha'),
    sourceBranch: required('--source-branch'),
    sourceCiRunId: required('--source-ci-run-id'),
    controlSha: required('--control-sha'),
  };
  if (values.size !== 11) fail('unknown argument');
  if (!REPOSITORY_RE.test(args.repository)) fail('invalid repository');
  if (!VERSION_RE.test(args.version)) fail('invalid version');
  if (!['stable', 'homolog', 'dev'].includes(args.channel)) fail('invalid channel');
  if (!(args.platformId in PLATFORMS)) fail('invalid platform id');
  if (!['main', 'homolog', 'dev'].includes(args.sourceBranch)) fail('invalid source branch');
  if (args.channel === 'stable' && args.sourceBranch !== 'main') fail('stable evidence requires a main source');
  if (args.channel === 'homolog' && args.sourceBranch === 'dev')
    fail('homolog evidence requires main or homolog source');
  if (!SHA_RE.test(args.sourceSha) || !SHA_RE.test(args.controlSha)) fail('invalid source/control SHA');
  if (!RUN_ID_RE.test(args.sourceCiRunId)) fail('invalid source CI run ID');
  return args as Arguments;
}

function sha256File(path: string): string {
  const digest = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count <= 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(fd);
  }
  return digest.digest('hex');
}

function collectPhysicalTreeEntries(root: string, current: string, entries: string[]): void {
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const path = relative(root, absolute).split(sep).join('/');
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`plugin tree contains symlink at ${path}`);
    if (stat.isDirectory()) {
      entries.push(`D\0${path}\0`);
      collectPhysicalTreeEntries(root, absolute, entries);
    } else if (stat.isFile()) {
      entries.push(`F\0${path}\0${(stat.mode & 0o111) !== 0 ? 'x' : '-'}\0${sha256File(absolute)}\0`);
    } else {
      fail(`plugin tree contains unsupported entry at ${path}`);
    }
  }
}

function physicalTreeDigest(root: string): string {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('plugins/genie must be a physical directory');
  const entries: string[] = [];
  collectPhysicalTreeEntries(root, root, entries);
  const digest = createHash('sha256');
  digest.update('genie-codex-activation-tree-v1\0');
  for (const entry of entries.sort()) digest.update(entry);
  return digest.digest('hex');
}

function assertSafeArchiveListing(tarball: string): void {
  const listing = Bun.spawnSync(['tar', '-tzf', tarball], { stdout: 'pipe', stderr: 'pipe' });
  if (listing.exitCode !== 0) fail(`cannot list tarball: ${listing.stderr.toString().trim()}`);
  for (const raw of listing.stdout.toString().split('\n')) {
    if (!raw) continue;
    const path = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (!path) continue;
    if (path.startsWith('/') || path.includes('\\') || path.split('/').some((part) => part === '..')) {
      fail(`unsafe archive path ${raw}`);
    }
  }
  const verbose = Bun.spawnSync(['tar', '-tvzf', tarball], { stdout: 'pipe', stderr: 'pipe' });
  if (verbose.exitCode !== 0) fail(`cannot inspect tarball entry types: ${verbose.stderr.toString().trim()}`);
  for (const line of verbose.stdout.toString().split('\n')) {
    if (!line) continue;
    const kind = line[0];
    if (kind !== '-' && kind !== 'd') fail(`archive contains link or unsupported member type ${kind}`);
  }
}

function assertPhysicalArchiveTree(current: string): void {
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`archive extracted a symlink at ${path}`);
    if (stat.isDirectory()) assertPhysicalArchiveTree(path);
    else if (!stat.isFile()) fail(`archive extracted an unsupported entry at ${path}`);
  }
}

function extractTarball(tarball: string, root: string): void {
  assertSafeArchiveListing(tarball);
  const extracted = Bun.spawnSync(['tar', '-xzf', tarball, '--no-same-owner', '--no-same-permissions', '-C', root], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (extracted.exitCode !== 0) fail(`cannot extract tarball: ${extracted.stderr.toString().trim()}`);
  assertPhysicalArchiveTree(root);
}

function assertManifestBinding(args: Arguments): void {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch {
    fail('manifest is not valid JSON');
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) fail('manifest must be an object');
  const value = manifest as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = ['channel', 'platforms', 'released_at', 'schema_version', 'tarball_base', 'version'].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) fail('manifest has an unsupported schema');
  if (
    value.schema_version !== 1 ||
    value.channel !== args.channel ||
    value.version !== args.version ||
    value.tarball_base !== `https://github.com/${args.repository}/releases/download/v${args.version}` ||
    !Array.isArray(value.platforms) ||
    JSON.stringify(value.platforms) !== JSON.stringify(Object.keys(PLATFORMS)) ||
    typeof value.released_at !== 'string' ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/.test(value.released_at) ||
    !Number.isFinite(Date.parse(value.released_at))
  ) {
    fail('manifest does not bind the descriptor release/channel/platform set');
  }
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const releaseName = basename(args.tarball);
  const expectedName = `genie-${args.version}-${args.platformId}.tar.gz`;
  if (releaseName !== expectedName) fail(`tarball name must be ${expectedName}`);
  for (const path of [args.tarball, args.manifest]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0)
      fail(`input must be a nonempty physical file: ${path}`);
  }
  assertManifestBinding(args);

  const extractionRoot = mkdtempSync(join(tmpdir(), 'genie-delivery-evidence-'));
  try {
    chmodSync(extractionRoot, 0o700);
    extractTarball(args.tarball, extractionRoot);
    const binary = join(extractionRoot, 'genie');
    const binaryStat = lstatSync(binary);
    if (!binaryStat.isFile() || binaryStat.isSymbolicLink()) fail('tarball genie member must be a physical file');

    const descriptor = {
      schemaVersion: 1,
      repository: args.repository,
      version: args.version,
      channel: args.channel,
      platformId: args.platformId,
      platformTriple: PLATFORMS[args.platformId],
      releaseTag: `v${args.version}`,
      releaseName,
      releaseManifestSha256: sha256File(args.manifest),
      artifactSha256: sha256File(args.tarball),
      installedBinarySha256: sha256File(binary),
      canonicalPayloadSha256: physicalTreeDigest(join(extractionRoot, 'plugins', 'genie')),
      digestAlgorithm: 'genie-physical-tree-v1',
      sourceSha: args.sourceSha,
      sourceBranch: args.sourceBranch,
      sourceCiRunId: args.sourceCiRunId,
      controlSha: args.controlSha,
    } as const;
    writeFileSync(args.output, `${JSON.stringify(descriptor)}\n`, { flag: 'wx', mode: 0o600 });
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

main();
