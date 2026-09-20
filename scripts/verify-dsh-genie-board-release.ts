#!/usr/bin/env bun
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  DELIVERY_EVIDENCE_PREDICATE_TYPE,
  DELIVERY_EVIDENCE_REPOSITORY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
} from '../src/lib/delivery-evidence-verify.js';
import { extractTarball, sha256File } from './release-archive-safety.js';
import { assertReleaseVersion, verifyReleasePayloadVersion } from './release-payload-version.js';

const platforms = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'];

/**
 * The single source of truth for the DSH plugin payload members a release must
 * carry. `scripts/build-binary.sh` stages the same ten paths; its list is
 * pinned against this one by `verify-dsh-genie-board-release.test.ts`.
 *
 * Every dist member is enumerated explicitly — never a glob. The suite is one
 * manager row plus three sub-rows, so the attested tarball gained three host
 * bundles; growing this list is a reviewed change, not a build detail.
 */
export const DSH_PLUGIN_MEMBERS = [
  'package.json',
  'agent.cordis.yml',
  'cordis.patch.yml',
  'README.md',
  'NOTICE',
  'dist/index.js',
  'dist/board.js',
  'dist/skills.js',
  'dist/workflows.js',
  'dist/client.js',
] as const;

/**
 * The workflow-loader row shipped beside the board. Its `package.json` is one
 * of the stamped top-level version files, so it is gated per tarball by
 * `verifyReleasePayloadVersion`; these four members are staged by
 * `scripts/build-binary.sh` and pinned here the same way as the board's.
 */
export const LOADER_PLUGIN_MEMBERS = ['agent.cordis.yml', 'cordis.patch.yml', 'README.md', 'dist/index.js'] as const;

const repository = DELIVERY_EVIDENCE_REPOSITORY;

/**
 * Network-step budgets. A flat cap across every step is what produced the
 * empty `bash failed: ` message this file used to emit: `spawnSync` reports a
 * `null` exit code and no stderr when it kills the child, so a `gh release
 * download` of four ~35 MB assets that outran a 120 s cap looked like an
 * unexplained failure. Each step now names its own budget and says so.
 */
const NETWORK_TIMEOUT_MS = 300_000;
const DOWNLOAD_TIMEOUT_MS = 1_800_000;
const NETWORK_ATTEMPTS = 3;
const NETWORK_RETRY_SLEEP_MS = [5_000, 15_000];

/**
 * Retry classification mirrors `scripts/gh-retry.sh`: permission and
 * validation failures surface at once, only provably transient failures (and
 * our own timeout kill) are replayed, and anything unclassifiable fails
 * closed immediately so a rejected signature is never retried into a pass.
 */
const PERMANENT_FAILURE = /HTTP 40[13]|forbidden|permission|not authorized|bad credentials|HTTP 422|validation failed/i;
const TRANSIENT_FAILURE =
  /timed? ?out|connection re(set|fused)|could not resolve|TLS|unexpected EOF|HTTP 5[0-9][0-9]|HTTP 429|rate limit|service unavailable|bad gateway|gateway time-?out|internal server error/i;

interface Attempt {
  stdout: string;
  failure?: string;
  transient: boolean;
}

function attempt(argv: string[], step: string, timeoutMs: number): Attempt {
  const result = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, env: { ...process.env } });
  const stdout = result.stdout.toString();
  if (result.exitCode === 0) return { stdout, transient: false };
  const stderr = result.stderr.toString().trim();
  const seconds = Math.round(timeoutMs / 1000);
  if (result.exitCode === null) {
    return {
      stdout,
      failure: `${step}: ${argv[0]} exceeded its ${seconds}s timeout${stderr ? `: ${stderr}` : ''}`,
      transient: true,
    };
  }
  return {
    stdout,
    failure: `${step}: ${argv[0]} failed (exit ${result.exitCode}, ${seconds}s budget): ${stderr || '<no stderr>'}`,
    transient: !PERMANENT_FAILURE.test(stderr) && TRANSIENT_FAILURE.test(stderr),
  };
}

export interface NetworkStepOptions {
  timeoutMs?: number;
  attempts?: number;
  /** Backoff between attempts; the last entry repeats. */
  sleepsMs?: number[];
}

/** Network step: its own budget plus bounded retries for transient failures. */
export function runNetwork(argv: string[], step: string, options: NetworkStepOptions = {}): string {
  const timeoutMs = options.timeoutMs ?? NETWORK_TIMEOUT_MS;
  const attempts = options.attempts ?? NETWORK_ATTEMPTS;
  const sleeps = options.sleepsMs ?? NETWORK_RETRY_SLEEP_MS;
  let failure = '';
  for (let tries = 1; tries <= attempts; tries++) {
    const result = attempt(argv, step, timeoutMs);
    if (!result.failure) return result.stdout;
    failure = `${result.failure} [attempt ${tries}/${attempts}]`;
    if (!result.transient || tries === attempts) break;
    Bun.sleepSync(sleeps[Math.min(tries - 1, sleeps.length - 1)]);
  }
  throw new Error(failure);
}

