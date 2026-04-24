import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';

export interface SecScanCommandOptions {
  json?: boolean;
  allHomes?: boolean;
  home?: string[];
  root?: string[];
  noProgress?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  progressJson?: boolean;
  progressInterval?: string;
  eventsFile?: string;
  redact?: boolean;
  persist?: boolean;
  impactSurface?: boolean;
  phaseBudget?: string[];
}

export interface SecRemediateCommandOptions {
  json?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  resume?: string;
  scanReport?: string;
  scanId?: string;
  plan?: string;
  quarantineDir?: string;
  unsafeUnverified?: string;
  remediatePartial?: boolean;
  confirmIncompleteScan?: string;
  killPid?: number[];
  autoConfirmFrom?: string;
}

export interface SecQuarantineListOptions {
  json?: boolean;
}

export interface SecQuarantineGcOptions {
  json?: boolean;
  olderThan?: string;
  confirmGc?: string;
}

export interface SecRollbackOptions {
  json?: boolean;
}

export interface SecVerifyInstallOptions {
  offline?: boolean;
  json?: boolean;
  tarball?: string;
  bundleDir?: string;
}

interface SecScanSpawnResult {
  status: number | null;
  error?: Error;
  stdout?: Buffer | string;
  stderr?: Buffer | string;
}

export interface SecScanDeps {
  existsSync: (path: string) => boolean;
  realpathSync: (path: string) => string;
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  spawnSync: (
    command: string,
    args: string[],
    options: { stdio?: 'inherit' | 'pipe'; encoding?: BufferEncoding },
  ) => SecScanSpawnResult;
  setExitCode: (exitCode: number) => void;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  now: () => Date;
}

const defaultDeps: SecScanDeps = {
  existsSync,
  realpathSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  spawnSync: (command, args, options) => spawnSync(command, args, options),
  setExitCode: (exitCode) => {
    process.exitCode = exitCode;
  },
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  now: () => new Date(),
};

function collectRepeatedOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectKillPid(value: string, previous: number[]): number[] {
  const pid = Number.parseInt(value, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error(`--kill-pid expects a positive integer, got "${value}"`);
  }
  return [...previous, pid];
}

/** Resolve genie's package root from either src/ or dist/. */
export function resolveGenieRoot(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  try {
    if (argv1) {
      const scriptDir = dirname(deps.realpathSync(argv1));
      const candidates = [resolve(scriptDir, '..'), resolve(scriptDir, '..', '..')];
      for (const candidate of candidates) {
        if (deps.existsSync(join(candidate, 'package.json'))) return candidate;
      }
    }
  } catch {
    /* fall through */
  }

  return resolve(import.meta.dir, '..', '..');
}

export function resolveSecScanScript(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  const root = resolveGenieRoot(argv1, deps);
  const scriptPath = join(root, 'scripts', 'sec-scan.cjs');
  if (!deps.existsSync(scriptPath)) {
    throw new Error(`Security scanner payload not found at ${scriptPath}`);
  }
  return scriptPath;
}

export function resolveSecRemediateScript(
  argv1: string | undefined = process.argv[1],
  deps: Pick<SecScanDeps, 'existsSync' | 'realpathSync'> = defaultDeps,
): string {
  const root = resolveGenieRoot(argv1, deps);
  const scriptPath = join(root, 'scripts', 'sec-remediate.cjs');
  if (!deps.existsSync(scriptPath)) {
    throw new Error(`Security remediation payload not found at ${scriptPath}`);
  }
  return scriptPath;
}

const BOOLEAN_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['json', '--json'],
  ['allHomes', '--all-homes'],
  ['noProgress', '--no-progress'],
  ['quiet', '--quiet'],
  ['verbose', '--verbose'],
  ['progressJson', '--progress-json'],
  ['redact', '--redact'],
  ['impactSurface', '--impact-surface'],
];

const REPEATED_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['home', '--home'],
  ['root', '--root'],
  ['phaseBudget', '--phase-budget'],
];

const STRING_FLAG_MAP: Array<[keyof SecScanCommandOptions, string]> = [
  ['progressInterval', '--progress-interval'],
  ['eventsFile', '--events-file'],
];

