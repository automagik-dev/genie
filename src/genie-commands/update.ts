import { execFileSync, execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type AgentSyncReport,
  type AgentSyncSelection,
  LIFECYCLE_LEASE_OWNER_ENV,
  LIFECYCLE_LEASE_PATH_ENV,
  type LifecycleLease,
  acquireLifecycleLease,
  runAgentSync,
} from '../lib/agent-sync.js';
import { observeCodexActivation, openCodexActivationStore } from '../lib/codex-activation-executor.js';
import { parseReleaseVersion, scanPhysicalTree } from '../lib/codex-activation.js';
import {
  type DeliveryEvidenceChannel,
  type DeliveryEvidencePlatformId,
  type DeliveryEvidenceVerificationDependencies,
  type VerifiedDeliveryEvidence,
  verifyDownloadedDeliveryEvidence,
} from '../lib/codex-delivery-evidence.js';
import {
  type HeldLifecycleLease,
  type LifecycleLeaseResult,
  acquireLifecycleLease as acquireCodexLifecycleLease,
} from '../lib/codex-lifecycle-lease.js';
import { snapshotDeliveryReadState } from '../lib/codex-lifecycle-truth.js';
import { contractPath, genieConfigExists, getGenieConfigPath, saveGenieConfig } from '../lib/genie-config.js';
import {
  type InstallStagingDirectoryGuard,
  admitExternalInstallStaging,
  closeInstallStagingDirectory,
  promoteStagedInstall,
  recoverPendingInstallPromotions,
  removeInstallStagingDirectory,
  verifyAdmittedInstallStagingPayload,
  verifyInstallStagingDirectory,
} from '../lib/install-promotion.js';
import { inspectPhysicalPath } from '../lib/install-transaction.js';
import { retireInstallVersionMarker } from '../lib/install-version-marker.js';
import {
  type CodexAgentInstallResult,
  type IntegrationResult,
  type IntegrationSelection,
  readIntegrationConsent,
  resolveRuntimeExecutable,
} from '../lib/runtime-integrations.js';
import {
  CODEX_ACTIVATION_PROTOCOL,
  printUpdateCapabilities,
  publishBackupCapabilitySidecar,
  runBackupCapabilityProbe,
} from '../lib/update-capabilities.js';
import { VERSION } from '../lib/version.js';
import { GenieConfigSchema } from '../types/genie-config.js';
import {
  type AuxiliaryTreeOperations,
  type AuxiliaryTreeOutcome,
  convergeAuxiliaryTree,
  fingerprintAuxiliaryTree,
} from './auxiliary-trees.js';
import {
  type CandidateProof,
  type DeliveryRepairOutcome,
  type DeliveryRepairSeams,
  type InstalledProof,
  type PinnedManifest,
  type RepairPinnedTarget,
  localDeliveryMatches,
  repairMissingDelivery,
} from './codex-delivery-repair.js';
import {
  CODEX_DELIVERY_INCOMPLETE_TRAILER,
  CODEX_DELIVERY_RESULT_TRAILER,
  CODEX_LIFECYCLE_BUSY_TRAILER,
  CodexLifecycleBusyError,
  publishCodexDelivery,
} from './codex-delivery.js';
import { performProtocolSafeRollback } from './codex-rollback.js';
import { cleanupV4 } from './legacy-v4.js';
import { assertLocalDeliveryRepairEnabled, materializeLocalDeliveryRepair } from './local-delivery-repair.js';
import { type RefreshUpdatePluginsOptions, refreshUpdatePlugins } from './update-integrations.js';
const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const GENIE_BIN = join(GENIE_HOME, 'bin');
const GENIE_BIN_STAGING = join(GENIE_BIN, '.staging');
const GENIE_BIN_PREVIOUS = join(GENIE_BIN, '.previous');
const PENDING_DELIVERY_NAME = '.pending-delivery.json';
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Diagnostics schema version. Bump on every additive change so consumers
 * branch on `schemaVersion` rather than file presence.
 *
 * - v1 (pre-update-unify-stages): `update`, `runtime`, `paths`, `processSnapshot`,
 *   `maintenance`, `recentLogSignals`.
 * - v2 (update-unify-stages): adds `verify: VerifyResult`.
 * - v3 (genie-distribution-cutover G5): hard-cutover to GitHub Releases. Replaces
 *   the npm/bun-add code path with `gh release download` + atomic binary swap.
 *   Adds `delivery: { channel, manifest, tarball, attestation }`.
 */
const UPDATE_DIAGNOSTIC_SCHEMA_VERSION = 3;

const FETCH_LATEST_TIMEOUT_MS = 5_000;

/** GitHub repo coordinates for the GH-Releases distribution cutover. */
const RELEASES_OWNER = 'automagik-dev';
const RELEASES_REPO = 'genie';
const RAW_BASE_URL = 'https://raw.githubusercontent.com';
const RELEASES_SLUG = `${RELEASES_OWNER}/${RELEASES_REPO}`;
const EXPECTED_COSIGN_IDENTITY = `^https://github\\.com/${RELEASES_SLUG}/\\.github/workflows/sign-attest\\.yml@refs/heads/main$`;
const EXPECTED_COSIGN_ISSUER = 'https://token.actions.githubusercontent.com';
// sign-attest.yml registers the GitHub-native attestation under a CUSTOM
// predicate type (NOT https://slsa.dev/provenance/v1 — GitHub's persistence API
// runs SLSA validation for that URI and rejects our custom buildType). The
// verifier MUST pass the same --predicate-type or `gh attestation verify`
// defaults to slsa.dev/provenance/v1, so the by-digest lookup 404s even though
// the attestation exists. Keep in lockstep with scripts/release-native-predicate.sh.
const EXPECTED_ATTESTATION_PREDICATE_TYPE = `https://github.com/${RELEASES_SLUG}/release-tarballs/v1`;

// ============================================================================
// Verify decision shape. v5 is zero-daemon — the atomic binary swap IS the
// update, so "verified" means the freshly-installed binary executes and
// reports the version we intended to install. `decideVerify` is a pure
// function so the tagged-union outcome can be unit-tested without spawning
// a real binary.
// ============================================================================

export type VerifySkipReason = 'no-restart' | 'no-verify-flag';

export type VerifyResult =
  /** The installed binary ran and reported `version` (already normalized).
   *  When a target version was known it equals that. `path` is the probed
   *  binary, surfaced in the banner. */
  | { kind: 'ok'; version: string | null; path: string | null }
  /** The binary could not be executed, emitted no parsable version, or
   *  reported a version other than the one we just installed. `reason` is
   *  operator-facing. */
  | { kind: 'verify-failed'; reason: string; path: string | null }
  | { kind: 'skipped'; reason: VerifySkipReason };

export interface DecideVerifyArgs {
  /** Version string the installed binary reported, or null when it did not
   *  run / emitted nothing parsable. Raw — decideVerify normalizes it. */
  reportedVersion: string | null;
  /** Version the update intended to install (manifest.version), or null when
   *  unknown. When null, any parsable reportedVersion is accepted as `ok`. */
  targetVersion: string | null;
  /** Path to the binary that was probed (for operator-facing messages). */
  binaryPath: string | null;
  skipReason?: VerifySkipReason | null;
}

/**
 * Strip build metadata (anything after `+`) so a `4.260504.21+abc1234` CLI build
 * compares equal to the `4.260504.21` registry-published string.
 */
export function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  const plusIdx = trimmed.indexOf('+');
  return plusIdx === -1 ? trimmed : trimmed.slice(0, plusIdx);
}

export function decideVerify(args: DecideVerifyArgs): VerifyResult {
  if (args.skipReason) {
    return { kind: 'skipped', reason: args.skipReason };
  }
  const label = args.binaryPath ?? 'installed binary';
  if (args.reportedVersion === null) {
    return { kind: 'verify-failed', reason: `${label} did not report a version`, path: args.binaryPath };
  }
  const reported = normalizeVersion(args.reportedVersion);
  if (args.targetVersion !== null && normalizeVersion(args.targetVersion) !== reported) {
    return {
      kind: 'verify-failed',
      reason: `expected v${normalizeVersion(args.targetVersion)}, but ${label} reports v${reported}`,
      path: args.binaryPath,
    };
  }
  return { kind: 'ok', version: reported, path: args.binaryPath };
}

/**
 * Compare a current install to a published version. Returns `true` only when
 * both strings normalize equal AND `latestVersion` is non-null. Null/empty
 * `latestVersion` returns `false` so the caller proceeds — never block on a
 * transient registry hiccup.
 */
export function shortCircuitIfCurrent(currentVersion: string, latestVersion: string | null | undefined): boolean {
  if (!latestVersion) return false;
  const current = parseGenieVersion(currentVersion);
  const latest = parseGenieVersion(latestVersion);
  return current !== null && latest !== null && compareParsedVersions(current, latest) === 0;
}

/**
 * Compare two Genie versions (`MAJOR.YYMMDD.N[-prerelease][+build]`). Core and
 * numeric prerelease identifiers compare numerically; non-numeric identifiers
 * compare lexically; numeric prerelease identifiers rank below non-numeric
 * identifiers; and a final release ranks above every prerelease of the same
 * core. Malformed values are rejected instead of being coerced to zero.
 */
export function compareVersions(a: string, b: string): number {
  const parsedA = parseGenieVersion(a);
  const parsedB = parseGenieVersion(b);
  if (parsedA === null) throw new Error(`Invalid Genie version: ${JSON.stringify(a)}`);
  if (parsedB === null) throw new Error(`Invalid Genie version: ${JSON.stringify(b)}`);
  return compareParsedVersions(parsedA, parsedB);
}

interface ParsedGenieVersion {
  core: [bigint, bigint, bigint];
  prerelease: string[] | null;
}

const GENIE_VERSION_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseGenieVersion(value: string): ParsedGenieVersion | null {
  const match = value.trim().match(GENIE_VERSION_RE);
  if (!match) return null;
  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease: match[4] ? match[4].split('.') : null,
  };
}

function compareParsedVersions(a: ParsedGenieVersion, b: ParsedGenieVersion): number {
  const coreComparison = compareNumericIdentifiers(a.core, b.core);
  if (coreComparison !== 0) return coreComparison;
  return comparePrereleases(a.prerelease, b.prerelease);
}

function compareNumericIdentifiers(a: readonly bigint[], b: readonly bigint[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] < b[index]) return -1;
    if (a[index] > b[index]) return 1;
  }
  return 0;
}

function comparePrereleases(a: string[] | null, b: string[] | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    return comparePrereleaseIdentifier(left, right);
  }
  return 0;
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const leftValue = BigInt(left);
    const rightValue = BigInt(right);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : 1;
}

/**
 * Direction of a resolved update relative to the installed binary.
 * - `upgrade`         — installed is older (or the manifest version is unknown); proceed.
 * - `current`         — installed equals the manifest version; short-circuit.
 * - `block-downgrade` — installed is NEWER and no explicit channel flag authorized it; refuse.
 * - `allow-downgrade` — installed is NEWER but an explicit `--stable/--dev/--homolog`
 *   signalled operator intent; proceed with a loud notice.
 */
export type DowngradeDecision =
  | { kind: 'upgrade' }
  | { kind: 'current' }
  | { kind: 'block-downgrade'; installed: string; latest: string }
  | { kind: 'allow-downgrade'; installed: string; latest: string }
  | { kind: 'invalid-version'; field: 'installed' | 'latest'; value: string };

/**
 * Decide whether `genie update` should proceed, short-circuit, refuse, or force a
 * version move. Pure so the operator-facing branch is unit-tested without any network
 * or binary swap. A null/empty `latestVersion` yields `upgrade` so the caller's
 * existing "manifest unavailable" abort runs unchanged.
 */
export function decideDowngrade(args: {
  installedVersion: string;
  latestVersion: string | null | undefined;
  explicitChannel: boolean;
}): DowngradeDecision {
  if (!args.latestVersion) return { kind: 'upgrade' };
  if (parseGenieVersion(args.latestVersion) === null) {
    return { kind: 'invalid-version', field: 'latest', value: args.latestVersion };
  }
  if (parseGenieVersion(args.installedVersion) === null) {
    return { kind: 'invalid-version', field: 'installed', value: args.installedVersion };
  }
  const cmp = compareVersions(args.installedVersion, args.latestVersion);
  if (cmp === 0) return { kind: 'current' };
  if (cmp < 0) return { kind: 'upgrade' };
  return args.explicitChannel
    ? { kind: 'allow-downgrade', installed: args.installedVersion, latest: args.latestVersion }
    : { kind: 'block-downgrade', installed: args.installedVersion, latest: args.latestVersion };
}

// ============================================================================
// GitHub Releases distribution layer (genie-distribution-cutover G5).
//
// Replaces the npm/bun-add code path entirely. Single canonical primitives:
//   1. fetch .well-known/<channel>.json from raw.githubusercontent.com
//   2. resolve target version + tarball base URL
//   3. gh release download to a staging directory
//   4. gh attestation verify the tarball
//   5. extract and atomically swap the binary at ~/.genie/bin/genie
//
// Old binary moves to ~/.genie/bin/.previous/genie-<old-version> for rollback.
// ============================================================================

/** Channel identifier resolved from CLI flags / config. Matches the
 *  workflow's `--channel` choices.
 *
 *  Canonical taxonomy (Felipe directive 2026-05-12, cross-repo unified):
 *  `stable` / `homolog` / `dev`. beta + canary retired.
 *
 *  Naming history:
 *  - prior to wish `release-channel-dev` (2026-05-11) the dev/pre-release
 *    channel was named `next` (npm dist-tag heritage). After the npm
 *    cutover (wish G6, 2026-05-09) the npm dist-tag was meaningless, so
 *    the channel was renamed to `dev` to match the source branch name
 *    and operator mental model. `--next` is kept as a deprecated CLI
 *    alias for one release cycle and config-read backward-compat.
 *  - 2026-05-12: `beta` + `canary` retired (never had producer paths).
 *    `homolog` added for the dev→homolog→stable promotion ladder; matches
 *    the homolog branch posture omni uses today. genie may not have an
 *    active homolog branch yet, but the type surface is present for
 *    cross-repo taxonomy parity. */
export type ReleaseChannel = 'stable' | 'homolog' | 'dev';

export interface LatestManifest {
  schema_version: number;
  channel: ReleaseChannel;
  version: string;
  released_at: string;
  tarball_base: string;
  platforms: string[];
  /** Exact fetched UTF-8 bytes retained for signed delivery-evidence verification. */
  manifestBytes: string;
  /** SHA-256 of the exact fetched UTF-8 bytes, before JSON parsing/reconstruction. */
  manifestSha256: string;
}

/**
 * Build the URL for a channel's manifest file.
 * `stable` → `latest.json`, others → `<channel>.json`.
 * Lives at `.well-known/` on the repo's `main` branch — see release-publish.yml.
 */
export function manifestUrlForChannel(channel: ReleaseChannel): string {
  const fileName = channel === 'stable' ? 'latest.json' : `${channel}.json`;
  return `${RAW_BASE_URL}/${RELEASES_OWNER}/${RELEASES_REPO}/main/.well-known/${fileName}`;
}

/**
 * Resolve the host platform identifier matching the tarball naming contract
 * from `scripts/build-binary.sh` (G1).
 *
 * Outputs: `linux-x64-glibc | linux-x64-musl | linux-arm64 | darwin-arm64`.
 * darwin-x64 is intentionally unsupported (build matrix dropped Intel Macs in G1).
 */
export function resolvePlatformId(): string {
  const os = process.platform;
  const cpu = process.arch;
  if (os === 'darwin' && cpu === 'arm64') return 'darwin-arm64';
  if (os === 'linux' && cpu === 'arm64') return 'linux-arm64';
  if (os === 'linux' && cpu === 'x64') {
    // Detect musl vs glibc on Linux x64. Alpine ships /etc/alpine-release.
    // ldd --version on glibc systems prints "GNU libc"; on musl it prints "musl".
    if (existsSync('/etc/alpine-release')) return 'linux-x64-musl';
    try {
      const out = execSync('ldd --version 2>&1 || true', { encoding: 'utf-8', timeout: 1000 });
      if (/musl/i.test(out)) return 'linux-x64-musl';
    } catch {
      // ldd absent or errored — assume glibc (the dominant Linux x64 case).
    }
    return 'linux-x64-glibc';
  }
  throw new Error(
    `Unsupported platform: ${os}-${cpu}. Genie ships binaries for linux-x64-glibc, linux-x64-musl, linux-arm64, darwin-arm64.`,
  );
}

/**
 * Resolve the running `genie` binary's filesystem path via `which genie` and
 * `realpathSync` (follows symlinks). Returns `null` when `which` fails or the
 * symlink target can't be resolved.
 */
export function resolveLiveBinaryPath(): string | null {
  try {
    const out = execSync('which genie', { encoding: 'utf-8', timeout: 1500 }).trim();
    if (!out) return null;
    try {
      return realpathSync(out);
    } catch {
      return out;
    }
  } catch {
    return null;
  }
}

/**
 * The version of the genie binary the user actually runs. Resolved by
 * executing the live `which genie` binary, then the on-disk VERSION file,
 * then the in-process compile-time constant as a last resort.
 *
 * The update decision MUST key off this, not the compile-time `VERSION`
 * of whatever binary happens to be executing `genie update`. If a stale
 * binary shadows ~/.genie/bin/genie on $PATH, its baked-in `VERSION`
 * never changes, so a `VERSION`-based check re-offers the same update on
 * every run forever (the "update doesn't stick" bug).
 */