/**
 * `statSync` used to throw its own `ENOENT: … statx '<path>'` before this check
 * could speak: an ABSENT member reported raw libuv text while a zero-byte one
 * got the crafted message, and neither named the archive the member came from.
 * `throwIfNoEntry: false` turns absence into the same one-line refusal, and
 * `context` names the offending tarball (the extracted copy lives in a temp
 * directory this function's caller deletes).
 */
function nonempty(path: string, context?: string): void {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || !stat.size)
    throw new Error(`missing/empty regular file: ${path}${context ? ` (${context})` : ''}`);
}

function verifyTarball(path: string, version: string): void {
  const root = mkdtempSync(join(tmpdir(), 'genie-dsh-verify-'));
  try {
    // Shared with build-delivery-evidence: reject escaping/backslash/duplicate
    // names and every non-regular member before extraction, extract without
    // inheriting archived ownership or modes, then rescan the extracted tree.
    extractTarball(path, root);
    for (const member of DSH_PLUGIN_MEMBERS)
      nonempty(
        join(root, 'plugins/dsh-genie-board', member),
        `payload member plugins/dsh-genie-board/${member} of ${path}`,
      );
    for (const member of LOADER_PLUGIN_MEMBERS)
      nonempty(
        join(root, 'plugins/dsh-workflow-loader', member),
        `payload member plugins/dsh-workflow-loader/${member} of ${path}`,
      );
    verifyReleasePayloadVersion(root, version);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function verifyDescriptor(path: string, name: string, version: string, channel: 'stable' | 'dev'): string {
  nonempty(`${path}.bundle`, `signature sidecar of ${name}`);
  nonempty(`${path}.intoto.jsonl`, `provenance sidecar of ${name}`);
  const descriptorPath = `${path}.${channel}.delivery.json`;
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'));
  const platform = platforms.find((value) => name === `genie-${version}-${value}.tar.gz`);
  if (
    descriptor.artifactSha256 !== sha256File(path) ||
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
  runNetwork(['bash', join(import.meta.dir, 'verify-release.sh'), '--local', path], `signature verification (${name})`);
  nonempty(`${descriptorPath}.sigstore.json`, `delivery-evidence attestation of ${name}`);
  const verified = JSON.parse(
    runNetwork(
      [
        'gh',
        'attestation',
        'verify',
        descriptorPath,
        '--bundle',
        `${descriptorPath}.sigstore.json`,
        '--repo',
        repository,
        '--predicate-type',
        DELIVERY_EVIDENCE_PREDICATE_TYPE,
        '--cert-identity',
        DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
        '--source-ref',
        'refs/heads/main',
        '--format',
        'json',
      ],
      `delivery-evidence attestation (${name})`,
    ),
  );
  if (
    !Array.isArray(verified) ||
    verified.length !== 1 ||
    !isDeepStrictEqual(verified[0]?.verificationResult?.statement?.predicate, descriptor)
  ) {
    throw new Error('verified delivery predicate does not equal descriptor');
  }
  return descriptor.sourceSha;
}

export function verifyArtifacts(directory: string, version: string, channel?: 'stable' | 'dev'): string | undefined {
  assertReleaseVersion(version);
  const expected = platforms.map((platform) => `genie-${version}-${platform}.tar.gz`).sort();
  const actual = readdirSync(directory)
    .filter((name) => name.endsWith('.tar.gz'))
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('expected exactly four candidate platform tarballs');
  let sourceSha: string | undefined;
  for (const [index, name] of expected.entries()) {
    const path = resolve(directory, name);
    nonempty(path, `candidate tarball ${name}`);
    if (channel) {
      const observed = verifyDescriptor(path, name, version, channel);
      if (index && sourceSha !== observed) throw new Error('candidate source mismatch');
      sourceSha = observed;
    }
    verifyTarball(path, version);
  }
  return sourceSha;
}

function parseOptions(args: string[]): Map<string, string> {
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
  return options;
}

function verifyPublishedRelease(tag: string, channel: string, source: string | undefined): void {
  const release = JSON.parse(
    runNetwork(
      ['gh', 'release', 'view', tag, '--repo', repository, '--json', 'tagName,isDraft,isPrerelease'],
      `release metadata (${tag})`,
    ),
  );
  const commit = JSON.parse(runNetwork(['gh', 'api', `repos/${repository}/commits/${tag}`], `tag commit (${tag})`));
  if (
    release.tagName !== tag ||
    release.isDraft ||
    (channel === 'stable' && release.isPrerelease) ||
    commit.sha !== source
  )
    throw new Error('published tag/source binding mismatch');
}

function main(): void {
  const options = parseOptions(process.argv.slice(2));
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
    if (mode === '--release') {
      // ~140 MB across four platform tarballs plus sidecars: its own budget.
      runNetwork(
        ['gh', 'release', 'download', input, '--repo', repository, '--dir', directory],
        `release download (${input})`,
        { timeoutMs: DOWNLOAD_TIMEOUT_MS },
      );
    }
    const source = verifyArtifacts(
      directory,
      version,
      mode === '--unsigned-artifact-dir' ? undefined : (channel as 'stable' | 'dev'),
    );
    if (mode === '--release') verifyPublishedRelease(input, channel, source);
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
