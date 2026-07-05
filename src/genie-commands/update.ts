import { execFileSync, execSync, spawn } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { genieConfigExists, loadGenieConfig, saveGenieConfig } from '../lib/genie-config.js';
import { VERSION } from '../lib/version.js';
import { cleanupV4 } from './legacy-v4.js';

const GENIE_HOME = process.env.GENIE_HOME || join(homedir(), '.genie');
const GENIE_BIN = join(GENIE_HOME, 'bin');
const GENIE_BIN_STAGING = join(GENIE_BIN, '.staging');
const GENIE_BIN_PREVIOUS = join(GENIE_BIN, '.previous');
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
const EXPECTED_COSIGN_IDENTITY = `^https://github.com/${RELEASES_SLUG}/.github/workflows/sign-attest.yml@`;
const EXPECTED_COSIGN_ISSUER = 'https://token.actions.githubusercontent.com';

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
  return normalizeVersion(currentVersion) === normalizeVersion(latestVersion);
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
  channel: string;
  version: string;
  released_at: string;
  tarball_base: string;
  platforms: string[];
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
      typeof parsed.version !== 'string' ||
      typeof parsed.tarball_base !== 'string' ||
      !Array.isArray(parsed.platforms)
    ) {
      return null;
    }
    return {
      schema_version: parsed.schema_version,
      channel: typeof parsed.channel === 'string' ? parsed.channel : channel,
      version: parsed.version,
      released_at: typeof parsed.released_at === 'string' ? parsed.released_at : '',
      tarball_base: parsed.tarball_base,
      platforms: parsed.platforms,
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
const COSIGN_VERIFY_TIMEOUT_MS = 30_000;

interface SignatureVerificationResult {
  method: 'gh-attestation' | 'cosign-bundle';
}

async function verifyTarballSignature(
  tarballName: string,
  tarballPath: string,
  bundlePath: string,
  runner: (cmd: string, args: string[], timeoutMs?: number) => Promise<{ success: boolean; output: string }>,
): Promise<SignatureVerificationResult> {
  const ghVerifyResult = await runner(
    'gh',
    [
      'attestation',
      'verify',
      tarballPath,
      '--repo',
      RELEASES_SLUG,
      '--cert-identity-regex',
      EXPECTED_COSIGN_IDENTITY,
      '--cert-oidc-issuer',
      EXPECTED_COSIGN_ISSUER,
    ],
    ATTESTATION_VERIFY_TIMEOUT_MS,
  );
  if (ghVerifyResult.success) return { method: 'gh-attestation' };

  const failures = [
    `gh attestation verify: ${ghVerifyResult.output.trim() || `failed after ${ATTESTATION_VERIFY_TIMEOUT_MS}ms`}`,
  ];

  if (!existsSync(bundlePath)) {
    failures.push(`cosign verify-blob: missing bundle ${bundlePath}`);
    throw new Error(`signature verification failed for ${tarballName}: ${failures.join('; ')}`);
  }

  const cosignVerifyResult = await runner(
    'cosign',
    [
      'verify-blob',
      '--bundle',
      bundlePath,
      '--certificate-identity-regexp',
      EXPECTED_COSIGN_IDENTITY,
      '--certificate-oidc-issuer',
      EXPECTED_COSIGN_ISSUER,
      tarballPath,
    ],
    COSIGN_VERIFY_TIMEOUT_MS,
  );
  if (cosignVerifyResult.success) return { method: 'cosign-bundle' };

  failures.push(`cosign verify-blob: ${cosignVerifyResult.output.trim() || 'no output'}`);
  throw new Error(`signature verification failed for ${tarballName}: ${failures.join('; ')}`);
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
  const bundlePath = `${tarballPath}.bundle`;

  // gh release download retries by name; --pattern lets us pull the tarball
  // and its sidecar (.bundle, .intoto.jsonl) in one shot via wildcards.
  const downloadResult = await runner('gh', [
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
    '--clobber',
  ]);
  if (!downloadResult.success) {
    throw new Error(
      `gh release download ${versionTag} failed for ${platform}: ${downloadResult.output.trim() || 'no output'}`,
    );
  }
  if (!existsSync(tarballPath)) {
    throw new Error(`gh release download succeeded but ${tarballPath} is missing`);
  }

  if (!opts.skipAttestation) {
    await verifyTarballSignature(tarballName, tarballPath, bundlePath, runner);
  }

  return tarballPath;
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

/**
 * Inode/device id of the directory that contains `path`. Returns `null` if
 * `path` (or its parent) does not exist. Used by the atomic-swap pre-flight
 * to confirm staging + target share a filesystem.
 */
function deviceIdFor(path: string): number | null {
  const probe = existsSync(path) ? path : dirname(path);
  try {
    return statSync(probe).dev;
  } catch {
    return null;
  }
}

interface AtomicSwapResult {
  oldVersionBackup: string | null;
  swapped: boolean;
  fallbackUsed: boolean;
}

/**
 * Atomic binary swap.
 *
 * Backup move: target → previousDir is always within `GENIE_BIN`, so it is
 * guaranteed same-filesystem and uses `renameSync` unconditionally. The
 * `sameFs` device check only applies to the staging→target leg.
 *
 * Same-fs staging swap: `renameSync(staged, target)` — atomic on POSIX.
 *
 * Cross-device staging swap: copy staging → `target.tmp` (in the target
 * directory, so the final `renameSync` is same-fs and atomic) → `fsyncSync`
 * the bytes → `renameSync(target.tmp, target)`. The live target is preserved
 * until the replacement is fully written; an interrupted copy leaves only
 * the orphan `.tmp` file, never a half-written live binary.
 *
 * Old binary is moved to `~/.genie/bin/.previous/genie-<old-version>` so
 * `genie update --rollback` can restore it.
 */
export function atomicBinarySwap(
  stagedBinPath: string,
  targetBinPath: string,
  previousDir: string,
  oldVersion: string,
): AtomicSwapResult {
  if (!existsSync(stagedBinPath)) {
    throw new Error(`staged binary missing: ${stagedBinPath}`);
  }

  const targetDir = dirname(targetBinPath);
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(previousDir, { recursive: true });

  const stagingDev = deviceIdFor(stagedBinPath);
  const targetDev = deviceIdFor(targetBinPath);
  const sameFs = stagingDev !== null && targetDev !== null && stagingDev === targetDev;

  let oldBackup: string | null = null;
  if (existsSync(targetBinPath)) {
    oldBackup = join(previousDir, `genie-${oldVersion}`);
    if (existsSync(oldBackup)) {
      try {
        rmSync(oldBackup);
      } catch {
        // best-effort
      }
    }
    // Backup move is always GENIE_BIN/* → GENIE_BIN/.previous/* (same fs by
    // construction); renameSync is atomic regardless of the staging-side
    // sameFs flag.
    renameSync(targetBinPath, oldBackup);
  }

  if (sameFs) {
    renameSync(stagedBinPath, targetBinPath);
  } else {
    // Cross-device: write to a temp file in the TARGET directory so the
    // final rename is same-fs and atomic. If the copy is interrupted,
    // we leave an orphan `.tmp` that the next update will overwrite —
    // never a corrupted live binary.
    const tmpTarget = `${targetBinPath}.tmp`;
    if (existsSync(tmpTarget)) {
      try {
        rmSync(tmpTarget);
      } catch {
        // best-effort
      }
    }
    copyFileSync(stagedBinPath, tmpTarget);
    try {
      const fd = openSync(tmpTarget, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // fsync is best-effort.
    }
    renameSync(tmpTarget, targetBinPath);
    try {
      rmSync(stagedBinPath);
    } catch {
      // staging cleanup is best-effort
    }
  }
  try {
    chmodSync(targetBinPath, 0o755);
  } catch {
    // best-effort
  }

  return { oldVersionBackup: oldBackup, swapped: true, fallbackUsed: !sameFs };
}

/**
 * Sync the per-binary VERSION stamp the compiled binary reads at startup.
 *
 * Why this exists: `src/lib/version.ts` resolves the running version by
 * reading `dirname(process.execPath)/VERSION` — i.e. `~/.genie/bin/VERSION`,
 * a sibling of the binary itself. The atomic swap replaces `~/.genie/bin/genie`
 * but never touches that file. Result: a freshly-installed v<new> binary
 * reports v<old> on `--version` until the next time something rewrites the
 * stamp. The 2026-05-22 incident on khal-os triggered exactly this — the
 * release tarball was correct, the swap was correct, but the stale stamp
 * masqueraded as a swap failure for three consecutive `genie update` runs.
 *
 * The G1 tarball convention ships a `VERSION` file at the root of the
 * extracted tree. Prefer copying that file (preserves whatever format
 * `build-tarballs.yml` produced); fall back to writing `manifestVersion`
 * directly when the tarball pre-dates the convention.
 *
 * Best-effort by design: write failures don't throw — the immediately-
 * following `verifySwappedBinary` will catch any resulting mismatch and
 * surface the structured error with full forensic context.
 */
export function syncBinaryVersionStamp(extractDir: string, binDir: string, manifestVersion: string): void {
  const targetStamp = join(binDir, 'VERSION');
  const stagedStamp = join(extractDir, 'VERSION');
  try {
    if (existsSync(stagedStamp)) {
      copyFileSync(stagedStamp, targetStamp);
    } else {
      writeFileSync(targetStamp, `${manifestVersion}\n`);
    }
  } catch {
    // verifySwappedBinary below will detect any version mismatch loudly;
    // never abort the update over a non-essential metadata write.
  }
}

/**
 * Post-swap correctness guard: execute the freshly-swapped binary and confirm
 * its `--version` output normalises to the version we intended to install.
 *
 * Why this exists: on 2026-05-22 we observed an update that printed
 * "✔ Genie binary updated → v4.260522.2" while the on-disk file at
 * `~/.genie/bin/genie` remained v4.260520.3 with an mtime predating the
 * update run. `atomicBinarySwap` returned `{ swapped: true }` without
 * throwing, but the bytes never landed (cause: cleaned-up `.staging/`, no
 * forensics). The success message was a lie produced from the *intent*
 * (`manifest.version`), not from re-reading the result.
 *
 * The fix is belt-and-suspenders: never claim success without proof. This
 * helper executes the binary at `targetBin` (injectable via `opts.runVersion`
 * for tests) and throws a structured `Error` when the reported version does
 * not match the manifest. The thrown error includes the staging + previous
 * directories the operator can inspect.
 */
export interface VerifySwappedBinaryOptions {
  /** Test seam — replaces the `execFileSync(targetBin, ['--version'])` call. */
  runVersion?: (targetBin: string) => string;
  stagingDir?: string;
  previousDir?: string;
}

export function verifySwappedBinary(
  targetBin: string,
  expectedVersion: string,
  opts: VerifySwappedBinaryOptions = {},
): void {
  const runner =
    opts.runVersion ??
    ((path: string) => execFileSync(path, ['--version'], { encoding: 'utf-8', timeout: 3000 }).toString());

  let raw: string;
  try {
    raw = runner(targetBin);
  } catch (err) {
    throw new Error(
      `Post-swap verification failed — could not execute ${targetBin}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const match = raw.trim().match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/);
  if (!match) {
    throw new Error(
      `Post-swap verification failed — ${targetBin} ran but emitted no parsable version (got: ${JSON.stringify(
        raw.slice(0, 200),
      )})`,
    );
  }
  const actual = normalizeVersion(match[0]);
  const intended = normalizeVersion(expectedVersion);
  if (actual !== intended) {
    const hints: string[] = [];
    if (opts.stagingDir) hints.push(`  Staging : ${opts.stagingDir}`);
    if (opts.previousDir) hints.push(`  Previous: ${opts.previousDir}`);
    throw new Error(
      [
        'Post-swap verification failed — the atomic swap reported success but the',
        'on-disk binary holds the wrong version. This usually means the staged file',
        'was the wrong version or the swap was rolled back by an external watcher.',
        `  Intended: v${intended}`,
        `  On disk : v${actual}`,
        `  Path    : ${targetBin}`,
        ...hints,
      ].join('\n'),
    );
  }
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
 *      (caught by `verifySwappedBinary`). The advisory's
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

/**
 * Restore the most recent backup from `~/.genie/bin/.previous/` to the live
 * binary path. Throws if no backup exists.
 */
export function rollbackBinary(): { restored: string; from: string } {
  if (!existsSync(GENIE_BIN_PREVIOUS)) {
    throw new Error(`No rollback target: ${GENIE_BIN_PREVIOUS} does not exist`);
  }
  const candidates = readdirSync(GENIE_BIN_PREVIOUS)
    .filter((entry) => entry.startsWith('genie-'))
    .map((entry) => ({ entry, mtime: statSync(join(GENIE_BIN_PREVIOUS, entry)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new Error(`No rollback target: ${GENIE_BIN_PREVIOUS} is empty`);
  }
  const newest = candidates[0].entry;
  const source = join(GENIE_BIN_PREVIOUS, newest);
  const target = join(GENIE_BIN, 'genie');
  mkdirSync(GENIE_BIN, { recursive: true });

  const sourceDev = deviceIdFor(source);
  const targetDev = deviceIdFor(target);
  const sameFs = sourceDev !== null && targetDev !== null && sourceDev === targetDev;

  // The current live binary is being supplanted — move it aside (so an
  // interrupted rollback can be re-run) before swapping in the backup.
  if (existsSync(target)) {
    const replacedAt = join(GENIE_BIN_PREVIOUS, `${newest}.replaced.${Date.now()}`);
    if (sameFs) renameSync(target, replacedAt);
    else {
      copyFileSync(target, replacedAt);
      rmSync(target);
    }
  }
  if (sameFs) renameSync(source, target);
  else {
    copyFileSync(source, target);
    rmSync(source);
  }
  try {
    chmodSync(target, 0o755);
  } catch {
    // best-effort
  }
  return { restored: target, from: source };
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

function copyDirSync(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (FRAMEWORK_MARKER_FILES.has(entry.name)) continue;
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

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
  if (genieConfigExists()) {
    try {
      const config = await loadGenieConfig();
      // The zod schema's `.transform` already normalizes the legacy 'next'
      // token to 'dev' at parse time. Post-2026-05-12 the schema also
      // accepts 'homolog'; only 'latest' | 'homolog' | 'dev' can land here.
      if (config.updateChannel === 'dev') return 'dev';
      if (config.updateChannel === 'homolog') return 'homolog';
      if (config.updateChannel === 'latest') return 'stable';
    } catch {
      // ignore
    }
  }
  return 'stable';
}

export async function persistChannel(channel: ReleaseChannel): Promise<void> {
  try {
    const config = await loadGenieConfig();
    // Map ReleaseChannel → genie-config schema enum. The schema accepts
    // 'next' as a read-time alias but we always write a canonical token
    // ('latest' / 'homolog' / 'dev') so the user's config converges to
    // the current naming on their next update.
    if (channel === 'dev') {
      config.updateChannel = 'dev';
    } else if (channel === 'homolog') {
      config.updateChannel = 'homolog';
    } else {
      config.updateChannel = 'latest';
    }
    await saveGenieConfig(config);
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
  /** `--rollback`. Restore the most recent ~/.genie/bin/.previous backup. */
  rollback?: boolean;
}

export async function updateCommand(options: UpdateCommandOptions = {}): Promise<void> {
  console.log();
  console.log(`${colorize('\x1b[1m', '\x1b[0m', '🧞 Genie CLI Update')}`);
  console.log(`${colorize('\x1b[2m', '\x1b[0m', '────────────────────────────────────')}`);
  console.log();

  if (options.rollback) {
    await runRollback();
    return;
  }

  const noRestart = options.restart === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_RESTART);
  const noVerify = options.verify === false || isTruthyEnv(process.env.GENIE_UPDATE_NO_VERIFY);
  const channel = await resolveChannel(options);

  // Persist on every run, not just explicit channel flips. This makes the
  // sticky behavior bulletproof: a one-time `genie update --dev` writes the
  // channel to config, and every subsequent bare `genie update` re-resolves
  // and re-persists the same channel. The only way to leave the dev channel
  // is an explicit `--stable`. (See wish release-channel-dev, decision #4.)
  await persistChannel(channel);

  // Pre-flight: fetch the channel manifest. Single canonical source of truth.
  const manifest = await fetchLatestManifest(channel);
  const latestVersion = manifest?.version ?? null;
  // Key the decision off the installed binary, NOT this process's
  // compile-time VERSION — a stale shadowing binary on $PATH would
  // otherwise re-offer the same update on every invocation.
  const installedVersion = resolveInstalledVersion();
  if (shortCircuitIfCurrent(installedVersion, latestVersion)) {
    success(`Already up to date (v${normalizeVersion(installedVersion)}, channel ${channel})`);
    console.log();
    return;
  }

  let platform: string;
  try {
    platform = resolvePlatformId();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Refuse to swap when the live binary is outside ~/.genie/bin/. Silently
  // updating a different file would mask the regression on bun/npm-installed
  // hosts where $PATH still points at the old binary.
  try {
    ensureCanonicalInstall();
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  log(`Channel: ${channel}${channel === 'stable' ? ' (stable)' : ` (${channel})`}`);
  log(`Platform: ${platform}`);
  if (latestVersion) {
    log(`Update available: ${normalizeVersion(installedVersion)} → ${normalizeVersion(latestVersion)}`);
  } else {
    log(`Channel manifest unavailable (.well-known/${channel === 'stable' ? 'latest' : channel}.json missing)`);
    error(`Cannot resolve target version for channel "${channel}". Aborting.`);
    process.exit(1);
  }
  console.log();

  if (!shouldAutoConfirm(options)) {
    const proceedQuestion = `Update v${normalizeVersion(installedVersion)} → v${normalizeVersion(latestVersion as string)}?`;
    const proceed = await promptConfirm(proceedQuestion);
    if (!proceed) {
      console.log();
      log('Update declined.');
      console.log();
      return;
    }
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

  try {
    await runDelivery(manifest as LatestManifest, platform, diagnosticsCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Update failed: ${msg}`);
    process.exit(1);
  }

  runV4CleanupSafe();
  await runPostUpdateVerifySafe({ ...options, noRestart, noVerify }, diagnosticsCtx);
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
 * Tarball delivery + binary swap. Linear flow extracted from `updateCommand`
 * to keep the command body readable: download → verify → extract → swap →
 * sync aux content → clean staging.
 */
async function runDelivery(
  manifest: LatestManifest,
  platform: string,
  diagnosticsCtx: UpdateDiagnosticsContext,
): Promise<void> {
  log('Downloading signed tarball from GitHub Releases...');
  const tarballPath = await downloadAndVerifyTarball(manifest, platform, GENIE_BIN_STAGING);
  diagnosticsCtx.tarballPath = tarballPath;
  diagnosticsCtx.attestationVerified = true;
  success(`Verified signed tarball for ${tarballPath.split('/').pop()}`);

  log('Extracting tarball...');
  const extractDir = join(GENIE_BIN_STAGING, `extract-${manifest.version}`);
  if (existsSync(extractDir)) rmSync(extractDir, { recursive: true, force: true });
  await extractTarball(tarballPath, extractDir);

  const stagedBin = join(extractDir, 'genie');
  if (!existsSync(stagedBin)) {
    throw new Error(`tarball did not contain a 'genie' binary at ${stagedBin}`);
  }
  try {
    chmodSync(stagedBin, 0o755);
  } catch {
    // best-effort
  }

  log('Atomically swapping binary...');
  const targetBin = join(GENIE_BIN, 'genie');
  const swapResult = atomicBinarySwap(stagedBin, targetBin, GENIE_BIN_PREVIOUS, normalizeVersion(VERSION));
  diagnosticsCtx.previousBackup = swapResult.oldVersionBackup;

  // Sync the per-binary VERSION stamp BEFORE verifying. The compiled binary
  // reads `dirname(process.execPath)/VERSION` at startup (see src/lib/version.ts
  // readVersionFromPackageJson). The atomic swap replaces `genie` but leaves
  // its sibling VERSION file untouched — so `targetBin --version` would still
  // report the OLD version even when the bytes on disk match the new release.
  // That's what bit us on 2026-05-22 (host khal-os): three consecutive updates
  // landed the correct binary but reported the stale version, tripping the
  // post-swap guard and the PATH advisory both as collateral. Copy the
  // tarball's VERSION file next to the binary so the executable agrees with
  // what we just installed; fall back to writing manifest.version directly if
  // the tarball is missing it (older builds).
  syncBinaryVersionStamp(extractDir, GENIE_BIN, manifest.version);

  // Belt-and-suspenders: re-read the on-disk binary BEFORE printing success.
  // `atomicBinarySwap` returning `{ swapped: true }` is necessary but not
  // sufficient — see verifySwappedBinary for the silent-failure case observed
  // on 2026-05-22. Any mismatch here throws and aborts the delivery so the
  // operator never sees a misleading "✔ Genie binary updated" banner.
  verifySwappedBinary(targetBin, manifest.version, {
    stagingDir: GENIE_BIN_STAGING,
    previousDir: GENIE_BIN_PREVIOUS,
  });

  success(`Genie binary updated → v${manifest.version}${swapResult.fallbackUsed ? ' (cross-device fallback)' : ''}`);

  try {
    writeFileSync(join(GENIE_HOME, 'VERSION'), `${manifest.version}\n`);
  } catch {
    // best-effort
  }

  // Post-swap divergence guard: ~/.genie/bin/genie now holds the new
  // binary, but if $PATH resolves `genie` to a different file (a pre-G5
  // copy or a shadowing shim) the user keeps running the old version and
  // would never escape the update prompt. Measure the actual outcome and
  // tell them exactly how to fix it rather than silently "succeeding".
  //
  // Suppression: when `live` and `canonical` resolve to the same file, a
  // version mismatch is upstream swap corruption (already caught by
  // verifySwappedBinary above), not a PATH problem. The legacy heuristic
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

  syncAuxiliaryContent(extractDir);
  cleanupStagingArtifacts(extractDir, tarballPath);
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
 * Mirror plugins/, skills/, templates/ from the extracted tarball into
 * `~/.genie/`. Stage to a sibling `<dest>.new` directory and `renameSync`
 * over the live target so concurrent readers (Claude Code's plugin loader)
 * never observe an empty directory mid-update. The previous live tree
 * moves to `<dest>.old` and is deleted last.
 *
 * Best-effort — failures are logged but never block the update.
 */
function syncAuxiliaryContent(extractDir: string): void {
  const targets: Array<{ src: string; dest: string; label: string }> = [
    { src: join(extractDir, 'plugins'), dest: join(GENIE_HOME, 'plugins'), label: 'plugins' },
    { src: join(extractDir, 'skills'), dest: join(GENIE_HOME, 'skills'), label: 'skills' },
    { src: join(extractDir, 'templates'), dest: join(GENIE_HOME, 'templates'), label: 'templates' },
  ];
  for (const target of targets) {
    if (!existsSync(target.src)) continue;
    swapAuxiliaryTree(target.src, target.dest, target.label);
  }
}

/** Atomic stage+rename for one auxiliary tree. Best-effort recovery on
 *  failure restores the previous live tree if we crashed after moving it
 *  aside. Errors are logged but never propagate to the caller. */
function swapAuxiliaryTree(src: string, dest: string, label: string): void {
  const stagingDest = `${dest}.new`;
  const oldDest = `${dest}.old`;
  try {
    if (existsSync(stagingDest)) rmSync(stagingDest, { recursive: true, force: true });
    if (existsSync(oldDest)) rmSync(oldDest, { recursive: true, force: true });
    copyDirSync(src, stagingDest);
    if (existsSync(dest)) renameSync(dest, oldDest);
    renameSync(stagingDest, dest);
    if (existsSync(oldDest)) rmSync(oldDest, { recursive: true, force: true });
    success(`Refreshed ${label}/ → ${dest}`);
  } catch (err) {
    recoverAuxiliarySwap(dest, stagingDest, oldDest);
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not refresh ${label}/ (non-fatal): ${msg}`);
  }
}

function recoverAuxiliarySwap(dest: string, stagingDest: string, oldDest: string): void {
  try {
    if (!existsSync(dest) && existsSync(oldDest)) renameSync(oldDest, dest);
    if (existsSync(stagingDest)) rmSync(stagingDest, { recursive: true, force: true });
  } catch {
    // give up; dest is in whatever state it's in
  }
}

async function runRollback(): Promise<void> {
  log('Rolling back to previous binary...');
  try {
    const result = rollbackBinary();
    success(`Restored ${result.from} → ${result.restored}`);
    console.log();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    error(`Rollback failed: ${msg}`);
    console.log();
    process.exit(1);
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