export function resolveInstalledVersion(): string {
  const live = resolveLiveBinaryPath();
  if (live) {
    try {
      const out = execFileSync(live, ['--version'], {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      const m = out.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/);
      if (m) return m[0];
    } catch {
      // fall through to on-disk / compile-time
    }
  }
  return readInstalledPackageVersion() ?? VERSION;
}

/**
 * Verify that the live `genie` binary lives at the canonical G5 location
 * (`~/.genie/bin/genie`). Returns the canonical target path when the live
 * install is canonical; throws with a migration message otherwise.
 *
 * Pre-G5 installs (bun-global, npm-global, source clone) place the binary
 * elsewhere and rely on `$PATH` symlinks. Updating `~/.genie/bin/genie`
 * for those users would silently leave the active binary on `$PATH`
 * unchanged. We fail loudly with re-install instructions instead of
 * pretending success.
 */
export function ensureCanonicalInstall(): string {
  const target = join(GENIE_BIN, 'genie');
  const live = resolveLiveBinaryPath();
  if (live === null) {
    // No live binary on $PATH — first install or pre-install scenario. The
    // canonical path is the right answer; downstream install.sh sets up the
    // PATH symlink.
    return target;
  }
  let liveCanonical: string;
  try {
    liveCanonical = realpathSync(live);
  } catch {
    liveCanonical = live;
  }
  let targetCanonical: string;
  try {
    targetCanonical = existsSync(target) ? realpathSync(target) : target;
  } catch {
    targetCanonical = target;
  }
  if (liveCanonical === targetCanonical) {
    return target;
  }
  // Live binary is outside ~/.genie/bin. Refuse to swap silently.
  throw new Error(
    [
      `Live genie binary is at ${live}, not ${target}.`,
      '  This install pre-dates the GH-Releases cutover (wish G5). `genie update`',
      '  only manages binaries under ~/.genie/bin/. To migrate, re-run:',
      '    curl -fsSL https://raw.githubusercontent.com/automagik-dev/genie/main/install.sh | bash',
      '  …which downloads the latest signed tarball, installs the canonical layout,',
      '  and points your $PATH at ~/.genie/bin/genie.',
    ].join('\n'),
  );
}

interface FetchManifestOptions {
  /** Test seam: replaces the network round-trip with a synchronous stub. */
  fetcher?: (url: string) => Promise<string | null>;
  timeoutMs?: number;
}

/**
 * Fetch + parse `.well-known/<channel>.json`. Returns `null` on any failure
 * (network, parse error, schema mismatch). Caller decides whether to proceed
 * defensively or surface the error.
 */
export async function fetchLatestManifest(
  channel: ReleaseChannel,
  opts: FetchManifestOptions = {},
): Promise<LatestManifest | null> {
  const url = manifestUrlForChannel(channel);
  const fetcher = opts.fetcher ?? defaultManifestFetcher;
  const timeoutMs = opts.timeoutMs ?? FETCH_LATEST_TIMEOUT_MS;
  let raw: string | null = null;
  try {
    raw = await Promise.race([
      fetcher(url),
      new Promise<string | null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LatestManifest>;
    if (
      typeof parsed.schema_version !== 'number' ||
      typeof parsed.channel !== 'string' ||
      parsed.channel !== channel ||
      typeof parsed.version !== 'string' ||
      parseGenieVersion(parsed.version) === null ||
      typeof parsed.released_at !== 'string' ||
      typeof parsed.tarball_base !== 'string' ||
      !Array.isArray(parsed.platforms) ||
      !parsed.platforms.every((platform) => typeof platform === 'string')
    ) {
      return null;
    }
    return {
      schema_version: parsed.schema_version,
      channel: parsed.channel,
      version: parsed.version,
      released_at: parsed.released_at,
      tarball_base: parsed.tarball_base,
      platforms: parsed.platforms,
      manifestBytes: raw,
      manifestSha256: createHash('sha256').update(raw).digest('hex'),
    };
  } catch {
    return null;
  }
}

async function defaultManifestFetcher(url: string): Promise<string | null> {
  // Use curl rather than fetch for parity with install.sh and to keep the
  // network surface obvious in offline-debugging traces (single -fsSL call).
  const result = await runCommandSilent('curl', ['-fsSL', '--max-time', '5', url], undefined, FETCH_LATEST_TIMEOUT_MS);
  if (!result.success) return null;
  return result.output;
}

interface DownloadAndVerifyOptions {
  /** Test seam: stubs the network/cli surface for deterministic unit tests. */
  runner?: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ success: boolean; output: string }>;
  /** Test seam: skip release signature verification (used by integration
   *  smokes where the real gh/cosign CLIs are not available). */
  skipAttestation?: boolean;
}

export interface DownloadedDeliveryAssets {
  tarballPath: string;
  descriptorBytes: Buffer;
  bundleBytes: Buffer;
}

/**
 * `gh attestation verify` performs TWO network round-trips on every call:
 *   1. GitHub Attestations API lookup by tarball digest (~1-2s)
 *   2. Sigstore Rekor inclusion-proof verification (~2-5s)
 * Combined with cosign bundle parsing the local 4-second default in
 * `runCommandSilent` is too tight — under normal network conditions the
 * call returns in 3-8s; under load 10-20s is realistic. 60s gives generous
 * headroom while still catching genuine network failures rather than
 * hanging forever. Empirical: PR #2421 release v4.260512.2 verify timed
 * out at 4000ms on a healthy connection (Felipe, 2026-05-12).
 */
const ATTESTATION_VERIFY_TIMEOUT_MS = 60_000;
/**
 * The tarball download moves ~37MB+ per platform and outgrew runCommandSilent's
 * 4s default the same way the verify steps did: genie update v5.260714.8 timed
 * out at 4000ms on a healthy connection (Felipe, 2026-07-14). 5 minutes bounds
 * a genuinely slow link without hanging forever.
 */
const RELEASE_DOWNLOAD_TIMEOUT_MS = 300_000;

async function verifyTarballSignature(
  tarballName: string,
  tarballPath: string,
  runner: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ success: boolean; output: string }>,
): Promise<void> {
  const ghVerifyResult = await runner(
    'gh',
    [
      'attestation',
      'verify',
      tarballPath,
      '--repo',
      RELEASES_SLUG,
      '--predicate-type',
      EXPECTED_ATTESTATION_PREDICATE_TYPE,
      '--cert-identity-regex',
      EXPECTED_COSIGN_IDENTITY,
      '--cert-oidc-issuer',
      EXPECTED_COSIGN_ISSUER,
    ],
    ATTESTATION_VERIFY_TIMEOUT_MS,
  );
  if (ghVerifyResult.success) return;
  throw new Error(
    `signature verification failed for ${tarballName}: gh attestation verify: ${ghVerifyResult.output.trim() || `failed after ${ATTESTATION_VERIFY_TIMEOUT_MS}ms`}. The reduced cosign verify-blob proof does not validate Genie's required custom predicate/subject; install GitHub CLI with attestation support and retry.`,
  );
}

/**
 * Download the platform-specific tarball + cosign bundle + attestation, then
 * verify with GitHub native attestations or the local cosign bundle fallback.
 * Returns the path to the downloaded tarball on success; throws on failure
 * (caller surfaces the error).
 */
export async function downloadAndVerifyTarball(
  manifest: LatestManifest,
  platform: string,
  destDir: string,
  opts: DownloadAndVerifyOptions = {},
): Promise<string> {
  // Adapt runCommandSilent's (cmd, args, cwd?, timeoutMs?) positional shape
  // to the (cmd, args, timeoutMs?) runner contract — we never need cwd here
  // and the verify step needs a generous timeout (see
  // ATTESTATION_VERIFY_TIMEOUT_MS).
  const runner =
    opts.runner ??
    ((cmd: string, args: string[], timeoutMs?: number) => runCommandSilent(cmd, args, undefined, timeoutMs));
  mkdirSync(destDir, { recursive: true });
  const versionTag = `v${manifest.version}`;
  const tarballName = `genie-${manifest.version}-${platform}.tar.gz`;
  const tarballPath = join(destDir, tarballName);

  // gh release download retries by name; --pattern lets us pull the tarball
  // and its sidecar (.bundle, .intoto.jsonl) in one shot via wildcards.
  const downloadResult = await runner(
    'gh',
    [
      'release',
      'download',
      versionTag,
      '--repo',
      `${RELEASES_OWNER}/${RELEASES_REPO}`,
      '--dir',
      destDir,
      '--pattern',
      tarballName,
      '--pattern',
      `${tarballName}.bundle`,
      '--pattern',
      `${tarballName}.intoto.jsonl`,
      '--pattern',
      `${tarballName}.${manifest.channel}.delivery.json`,
      '--pattern',
      `${tarballName}.${manifest.channel}.delivery.json.sigstore.json`,
      '--clobber',
    ],
    RELEASE_DOWNLOAD_TIMEOUT_MS,
  );
  if (!downloadResult.success) {
    throw new Error(
      `gh release download ${versionTag} failed for ${platform}: ${downloadResult.output.trim() || 'no output'}`,
    );
  }
  if (!existsSync(tarballPath)) {
    throw new Error(`gh release download succeeded but ${tarballPath} is missing`);
  }

  if (!opts.skipAttestation) {
    await verifyTarballSignature(tarballName, tarballPath, runner);
  }

  return tarballPath;
}

/**
 * Download the release tarball and the channel-specific signed evidence pack.
 * The legacy tarball attestation remains a pre-execution defense; the descriptor
 * bundle is the durable authority setup/doctor can later reverify offline.
 */
export async function downloadAndVerifyDeliveryAssets(
  manifest: LatestManifest,
  platform: string,
  destDir: string,
  opts: DownloadAndVerifyOptions = {},
): Promise<DownloadedDeliveryAssets> {
  const tarballPath = await downloadAndVerifyTarball(manifest, platform, destDir, opts);
  const descriptorPath = `${tarballPath}.${manifest.channel}.delivery.json`;
  const bundlePath = `${descriptorPath}.sigstore.json`;
  let descriptorBytes: Buffer;
  let bundleBytes: Buffer;
  try {
    descriptorBytes = readFileSync(descriptorPath);
    bundleBytes = readFileSync(bundlePath);
  } catch (cause) {
    throw new Error(`signed delivery evidence is incomplete for ${tarballPath.split('/').pop()}: ${errMsg(cause)}`);
  }
  if (descriptorBytes.length === 0 || bundleBytes.length === 0) {
    throw new Error(`signed delivery evidence is empty for ${tarballPath.split('/').pop()}`);
  }
  return { tarballPath, descriptorBytes, bundleBytes };
}

/**
 * Extract a tarball into a destination directory. Uses the system `tar` since
 * macOS bsdtar and GNU tar both accept `-xzf`. Throws on failure.
 */
export async function extractTarball(tarballPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
  const result = await runCommandSilent('tar', ['-xzf', tarballPath, '-C', destDir], undefined, 30_000);
  if (!result.success) {
    throw new Error(`tar -xzf ${tarballPath} failed: ${result.output.trim() || 'no output'}`);
  }
}

function sameBigStat(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function assertPrivatePhysicalFileStat(stat: BigIntStats, path: string): void {
  const currentUid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777n) !== 0o600n || stat.nlink !== 1n) {
    throw new Error(`private transaction file has an unsafe shape: ${path}`);
  }
  if (stat.uid !== currentUid) throw new Error(`private transaction file has another owner: ${path}`);
}