export function buildSecScanArgv(options: SecScanCommandOptions): string[] {
  const args: string[] = [];

  for (const [key, flag] of BOOLEAN_FLAG_MAP) {
    if (options[key]) args.push(flag);
  }

  for (const [key, flag] of REPEATED_FLAG_MAP) {
    const values = (options[key] as string[] | undefined) ?? [];
    for (const value of values) args.push(flag, value);
  }

  for (const [key, flag] of STRING_FLAG_MAP) {
    const value = options[key] as string | undefined;
    if (value) args.push(flag, value);
  }

  if (options.persist === false) args.push('--no-persist');

  return args;
}

export function buildSecRemediateArgv(options: SecRemediateCommandOptions): string[] {
  const args: string[] = [];

  if (options.dryRun) args.push('--dry-run');
  if (options.apply) args.push('--apply');
  if (options.resume) args.push('--resume', options.resume);
  if (options.scanReport) args.push('--scan-report', options.scanReport);
  if (options.scanId) args.push('--scan-id', options.scanId);
  if (options.plan) args.push('--plan', options.plan);
  if (options.quarantineDir) args.push('--quarantine-dir', options.quarantineDir);
  if (options.unsafeUnverified) args.push('--unsafe-unverified', options.unsafeUnverified);
  if (options.remediatePartial) args.push('--remediate-partial');
  if (options.confirmIncompleteScan) args.push('--confirm-incomplete-scan', options.confirmIncompleteScan);
  for (const pid of options.killPid ?? []) {
    args.push('--kill-pid', String(pid));
  }
  if (options.autoConfirmFrom) args.push('--auto-confirm-from', options.autoConfirmFrom);
  if (options.json) args.push('--json');

  return args;
}

export function runSecScan(options: SecScanCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecScanScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecScanArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecRemediate(options: SecRemediateCommandOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecRemediateArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });

  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecRestore(quarantineId: string, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, '--restore', quarantineId];
  // The current sec-remediate.cjs handles restore via a separate entry: invoke
  // the small CLI shim below by reusing the script and a dedicated flag.
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function buildSecRollbackArgv(scanId: string, options: SecRollbackOptions): string[] {
  const args: string[] = ['--rollback', scanId];
  if (options.json) args.push('--json');
  return args;
}

export function buildSecQuarantineListArgv(options: SecQuarantineListOptions): string[] {
  const args: string[] = ['--quarantine-list'];
  if (options.json) args.push('--json');
  return args;
}

export function buildSecQuarantineGcArgv(options: SecQuarantineGcOptions): string[] {
  const args: string[] = ['--quarantine-gc'];
  if (options.olderThan) args.push('--older-than', options.olderThan);
  if (options.confirmGc) args.push('--confirm-gc', options.confirmGc);
  if (options.json) args.push('--json');
  return args;
}