function readPrivatePhysicalFile(path: string): Buffer {
  const beforePath = lstatSync(path, { bigint: true });
  assertPrivatePhysicalFileStat(beforePath, path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assertPrivatePhysicalFileStat(before, path);
    if (!sameBigStat(beforePath, before)) throw new Error(`private transaction file changed before read: ${path}`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameBigStat(before, after) || !sameBigStat(after, afterPath)) {
      throw new Error(`private transaction file changed during read: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function assertOwnedPhysicalDirectory(path: string, label: string): void {
  const identity = inspectPhysicalPath(path);
  if (identity?.kind !== 'directory') throw new Error(`${label} is not a physical directory: ${path}`);
  const currentUid = typeof process.getuid === 'function' ? String(process.getuid()) : identity.uid;
  if (identity.uid !== currentUid) throw new Error(`${label} has another owner: ${path}`);
}

/**
 * Decide whether the post-update "PATH `genie` is NOT the binary that was
 * just updated" advisory should be emitted.
 *
 * Pure decision function — separated from I/O so the heuristic is testable
 * without spawning a real `genie` binary.
 *
 * Suppression rules (return `false` = do NOT warn):
 *   1. No live binary on `$PATH` — nothing to compare against.
 *   2. No live version probe result — unknowable, stay silent.
 *   3. Versions match — PATH is fine.
 *   4. **`live` and `canonical` resolve to the same canonical path** —
 *      a version mismatch in that case means the swap silently failed
 *      (caught by the promotion transaction's version verification). The advisory's
 *      `ln -sf <canonical> <live>` suggestion would devolve into
 *      `ln -sf X X` — a useless self-symlink — and mislead the operator
 *      into thinking PATH is the problem when the real defect is upstream.
 *
 * Only when paths genuinely differ AND versions disagree do we emit.
 */
export interface PathDivergenceInput {
  /** Realpath-resolved live binary (output of `resolveLiveBinaryPath`). */
  live: string | null;
  /** Canonical target path the swap wrote to (`~/.genie/bin/genie`). */
  canonical: string;
  /** Realpath-resolved canonical (handles symlinks at the canonical leg). */
  canonicalReal: string;
  /** Live binary's reported `--version`, or null when probe failed. */
  liveVersion: string | null;
  /** Version the update intended to install. */
  intendedVersion: string;
}

export function shouldEmitPathDivergenceWarning(input: PathDivergenceInput): boolean {
  if (input.live === null) return false;
  if (!input.liveVersion) return false;
  if (normalizeVersion(input.liveVersion) === normalizeVersion(input.intendedVersion)) {
    return false;
  }
  // Same physical file → version mismatch is a swap-correctness bug, not a
  // PATH bug. Suppress the misleading self-symlink advisory.
  if (input.live === input.canonical) return false;
  if (input.live === input.canonicalReal) return false;
  return true;
}

/** Read-only compatibility surface. Legacy backups contain only `genie`, not
 * the exact sibling VERSION generation, so they cannot authorize mutation. */
export function rollbackBinaryAt(
  genieBin: string,
  _currentVersion = normalizeVersion(VERSION),
): { restored: string; from: string } {
  assertOwnedPhysicalDirectory(genieBin, 'rollback binary root');
  const previousDir = join(genieBin, '.previous');
  if (existsSync(previousDir)) assertOwnedPhysicalDirectory(previousDir, 'rollback backup root');
  throw new Error(
    'Automatic rollback is disabled: legacy .previous entries do not authenticate an exact genie+VERSION generation. Reinstall the desired signed version explicitly.',
  );
}

// ============================================================================
// Verify probe — zero-daemon post-update check. v5 has no daemon to poll; the
// atomic binary swap IS the update, so "verified" means the freshly-installed
// binary executes and reports the version we intended to install. Pure I/O
// wrapper around `decideVerify` — no polling, no /proc reads, no pm2.
// ============================================================================

interface VerifyProbeOptions {
  skipReason?: VerifySkipReason | null;
  /** Version the update intended to install (manifest.version). Compared
   *  against the binary's reported `--version`. Null skips the equality
   *  check — any parsable version counts as verified. */
  targetVersion?: string | null;
  /** Path to the installed binary. Defaults to ~/.genie/bin/genie. */
  binaryPath?: string;
  /** Test seam: replaces the `execFileSync(binary, ['--version'])` probe. */
  readVersion?: (binaryPath: string) => string | null;
}

/**
 * Resolve the on-disk genie binary version by reading the VERSION file
 * shipped in the tarball next to the binary, falling back to the calling
 * CLI's compile-time `VERSION` when no install metadata resolves.
 */
function readInstalledPackageVersion(): string | null {
  const candidates: string[] = [
    join(GENIE_HOME, 'VERSION'),
    join(homedir(), '.bun', 'install', 'global', 'node_modules', '@automagik', 'genie', 'package.json'),
  ];
  const npmPrefix = safeExec('npm prefix -g', 1500);
  if (npmPrefix) {
    candidates.push(join(npmPrefix, 'lib', 'node_modules', '@automagik', 'genie', 'package.json'));
  }
  for (const path of candidates) {
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (raw.startsWith('{')) {
        const pkg = JSON.parse(raw) as { version?: unknown };
        if (typeof pkg.version === 'string' && /^\d+\.\d+/.test(pkg.version)) return pkg.version;
      } else if (/^\d+\.\d+/.test(raw)) {
        return raw;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

/**
 * Execute the freshly-installed binary's `--version` and return the parsed
 * version, or null when the binary can't run or emits nothing parsable.
 */
function readBinaryVersion(binaryPath: string): string | null {
  try {
    const out = execFileSync(binaryPath, ['--version'], { encoding: 'utf-8', timeout: 3000 }).toString();
    return out.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export function runVerifyProbe(opts: VerifyProbeOptions = {}): VerifyResult {
  const binaryPath = opts.binaryPath ?? join(GENIE_BIN, 'genie');
  if (opts.skipReason) {
    return decideVerify({
      reportedVersion: null,
      targetVersion: opts.targetVersion ?? null,
      binaryPath,
      skipReason: opts.skipReason,
    });
  }
  const reader = opts.readVersion ?? readBinaryVersion;
  return decideVerify({
    reportedVersion: reader(binaryPath),
    targetVersion: opts.targetVersion ?? null,
    binaryPath,
  });
}

/** Format the post-update verify banner. Operator's primary signal that the
 *  update succeeded. Single primary line on the happy path; a follow-up line
 *  with the binary path on failure. */
export function formatVerifyBanner(result: VerifyResult): string[] {
  const lines: string[] = [];
  switch (result.kind) {
    case 'ok': {
      const versionLabel = result.version ? `v${result.version}` : 'version unknown';
      lines.push(`${colorize('\x1b[32m', '\x1b[0m', '✔')} Genie ${versionLabel} verified`);
      break;
    }
    case 'verify-failed': {
      lines.push(`${colorize('\x1b[31m', '\x1b[0m', '✖')} Genie update verification failed: ${result.reason}`);
      if (result.path) {
        lines.push(`${colorize('\x1b[2m', '\x1b[0m', `  binary: ${result.path}`)}`);
      }
      break;
    }
    case 'skipped':
      lines.push(
        `${colorize('\x1b[2m', '\x1b[0m', `· Genie verify skipped: ${result.reason} (CLI in-process v${VERSION})`)}`,
      );
      break;
  }
  return lines;
}

// ============================================================================
// Output primitives — direct ANSI; NO_COLOR honored.
// ============================================================================

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function colorize(open: string, close: string, text: string): string {
  return colorEnabled() ? `${open}${text}${close}` : text;
}

function log(message: string): void {
  console.log(`${colorize('\x1b[32m', '\x1b[0m', '▸')} ${message}`);
}

function success(message: string): void {
  console.log(`${colorize('\x1b[32m', '\x1b[0m', '✔')} ${message}`);
}

function error(message: string): void {
  console.log(`${colorize('\x1b[31m', '\x1b[0m', '✖')} ${message}`);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase());
}

// ============================================================================
// Diagnostics — schema v3 (G5: adds `delivery` block).
// ============================================================================

interface UpdateDiagnosticsContext {
  channel: ReleaseChannel;
  manifest: LatestManifest | null;
  platform: string;
  /** Latest registry version observed pre-flight, or null when fetch failed. */
  latestVersion: string | null;
  /** Local CLI version at the time the diagnostics file was written. */
  cliVersion: string;
  /** Path to the downloaded tarball, or null when delivery short-circuited. */
  tarballPath: string | null;
  /** Whether `gh attestation verify` succeeded (or was skipped). */
  attestationVerified: boolean;
  /** Backup path for the previous binary, set after atomic swap. */
  previousBackup: string | null;
}

interface RecentLogSignal {
  level: string;
  event: string;
  count: number;
  lastTimestamp?: string;
  lastError?: string;
}

function safeExec(command: string, timeoutMs = 1500): string {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string' && stdout.trim()) return stdout.trim();
    return '';
  }
}

function safeRead(path: string, maxChars = 4000): string | null {
  try {
    const value = readFileSync(path, 'utf-8');
    if (value.length <= maxChars) return value;
    return value.slice(value.length - maxChars);
  } catch {
    return null;
  }
}

function tailLines(path: string, maxBytes = 64_000, maxLines = 200): string[] {
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    const bytesToRead = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fd = openSync(path, 'r');
    readSync(fd, buffer, 0, bytesToRead, Math.max(0, stat.size - bytesToRead));
    const tail = buffer.toString('utf-8');
    return tail
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/** Signals older than this are noise from a previous era, not "recent". */
const SCHEDULER_SIGNAL_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export interface JsonlSignalSummary {
  signals: RecentLogSignal[];
  /** Newest timestamp among age-excluded entries — null when nothing was excluded. */
  newestStaleTimestamp: string | null;
}

/**
 * Age-filtered (48h default): scheduler.log is a dead v4 artifact on upgraded
 * machines, and without the filter a June disk-full incident resurfaced as
 * "Recent scheduler signals" weeks later on a healthy machine. Entries with an
 * unparseable/missing timestamp are kept — staleness must be proven, not
 * assumed. Exported (with injectable clock) for boundary tests.
 */
interface ParsedSignalLine {
  level: string;
  event: string;
  ts: string | null;
  tsMs: number;
  error?: string;
}

/** Parse one JSONL line into a warn/error signal — null for non-JSON or info-level lines. */
function parseSignalLine(line: string): ParsedSignalLine | null {
  try {
    const event = JSON.parse(line) as { level?: unknown; event?: unknown; timestamp?: unknown; error?: unknown };
    const level = typeof event.level === 'string' ? event.level : 'unknown';
    if (level !== 'error' && level !== 'warn') return null;
    const ts = typeof event.timestamp === 'string' ? event.timestamp : null;
    return {
      level,
      event: typeof event.event === 'string' ? event.event : 'unknown',
      ts,
      tsMs: ts ? Date.parse(ts) : Number.NaN,
      error: typeof event.error === 'string' ? event.error : undefined,
    };
  } catch {
    return null; // non-JSON lines kept in the raw tail, not summarized.
  }
}

export function summarizeJsonlSignals(path: string, nowMs: number = Date.now()): JsonlSignalSummary {
  const signals = new Map<string, RecentLogSignal>();
  let newestStaleTimestamp: string | null = null;
  for (const line of tailLines(path)) {
    const parsed = parseSignalLine(line);
    if (!parsed) continue;
    if (parsed.ts && !Number.isNaN(parsed.tsMs) && nowMs - parsed.tsMs > SCHEDULER_SIGNAL_MAX_AGE_MS) {
      if (newestStaleTimestamp === null || Date.parse(newestStaleTimestamp) < parsed.tsMs) {
        newestStaleTimestamp = parsed.ts;
      }
      continue;
    }
    const key = `${parsed.level}:${parsed.event}`;
    const existing = signals.get(key) ?? { level: parsed.level, event: parsed.event, count: 0 };
    existing.count++;
    if (parsed.ts) existing.lastTimestamp = parsed.ts;
    if (parsed.error) existing.lastError = parsed.error;
    signals.set(key, existing);
  }
  return { signals: [...signals.values()].sort((a, b) => b.count - a.count).slice(0, 10), newestStaleTimestamp };
}

export function isGenieProcessSnapshotLine(line: string): boolean {
  if (/pgserve|autopg|postgres-server\.js|postgres -D /.test(line)) return false;
  return (
    line.includes(' serve start ') ||
    line.includes('/dist/genie.js') ||
    line.includes('/src/genie.ts') ||
    line.includes('tmux -L genie-tui')
  );
}

function collectGenieProcessSnapshot(): string | null {
  const snapshot = safeExec('ps -axo pid,ppid,pgid,stat,pcpu,pmem,etime,command -r', 2000)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isGenieProcessSnapshotLine)
    .join('\n');
  return snapshot || null;
}

interface UpdateDiagnosticsExtras {
  verify: VerifyResult;
}

async function collectUpdateDiagnostics(
  ctx: UpdateDiagnosticsContext,
  maintenance: { outcome: 'completed' | 'failed'; durationMs: number; lines: string[]; error?: string },
  extras: UpdateDiagnosticsExtras,
): Promise<{ path: string; signals: RecentLogSignal[]; newestStaleTimestamp: string | null }> {
  const logsDir = join(GENIE_HOME, 'logs');
  mkdirSync(logsDir, { recursive: true });
  const generatedAt = new Date().toISOString();
  const safeStamp = generatedAt.replace(/[:.]/g, '-');
  const path = join(logsDir, `update-diagnostics-${safeStamp}.json`);
  const schedulerLog = join(logsDir, 'scheduler.log');
  const tuiCrashLog = join(logsDir, 'tui-crash.log');
  const schedulerSummary = summarizeJsonlSignals(schedulerLog);
  const signals = schedulerSummary.signals;

  const diagnostics = {
    schemaVersion: UPDATE_DIAGNOSTIC_SCHEMA_VERSION,
    cli: 'genie',
    generatedAt,
    verify: extras.verify,
    update: {
      channel: ctx.channel,
      latestVersion: ctx.latestVersion,
      cliVersion: ctx.cliVersion,
      platform: ctx.platform,
    },
    delivery: {
      manifest: ctx.manifest,
      tarballPath: ctx.tarballPath,
      attestationVerified: ctx.attestationVerified,
      previousBackup: ctx.previousBackup,
    },
    runtime: {
      platform: process.platform,
      arch: process.arch,
      cwd: process.cwd(),
      node: process.version,
      bun: (await runCommandSilent('bun', ['--version'])).output.trim() || null,
      gh: (await runCommandSilent('gh', ['--version'])).output.split('\n')[0]?.trim() || null,
      genie: {
        which: (await runCommandSilent('which', ['genie'])).output.trim() || null,
        tuiDisabled: isTruthyEnv(process.env.GENIE_TUI_DISABLE),
        updateSkipMaintenance: isTruthyEnv(process.env.GENIE_UPDATE_SKIP_MAINTENANCE),
      },
    },
    paths: {
      genieHome: GENIE_HOME,
      genieBin: GENIE_BIN,
      genieBinStaging: GENIE_BIN_STAGING,
      genieBinPrevious: GENIE_BIN_PREVIOUS,
      logsDir,
      servePid: safeRead(join(GENIE_HOME, 'serve.pid'), 200),
      schedulerLog,
      tuiCrashLog,
    },
    processSnapshot: {
      genie: collectGenieProcessSnapshot(),
      tuiTmux: safeExec('tmux -L genie-tui ls 2>/dev/null || true', 1000) || null,
    },
    maintenance: {
      ...maintenance,
      pgAutostartDisabled: true,
      legend: {
        '[ok]': 'healthy',
        '[fix]': 'fixed during maintenance',
        '[--]': 'skipped/non-blocking',
        '[!!]': 'operator action needed; update still completed',
      },
    },
    recentLogSignals: {
      scheduler: signals,
      schedulerTail: tailLines(schedulerLog, 32_000, 80),
      tuiCrashTail: tailLines(tuiCrashLog, 32_000, 80),
    },
  };

  writeFileSync(path, `${JSON.stringify(diagnostics, null, 2)}\n`);
  return { path, signals, newestStaleTimestamp: schedulerSummary.newestStaleTimestamp };
}

// ============================================================================
// Subprocess wrappers.
// ============================================================================

async function runCommandSilent(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 4000,
): Promise<{ success: boolean; output: string }> {
  return new Promise((resolve) => {
    const output: string[] = [];
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ success: false, output: `Timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (data) => {
      output.push(data.toString());
    });
    child.stderr?.on('data', (data) => {
      output.push(data.toString());
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: code === 0, output: output.join('') });
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ success: false, output: err.message });
    });
  });
}

// ============================================================================
// Plugin sync framework markers (skill-loading regression 2026-05-06).
// `.orphaned_at` MUST NOT propagate from a tarball into the active Claude
// Code cache. Filter at the copy boundary.
// ============================================================================

const FRAMEWORK_MARKER_FILES = new Set(['.orphaned_at']);
const AUXILIARY_DELIVERY_TREE_NAMES = ['plugins', 'skills', 'templates', '.agents', '.claude-plugin'] as const;
type AuxiliaryDeliveryTreeName = (typeof AUXILIARY_DELIVERY_TREE_NAMES)[number];

// ============================================================================
// Channel resolution + persistence.
// ============================================================================

/** Tracks whether the `--next` deprecation notice has already been emitted in
 *  this process so users see it exactly once per invocation, not once per
 *  call site that might re-resolve the channel. */
let nextDeprecationEmitted = false;

function emitNextDeprecationOnce(): void {
  if (nextDeprecationEmitted) return;
  nextDeprecationEmitted = true;
  process.stderr.write(
    'warning: --next is deprecated; use --dev instead (--next will be removed in a future release)\n',
  );
}

/** Test-only: reset the deprecation latch so successive in-process resolves
 *  in a single test file can independently exercise the emit path. */
export function _resetNextDeprecationLatchForTest(): void {
  nextDeprecationEmitted = false;
}

/** Map a raw `updateChannel` token (including the legacy 'next' alias) to a
 *  ReleaseChannel, or null when the token is absent or unrecognized. */
function channelFromToken(token: unknown): ReleaseChannel | null {
  if (token === 'dev' || token === 'next') return 'dev';
  if (token === 'homolog') return 'homolog';
  if (token === 'latest') return 'stable';
  return null;
}

/** Map a ReleaseChannel back to its canonical persisted token. We always write
 *  one of the three canonical tokens ('latest' / 'homolog' / 'dev'); the legacy
 *  'next' alias is read-only and never round-trips to disk. */
function channelToken(channel: ReleaseChannel): 'latest' | 'homolog' | 'dev' {
  if (channel === 'dev') return 'dev';
  if (channel === 'homolog') return 'homolog';
  return 'latest';
}

/** Outcome of a tolerant config read. `ok` means the file parsed as a JSON
 *  object (recoverable — the updateChannel key is readable even when the full
 *  schema rejects the config); `unreadable` means it could not be parsed at all. */
type RawConfigRead =
  | { kind: 'ok'; raw: Record<string, unknown>; schemaValid: boolean }
  | { kind: 'unreadable'; reason: string };

/**
 * Read the genie config leniently — never throws, never returns defaults. Unlike
 * `loadGenieConfig`, this distinguishes a JSON-parseable-but-schema-invalid file
 * (from which the channel can still be recovered) from a truly unparseable one, and
 * it never manufactures a defaults object that a caller could mistake for the real
 * config and persist over the top of it. `schemaValid` is true only when the WHOLE
 * config satisfies GenieConfigSchema.
 */
function readConfigTolerant(): RawConfigRead {
  const path = getGenieConfigPath();
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { kind: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'config root is not a JSON object' };
  }
  const raw = parsed as Record<string, unknown>;
  return { kind: 'ok', raw, schemaValid: GenieConfigSchema.safeParse(raw).success };
}

export async function resolveChannel(options: {
  dev?: boolean;
  homolog?: boolean;
  next?: boolean;
  stable?: boolean;
}): Promise<ReleaseChannel> {
  // --stable is checked FIRST so an explicit override always wins over the
  // prerelease channels (homolog / dev / next). Common case: wrappers /
  // aliases / smoke scripts append `--stable` to force-pull-back from a
  // prerelease regardless of what other flags are on the command line.
  // (PR #2419 review: codex P2 + gemini medium — without this ordering,
  // `genie update --stable --dev` resolved to dev, silently ignoring the
  // operator's stable intent.)
  if (options.stable) {
    // Still emit the --next deprecation notice if --next was passed too —
    // operators learn to drop it from muscle memory even when --stable
    // overrode the channel.
    if (options.next) emitNextDeprecationOnce();
    return 'stable';
  }
  // --homolog ranks ABOVE --dev so an explicit `--homolog --dev` picks
  // homolog (the higher-tier prerelease channel; closer to stable in the
  // dev→homolog→stable promotion ladder).
  if (options.homolog) return 'homolog';
  if (options.dev) return 'dev';
  if (options.next) {
    emitNextDeprecationOnce();
    return 'dev';
  }
  if (genieConfigExists()) return resolveChannelFromConfig();
  return 'stable';
}

/**
 * Resolve the sticky channel from an EXISTING config file, degrading loudly — never
 * silently — when the file can't be fully read. A transient corruption (a truncated
 * concurrent write, or a schema-rejecting field written by another session) must NOT
 * silently reset a persisted 'dev'/'homolog' channel to stable: we recover the channel
 * from the raw updateChannel key first, and only fall back to stable when even that is
 * impossible — saying so on stderr either way.
 */
function resolveChannelFromConfig(): ReleaseChannel {
  const path = getGenieConfigPath();
  const read = readConfigTolerant();
  if (read.kind === 'unreadable') {
    process.stderr.write(
      `warning: could not read ${contractPath(path)} (${read.reason}); falling back to stable channel\n`,
    );
    return 'stable';
  }
  const channel = channelFromToken(read.raw.updateChannel);
  if (read.schemaValid) {
    // Valid config; an absent updateChannel means the schema default (stable).
    return channel ?? 'stable';
  }
  // JSON-parseable but schema-invalid — recover the channel from the raw key
  // rather than silently resetting to stable.
  if (channel) {
    process.stderr.write(
      `warning: could not fully read ${contractPath(path)} (invalid config); keeping channel ${channel} from updateChannel\n`,
    );
    return channel;
  }
  process.stderr.write(
    `warning: could not fully read ${contractPath(path)} (invalid config, no usable updateChannel); falling back to stable channel\n`,
  );
  return 'stable';
}

export async function persistChannel(channel: ReleaseChannel): Promise<void> {
  const token = channelToken(channel);
  // Fresh install (no config yet): write a proper default config carrying the
  // channel. There is nothing on disk to preserve.
  if (!genieConfigExists()) {
    try {
      const config = GenieConfigSchema.parse({});
      config.updateChannel = token;
      await saveGenieConfig(config);
    } catch {
      // non-fatal — channel preference lost but update still works.
    }
    return;
  }
  // Existing config: NEVER round-trip through the schema. `saveGenieConfig` strips
  // unknown keys and, when the load fails, `loadGenieConfig` returns DEFAULTS — so
  // the old load→save path rewrote the whole file from defaults on any transient
  // read failure, the exact side effect that silently reset users' configs during
  // `genie update`. A tolerant raw read-modify-write touches only updateChannel and
  // preserves every other key verbatim; an unparseable file is left untouched.
  const read = readConfigTolerant();
  if (read.kind === 'unreadable') {
    process.stderr.write(
      `warning: ${contractPath(getGenieConfigPath())} is unparseable (${read.reason}); leaving it untouched — channel ${channel} not persisted\n`,
    );
    return;
  }
  read.raw.updateChannel = token;
  try {
    writeFileSync(getGenieConfigPath(), JSON.stringify(read.raw, null, 2), 'utf-8');
  } catch {
    // non-fatal — channel preference lost but update still works.
  }
}

// ============================================================================
// updateCommand — single canonical GH-Releases path. No npm/bun fallback.
// ============================================================================

export interface UpdateCommandOptions {
  /** `--dev`. Switch to the dev/pre-release channel (.well-known/dev.json). */
  dev?: boolean;
  /** `--homolog`. Switch to the homolog/staging channel
   *  (.well-known/homolog.json). Middle tier in the
   *  dev → homolog → stable promotion ladder. */
  homolog?: boolean;
  /** `--next`. Deprecated alias for `--dev`. Resolves to channel 'dev' and
   *  emits a single-line stderr deprecation notice. */
  next?: boolean;
  /** `--stable`. Switch back to the stable channel (.well-known/latest.json). */
  stable?: boolean;
  /** `--skip-maintenance`. Retained for compatibility; v5 has no maintenance
   *  pass, so it now just skips the post-update binary verify probe. */
  skipMaintenance?: boolean;
  /** `--yes` / `-y`. Skips the TTY confirmation. */
  yes?: boolean;
  /** `--no-restart`. Retained for compatibility; v5 is zero-daemon so there is
   *  nothing to restart — it now just skips the post-update verify probe. */
  restart?: boolean;
  /** `--no-verify`. Skips the post-update binary verify probe. */
  verify?: boolean;
  /** `--rollback`. Read-only legacy check; directs operators to an explicit signed-version reinstall. */
  rollback?: boolean;
  /** `--sync-only`. Converge agent integrations and return — no manifest
   *  fetch, no binary swap. Equivalent to GENIE_UPDATE_SYNC_ONLY=1; the flag
   *  is retained for legacy automation and intentionally remains limited to
   *  skills and role agents. */
  syncOnly?: boolean;
  /** Hidden child protocol used only after a verified binary delivery. A
   *  pre-contract binary must reject this argv flag before doing any work. */
  postDeliveryConverge?: boolean;
  /** Hidden read-only capability probe. Emits exactly one schema-valid JSON
   *  object describing this binary's activation-protocol floor and exits 0. A
   *  pre-contract binary rejects the unknown argv flag at commander parse time,
   *  which is how a rollback distinguishes a protocol-1+ backup. */
  printUpdateCapabilities?: boolean;
  /** Companion `--json` flag for `--print-update-capabilities`; the probe output
   *  is always JSON, so this only pins the contract explicit. */
  json?: boolean;
  /**
   * Hidden release-dogfood boundary. The value is one bounded exact-schema JSON
   * request naming a local artifact, raw manifest, signed descriptor, and
   * Sigstore bundle. It is inert unless GENIE_RELEASE_DOGFOOD is exactly `1`.
   */
  publishLocalDelivery?: string;
}

export type UpdateExecutionMode =
  | 'normal'
  | 'rollback'
  | 'sync-only'
  | 'post-delivery-converge'
  | 'publish-local-delivery';

function hasPostDeliveryModeConflict(options: UpdateCommandOptions, syncOnlyEnvironment: string | undefined): boolean {
  return Boolean(
    options.rollback ||
      options.syncOnly ||
      syncOnlyEnvironment === '1' ||
      options.dev ||
      options.homolog ||
      options.next ||
      options.stable ||
      options.yes ||
      options.restart === false ||
      options.verify === false ||
      options.skipMaintenance ||
      options.publishLocalDelivery !== undefined,
  );
}

function hasLocalDeliveryModeConflict(options: UpdateCommandOptions, syncOnlyEnvironment: string | undefined): boolean {
  return Boolean(
    options.rollback ||
      options.syncOnly ||
      syncOnlyEnvironment === '1' ||
      options.postDeliveryConverge ||
      options.printUpdateCapabilities ||
      options.json ||
      options.dev ||
      options.homolog ||
      options.next ||
      options.stable ||
      options.yes ||
      options.restart === false ||
      options.verify === false ||
      options.skipMaintenance,
  );
}

/** Resolve one mutually-exclusive mode before any recovery or other mutation. */
export function resolveUpdateExecutionMode(
  options: UpdateCommandOptions,
  syncOnlyEnvironment = process.env.GENIE_UPDATE_SYNC_ONLY,
): UpdateExecutionMode {
  if (options.publishLocalDelivery !== undefined) {
    if (hasLocalDeliveryModeConflict(options, syncOnlyEnvironment)) {
      throw new Error('--publish-local-delivery cannot be combined with another update mode or delivery option');
    }
    return 'publish-local-delivery';
  }
  if (options.postDeliveryConverge) {
    if (hasPostDeliveryModeConflict(options, syncOnlyEnvironment)) {
      throw new Error('--post-delivery-converge cannot be combined with another update mode or delivery option');
    }
    return 'post-delivery-converge';
  }
  if (options.rollback && options.syncOnly) {
    throw new Error('--rollback and --sync-only cannot be used together');
  }
  if (options.rollback) return 'rollback';
  if (options.syncOnly === true || syncOnlyEnvironment === '1') return 'sync-only';
  return 'normal';
}

/**
 * Downgrade policy gate. Returns true when the caller MUST short-circuit — a
 * backward-pointing manifest with no explicit operator intent — after emitting the
 * refusal line. Returns false to proceed with the swap: for an explicitly-authorized
 * downgrade it first prints a loud one-line notice so the backward move is never
 * silent. An explicit `--stable/--homolog/--dev/--next` on the command line is what
 * counts as operator intent.
 */
function applyDowngradeGuard(
  installedVersion: string,
  latestVersion: string | null,
  channel: ReleaseChannel,
  options: UpdateCommandOptions,
): boolean {
  const explicitChannel = Boolean(options.stable || options.homolog || options.dev || options.next);
  const downgrade = decideDowngrade({ installedVersion, latestVersion, explicitChannel });
  if (downgrade.kind === 'invalid-version') {
    if (downgrade.field === 'latest') {
      throw new Error(`Channel manifest contains an invalid Genie version: ${JSON.stringify(downgrade.value)}`);
    }
    log(
      `Installed version ${JSON.stringify(downgrade.value)} is malformed; proceeding with the valid channel manifest as a repair`,
    );
    return false;
  }
  if (downgrade.kind === 'block-downgrade') {
    log(
      `Installed v${normalizeVersion(downgrade.installed)} is NEWER than ${channel} manifest v${normalizeVersion(downgrade.latest)} — refusing automatic downgrade (switch channels or reinstall explicitly to downgrade)`,
    );
    return true;
  }
  if (downgrade.kind === 'allow-downgrade') {
    log(
      `DOWNGRADE v${normalizeVersion(downgrade.installed)} → v${normalizeVersion(downgrade.latest)} (channel ${channel})`,
    );
  }
  return false;
}

/**
 * Map a convergence outcome to the process exit code (deliverable 3):
 *   - any failed integration  → exit 1 (retry)
 *   - else any action-required (delivered, activation deferred) → exit 2 with the
 *     result trailer and NO all-green footer
 *   - else success (exit 0), caller prints its own success line.
 * `emitTrailer` is false on the fresh-binary parent, whose child already printed
 * the trailer over inherited stdio — the parent only mirrors the exit code.
 */
export function applyConvergenceExitSignal(convergence: ManualUpdateConvergenceResult, emitTrailer = true): void {
  if (convergence.integrations.some((result) => !result.ok)) {
    process.exitCode = 1;
    return;
  }
  if (convergence.integrations.some((result) => result.actionRequired === true)) {
    process.exitCode = 2;
    if (emitTrailer) log(CODEX_DELIVERY_RESULT_TRAILER);
  }
}

function runTrackedManualUpdateConvergence(expectedVersion: string): void {
  const convergence = runManualUpdateConvergence({ expectedVersion });
  applyConvergenceExitSignal(convergence);
}