export function runSecRollback(scanId: string, options: SecRollbackOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecRollbackArgv(scanId, options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecQuarantineList(options: SecQuarantineListOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecQuarantineListArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function runSecQuarantineGc(options: SecQuarantineGcOptions, deps: SecScanDeps = defaultDeps): number {
  const scriptPath = resolveSecRemediateScript(process.argv[1], deps);
  const args = [scriptPath, ...buildSecQuarantineGcArgv(options)];
  const result = deps.spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

export function applySecScanExitCode(exitCode: number, deps: Pick<SecScanDeps, 'setExitCode'> = defaultDeps): void {
  if (exitCode !== 0) deps.setExitCode(exitCode);
}

// ---------------------------------------------------------------------------
// verify-install
//
// `genie sec verify-install` walks the cosign + SLSA verification path that
// `scripts/verify-release.sh` documents:
//   1. Locate a signed tarball + .sig + .cert + provenance.intoto.jsonl
//      bundle on disk (either auto-discovered or user-supplied).
//   2. Run `cosign verify-blob` pinning the certificate identity regexp +
//      OIDC issuer documented in .github/cosign.pub.
//   3. Run `slsa-verifier verify-artifact` against the provenance attestation.
//   4. Report the outcome with the exit codes documented in the wish.
//
// Signing is cosign KEYLESS ONLY — there is no PEM public key to pin. The
// committed .github/cosign.pub is an explicit NO-KEY sentinel. Any operator
// who hands us a file whose content matches the sentinel MUST get exit 5
// ("no signature material found") rather than a false positive.
// ---------------------------------------------------------------------------

/**
 * Exit codes are a public contract consumed by operators, CI, and the runbook.
 * Keep in sync with `scripts/verify-release.sh` and the wish.
 */
export const VERIFY_EXIT = {
  VERIFIED: 0,
  SIGNATURE_INVALID: 2,
  SIGNER_IDENTITY_MISMATCH: 3,
  PROVENANCE_INVALID: 4,
  NO_SIGNATURE_MATERIAL: 5,
  MISSING_BINARY: 127,
} as const;

export type VerifyExitCode = (typeof VERIFY_EXIT)[keyof typeof VERIFY_EXIT];

export const SIGNER_IDENTITY_REGEXP = '^https://github.com/automagik-dev/genie/.github/workflows/release.yml@';
export const SIGNER_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const PROVENANCE_SOURCE_URI = 'github.com/automagik-dev/genie';

const COSIGN_NO_KEY_SENTINEL = 'BEGIN COSIGN NO-PINNED-KEY SENTINEL';

export interface VerifyInstallJsonShape {
  verified: boolean;
  exit_code: VerifyExitCode;
  signer_identity: string;
  signer_oidc_issuer: string;
  signature_source: string | null;
  provenance_source: string | null;
  tarball_path: string | null;
  verified_at: string;
  pinned_key_fingerprint: null;
  signing_mode: 'cosign-keyless';
  offline: boolean;
  errors: string[];
}

interface DiscoveredBundle {
  tarball: string;
  signature: string;
  certificate: string;
  provenance: string | null;
}

/**
 * Discover a {tarball, .sig, .cert, provenance} bundle relative to a starting
 * directory. Looks for a single *.tgz with matching `.sig` + `.cert` siblings
 * and an optional `provenance.intoto.jsonl`. Returns null if no complete
 * bundle is present.
 */
export function discoverSignatureBundle(
  bundleDir: string,
  deps: Pick<SecScanDeps, 'existsSync'> = defaultDeps,
): DiscoveredBundle | null {
  if (!deps.existsSync(bundleDir)) return null;

  const candidates: string[] = [];
  try {
    for (const entry of readdirSync(bundleDir)) {
      if (entry.endsWith('.tgz')) candidates.push(entry);
    }
  } catch {
    return null;
  }

  for (const tarballName of candidates) {
    const tarball = join(bundleDir, tarballName);
    const signature = `${tarball}.sig`;
    const certificate = `${tarball}.cert`;
    if (!deps.existsSync(signature)) continue;
    if (!deps.existsSync(certificate)) continue;
    const provenancePath = join(bundleDir, 'provenance.intoto.jsonl');
    const provenance = deps.existsSync(provenancePath) ? provenancePath : null;
    return { tarball, signature, certificate, provenance };
  }

  return null;
}

/**
 * Sentinel guard: the committed `.github/cosign.pub` is not a PEM key. Any
 * code path that tries to treat it as a key must fail closed with exit 5.
 */
export function readsAsCosignSentinel(
  path: string,
  deps: Pick<SecScanDeps, 'existsSync' | 'readFileSync'> = defaultDeps,
): boolean {
  if (!deps.existsSync(path)) return false;
  try {
    const content = deps.readFileSync(path, 'utf8');
    return content.includes(COSIGN_NO_KEY_SENTINEL);
  } catch {
    return false;
  }
}

interface CosignBinaryCheck {
  ok: boolean;
  binary: string;
  reason?: string;
}

function ensureBinary(name: string, deps: Pick<SecScanDeps, 'spawnSync'>): CosignBinaryCheck {
  const result = deps.spawnSync(name, ['--version'], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.error) return { ok: false, binary: name, reason: result.error.message };
  if ((result.status ?? 1) !== 0) {
    return { ok: false, binary: name, reason: `${name} --version exited non-zero` };
  }
  return { ok: true, binary: name };
}

export interface VerifyInstallResult {
  exitCode: VerifyExitCode;
  json: VerifyInstallJsonShape;
}

function buildVerifyResult(
  exitCode: VerifyExitCode,
  ctx: {
    bundle: DiscoveredBundle | null;
    verifiedAt: string;
    offline: boolean;
    errors: string[];
  },
): VerifyInstallResult {
  return {
    exitCode,
    json: {
      verified: exitCode === VERIFY_EXIT.VERIFIED,
      exit_code: exitCode,
      signer_identity: SIGNER_IDENTITY_REGEXP,
      signer_oidc_issuer: SIGNER_OIDC_ISSUER,
      signature_source: ctx.bundle?.signature ?? null,
      provenance_source: ctx.bundle?.provenance ?? null,
      tarball_path: ctx.bundle?.tarball ?? null,
      verified_at: ctx.verifiedAt,
      pinned_key_fingerprint: null,
      signing_mode: 'cosign-keyless',
      offline: ctx.offline,
      errors: ctx.errors,
    },
  };
}

function classifyCosignFailure(stderr: string): VerifyExitCode {
  const lower = stderr.toLowerCase();
  const identityMismatch =
    lower.includes('certificate identity') || lower.includes('subject does not match') || lower.includes('oidc issuer');
  return identityMismatch ? VERIFY_EXIT.SIGNER_IDENTITY_MISMATCH : VERIFY_EXIT.SIGNATURE_INVALID;
}

function runCosignStep(
  bundle: DiscoveredBundle,
  offline: boolean,
  errors: string[],
  deps: SecScanDeps,
): VerifyExitCode {
  const cosignCheck = ensureBinary('cosign', deps);
  if (!cosignCheck.ok) {
    errors.push(
      `cosign not available in PATH (${cosignCheck.reason ?? 'unknown'}). Install from https://docs.sigstore.dev/cosign/installation/.`,
    );
    return VERIFY_EXIT.MISSING_BINARY;
  }

  const cosignArgs = [
    'verify-blob',
    '--certificate-identity-regexp',
    SIGNER_IDENTITY_REGEXP,
    '--certificate-oidc-issuer',
    SIGNER_OIDC_ISSUER,
    '--signature',
    bundle.signature,
    '--certificate',
    bundle.certificate,
    bundle.tarball,
  ];
  if (offline) cosignArgs.push('--insecure-ignore-tlog', '--offline');

  const result = deps.spawnSync('cosign', cosignArgs, { stdio: 'pipe', encoding: 'utf8' });
  if (result.error) {
    errors.push(`cosign spawn failed: ${result.error.message}`);
    return VERIFY_EXIT.MISSING_BINARY;
  }
  if ((result.status ?? 1) === 0) return VERIFY_EXIT.VERIFIED;

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (stderr) errors.push(stderr.trim());
  return classifyCosignFailure(stderr);
}

function runSlsaStep(bundle: DiscoveredBundle, errors: string[], deps: SecScanDeps): VerifyExitCode {
  if (!bundle.provenance) {
    errors.push(
      `provenance.intoto.jsonl missing alongside ${bundle.tarball} — cosign passed but SLSA provenance cannot be checked.`,
    );
    return VERIFY_EXIT.PROVENANCE_INVALID;
  }

  const slsaCheck = ensureBinary('slsa-verifier', deps);
  if (!slsaCheck.ok) {
    errors.push(
      `slsa-verifier not available in PATH (${slsaCheck.reason ?? 'unknown'}). Install from https://github.com/slsa-framework/slsa-verifier.`,
    );
    return VERIFY_EXIT.MISSING_BINARY;
  }

  const result = deps.spawnSync(
    'slsa-verifier',
    ['verify-artifact', bundle.tarball, '--provenance-path', bundle.provenance, '--source-uri', PROVENANCE_SOURCE_URI],
    { stdio: 'pipe', encoding: 'utf8' },
  );
  if (result.error) {
    errors.push(`slsa-verifier spawn failed: ${result.error.message}`);
    return VERIFY_EXIT.MISSING_BINARY;
  }
  if ((result.status ?? 1) === 0) return VERIFY_EXIT.VERIFIED;

  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (stderr) errors.push(stderr.trim());
  return VERIFY_EXIT.PROVENANCE_INVALID;
}

function resolveBundleDir(options: SecVerifyInstallOptions, genieRoot: string): string {
  if (options.bundleDir) return options.bundleDir;
  if (options.tarball) return dirname(resolve(options.tarball));
  return resolve(genieRoot);
}

export function runVerifyInstall(
  options: SecVerifyInstallOptions,
  deps: SecScanDeps = defaultDeps,
): VerifyInstallResult {
  const errors: string[] = [];
  const verifiedAt = deps.now().toISOString();
  const offline = options.offline === true;

  const genieRoot = resolveGenieRoot(process.argv[1], deps);
  const bundleDir = resolveBundleDir(options, genieRoot);
  const bundle = discoverSignatureBundle(bundleDir, deps);
  const ctx = { bundle, verifiedAt, offline, errors };

  if (!bundle) {
    errors.push(
      `No signed release bundle found under ${bundleDir}. Expected <pkg>.tgz + .sig + .cert + provenance.intoto.jsonl.`,
    );
    if (readsAsCosignSentinel(join(genieRoot, '.github', 'cosign.pub'), deps)) {
      errors.push(
        '.github/cosign.pub is the documented NO-KEY sentinel — release signing is cosign KEYLESS ONLY; there is no public key to pin.',
      );
    }
    return buildVerifyResult(VERIFY_EXIT.NO_SIGNATURE_MATERIAL, ctx);
  }

  const cosignExit = runCosignStep(bundle, offline, errors, deps);
  if (cosignExit !== VERIFY_EXIT.VERIFIED) return buildVerifyResult(cosignExit, ctx);

  const slsaExit = runSlsaStep(bundle, errors, deps);
  return buildVerifyResult(slsaExit, ctx);
}

function emitHumanReport(
  result: VerifyInstallResult,
  options: SecVerifyInstallOptions,
  deps: Pick<SecScanDeps, 'stdout' | 'stderr'>,
): void {
  const { json, exitCode } = result;
  const status = json.verified ? 'OK' : 'FAIL';
  deps.stdout(`verify-install: ${status} (exit ${exitCode})`);
  deps.stdout(`  signing mode:       ${json.signing_mode}`);
  deps.stdout(`  signer identity:    ${json.signer_identity}`);
  deps.stdout(`  OIDC issuer:        ${json.signer_oidc_issuer}`);
  deps.stdout(`  provenance source:  ${PROVENANCE_SOURCE_URI}`);
  deps.stdout(`  tarball:            ${json.tarball_path ?? '(not found)'}`);
  deps.stdout(`  signature:          ${json.signature_source ?? '(not found)'}`);
  deps.stdout(`  provenance:         ${json.provenance_source ?? '(not found)'}`);
  deps.stdout(`  verified_at:        ${json.verified_at}`);
  deps.stdout(`  offline:            ${json.offline ? 'yes (skips Rekor tlog)' : 'no'}`);
  if (options.offline) {
    deps.stdout('  warning:            offline mode skips the Rekor transparency log; revoked certs are not detected.');
  }
  if (json.errors.length > 0) {
    deps.stderr('verify-install errors:');
    for (const err of json.errors) deps.stderr(`  - ${err}`);
  }
}

export function runVerifyInstallCommand(options: SecVerifyInstallOptions, deps: SecScanDeps = defaultDeps): number {
  const result = runVerifyInstall(options, deps);
  if (options.json) {
    deps.stdout(JSON.stringify(result.json));
  } else {
    emitHumanReport(result, options, deps);
  }
  return result.exitCode;
}

export function registerSecCommands(program: Command, deps: SecScanDeps = defaultDeps): void {
  const sec = program.command('sec').description('Security tooling — host compromise triage and IOC hunts');

  sec
    .command('scan', { isDefault: true })
    .description('Scan host for TeamPCP/CanisterWorm-style package compromise indicators')
    .option('--json', 'Output as JSON envelope')
    .option('--all-homes', 'Scan /root, /home/*, /Users/*, and WSL Windows homes when present')
    .option('--home <path>', 'Add a specific home directory to scan', collectRepeatedOption, [])
    .option('--root <path>', 'Add an application root to scan for project evidence', collectRepeatedOption, [])
    .option('--no-progress', 'Suppress progress output on stderr')
    .option('--quiet', 'Suppress progress and banners on stderr')
    .option('--verbose', 'Emit extra diagnostics on stderr')
    .option('--progress-json', 'Emit progress as NDJSON events to stderr')
    .option('--progress-interval <ms>', 'Progress tick interval in milliseconds')
    .option('--events-file <path>', 'Append structured NDJSON events to a 0600-mode file')
    .option('--redact', 'Hash $HOME-prefixed paths; scrub AWS/GitHub/npm/JWT patterns')
    .option('--no-persist', 'Do not persist the report to $GENIE_HOME/sec-scan/')
    .option('--impact-surface', 'Scan for at-risk local material (secrets, wallets, browsers)')
    .option('--phase-budget <name=ms>', 'Budget (ms) for a named phase (repeatable)', collectRepeatedOption, [])
    .action((options: SecScanCommandOptions) => {
      const exitCode = runSecScan(options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('remediate')
    .description('Reversibly remediate findings from a sec scan (dry-run by default)')
    .option('--dry-run', 'Generate a plan manifest without mutating anything (default mode)')
    .option('--apply', 'Execute a previously-generated plan (requires --plan)')
    .option('--resume <path>', 'Resume a previously-aborted apply from its resume file')
    .option('--scan-report <path>', 'Path to a scan JSON report (use with --dry-run)')
    .option('--scan-id <ulid>', 'ULID of a persisted scan in $GENIE_HOME/sec-scan/')
    .option('--plan <path>', 'Path to a frozen plan manifest (required with --apply)')
    .option('--quarantine-dir <path>', 'Override quarantine root (must be on same device as targets)')
    .option('--unsafe-unverified <id>', 'Bypass binary signature requirement (logs incident id + ack)')
    .option('--remediate-partial', 'Allow remediation against a coverage-capped scan (requires typed ack)')
    .option('--confirm-incomplete-scan <ack>', 'Typed ack for --remediate-partial')
    .option('--kill-pid <pid>', 'Authorize SIGTERM to a PID matching a plan entry', collectKillPid, [])
    .option('--auto-confirm-from <path>', 'Non-interactive consent map (testing only)')
    .option('--json', 'Emit JSON summary to stdout')
    .action((options: SecRemediateCommandOptions) => {
      const normalized: SecRemediateCommandOptions = { ...options };
      if (!normalized.dryRun && !normalized.apply && !normalized.resume) {
        normalized.dryRun = true;
      }
      const exitCode = runSecRemediate(normalized, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('restore <quarantine-id>')
    .description('Restore every action under a quarantine id (sha256-verified per file)')
    .action((quarantineId: string) => {
      const exitCode = runSecRestore(quarantineId, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('rollback <scan-id>')
    .description('Bulk undo every quarantined action for a scan (walks audit log in reverse)')
    .option('--json', 'Emit JSON summary to stdout')
    .action((scanId: string, options: SecRollbackOptions) => {
      const exitCode = runSecRollback(scanId, options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  const quarantine = sec.command('quarantine').description('Quarantine lifecycle (list, gc)');

  quarantine
    .command('list')
    .description('List quarantines with id, timestamp, size, status, scan_id')
    .option('--json', 'Emit JSON rows to stdout')
    .action((options: SecQuarantineListOptions) => {
      const exitCode = runSecQuarantineList(options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  quarantine
    .command('gc')
    .description('Delete restored/abandoned quarantines older than <duration> (refuses active)')
    .requiredOption('--older-than <duration>', 'Duration threshold, e.g. 30d, 24h, 15m')
    .option('--confirm-gc <token>', 'Typed ack: CONFIRM-GC-<6-hex>')
    .option('--json', 'Emit JSON summary to stdout')
    .action((options: SecQuarantineGcOptions) => {
      const exitCode = runSecQuarantineGc(options, deps);
      applySecScanExitCode(exitCode, deps);
    });

  sec
    .command('verify-install')
    .description('Verify the cosign signature + SLSA provenance of the running @automagik/genie release.')
    .option('--offline', 'Skip the Rekor transparency-log check (signature + cert still verified)')
    .option('--json', 'Emit machine-readable verification report on stdout')
    .option('--tarball <path>', 'Point at a specific release tarball (for local verification)')
    .option('--bundle-dir <path>', 'Directory containing <pkg>.tgz + .sig + .cert + provenance')
    .action((options: SecVerifyInstallOptions) => {
      const exitCode = runVerifyInstallCommand(options, deps);
      applySecScanExitCode(exitCode, deps);
    });
}