function resolveUpdatePlatformOrExit(): string {
  try {
    return resolvePlatformId();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function acquireRequiredLifecycleLease(
  acquire: () => LifecycleLease | { skipped: string } = () => acquireLifecycleLease(GENIE_HOME),
): LifecycleLease {
  const lease = acquire();
  if ('skipped' in lease) {
    throw new Error(`Another Genie lifecycle command is active: ${lease.skipped}`);
  }
  return lease;
}

export type FreshBinaryConvergenceRunner = (binaryPath: string, argv: string[], environment: NodeJS.ProcessEnv) => void;

export interface FreshBinaryConvergenceOptions {
  lifecycleLease: LifecycleLease;
  binaryPath?: string;
  run?: FreshBinaryConvergenceRunner;
}

/**
 * Hand the live lifecycle lease to the freshly installed binary and invoke an
 * argv-only protocol that old binaries reject at parse time. The parent stays
 * the sole lease owner while the child performs integration convergence.
 */
export function runFreshBinaryPostDeliveryConvergence(
  options: FreshBinaryConvergenceOptions,
): 'converged' | 'action-required' {
  const binaryPath = options.binaryPath ?? join(GENIE_BIN, 'genie');
  let owner: string;
  try {
    owner = readFileSync(options.lifecycleLease.path, 'utf8').trim();
  } catch (cause) {
    throw new Error(`cannot hand off the Genie lifecycle lease: ${errMsg(cause)}`);
  }
  if (!owner || owner.includes('\n') || owner.includes('\r')) {
    throw new Error('cannot hand off the Genie lifecycle lease: live owner record is missing or malformed');
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    [LIFECYCLE_LEASE_PATH_ENV]: options.lifecycleLease.path,
    [LIFECYCLE_LEASE_OWNER_ENV]: owner,
  };
  const run =
    options.run ??
    ((path, argv, env) => {
      execFileSync(path, argv, { env, stdio: 'inherit' });
    });
  try {
    run(binaryPath, ['update', '--post-delivery-converge'], environment);
    return 'converged';
  } catch (cause) {
    // Exit 2 from the child is delivered-but-action-required (installed N ≠
    // delivered T), NOT a convergence failure. The child already printed its
    // result trailer over inherited stdio; the parent only mirrors the code.
    if (childExitStatus(cause) === 2) return 'action-required';
    throw new Error(
      `fresh Genie integration convergence failed: ${errMsg(cause)}. The verified CLI update is installed, but the integration named above is not converged. Rerun \`genie update\` from a regular terminal to retry. If Codex activation is pending afterwards, close Codex tasks, run \`genie setup --codex\`, review \`/hooks\`, and start a new Codex task.`,
    );
  }
}

/** The child process exit code surfaced by `execFileSync` (or an injected runner) on non-zero exit. */
function childExitStatus(cause: unknown): number | null {
  if (typeof cause === 'object' && cause !== null && 'status' in cause) {
    const status = (cause as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

/**
 * Gate the agent-sync scope for update. R2/A1 (agent-sync must never write
 * codex product skills into ~/.agents/skills) is structural in `runAgentSync`
 * itself now — there is no `codex` arm to narrow away from — so this only
 * skips agent-sync where it has nothing to do: `none` and `codex` (setup owns
 * Codex convergence). `auto`/`all`/`claude` pass through UNCHANGED so
 * `runAgentSync` sees the real selection and converges hermes on `auto`/`all`.
 */
export function narrowUpdateAgentSyncSelection(selection: IntegrationSelection): IntegrationSelection | null {
  return selection === 'none' || selection === 'codex' ? null : selection;
}

/**
 * Update delivery owns no Codex activation surfaces. Claude refresh remains
 * update-owned; Hermes continues through agent-sync. Returning null prevents
 * even a Codex query when Codex is the only selected integration.
 */
export function narrowUpdatePluginRefreshSelection(selection: IntegrationSelection): 'claude' | null {
  return selection === 'none' || selection === 'codex' ? null : 'claude';
}

/** Update-owned agent sync cannot cross into setup-owned Codex role convergence. */
export function runUpdateAgentSync(
  selection: IntegrationSelection,
  sync: typeof runAgentSyncSafe = runAgentSyncSafe,
): AgentSyncReport | null {
  return sync({ strict: true, selection });
}

export interface LegacySyncOnlyConvergenceOptions {
  selection: IntegrationSelection;
  /** Retained for the call signature and structure tests; sync-only never reads a version. */
  expectedVersion: string;
  sync?: () => void;
  log?: (line: string) => void;
}

/**
 * D2 (wish decision 3, Felipe-ratified): legacy `--sync-only` is a pure
 * agent-sync compatibility path. It branches BEFORE every Codex activation
 * observer, classifier, authorization, plugin query, or mutation — it never
 * lists, probes, inspects, enables, installs, or swaps the Codex plugin — and a
 * genuine agent-sync failure is its ONLY nonzero result. Codex product skills
 * are never rewritten under ~/.agents/skills (R2/A1) — that guarantee is
 * structural in `runAgentSync`, not a Claude-only narrowing here.
 */
export function runLegacySyncOnlyConvergence(options: LegacySyncOnlyConvergenceOptions): void {
  const agentSyncSelection = narrowUpdateAgentSyncSelection(options.selection);
  (
    options.sync ??
    (() => {
      if (agentSyncSelection !== null) runUpdateAgentSync(agentSyncSelection);
    })
  )();
}

function announceUpdatePlanOrExit(
  channel: ReleaseChannel,
  platform: string,
  installedVersion: string,
  latestVersion: string | null,
): string {
  log(`Channel: ${channel}${channel === 'stable' ? ' (stable)' : ` (${channel})`}`);
  log(`Platform: ${platform}`);
  if (!latestVersion) {
    log(`Channel manifest unavailable (.well-known/${channel === 'stable' ? 'latest' : channel}.json missing)`);
    error(`Cannot resolve target version for channel "${channel}". Aborting.`);
    process.exit(1);
  }
  if (normalizeVersion(installedVersion) !== normalizeVersion(latestVersion)) {
    log(`Update available: ${normalizeVersion(installedVersion)} → ${normalizeVersion(latestVersion)}`);
  }
  return latestVersion;
}

function runLegacySyncOnlyMode(): void {
  // Consent is re-read under the lease so a concurrent lifecycle command
  // cannot change the selected client-home scope between plan and write.
  const selection = readIntegrationConsent(GENIE_HOME);
  runLegacySyncOnlyConvergence({ selection, expectedVersion: VERSION });
}

function runPostDeliveryConvergenceMode(): void {
  const installedVersion = readBinaryVersion(join(GENIE_BIN, 'genie'));
  if (installedVersion === null) {
    error('Post-delivery convergence refused: the canonical installed binary did not report a version.');
    process.exitCode = 1;
    return;
  }
  try {
    const convergence = runManualUpdateConvergence({
      expectedVersion: installedVersion,
      selection: readIntegrationConsent(GENIE_HOME),
    });
    const failures = convergence.integrations.filter((result) => !result.ok);
    if (failures.length > 0) {
      throw new Error(failures.map((result) => `${result.runtime}: ${result.detail}`).join('; '));
    }
    // Delivered-but-action-required (installed N ≠ delivered T): exit 2 with the
    // result trailer and no all-green footer. The parent mirrors this exit code.
    applyConvergenceExitSignal(convergence);
  } catch (cause) {
    error(`Post-delivery convergence failed: ${errMsg(cause)}`);
    process.exitCode = 1;
  }
}

async function runExplicitUpdateMode(
  mode: Exclude<UpdateExecutionMode, 'normal' | 'publish-local-delivery'>,
): Promise<void> {
  const lifecycleLease = acquireRequiredLifecycleLease();
  let terminal: DeferredUpdateTerminal | null = null;
  try {
    if (mode === 'rollback') terminal = await runRollback();
    else if (mode === 'sync-only') runLegacySyncOnlyMode();
    else runPostDeliveryConvergenceMode();
  } finally {
    lifecycleLease.release();
  }
  if (terminal !== null) projectDeferredUpdateTerminal(terminal);
}

async function dispatchNonNormalUpdateMode(options: UpdateCommandOptions): Promise<boolean> {
  if (options.printUpdateCapabilities) {
    if (options.publishLocalDelivery !== undefined) {
      throw new Error('--print-update-capabilities cannot be combined with --publish-local-delivery');
    }
    printUpdateCapabilities();
    return true;
  }
  const mode = resolveUpdateExecutionMode(options);
  if (mode === 'publish-local-delivery') {
    await runLocalDeliveryRepairMode(options.publishLocalDelivery as string);
    return true;
  }
  if (mode !== 'normal') {
    await runExplicitUpdateMode(mode);
    return true;
  }
  return false;
}

async function confirmPlannedDelivery(
  options: UpdateCommandOptions,
  installedVersion: string,
  latestVersion: string,
): Promise<boolean> {
  const decision = decideDowngrade({
    installedVersion,
    latestVersion,
    explicitChannel: Boolean(options.stable || options.homolog || options.dev || options.next),
  });
  const needsDelivery =
    normalizeVersion(installedVersion) !== normalizeVersion(latestVersion) && decision.kind !== 'block-downgrade';
  if (!needsDelivery || shouldAutoConfirm(options)) return true;
  const proceed = await promptConfirm(
    `Update v${normalizeVersion(installedVersion)} → v${normalizeVersion(latestVersion)}?`,
  );
  if (proceed) return true;
  console.log();
  log('Update declined.');
  console.log();
  return false;
}

function runFreshConvergenceOrReport(lifecycleLease: LifecycleLease): boolean {
  try {
    const outcome = runFreshBinaryPostDeliveryConvergence({ lifecycleLease });
    // The child already printed its trailer over inherited stdio; mirror exit 2
    // without re-emitting (parent/child exit semantics agree).
    if (outcome === 'action-required') process.exitCode = 2;
    return true;
  } catch (cause) {
    error(errMsg(cause));
    process.exitCode = 1;
    return false;
  }
}

function recoverInstallPromotionAndConvergePayload(): void {
  const genuinelyAbsent = (path: string): boolean => {
    try {
      lstatSync(path);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
  if (genuinelyAbsent(GENIE_HOME) || genuinelyAbsent(GENIE_BIN)) return;
  const reports = recoverPendingInstallPromotions({ genieHome: GENIE_HOME });
  const outcomes = syncAuxiliaryContent(GENIE_BIN, GENIE_HOME, undefined, true);
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  if (failures.length > 0) {
    throw new Error(
      `committed install payload convergence failed: ${failures
        .map((outcome) => `${outcome.label} (${outcome.stage})`)
        .join(', ')}`,
    );
  }
  if (reports.length === 0 && outcomes.every((outcome) => outcome.status === 'skipped')) return;
  const versionPath = join(GENIE_BIN, 'VERSION');
  const fd = openSync(versionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let exactVersion: Buffer;
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('live bin/VERSION is not a physical file');
    exactVersion = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (!sameBigStat(before, after)) throw new Error('live bin/VERSION changed while recovery read it');
  } finally {
    closeSync(fd);
  }
  writeFileSync(join(GENIE_HOME, 'VERSION'), exactVersion);
}

// ============================================================================
// Same-version delivery repair on the already-current path (Group D deliverable 1)
// ============================================================================

export type AlreadyCurrentRepairDirective =
  | { action: 'proceed-current' }
  | { action: 'repaired-current' }
  | { action: 'exit-handoff' }
  | { action: 'route-upgrade'; manifest: PinnedManifest }
  | { action: 'busy'; detail: string }
  | { action: 'failed'; detail: string };

/**
 * Pure mapping of a repair outcome to the already-current directive. A published
 * record whose registered generation still trails the target hands off to setup
 * (exit 2 with the delivery trailer); a target-current publish reports the repair
 * and returns without entering activation or ordinary rerun convergence. A matching
 * record retains the ordinary rerun path, a channel advance routes through ordinary
 * upgrade, and failed repair remains an explicit non-success terminal outcome.
 */
export function mapAlreadyCurrentRepairOutcome(outcome: DeliveryRepairOutcome): AlreadyCurrentRepairDirective {
  if (outcome.kind === 'published') {
    return outcome.handoff === 'activation-pending' ? { action: 'exit-handoff' } : { action: 'repaired-current' };
  }
  if (outcome.kind === 'channel-advanced') return { action: 'route-upgrade', manifest: outcome.manifest };
  if (outcome.kind === 'failed') return { action: 'failed', detail: `${outcome.stage}: ${outcome.detail}` };
  return { action: 'proceed-current' };
}

/** The pinned, immutable repair target — every field is locally known at pin time. */
function buildRepairPinnedTarget(channel: DeliveryEvidenceChannel, platformId: string): RepairPinnedTarget {
  const version = normalizeVersion(VERSION);
  return {
    channel,
    targetVersion: version,
    platformTriple: `${process.platform}-${process.arch}`,
    platformId,
    releaseTag: `v${version}`,
    releaseName: `genie-${version}-${platformId}.tar.gz`,
  };
}

/** The canonical installed payload root under GENIE_HOME, or null when no payload is present. */
function resolveCanonicalPayloadRoot(genieHome = GENIE_HOME): string | null {
  for (const candidate of [genieHome, join(genieHome, 'bin')]) {
    if (existsSync(join(candidate, 'plugins', 'genie'))) return candidate;
  }
  return null;
}

function hashFileSha256(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

/** Local canonical observation; null when the installed payload/binary cannot be safely observed. */
function observeInstalledForRepair(
  genieHome = GENIE_HOME,
  deliveryEvidenceVerification: DeliveryEvidenceVerificationDependencies = {},
): InstalledProof | null {
  const snapshot = observeCodexActivation({ genieHome, command: null, deliveryEvidenceVerification });
  if (snapshot.canonical.status !== 'ok') return null;
  return {
    version: snapshot.canonical.version.canonical,
    pluginTreeSha256: snapshot.canonical.digest,
    binarySha256: snapshot.canonical.installedBinarySha256,
    deliveryRoot: snapshot.canonical.deliveryRoot,
  };
}

/** Re-scan a freshly extracted tarball into a candidate proof; throws on any unsafe/unreadable member. */
async function proveCandidateFromTarball(tarballPath: string): Promise<CandidateProof> {
  const extractRoot = createPrivateUpdateTempRoot();
  try {
    await extractTarball(tarballPath, extractRoot);
    chmodSync(extractRoot, 0o700);
    return proveExtractedDeliveryCandidate(extractRoot);
  } finally {
    rmSync(extractRoot, { recursive: true, force: true });
  }
}

/** Bind the exact extracted VERSION, binary, and physical plugin tree before promotion. */
function proveExtractedDeliveryCandidate(extractRoot: string): CandidateProof {
  const tree = scanPhysicalTree(join(extractRoot, 'plugins', 'genie'));
  if (tree.status !== 'ok' || tree.digest === undefined) {
    throw new Error(`candidate plugin tree is not a safe physical tree: ${tree.status}`);
  }
  const version = parseReleaseVersion(readTrimmedFile(join(extractRoot, 'VERSION')));
  if (version === null) throw new Error('candidate VERSION is missing or fails the release grammar');
  const binarySha256 = hashFileSha256(join(extractRoot, 'genie'));
  if (binarySha256 === null) throw new Error('candidate binary is unreadable');
  return { version: version.canonical, pluginTreeSha256: tree.digest, binarySha256 };
}

function readTrimmedFile(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Attempt the same-version delivery repair before an already-current return.
 * The operation is fail-closed: unobservable state, lease contention, or any
 * repair failure is reported explicitly instead of masquerading as current.
 * Download and private extraction happen under the held Codex lease and are
 * cleaned up on every path; only `publishDelivery` mutates durable state.
 */
export async function attemptAlreadyCurrentDeliveryRepair(
  channel: DeliveryEvidenceChannel,
  platformId: string,
  heldLease?: HeldLifecycleLease,
  genieHome = GENIE_HOME,
  dependencies: AlreadyCurrentRepairAdapterDeps = {},
): Promise<AlreadyCurrentRepairDirective> {
  const installed = observeInstalledForRepair(genieHome, dependencies.evidenceVerification);
  if (installed === null) return { action: 'failed', detail: 'installed payload/binary could not be observed' };
  const pinned = buildRepairPinnedTarget(channel, platformId);
  // No-network, no-lease fast path: an already-bound record needs no repair.
  const delivery = observeCodexActivation({
    genieHome,
    command: null,
    deliveryEvidenceVerification: dependencies.evidenceVerification,
  }).delivery;
  if (localDeliveryMatches(delivery, pinned, installed)) {
    return { action: 'proceed-current' };
  }
  const acquired = heldLease === undefined ? acquireCodexLifecycleLease('update-delivery', { genieHome }) : null;
  if (acquired !== null && !acquired.ok) {
    return {
      action: 'busy',
      detail: `another Genie lifecycle command (${acquired.holderKind ?? 'unknown'}) holds the Codex lease`,
    };
  }
  const lease = heldLease ?? (acquired as HeldLifecycleLease);
  const tempRoots: string[] = [];
  try {
    const seams = buildAlreadyCurrentRepairSeams(platformId, installed, lease, tempRoots, genieHome, dependencies);
    const outcome = await repairMissingDelivery(pinned, seams);
    return mapAlreadyCurrentRepairOutcome(outcome);
  } catch (cause) {
    return { action: 'failed', detail: errMsg(cause) };
  } finally {
    if (heldLease === undefined) lease.release();
    for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  }
}

export interface AlreadyCurrentRepairAdapterDeps {
  fetchManifest?: typeof fetchLatestManifest;
  downloadAndVerifyDeliveryAssets?: typeof downloadAndVerifyDeliveryAssets;
  evidenceVerification?: DeliveryEvidenceVerificationDependencies;
  createTempRoot?: typeof createPrivateUpdateTempRoot;
}

export interface LocalDeliveryRepairProjection {
  exitCode: 0 | 1 | 2;
  stdout: string[];
  stderr: string[];
}

/**
 * Map the production repair directive onto the same stable delivery trailers
 * used by ordinary update. The local dogfood surface never routes a moving
 * channel into the network-backed upgrade path.
 */
export function projectLocalDeliveryRepairDirective(
  directive: AlreadyCurrentRepairDirective,
  version = normalizeVersion(VERSION),
): LocalDeliveryRepairProjection {
  if (directive.action === 'busy') {
    return {
      exitCode: 2,
      stdout: [CODEX_LIFECYCLE_BUSY_TRAILER],
      stderr: [`Local Codex delivery publication is busy: ${directive.detail}`],
    };
  }
  if (directive.action === 'failed') {
    return {
      exitCode: 1,
      stdout: [CODEX_DELIVERY_INCOMPLETE_TRAILER],
      stderr: [`Local Codex delivery publication failed: ${directive.detail}`],
    };
  }
  if (directive.action === 'route-upgrade') {
    return {
      exitCode: 1,
      stdout: [CODEX_DELIVERY_INCOMPLETE_TRAILER],
      stderr: [
        `Local Codex delivery publication refused a non-current manifest (${version} → ${directive.manifest.version})`,
      ],
    };
  }
  if (directive.action === 'exit-handoff') {
    return {
      exitCode: 2,
      stdout: ['Authenticated Codex delivery published; activation is pending.', CODEX_DELIVERY_RESULT_TRAILER],
      stderr: [],
    };
  }
  if (directive.action === 'repaired-current') {
    return {
      exitCode: 0,
      stdout: [`Authenticated Codex delivery published for current v${version}.`],
      stderr: [],
    };
  }
  return {
    exitCode: 0,
    stdout: [`Authenticated Codex delivery already matches current v${version}.`],
    stderr: [],
  };
}

function emitLocalDeliveryRepairProjection(projection: LocalDeliveryRepairProjection): void {
  for (const line of projection.stdout) log(line);
  for (const line of projection.stderr) process.stderr.write(`${line}\n`);
  process.exitCode = projection.exitCode;
}

/**
 * Offline release-dogfood entrypoint. External paths are snapshotted first,
 * the Codex lifecycle lease is then held across the complete production
 * `repairMissingDelivery` call, and no fetch/download implementation is
 * reachable: both adapters return only the snapshotted bytes.
 */
async function runLocalDeliveryRepairMode(rawRequest: string): Promise<void> {
  let snapshotRoot: string | null = null;
  let lease: HeldLifecycleLease | null = null;
  try {
    assertLocalDeliveryRepairEnabled(process.env.GENIE_RELEASE_DOGFOOD);
    const platformId = resolvePlatformId();
    snapshotRoot = createPrivateUpdateTempRoot();
    const local = materializeLocalDeliveryRepair(rawRequest, snapshotRoot, platformId, normalizeVersion(VERSION));
    const acquired = acquireCodexLifecycleLease('update-delivery', { genieHome: GENIE_HOME });
    if (!acquired.ok) {
      emitLocalDeliveryRepairProjection({
        exitCode: 2,
        stdout: [CODEX_LIFECYCLE_BUSY_TRAILER],
        stderr: [`Local Codex delivery publication is busy: ${acquired.detail}`],
      });
      return;
    }
    lease = acquired;
    const directive = await attemptAlreadyCurrentDeliveryRepair(
      local.manifest.channel,
      local.platformId,
      lease,
      GENIE_HOME,
      {
        fetchManifest: async (channel) => {
          if (channel !== local.manifest.channel) {
            throw new Error(`local manifest channel ${local.manifest.channel} differs from requested ${channel}`);
          }
          return local.manifest;
        },
        downloadAndVerifyDeliveryAssets: async (manifest, requestedPlatform) => {
          if (
            requestedPlatform !== local.platformId ||
            manifest.manifestSha256 !== local.manifest.manifestSha256 ||
            manifest.manifestBytes !== local.manifest.manifestBytes
          ) {
            throw new Error('local delivery adapter received a target other than the snapshotted request');
          }
          return {
            tarballPath: local.artifactPath,
            descriptorBytes: local.descriptorBytes,
            bundleBytes: local.bundleBytes,
          };
        },
      },
    );
    emitLocalDeliveryRepairProjection(projectLocalDeliveryRepairDirective(directive));
  } catch (cause) {
    emitLocalDeliveryRepairProjection(projectLocalDeliveryRepairDirective({ action: 'failed', detail: errMsg(cause) }));
  } finally {
    lease?.release();
    if (snapshotRoot !== null) rmSync(snapshotRoot, { recursive: true, force: true });
  }
}

/** Build the real repair seams; download roots are tracked in `tempRoots` for cleanup by the caller. */
export function buildAlreadyCurrentRepairSeams(
  platformId: string,
  installed: InstalledProof,
  lease: HeldLifecycleLease,
  tempRoots: string[],
  genieHome = GENIE_HOME,
  deps: AlreadyCurrentRepairAdapterDeps = {},
): DeliveryRepairSeams {
  const fetchManifest = deps.fetchManifest ?? fetchLatestManifest;
  const downloadAssets = deps.downloadAndVerifyDeliveryAssets ?? downloadAndVerifyDeliveryAssets;
  const createTempRoot = deps.createTempRoot ?? createPrivateUpdateTempRoot;
  return {
    readDeliveryFact: () =>
      observeCodexActivation({
        genieHome,
        command: null,
        deliveryEvidenceVerification: deps.evidenceVerification,
      }).delivery,
    observeInstalled: () => installed,
    fetchManifest: async (channel) => {
      const manifest = await fetchManifest(channel as ReleaseChannel);
      return manifest === null ? null : manifest;
    },
    downloadAndVerify: async (target, pinnedManifest) => {
      const destDir = createTempRoot();
      tempRoots.push(destDir);
      if (target.platformId !== platformId) {
        throw new Error(`repair target platform ${target.platformId} differs from adapter ${platformId}`);
      }
      const expectedName = `genie-${normalizeVersion(pinnedManifest.version)}-${platformId}.tar.gz`;
      if (target.releaseTag !== `v${normalizeVersion(pinnedManifest.version)}` || target.releaseName !== expectedName) {
        throw new Error('repair release tag/name differ from the immutable pinned manifest asset');
      }
      const downloaded = await downloadAssets(pinnedManifest, platformId, destDir);
      if (downloaded.tarballPath.split('/').pop() !== target.releaseName) {
        throw new Error(`downloaded asset name differs from pinned ${target.releaseName}`);
      }
      return downloaded;
    },
    hashArtifact: (path) => {
      const digest = hashFileSha256(path);
      if (digest === null) throw new Error('downloaded artifact is unreadable');
      return digest;
    },
    proveCandidate: (path) => proveCandidateFromTarball(path),
    verifyEvidence: (input) => verifyDownloadedDeliveryEvidence(input, deps.evidenceVerification),
    reobserve: () => reobserveForRepair(genieHome),
    store: openCodexActivationStore({ genieHome, deliveryEvidenceVerification: deps.evidenceVerification }),
    lease,
  };
}

/** Re-observe the installed generation + canonical digest immediately before publication. */
function reobserveForRepair(genieHome = GENIE_HOME): {
  installedGeneration: string | null;
  canonicalVersion: string;
  canonicalPayloadSha256: string;
  installedBinarySha256: string;
  deliveryRoot: string;
} | null {
  let command: string | null = null;
  try {
    command = resolveRuntimeExecutable('codex', process.cwd());
  } catch {
    command = null;
  }
  const snapshot = observeCodexActivation({ genieHome, command });
  if (snapshot.canonical.status !== 'ok') return null;
  const registration = snapshot.query.status === 'ok' ? snapshot.query.registration : { present: false as const };
  const installedGeneration = registration.present && registration.version ? registration.version.canonical : null;
  return {
    installedGeneration,
    canonicalVersion: snapshot.canonical.version.canonical,
    canonicalPayloadSha256: snapshot.canonical.digest,
    installedBinarySha256: snapshot.canonical.installedBinarySha256,
    deliveryRoot: snapshot.canonical.deliveryRoot,
  };
}

/** Best-effort retirement of the legacy `.install-version` marker after a proven-successful convergence. */
function retireLegacyInstallMarkerSafe(): void {
  try {
    retireInstallVersionMarker(GENIE_HOME);
  } catch {
    // Orphan-metadata cleanup must never fail a completed update.
  }
}

/**
 * The already-current terminal path. Group D deliverable 1: before returning
 * "Already up to date", repair a missing authenticated delivery record for the
 * installed target exactly once. A matching record retains non-Codex rerun
 * convergence, a channel advance enters ordinary upgrade, and repair failure
 * or contention exits nonzero. An old-parent repair hands off to setup (exit 2).
 */
export interface AlreadyCurrentUpdateDependencies {
  attemptRepair?: typeof attemptAlreadyCurrentDeliveryRepair;
  runConvergence?: typeof runTrackedManualUpdateConvergence;
  retireLegacyMarker?: typeof retireLegacyInstallMarkerSafe;
}

export async function handleAlreadyCurrentUpdate(
  channel: ReleaseChannel,
  platform: string,
  installedVersion: string,
  latestVersion: string | null | undefined,
  dependencies: AlreadyCurrentUpdateDependencies = {},
  heldLease?: HeldLifecycleLease,
): Promise<LatestManifest | null> {
  const repair = await (dependencies.attemptRepair ?? attemptAlreadyCurrentDeliveryRepair)(
    channel,
    platform,
    heldLease,
  );
  if (repair.action === 'route-upgrade') {
    log(`Channel advanced while repairing delivery (${installedVersion} → ${repair.manifest.version}); upgrading.`);
    return repair.manifest;
  }
  if (repair.action === 'busy') {
    error(`Codex delivery repair is busy: ${repair.detail}`);
    log(CODEX_LIFECYCLE_BUSY_TRAILER);
    process.exitCode = 2;
    return null;
  }
  if (repair.action === 'failed') {
    error(`Codex delivery repair failed: ${repair.detail}`);
    log(CODEX_DELIVERY_INCOMPLETE_TRAILER);
    process.exitCode = 1;
    return null;
  }
  if (repair.action === 'repaired-current') {
    (dependencies.retireLegacyMarker ?? retireLegacyInstallMarkerSafe)();
    log('Repaired the missing Codex delivery record for the installed generation.');
    return null;
  }
  if (repair.action === 'exit-handoff') {
    // Publication owns only the delivery fact. Activation remains an explicit
    // setup authority, so this terminal path must not enter convergence.
    log(
      'Codex plugin activation is pending: retire Codex tasks, run `genie setup --codex`, review `/hooks`, then start a new Codex task.',
    );
    (dependencies.retireLegacyMarker ?? retireLegacyInstallMarkerSafe)();
    log(CODEX_DELIVERY_RESULT_TRAILER);
    process.exitCode = 2;
    return null;
  }
  success(`Already up to date (v${normalizeVersion(installedVersion)}, channel ${channel})`);
  (dependencies.runConvergence ?? runTrackedManualUpdateConvergence)(
    latestVersion ?? normalizeVersion(installedVersion),
  );
  (dependencies.retireLegacyMarker ?? retireLegacyInstallMarkerSafe)();
  console.log();
  return null;
}

/**
 * Normal-delivery terminal boundary. Publication failure happens after verified
 * promotion, so it is handled as an explicit incomplete delivery and no
 * success-only cleanup, convergence, verification, or marker retirement runs.
 */
export async function runNormalUpdatePublicationBoundary(
  deliver: () => Promise<AuxiliaryTreeOutcome[]>,
  afterPublished: () => Promise<boolean>,
): Promise<boolean> {
  try {
    await deliver();
  } catch (cause) {
    if (!(cause instanceof CodexDeliveryPublicationError)) throw cause;
    error(`Update delivered the verified binary, but ${cause.message}`);
    log(CODEX_DELIVERY_INCOMPLETE_TRAILER);
    process.exitCode = 1;
    return false;
  }
  return afterPublished();
}

export interface UpdateCommandDependencies {
  /** Narrow same-process test seam; production always fetches the selected channel manifest. */
  fetchManifest?: typeof fetchLatestManifest;
  /** Narrow same-process test seam; production always downloads release assets through GitHub. */
  downloadDeliveryAssets?: typeof downloadAndVerifyDeliveryAssets;
  /** Cryptographic verifier seam only; every descriptor/candidate binding remains live. */
  evidenceVerification?: DeliveryEvidenceVerificationDependencies;
  /** Same-version terminal seam; production keeps repair, convergence, and marker authority unchanged. */
  alreadyCurrent?: AlreadyCurrentUpdateDependencies;
  /** Narrow selected-target delivery seam for command-boundary tests. */
  deliverSelectedManifest?: (manifest: LatestManifest, platform: string) => Promise<AuxiliaryTreeOutcome[]>;
  /** Narrow success-finalizer seam paired with `deliverSelectedManifest`. */
  finalizeSelectedDelivery?: () => Promise<boolean>;
  /** Read-only installed-version seam for command-boundary tests. */
  readInstalledVersion?: typeof resolveInstalledVersion;
  /** Read-only platform seam for command-boundary tests. */
  resolvePlatform?: () => string;
  /** Recovery seam; production replays both durable delivery transactions under both locks. */
  recoverPendingState?: () => void;
  /** Channel persistence seam; production writes only after both locks are held. */
  persistSelectedChannel?: (channel: ReleaseChannel) => Promise<void>;
  /** Canonical-install guard seam for command-boundary tests. */
  requireCanonicalInstall?: () => void;
  /** Outer delivery lock seam; production acquires the shared agent-sync lifecycle lease. */
  acquireLease?: () => LifecycleLease | { skipped: string };
  /** Inner delivery lock seam; production acquires one Codex lease for the whole mutation phase. */
  acquireCodexLease?: () => LifecycleLeaseResult;
}

type UpdateTerminalExitCode = 1 | 2;

/**
 * A terminal CLI projection discovered while lifecycle leases are held.
 * Throwing/capturing this value unwinds both leases before stderr, trailer,
 * and process status are projected at the command boundary.
 */
class DeferredUpdateTerminal extends Error {
  constructor(
    readonly exitCode: UpdateTerminalExitCode,
    message: string,
    readonly trailer?: string,
    readonly trailingBlankLine = false,
  ) {
    super(message);
    this.name = 'DeferredUpdateTerminal';
  }
}

function projectDeferredUpdateTerminal(terminal: DeferredUpdateTerminal): void {
  error(terminal.message);
  if (terminal.trailer !== undefined) log(terminal.trailer);
  if (terminal.trailingBlankLine) console.log();
  process.exitCode = terminal.exitCode;
}

function captureDeferredUpdateTerminal(error: unknown): DeferredUpdateTerminal {
  if (error instanceof DeferredUpdateTerminal) return error;
  throw error;
}

function acquireCodexUpdateLeaseOrRefuse(
  acquire: NonNullable<UpdateCommandDependencies['acquireCodexLease']> = () =>
    acquireCodexLifecycleLease('update-delivery', { genieHome: GENIE_HOME }),
): HeldLifecycleLease {
  const acquired = acquire();
  if (!acquired.ok) {
    throw new DeferredUpdateTerminal(
      2,
      new CodexLifecycleBusyError(acquired.holderKind).message,
      CODEX_LIFECYCLE_BUSY_TRAILER,
    );
  }
  acquired.assertOperation(acquired.operationId);
  return acquired;
}

function recoverPendingUpdateStateOrThrow(recover?: () => void): void {
  try {
    (
      recover ??
      (() => {
        recoverInstallPromotionAndConvergePayload();
        resumePendingDelivery();
      })
    )();
  } catch (err) {
    throw new DeferredUpdateTerminal(1, `Pending update recovery failed: ${errMsg(err)}`);
  }
}

function releaseUpdateLifecycleLeases(codexLease: HeldLifecycleLease | null, lifecycleLease: LifecycleLease): void {
  try {
    codexLease?.release();
  } finally {
    lifecycleLease.release();
  }
}

export async function updateCommand(
  options: UpdateCommandOptions = {},
  dependencies: UpdateCommandDependencies = {},
): Promise<void> {
  // The read-only capability probe is answered before mode resolution and any
  // mutation: it self-hashes this binary, prints exactly one JSON object, and
  // exits 0. A pre-contract binary never reaches here — it rejects the unknown
  // `--print-update-capabilities` flag at commander parse, which is precisely
  // the signal the rollback capability floor relies on.
  if (await dispatchNonNormalUpdateMode(options)) return;

  console.log();
  console.log(`${colorize('\x1b[1m', '\x1b[0m', '🧞 Genie CLI Update')}`);
  console.log(`${colorize('\x1b[2m', '\x1b[0m', '────────────────────────────────────')}`);
  console.log();

  const noRestart = options.restart === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_RESTART);
  const noVerify = options.verify === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_VERIFY);
  const channel = await resolveChannel(options);

  // Planning is read-only and deliberately happens before lifecycle lease
  // acquisition. Interactive users can consider the prompt without blocking
  // install/setup/uninstall in another process.
  let manifest = await (dependencies.fetchManifest ?? fetchLatestManifest)(channel);
  const plannedInstalledVersion = (dependencies.readInstalledVersion ?? resolveInstalledVersion)();
  const platform = (dependencies.resolvePlatform ?? resolveUpdatePlatformOrExit)();
  let latestVersion = announceUpdatePlanOrExit(channel, platform, plannedInstalledVersion, manifest?.version ?? null);
  console.log();

  if (!(await confirmPlannedDelivery(options, plannedInstalledVersion, latestVersion))) return;

  const lifecycleLease = acquireRequiredLifecycleLease(dependencies.acquireLease);
  let codexLease: HeldLifecycleLease | null = null;
  let terminal: DeferredUpdateTerminal | null = null;
  try {
    try {
      const acquired = acquireCodexUpdateLeaseOrRefuse(dependencies.acquireCodexLease);
      codexLease = acquired;

      // Revalidate durable recovery and the installed binary immediately after
      // acquiring both locks, before the first mutation owned by this plan.
      recoverPendingUpdateStateOrThrow(dependencies.recoverPendingState);
      const installedVersion = (dependencies.readInstalledVersion ?? resolveInstalledVersion)();

      // Channel persistence is now inside the mutation lease and follows local
      // state revalidation; the prompt itself never owns the lease.
      await (dependencies.persistSelectedChannel ?? persistChannel)(channel);

      if (shortCircuitIfCurrent(installedVersion, latestVersion)) {
        const advancedManifest = await handleAlreadyCurrentUpdate(
          channel,
          platform,
          installedVersion,
          latestVersion,
          dependencies.alreadyCurrent,
          acquired,
        );
        if (advancedManifest === null) return;
        manifest = advancedManifest;
        latestVersion = advancedManifest.version;
      }

      if (applyDowngradeGuard(installedVersion, latestVersion, channel, options)) {
        runTrackedManualUpdateConvergence(normalizeVersion(installedVersion));
        console.log();
        return;
      }

      // A concurrent lifecycle operation may have moved or replaced the live
      // binary while this process was prompting. Re-check canonical ownership
      // under the lease immediately before delivery. Refusals are deferred so
      // both leases unwind before process status is projected.
      try {
        (dependencies.requireCanonicalInstall ?? ensureCanonicalInstall)();
      } catch (err) {
        throw new DeferredUpdateTerminal(1, errMsg(err));
      }

      const diagnosticsCtx: UpdateDiagnosticsContext = {
        channel,
        manifest,
        platform,
        latestVersion,
        cliVersion: VERSION,
        tarballPath: null,
        attestationVerified: false,
        previousBackup: null,
      };
      const resolvedManifest = manifest as LatestManifest;

      try {
        acquired.assertOperation(acquired.operationId);
        const complete = await runNormalUpdatePublicationBoundary(
          () =>
            dependencies.deliverSelectedManifest?.(resolvedManifest, platform) ??
            runDelivery(resolvedManifest, platform, diagnosticsCtx, acquired, dependencies),
          dependencies.finalizeSelectedDelivery ??
            (async () => {
              runV4CleanupSafe();
              if (!runFreshConvergenceOrReport(lifecycleLease)) return false;
              await runPostUpdateVerifySafe({ ...options, noRestart, noVerify }, diagnosticsCtx);
              // Convergence succeeded: retire the orphaned legacy `.install-version` marker
              // (Decision 14). Canonical VERSION is the sole authority; this only runs after
              // a proven-successful delivery + convergence, so a failed run preserves it.
              retireLegacyInstallMarkerSafe();
              return true;
            }),
        );
        if (!complete) return;
      } catch (err) {
        if (err instanceof CodexLifecycleBusyError) {
          // Loser semantics (deliverable 9): refused before any swap with zero
          // mutation. Exit 2 codex-lifecycle-busy with the busy trailer, not a
          // generic failure.
          throw new DeferredUpdateTerminal(2, err.message, CODEX_LIFECYCLE_BUSY_TRAILER);
        }
        throw new DeferredUpdateTerminal(1, `Update failed: ${errMsg(err)}`);
      }
    } catch (err) {
      terminal = captureDeferredUpdateTerminal(err);
    }
  } finally {
    releaseUpdateLifecycleLeases(codexLease, lifecycleLease);
  }
  if (terminal !== null) projectDeferredUpdateTerminal(terminal);
}

/**
 * Post-swap v4 legacy cleanup (see legacy-v4.ts). v5 machines upgrade through
 * this command — never by re-running install.sh — so the upgrade path must
 * run the same cleanup the installer does. Non-fatal by contract: a cleanup
 * failure must never fail a completed update. `runner` is an injection seam
 * for tests (mirrors installCommand).
 */
export function runV4CleanupSafe(runner: typeof cleanupV4 = cleanupV4): void {
  try {
    runner();
  } catch {
    /* post-swap must never fail the update */
  }
}

/**
 * Agent-sync phase — converge the selected Claude/Hermes surfaces from the
 * canonical source root. Codex product skills are plugin-owned, and managed
 * Codex roles run only through an explicit setup-authorized callback.
 *
 * Non-fatal by default — an engine failure becomes a single advisory line.
 * The `~/.genie/.last-agent-sync` throttle marker is refreshed only after all
 * surfaces authorized for this invocation converge without a reported failure;
 * partial work therefore remains immediately retryable.
 *
 * `sync` / `log` / `markerPath` / `now` are injection seams (mirrors
 * runV4CleanupSafe) so the wiring is unit-testable without
 * touching a real home directory.
 */
export interface RunAgentSyncSafeOptions {
  /** Test seam: replaces the real agent-sync engine call. */
  sync?: typeof runAgentSync;
  /** Test seam: sink for the compact summary; defaults to the module `log`. */
  log?: (line: string) => void;
  /** Throttle marker path; defaults to `<GENIE_HOME>/.last-agent-sync`. */
  markerPath?: string;
  /** Injectable clock for the marker timestamp. */
  now?: () => Date;
  /**
   * Explicit setup-only seam for managed Codex role convergence. Ordinary
   * install/update callers omit it, so role mutation is structurally absent.
   */
  codexRefresh?: () => CodexAgentInstallResult | null;
  /** Explicit lifecycle commands fail instead of converting convergence errors to warnings. */
  strict?: boolean;
  selection?: AgentSyncSelection;
}

export function runAgentSyncSafe(opts: RunAgentSyncSafeOptions = {}): AgentSyncReport | null {
  const emit = opts.log ?? log;
  let successful = false;
  try {
    const report = (opts.sync ?? runAgentSync)({ selection: opts.selection });
    for (const line of formatAgentSyncSummary(report)) emit(line);
    const roleError = opts.codexRefresh ? refreshCodexIntegrationsSafe(report, emit, opts.codexRefresh) : null;
    const failures = report.agents.flatMap((agent) => agent.failures ?? []);
    if (report.source.pluginRoot === null) failures.push('no Genie plugin source was available');
    if (report.skipped) failures.push(report.skipped);
    if (roleError) failures.push(roleError);
    if (opts.strict && failures.length > 0) throw new Error(failures.join('; '));
    successful = failures.length === 0;
    if (successful) {
      touchAgentSyncMarker(opts.markerPath ?? join(GENIE_HOME, '.last-agent-sync'), (opts.now ?? (() => new Date()))());
    }
    return report;
  } catch (err) {
    emit(`agent sync failed: ${errMsg(err)} — will retry on the next genie update`);
    if (opts.strict) throw err;
    return null;
  }
}

/**
 * Explicit managed-role convergence seam. Delivery/update callers never
 * provide it; setup may do so only after its matching-record and authorization
 * gates. The sync engine must have observed Codex, and lock-skipped runs never
 * invoke the callback. Failures remain retryable and strict-visible.
 */
function refreshCodexIntegrationsSafe(
  report: AgentSyncReport,
  emit: (line: string) => void,
  refresh: () => CodexAgentInstallResult | null,
): string | null {
  if (report.skipped || !report.agents.some((agent) => agent.agent === 'codex' && agent.detected)) return null;
  try {
    const result = refresh();
    if (result === null) return 'Codex role-agent bundle is unavailable';
    const parts = [`${result.installed} role-agent TOMLs refreshed`];
    if (result.backedUp.length > 0) parts.push(`${result.backedUp.length} user-tuned backed up`);
    if (result.skippedUserOwned.length > 0) parts.push(`${result.skippedUserOwned.length} user-owned kept`);
    emit(`agent-sync: codex — ${parts.join(', ')}`);
    return null;
  } catch (err) {
    const failure = `agent-sync: codex role-agent refresh failed: ${errMsg(err)} — will retry on the next genie update`;
    emit(failure);
    return failure;
  }
}

/** Compact per-agent summary: detected + counts by action + advisories. */
function formatAgentSyncSummary(report: AgentSyncReport): string[] {
  if (report.source.pluginRoot === null) {
    return ['agent-sync: no genie plugin source found (plugins/genie); skipped'];
  }
  if (report.skipped) return [`agent-sync: ${report.skipped}`];
  const lines: string[] = [];
  for (const agent of report.agents) {
    if (!agent.detected) {
      lines.push(`agent-sync: ${agent.agent} not detected — skipped`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const skill of agent.skills) counts.set(skill.action, (counts.get(skill.action) ?? 0) + 1);
    const parts = [...counts.entries()].map(([action, n]) => `${action} ${n}`);
    for (const extra of agent.extras) parts.push(`${extra.kind} ${extra.action}`);
    lines.push(`agent-sync: ${agent.agent} — ${parts.join(', ') || 'no changes'}`);
    for (const advisory of agent.advisories) lines.push(`  ${agent.agent}: ${advisory}`);
  }
  if (report.backupsDir !== null) lines.push(`agent-sync: backups saved to ${report.backupsDir}`);
  return lines;
}

/** Best-effort refresh of the SessionStart-hook throttle marker (ISO string). */
function touchAgentSyncMarker(markerPath: string, now: Date): void {
  try {
    writeFileSync(markerPath, `${now.toISOString()}\n`);
  } catch {
    // the marker only optimizes the hook throttle; never fail the sync over it.
  }
}

/**
 * Canonical operator-driven convergence routine. After delivery it runs only
 * inside the fresh binary's explicit `--post-delivery-converge` mode; already-
 * current and blocked-downgrade paths can call it in-process. Never launch a
 * fresh binary with an ambiguous plain `update` or environment-only marker —
 * that caused the 2026-07-11 downgrade→unattended-upgrade cascade.
 */
export interface ManualUpdateConvergenceOptions {
  expectedVersion: string;
  bundleRoot?: string;
  runSync?: () => void;
  refreshPlugins?: (options: RefreshUpdatePluginsOptions) => IntegrationResult[];
  log?: (line: string) => void;
  /** Persisted operator scope; explicit Codex authority is written only by setup. */
  selection?: IntegrationSelection;
}

export interface ManualUpdateConvergenceResult {
  integrations: IntegrationResult[];
}

export function runManualUpdateConvergence(options: ManualUpdateConvergenceOptions): ManualUpdateConvergenceResult {
  const emit = options.log ?? log;
  const selection = options.selection ?? readIntegrationConsent(GENIE_HOME);
  if (selection === 'none') return { integrations: [] };
  // `runAgentSync` has no codex arm, so it structurally never writes Codex
  // product skills or roles. A full update passes the real non-Codex selection
  // through so auto/all still converge Claude + Hermes.
  const agentSyncSelection = narrowUpdateAgentSyncSelection(selection);
  if (agentSyncSelection !== null) {
    (options.runSync ?? (() => runUpdateAgentSync(agentSyncSelection)))();
  }
  const pluginSelection = narrowUpdatePluginRefreshSelection(selection);
  const integrations =
    pluginSelection === null
      ? []
      : (options.refreshPlugins ?? refreshUpdatePlugins)({
          bundleRoot: options.bundleRoot ?? GENIE_HOME,
          expectedVersion: options.expectedVersion,
          selection: pluginSelection,
        }).filter((result) => result.runtime !== 'codex');
  for (const result of integrations) {
    const disabled = result.preservedDisabled ? '; disabled state preserved' : '';
    emit(
      `integration refresh: ${result.runtime} — ${result.ok ? result.detail : `FAILED: ${result.detail}`}${disabled}`,
    );
  }
  return { integrations };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function currentUpdateUid(): bigint {
  if (process.getuid === undefined) throw new Error('private update staging requires a POSIX user identity');
  return BigInt(process.getuid());
}

function sameDirectoryObject(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid
  );
}

function assertTrustedUpdateTempParent(stat: BigIntStats, path: string): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 1n) {
    throw new Error(`update temp parent is not a physical directory: ${path}`);
  }
  const permissions = Number(stat.mode & 0o7777n);
  const nonWritableByOtherPrincipals = (permissions & 0o022) === 0;
  const rootSticky = stat.uid === 0n && (permissions & 0o1000) !== 0;
  if (!nonWritableByOtherPrincipals && !rootSticky) {
    throw new Error(`update temp parent permits unsafe cross-principal replacement: ${path}`);
  }
}

function assertPrivateUpdateTempRoot(path: string): void {
  const stat = lstatSync(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== currentUpdateUid() ||
    stat.nlink < 1n ||
    (stat.mode & 0o777n) !== 0o700n
  ) {
    throw new Error(`update temp root is not an owned physical mode-0700 directory: ${path}`);
  }
}

/** Create private external download/extraction staging without touching GENIE_HOME. */
export function createPrivateUpdateTempRoot(baseDir = tmpdir()): string {
  const base = resolve(baseDir);
  const namespaceParent = dirname(base);
  const namespaceFd = openSync(namespaceParent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let parentFd: number | null = null;
  try {
    assertTrustedUpdateTempParent(fstatSync(namespaceFd, { bigint: true }), namespaceParent);
    parentFd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const heldParent = fstatSync(parentFd, { bigint: true });
    assertTrustedUpdateTempParent(heldParent, base);
    const root = mkdtempSync(join(base, 'genie-update-'));
    chmodSync(root, 0o700);
    assertPrivateUpdateTempRoot(root);
    const visibleParentFd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameDirectoryObject(heldParent, fstatSync(visibleParentFd, { bigint: true }))) {
        throw new Error('update temp parent changed while private staging was created');
      }
    } finally {
      closeSync(visibleParentFd);
    }
    return root;
  } finally {
    if (parentFd !== null) closeSync(parentFd);
    closeSync(namespaceFd);
  }
}

/**
 * Tarball delivery + binary swap. Linear flow extracted from `updateCommand`
 * to keep the command body readable: download → verify → extract → swap →
 * sync aux content → clean staging.
 */
/**
 * Parent-side attestation (deliverable 4/5): after the binary is delivered and
 * the payload is synced into GENIE_HOME, publish the exact delivery facts through
 * A's `publishDelivery` under the held lease, using OBSERVED reality — the
 * installed generation N from a live `codex plugin list` and the delivered T +
 * digest from a physical scan of the delivered tree (never the raw manifest).
 * When the delivery is pending (N ≠ T) and the prior binary is a protocol-1+
 * backup, also publish its digest-bound rollback capability sidecar. A pre-
 * contract backup gets NO sidecar, which makes the rollback capability floor
 * refuse to restore it. Once Codex is in scope, inability to observe or publish
 * the complete binding is terminal and must surface as delivery-incomplete.
 */
type DeliveryPublicationCompletion =
  | { kind: 'not-in-scope' }
  | { kind: 'matching' | 'published'; deliveryId: string }
  | { kind: 'incomplete'; detail: string };

export class CodexDeliveryPublicationError extends Error {
  constructor(detail: string) {
    super(`authenticated Codex delivery publication incomplete: ${detail}`);
    this.name = 'CodexDeliveryPublicationError';
  }
}

function publishCodexDeliveryFacts(
  previousBackup: string | null,
  lease: HeldLifecycleLease,
  evidence: VerifiedDeliveryEvidence,
  deliveryRoot: string,
): DeliveryPublicationCompletion {
  const selection = readIntegrationConsent(GENIE_HOME);
  if (selection === 'none' || selection === 'claude') return { kind: 'not-in-scope' };
  let command: string | null = null;
  try {
    command = resolveRuntimeExecutable('codex', process.cwd());
  } catch {
    command = null;
  }
  if (command === null) {
    return selection === 'auto'
      ? { kind: 'not-in-scope' }
      : { kind: 'incomplete', detail: 'Codex was explicitly selected but its executable is unavailable' };
  }
  const snapshot = observeCodexActivation({ genieHome: GENIE_HOME, command });
  if (snapshot.canonical.status !== 'ok') {
    return { kind: 'incomplete', detail: `canonical payload observation failed: ${snapshot.canonical.detail}` };
  }
  if (snapshot.query.status !== 'ok') {
    return { kind: 'incomplete', detail: `Codex registration observation failed: ${snapshot.query.detail}` };
  }
  const registration = snapshot.query.registration;
  const installedVersion = registration.present && registration.version ? registration.version.canonical : null;
  const store = openCodexActivationStore({ genieHome: GENIE_HOME });
  const published = publishCodexDelivery({
    lease,
    store,
    installedVersion,
    evidence,
    deliveryRoot,
    // Group E: a current-N delivery with a STALE record republishes (a matching
    // record never does) — same fresh-host/converged-host truth as install.
    existingRecord: snapshotDeliveryReadState(snapshot),
  });
  if ((published.outcome === 'published' || published.outcome === 'matching') && previousBackup !== null) {
    publishBackupSidecarIfProtocolCapable(previousBackup, published.record.deliveryId);
  }
  if (published.outcome === 'published' || published.outcome === 'matching') {
    return { kind: published.outcome, deliveryId: published.record.deliveryId };
  }
  return { kind: 'incomplete', detail: published.detail };
}

/**
 * Publish the rollback capability sidecar ONLY when the backup binary itself
 * proves protocol-1+ via its no-shell probe. A pre-contract backup (unknown
 * flag ⇒ nonzero/unparsable probe) or a sub-floor protocol yields NO sidecar, so
 * `enforceRollbackCapabilityFloor` later refuses to restore it — the explicit
 * first-fixed→pre-contract rollback refusal.
 */
function publishBackupSidecarIfProtocolCapable(backupPath: string, deliveryId: string): void {
  const probe = runBackupCapabilityProbe(backupPath);
  if (probe.status !== 'ok' || probe.report === undefined) return;
  if (probe.report.codexActivationProtocol < CODEX_ACTIVATION_PROTOCOL) return;
  try {
    publishBackupCapabilitySidecar({
      backupBinaryPath: backupPath,
      expectedPreviousVersion: probe.report.reportedVersion,
      deliveryId,
    });
  } catch {
    // Best-effort: a missing sidecar only means rollback refuses this backup.
  }
}

async function runDelivery(
  manifest: LatestManifest,
  platform: string,
  diagnosticsCtx: UpdateDiagnosticsContext,
  codexLease: HeldLifecycleLease,
  dependencies: UpdateCommandDependencies = {},
): Promise<AuxiliaryTreeOutcome[]> {
  const externalRoot = createPrivateUpdateTempRoot();
  const extractedRoot = join(externalRoot, 'release-payload');
  mkdirSync(extractedRoot, { mode: 0o700 });
  chmodSync(extractedRoot, 0o700);
  assertPrivateUpdateTempRoot(extractedRoot);
  let admitted: InstallStagingDirectoryGuard | null = null;
  let promotionComplete = false;
  log('Downloading signed tarball from GitHub Releases...');
  const downloaded = await (dependencies.downloadDeliveryAssets ?? downloadAndVerifyDeliveryAssets)(
    manifest,
    platform,
    externalRoot,
  );
  const { tarballPath } = downloaded;
  const artifactSha256 = hashFileSha256(tarballPath);
  if (artifactSha256 === null) throw new Error('verified tarball became unreadable before delivery');
  diagnosticsCtx.tarballPath = tarballPath;
  diagnosticsCtx.attestationVerified = true;
  success(`Verified signed tarball for ${tarballPath.split('/').pop()}`);

  log('Extracting exact release payload...');
  await extractTarball(tarballPath, extractedRoot);
  // tar restores the archived root "./" entry's recorded mode (0755 on every
  // published tarball) onto extractedRoot, clobbering the 0700 it was created
  // with. admitExternalInstallStaging -> verifyPayloadLayout asserts the
  // staging root is *exactly* 0700, so relock the private extraction sandbox
  // before admission. This normalizes only our own staging root.
  chmodSync(extractedRoot, 0o700);
  assertPrivateUpdateTempRoot(extractedRoot);
  const candidate = proveExtractedDeliveryCandidate(extractedRoot);
  if (candidate.version !== normalizeVersion(manifest.version)) {
    throw new Error(
      `candidate version ${candidate.version} differs from selected ${normalizeVersion(manifest.version)}`,
    );
  }
  const evidence = verifyDownloadedDeliveryEvidence(
    {
      descriptorBytes: downloaded.descriptorBytes,
      bundleBytes: downloaded.bundleBytes,
      manifestBytes: manifest.manifestBytes,
      targetVersion: candidate.version,
      channel: manifest.channel as DeliveryEvidenceChannel,
      platformId: platform as DeliveryEvidencePlatformId,
      platformTriple: `${process.platform}-${process.arch}`,
      releaseTag: `v${normalizeVersion(manifest.version)}`,
      releaseName: `genie-${normalizeVersion(manifest.version)}-${platform}.tar.gz`,
      artifactSha256,
      installedBinarySha256: candidate.binarySha256,
      canonicalPayloadSha256: candidate.pluginTreeSha256,
    },
    dependencies.evidenceVerification,
  );

  log('Promoting verified release generation...');
  codexLease.assertOperation(codexLease.operationId);
  recoverPendingInstallPromotions({ genieHome: GENIE_HOME });
  admitted = admitExternalInstallStaging({
    genieHome: GENIE_HOME,
    externalStagingRoot: extractedRoot,
    expectedVersion: manifest.version,
  });
  try {
    verifyAdmittedInstallStagingPayload(admitted);
    codexLease.assertOperation(codexLease.operationId);
    const promotion = promoteStagedInstall({
      genieHome: GENIE_HOME,
      stagingRoot: admitted.stagingRoot,
      expectedVersion: manifest.version,
      dependencies: {
        beforeRename: () => verifyInstallStagingDirectory(admitted as InstallStagingDirectoryGuard),
      },
      verifyVersion: ({ binaryPath, expectedVersion, phase }) => {
        verifyInstallStagingDirectory(admitted as InstallStagingDirectoryGuard);
        if (phase === 'staged') {
          verifyAdmittedInstallStagingPayload(admitted as InstallStagingDirectoryGuard);
        }
        if (expectedVersion === null) return false;
        try {
          const output = execFileSync(binaryPath, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 30_000,
          });
          const reported = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/)?.[0];
          return reported !== undefined && normalizeVersion(reported) === normalizeVersion(expectedVersion);
        } catch {
          return false;
        }
      },
    });
    promotionComplete = true;
    diagnosticsCtx.previousBackup = promotion.priorBinaryPath ?? null;
    success(`Genie release generation updated → v${manifest.version}`);

    // Post-swap divergence guard: ~/.genie/bin/genie now holds the new
    // binary, but if $PATH resolves `genie` to a different file (a pre-G5
    // copy or a shadowing shim) the user keeps running the old version and
    // would never escape the update prompt. Measure the actual outcome and
    // tell them exactly how to fix it rather than silently "succeeding".
    //
    // Suppression: when `live` and `canonical` resolve to the same file, a
    // version mismatch is upstream swap corruption (already caught by the
    // staged-promotion version verification above), not a PATH problem. The legacy heuristic
    // generated `ln -sf canonical canonical` — a useless self-symlink. See
    // shouldEmitPathDivergenceWarning for the full rule set.
    try {
      const live = resolveLiveBinaryPath();
      if (live) {
        let liveVer: string | null = null;
        try {
          liveVer =
            execFileSync(live, ['--version'], { encoding: 'utf-8', timeout: 3000 })
              .trim()
              .match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/)?.[0] ?? null;
        } catch {
          // unknowable — skip the advisory
        }
        const canonical = join(GENIE_BIN, 'genie');
        let canonicalReal = canonical;
        try {
          canonicalReal = realpathSync(canonical);
        } catch {
          // canonical may not be a symlink — keep as-is
        }
        const emit = shouldEmitPathDivergenceWarning({
          live,
          canonical,
          canonicalReal,
          liveVersion: liveVer,
          intendedVersion: manifest.version,
        });
        if (emit) {
          log('');
          log('⚠ Your PATH `genie` is NOT the binary that was just updated.');
          log(`  Updated    : ${canonical} → v${manifest.version}`);
          log(`  which genie: ${live} (still v${liveVer ?? 'unknown'})`);
          log('  Fix it:');
          log(`    ln -sf ${canonical} ${live} && hash -r`);
          log('  (or put ~/.genie/bin first on $PATH)');
        }
      }
    } catch {
      // advisory only — never fail the update for this
    }

    const auxiliaryOutcomes = syncAuxiliaryContent(GENIE_BIN, GENIE_HOME, undefined, true);
    finalizeAuxiliaryDelivery(auxiliaryOutcomes, {
      writeVersion: () => {
        // This stamp follows verified content convergence. It is never used as
        // a substitute for per-tree digest comparison, and a failed stamp keeps
        // the durable transaction retryable.
        writeFileSync(join(GENIE_HOME, 'VERSION'), `${manifest.version}\n`);
      },
      cleanupExtraction: () => {
        cleanupStagingArtifacts(externalRoot, tarballPath);
      },
    });
    // The payload is now in GENIE_HOME; publish attested delivery facts (and the
    // rollback sidecar for a protocol-capable backup) under the held lease.
    const deliveryRoot = resolveCanonicalPayloadRoot();
    const installedBinarySha256 = hashFileSha256(join(GENIE_BIN, 'genie'));
    if (deliveryRoot === null || installedBinarySha256 === null) {
      throw new CodexDeliveryPublicationError('installed delivery root/binary could not be bound');
    }
    if (installedBinarySha256 !== candidate.binarySha256) {
      throw new CodexDeliveryPublicationError('installed binary differs from the verified delivery evidence');
    }
    let publication: DeliveryPublicationCompletion;
    try {
      publication = publishCodexDeliveryFacts(
        diagnosticsCtx.previousBackup,
        codexLease,
        evidence,
        realpathSync(deliveryRoot),
      );
    } catch (cause) {
      throw new CodexDeliveryPublicationError(`delivery record publication failed: ${errMsg(cause)}`);
    }
    if (publication.kind === 'incomplete') throw new CodexDeliveryPublicationError(publication.detail);
    return auxiliaryOutcomes;
  } finally {
    // The command boundary owns both lifecycle leases. This scope only closes
    // admitted staging; the caller releases Codex first, then agent-sync.
    if (admitted !== null) {
      try {
        if (promotionComplete) removeInstallStagingDirectory(admitted);
      } finally {
        closeInstallStagingDirectory(admitted);
      }
    }
  }
}

interface PendingFileFingerprint {
  sha256: string;
  mode: number;
}

interface PendingOptionalFileFingerprint {
  present: boolean;
  fingerprint: PendingFileFingerprint | null;
}

interface PendingAuxiliaryFingerprint {
  name: AuxiliaryDeliveryTreeName;
  present: boolean;
  digest: string | null;
}

export interface PendingDeliveryRecord {
  schemaVersion: 2 | 3 | 4;
  version: string;
  /** Version of the live binary whose same-version backups recovery may prune. */
  previousVersion: string | null;
  extractDir: string;
  tarballPath: string;
  createdAt: string;
  payload: {
    binary: PendingFileFingerprint;
    /** Authentic pre-swap executable identity; absent for legacy journals. */
    previousBinary?: PendingOptionalFileFingerprint;
    versionStamp: PendingOptionalFileFingerprint;
    tarball: PendingFileFingerprint;
    auxiliary: PendingAuxiliaryFingerprint[];
  };
}

interface PendingDeliveryPaths {
  version: string;
  extractDir: string;
  tarballPath: string;
  previousVersion?: string | null;
  /** Live target fingerprinted before the pending journal is published. */
  previousBinaryPath?: string;
}

export interface ResumePendingDeliveryOptions {
  genieHome?: string;
  genieBin?: string;
  stagingRoot?: string;
  pendingPath?: string;
}

/**
 * Read and revalidate legacy pending-delivery evidence, but never replay it.
 * Only the install-promotion journal can authorize release mutation now.
 */
export function resumePendingDelivery(options: ResumePendingDeliveryOptions = {}): boolean {
  const genieHome = options.genieHome ?? GENIE_HOME;
  const genieBin = options.genieBin ?? join(genieHome, 'bin');
  const stagingRoot = options.stagingRoot ?? join(genieBin, '.staging');
  const pendingPath = options.pendingPath ?? join(genieHome, PENDING_DELIVERY_NAME);
  const record = readPendingDelivery(pendingPath, stagingRoot);
  if (record === null) return false;

  // Revalidate all retained artifacts before reporting the actionable stop.
  revalidatePendingPayload(record);
  throw new Error(
    `legacy pending delivery is retained read-only at ${pendingPath}; its executable transaction cannot authenticate an exact genie+VERSION generation. Inspect the retained artifacts, relocate the legacy journal, and rerun \`genie update\` for a signed install`,
  );
}

function readPendingDelivery(path: string, stagingRoot: string): PendingDeliveryRecord | null {
  let bytes: Buffer;
  try {
    bytes = readPrivatePhysicalFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`pending delivery journal is unreadable: ${errMsg(error)}`);
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    ![2, 3, 4].includes(Number(Reflect.get(parsed, 'schemaVersion'))) ||
    typeof Reflect.get(parsed, 'version') !== 'string' ||
    ([3, 4].includes(Number(Reflect.get(parsed, 'schemaVersion'))) &&
      (typeof Reflect.get(parsed, 'previousVersion') !== 'string' ||
        parseGenieVersion(Reflect.get(parsed, 'previousVersion') as string) === null)) ||
    typeof Reflect.get(parsed, 'extractDir') !== 'string' ||
    typeof Reflect.get(parsed, 'tarballPath') !== 'string' ||
    typeof Reflect.get(parsed, 'createdAt') !== 'string' ||
    !isPendingPayloadFingerprint(Reflect.get(parsed, 'payload')) ||
    (Reflect.get(parsed, 'schemaVersion') === 4 &&
      !isOptionalFileFingerprint(Reflect.get(Reflect.get(parsed, 'payload') as object, 'previousBinary')))
  ) {
    throw new Error('pending delivery journal has an invalid schema');
  }
  const record = {
    ...(parsed as PendingDeliveryRecord),
    previousVersion: [3, 4].includes(Number(Reflect.get(parsed, 'schemaVersion')))
      ? (Reflect.get(parsed, 'previousVersion') as string)
      : null,
  };
  assertPendingDeliveryPaths(record, stagingRoot);
  return record;
}

function assertPendingDeliveryPaths(pending: PendingDeliveryPaths, stagingRoot: string): void {
  if (parseGenieVersion(pending.version) === null)
    throw new Error(`invalid pending delivery version: ${pending.version}`);
  if (pending.previousVersion != null && parseGenieVersion(pending.previousVersion) === null) {
    throw new Error(`invalid pending delivery previous version: ${pending.previousVersion}`);
  }
  let physicalStagingRoot: string;
  try {
    const stagingStat = lstatSync(stagingRoot);
    if (!stagingStat.isDirectory() || stagingStat.isSymbolicLink()) throw new Error('not a physical directory');
    physicalStagingRoot = realpathSync(stagingRoot);
  } catch (error) {
    throw new Error(`pending delivery staging root is unavailable: ${stagingRoot} (${errMsg(error)})`);
  }
  for (const [label, path] of [
    ['extractDir', pending.extractDir],
    ['tarballPath', pending.tarballPath],
  ] as const) {
    const rel = relative(resolve(stagingRoot), resolve(path));
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`pending delivery ${label} escapes staging root: ${path}`);
    }
    let physicalPath: string;
    try {
      const pathStat = lstatSync(path);
      const expectedKind = label === 'extractDir' ? pathStat.isDirectory() : pathStat.isFile();
      if (!expectedKind || pathStat.isSymbolicLink()) throw new Error('wrong physical entry type');
      physicalPath = realpathSync(path);
    } catch (error) {
      throw new Error(`pending delivery ${label} is unavailable: ${path} (${errMsg(error)})`);
    }
    const physicalRel = relative(physicalStagingRoot, physicalPath);
    if (physicalRel === '' || physicalRel === '..' || physicalRel.startsWith(`..${sep}`) || isAbsolute(physicalRel)) {
      throw new Error(`pending delivery ${label} escapes physical staging root: ${path}`);
    }
  }
}

const PENDING_FILE_HASH_BUFFER_BYTES = 1024 * 1024;

/** Hash a physical file with a fixed-size buffer instead of retaining release-sized bytes in RSS. */
export function hashPhysicalFileIncrementally(path: string, bufferBytes = PENDING_FILE_HASH_BUFFER_BYTES): string {
  if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1 || bufferBytes > 8 * 1024 * 1024) {
    throw new Error(`invalid incremental hash buffer size: ${bufferBytes}`);
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(bufferBytes);
  const fd = openSync(path, 'r');
  try {
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
}

function fingerprintPhysicalFile(path: string, label: string): PendingFileFingerprint {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    throw new Error(`pending delivery ${label} is unavailable: ${path} (${errMsg(error)})`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`pending delivery ${label} is not a physical file: ${path}`);
  }
  return {
    sha256: hashPhysicalFileIncrementally(path),
    mode: stat.mode & 0o7777,
  };
}

function fingerprintOptionalPhysicalFile(path: string, label: string): PendingOptionalFileFingerprint {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, fingerprint: null };
    throw new Error(`pending delivery ${label} is unavailable: ${path} (${errMsg(error)})`);
  }
  return { present: true, fingerprint: fingerprintPhysicalFile(path, label) };
}

function fingerprintPendingAuxiliary(extractDir: string): PendingAuxiliaryFingerprint[] {
  return AUXILIARY_DELIVERY_TREE_NAMES.map((name) => {
    const path = join(extractDir, name);
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { name, present: false, digest: null };
      throw new Error(`pending delivery auxiliary tree is unavailable: ${path} (${errMsg(error)})`);
    }
    return { name, present: true, digest: fingerprintAuxiliaryTree(path) };
  });
}

function fingerprintPendingPayload(pending: PendingDeliveryPaths): PendingDeliveryRecord['payload'] {
  return {
    binary: fingerprintPhysicalFile(join(pending.extractDir, 'genie'), 'binary'),
    versionStamp: fingerprintOptionalPhysicalFile(join(pending.extractDir, 'VERSION'), 'VERSION stamp'),
    tarball: fingerprintPhysicalFile(pending.tarballPath, 'tarball'),
    auxiliary: fingerprintPendingAuxiliary(pending.extractDir),
  };
}

function fingerprintsEqual(left: PendingFileFingerprint, right: PendingFileFingerprint): boolean {
  return left.sha256 === right.sha256 && left.mode === right.mode;
}

function revalidatePendingPayload(record: PendingDeliveryRecord): void {
  const actual = fingerprintPendingPayload(record);
  const mismatches: string[] = [];
  if (!fingerprintsEqual(actual.binary, record.payload.binary)) mismatches.push('binary');
  if (
    actual.versionStamp.present !== record.payload.versionStamp.present ||
    (actual.versionStamp.present &&
      actual.versionStamp.fingerprint !== null &&
      record.payload.versionStamp.fingerprint !== null &&
      !fingerprintsEqual(actual.versionStamp.fingerprint, record.payload.versionStamp.fingerprint))
  ) {
    mismatches.push('VERSION stamp');
  }
  if (!fingerprintsEqual(actual.tarball, record.payload.tarball)) mismatches.push('tarball');
  for (const expected of record.payload.auxiliary) {
    const observed = actual.auxiliary.find((entry) => entry.name === expected.name);
    if (observed === undefined || observed.present !== expected.present || observed.digest !== expected.digest) {
      mismatches.push(`${expected.name}/`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`pending delivery payload fingerprint mismatch: ${mismatches.join(', ')}`);
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isFileFingerprint(value: unknown): value is PendingFileFingerprint {
  return (
    typeof value === 'object' &&
    value !== null &&
    isSha256(Reflect.get(value, 'sha256')) &&
    Number.isInteger(Reflect.get(value, 'mode')) &&
    (Reflect.get(value, 'mode') as number) >= 0 &&
    (Reflect.get(value, 'mode') as number) <= 0o7777
  );
}

function isOptionalFileFingerprint(value: unknown): value is PendingOptionalFileFingerprint {
  if (typeof value !== 'object' || value === null || typeof Reflect.get(value, 'present') !== 'boolean') return false;
  const present = Reflect.get(value, 'present');
  const fingerprint = Reflect.get(value, 'fingerprint');
  return present ? isFileFingerprint(fingerprint) : fingerprint === null;
}

function isPendingPayloadFingerprint(value: unknown): value is PendingDeliveryRecord['payload'] {
  if (typeof value !== 'object' || value === null) return false;
  const auxiliary = Reflect.get(value, 'auxiliary');
  if (
    !isFileFingerprint(Reflect.get(value, 'binary')) ||
    !isOptionalFileFingerprint(Reflect.get(value, 'versionStamp')) ||
    !isFileFingerprint(Reflect.get(value, 'tarball')) ||
    !Array.isArray(auxiliary) ||
    auxiliary.length !== AUXILIARY_DELIVERY_TREE_NAMES.length
  ) {
    return false;
  }
  return AUXILIARY_DELIVERY_TREE_NAMES.every((name) => {
    const entries = auxiliary.filter((entry) => typeof entry === 'object' && entry !== null && entry.name === name);
    if (entries.length !== 1) return false;
    const entry = entries[0];
    return typeof entry.present === 'boolean' && (entry.present ? isSha256(entry.digest) : entry.digest === null);
  });
}

export interface AuxiliaryDeliveryFinalizers {
  writeVersion: () => void;
  cleanupExtraction: () => void;
}

/** Never stamp or remove recovery material while any tree is unverified. */
export function finalizeAuxiliaryDelivery(
  outcomes: AuxiliaryTreeOutcome[],
  finalizers: AuxiliaryDeliveryFinalizers,
): void {
  const failures = outcomes.filter((outcome) => outcome.status === 'failed');
  if (failures.length > 0) {
    throw new Error(
      `auxiliary payload convergence failed: ${failures
        .map((outcome) => {
          const fresh = outcome.freshArtifact ? `; verified fresh: ${outcome.freshArtifact}` : '';
          return `${outcome.label} (${outcome.stage}${fresh})`;
        })
        .join(', ')}`,
    );
  }
  finalizers.writeVersion();
  finalizers.cleanupExtraction();
}

function cleanupStagingArtifacts(extractDir: string, tarballPath: string): void {
  try {
    rmSync(extractDir, { recursive: true, force: true });
    rmSync(tarballPath);
    const sidecarBundle = `${tarballPath}.bundle`;
    const sidecarIntoto = `${tarballPath}.intoto.jsonl`;
    if (existsSync(sidecarBundle)) rmSync(sidecarBundle);
    if (existsSync(sidecarIntoto)) rmSync(sidecarIntoto);
  } catch {
    // best-effort
  }
}

/**
 * Mirror plugins/, skills/, templates/ plus the marketplace-manifest dirs
 * (`.agents/`, `.claude-plugin/` — must sit beside plugins/ so their relative
 * `./plugins/genie` payload references stay truthful; mirrors AUX_LAYOUT_DIRS
 * in install.ts) from the extracted tarball into `~/.genie/`. Stage to a
 * sibling `<dest>.new` directory and promote it with same-filesystem renames.
 * The previous live tree is retained until the fresh tree is verified. Portable
 * Node filesystem APIs do not provide an atomic non-empty directory exchange;
 * the pending-delivery journal therefore preserves retry/recovery evidence but
 * does not claim cross-process generation atomicity.
 *
 * Every present tree returns a structured outcome. A failed outcome blocks
 * VERSION stamping and extraction cleanup so the verified source remains
 * available for diagnosis and retry. Tarballs predating a tree skip it.
 */
export function syncAuxiliaryContent(
  extractDir: string,
  genieHome = GENIE_HOME,
  operations?: Partial<AuxiliaryTreeOperations>,
  removeSourceOnSuccess = false,
): AuxiliaryTreeOutcome[] {
  const targets: Array<{ src: string; dest: string; label: string }> = [
    { src: join(extractDir, 'plugins'), dest: join(genieHome, 'plugins'), label: 'plugins' },
    { src: join(extractDir, 'skills'), dest: join(genieHome, 'skills'), label: 'skills' },
    { src: join(extractDir, 'templates'), dest: join(genieHome, 'templates'), label: 'templates' },
    { src: join(extractDir, '.agents'), dest: join(genieHome, '.agents'), label: '.agents' },
    { src: join(extractDir, '.claude-plugin'), dest: join(genieHome, '.claude-plugin'), label: '.claude-plugin' },
  ];
  const outcomes = targets.map((target) =>
    convergeAuxiliaryTree({
      label: target.label,
      source: target.src,
      destination: target.dest,
      removeSourceOnSuccess,
      excludedEntryNames: FRAMEWORK_MARKER_FILES,
      operations,
    }),
  );
  for (const outcome of outcomes) printAuxiliaryOutcome(outcome);
  return outcomes;
}

function printAuxiliaryOutcome(outcome: AuxiliaryTreeOutcome): void {
  if (outcome.status === 'skipped') return;
  if (outcome.status === 'failed') {
    const rollback = outcome.rollbackError ? `; rollback: ${outcome.rollbackError}` : '';
    const fresh = outcome.freshArtifact
      ? `; verified fresh artifact retained at ${outcome.freshArtifact}`
      : '; no verified fresh artifact available';
    log(`Could not refresh ${outcome.label}/ at ${outcome.stage}: ${outcome.error}${rollback}${fresh}`);
    return;
  }
  const verb = outcome.status === 'unchanged' ? 'Verified current' : 'Refreshed';
  success(`${verb} ${outcome.label}/ → ${outcome.destination}`);
  for (const warning of outcome.warnings) log(`${outcome.label}/ cleanup warning: ${warning}`);
}

async function runRollback(): Promise<DeferredUpdateTerminal | null> {
  log('Checking protocol-safe rollback eligibility...');
  const result = performProtocolSafeRollback({ genieBin: GENIE_BIN, genieHome: GENIE_HOME });
  switch (result.status) {
    case 'rolled-back':
      success(`Rolled back to v${result.restoredVersion} (digest ${result.binarySha256.slice(0, 12)}…)`);
      console.log();
      return null;
    case 'busy':
      return new DeferredUpdateTerminal(
        2,
        `codex-lifecycle-busy: the ${result.holderKind ?? 'unknown'} lifecycle command holds the Codex lease; rollback refused before any exchange with zero mutation.`,
        CODEX_LIFECYCLE_BUSY_TRAILER,
        true,
      );
    case 'no-backup':
    case 'refused':
      return new DeferredUpdateTerminal(1, `Rollback refused: ${result.detail}`, undefined, true);
    case 'aborted':
      return new DeferredUpdateTerminal(
        1,
        `Rollback aborted before completion (the live binary is unchanged): ${result.detail}`,
        undefined,
        true,
      );
  }
}

/**
 * TTY confirmation prompt. Auto-confirms in non-TTY environments so CI
 * pipelines never hang waiting for stdin.
 */
async function promptConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return true;
  process.stdout.write(`${question} [Y/n] `);
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const answer = chunk.toString('utf-8').trim().toLowerCase();
      if (answer === '' || answer === 'y' || answer === 'yes') resolve(true);
      else resolve(false);
    };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

function shouldAutoConfirm(opts: { yes?: boolean }): boolean {
  if (opts.yes) return true;
  return isTruthyEnv(process.env.GENIE_UPDATE_YES);
}

// ============================================================================
// Post-update maintenance + verify orchestration.
// ============================================================================

function printDiagnosticsSummary(diagnostics: {
  path: string;
  signals: RecentLogSignal[];
  newestStaleTimestamp?: string | null;
}): void {
  log('Post-update diagnostics captured.');
  console.log(`  Report: ${diagnostics.path}`);
  console.log('  Include this file when opening a GitHub issue; it contains install metadata, step output,');
  console.log('  local process state, and recent scheduler/TUI log signals.');
  if (diagnostics.signals.length === 0) {
    if (diagnostics.newestStaleTimestamp) {
      console.log(`  No recent scheduler signals; last entry ${diagnostics.newestStaleTimestamp}`);
    }
    return;
  }
  console.log('  Recent scheduler signals:');
  for (const signal of diagnostics.signals.slice(0, 3)) {
    const errorDetail = signal.lastError ? ` — ${signal.lastError}` : '';
    console.log(`    ${signal.level}:${signal.event} ×${signal.count}${errorDetail}`);
  }
}

async function capturePostUpdateDiagnostics(
  diagnosticsCtx: UpdateDiagnosticsContext | undefined,
  maintenance: { outcome: 'completed' | 'failed'; durationMs: number; lines: string[]; error?: string },
  extras: UpdateDiagnosticsExtras,
): Promise<void> {
  if (!diagnosticsCtx) return;
  try {
    const diagnostics = await collectUpdateDiagnostics(diagnosticsCtx, maintenance, extras);
    printDiagnosticsSummary(diagnostics);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Post-update diagnostics capture failed (non-fatal): ${msg}`);
  }
}

function printVerifyBanner(result: VerifyResult): void {
  console.log();
  for (const line of formatVerifyBanner(result)) console.log(`  ${line}`);
  console.log();
}

interface MaintenanceOptions {
  skipMaintenance?: boolean;
  noRestart?: boolean;
  noVerify?: boolean;
}

/**
 * Post-delivery verify + diagnostics.
 *
 * v5 is zero-daemon: there is no post-update maintenance pass, pm2 restart, or
 * legacy-artifact cleanup — the atomic binary swap IS the update. Verification
 * re-executes the freshly-installed binary and confirms its `--version` matches
 * the release we just installed; a mismatch (or a binary that won't run) is a
 * real failure and exits non-zero. We also capture a diagnostics report for
 * issue triage.
 */
async function runPostUpdateVerifySafe(
  options: MaintenanceOptions,
  diagnosticsCtx: UpdateDiagnosticsContext,
): Promise<void> {
  let skipReason: VerifySkipReason | undefined;
  if (options.noRestart || options.skipMaintenance || isTruthyEnv(process.env.GENIE_UPDATE_SKIP_MAINTENANCE)) {
    skipReason = 'no-restart';
  } else if (options.noVerify) {
    skipReason = 'no-verify-flag';
  }

  const verify = runVerifyProbe({
    skipReason: skipReason ?? null,
    targetVersion: diagnosticsCtx.latestVersion,
  });
  printVerifyBanner(verify);

  await capturePostUpdateDiagnostics(diagnosticsCtx, { outcome: 'completed', durationMs: 0, lines: [] }, { verify });

  if (verify.kind === 'verify-failed') {
    process.exitCode = 1;
  }
}
