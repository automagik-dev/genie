/**
 * Update capability probe + digest-bound rollback capability floor.
 *
 * Binary rollback must never hand control back to an updater that bypasses the
 * Codex activation gate. Every fixed binary exposes a bounded, read-only
 * `update --print-update-capabilities --json` probe reporting exactly
 * `{schemaVersion:1, reportedVersion, binarySha256, codexActivationProtocol,
 * readableIntentSchemas}`. When a binary is backed up for rollback it is paired
 * atomically with a `<backup>.capabilities.json` sidecar that binds the same
 * facts to the authenticated delivery record, backup slot, expected previous
 * version, and delivery id.
 *
 * Before any live-binary exchange, `enforceRollbackCapabilityFloor` re-opens the
 * backup and sidecar no-follow, fstat-confirms both are regular files, rehashes
 * the backup under a bounded read, runs the no-shell probe in a sterile
 * environment (<=5s, <=64 KiB, empty stderr, exactly one schema-valid JSON
 * object), requires sidecar/probe/rehash agreement, `codexActivationProtocol >=
 * 1`, support for every extant intent schema, and finally revalidates both
 * device/inode identities immediately before returning `ok`. Any mismatch,
 * tamper, malformed probe, or replacement between check/probe/exchange refuses
 * before mutation. This module never renames, swaps, or deletes the live binary;
 * it only proves a candidate backup is safe to restore.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Stats, closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { atomicWriteFileSync } from './codex-activation-persistence.js';
import { VERSION } from './version.js';

/**
 * Current Codex activation protocol. Protocol 1 includes the rollback-floor
 * rule itself, so any binary reporting `>= 1` is known to enforce the same gate.
 */
export const CODEX_ACTIVATION_PROTOCOL = 1 as const;

/** Intent schemas this binary can read; a rollback target must cover every extant schema. */
export const READABLE_INTENT_SCHEMAS: readonly number[] = [1];

/**
 * The intent schema currently written by A's activation store (`RefreshIntent`
 * carries `schemaVersion: 1`). A rollback target must declare it can read every
 * extant schema so it never resumes an interrupted transaction it cannot parse.
 */
export const EXTANT_INTENT_SCHEMAS: readonly number[] = [1];

const CAPABILITY_SCHEMA_VERSION = 1 as const;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 8 * 1024;
const CAPABILITIES_ARGS: readonly string[] = ['update', '--print-update-capabilities', '--json'];

/**
 * The on-disk file this process runs AS. Genie ships as a single-file `bun`
 * bundle invoked through its shebang, so `process.execPath` is the `bun`
 * interpreter and `argv[1]` is the genie script itself — the file the sidecar
 * hashes and the rollback floor rehashes. Probing a backup spawns that backup
 * path, so `argv[1]` is exactly the backup binary being verified.
 */
export function resolveSelfBinaryPath(): string {
  const argvScript = process.argv[1];
  if (typeof argvScript === 'string' && argvScript.length > 0) return argvScript;
  return process.execPath;
}

// ============================================================================
// Capability report (probe output)
// ============================================================================

export interface UpdateCapabilityReport {
  schemaVersion: 1;
  reportedVersion: string;
  binarySha256: string;
  codexActivationProtocol: number;
  readableIntentSchemas: number[];
}

export interface BuildCapabilityReportOptions {
  binaryPath?: string;
  version?: string;
}

/**
 * Build this binary's capability report by self-hashing its own executable.
 * The `binarySha256` a probe reports must equal the rehash a rollback performs
 * of the same on-disk file, which is what makes tamper detectable.
 */
export function buildUpdateCapabilityReport(options: BuildCapabilityReportOptions = {}): UpdateCapabilityReport {
  const binaryPath = options.binaryPath ?? resolveSelfBinaryPath();
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    reportedVersion: options.version ?? VERSION,
    binarySha256: hashRegularFileNoFollow(binaryPath).digest,
    codexActivationProtocol: CODEX_ACTIVATION_PROTOCOL,
    readableIntentSchemas: [...READABLE_INTENT_SCHEMAS],
  };
}

/** Serialize the report as exactly one compact JSON object (no trailing content). */
export function serializeUpdateCapabilityReport(report: UpdateCapabilityReport): string {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    reportedVersion: report.reportedVersion,
    binarySha256: report.binarySha256,
    codexActivationProtocol: report.codexActivationProtocol,
    readableIntentSchemas: report.readableIntentSchemas,
  });
}

/**
 * The `update --print-update-capabilities --json` handler: emit exactly one
 * schema-valid JSON object to stdout, nothing to stderr, and exit 0. The probe
 * contract requires this output be the only thing on stdout.
 */
export function printUpdateCapabilities(write: (text: string) => void = (text) => process.stdout.write(text)): void {
  write(`${serializeUpdateCapabilityReport(buildUpdateCapabilityReport())}\n`);
}

/** Parse and totally validate an untrusted capability report (probe stdout). */
export function parseUpdateCapabilityReport(text: string): UpdateCapabilityReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const allowed = new Set([
    'schemaVersion',
    'reportedVersion',
    'binarySha256',
    'codexActivationProtocol',
    'readableIntentSchemas',
  ]);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return null;
  if (record.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return null;
  if (typeof record.reportedVersion !== 'string' || record.reportedVersion.length === 0) return null;
  if (!isSha256(record.binarySha256)) return null;
  if (typeof record.codexActivationProtocol !== 'number' || !Number.isInteger(record.codexActivationProtocol))
    return null;
  if (!isSchemaList(record.readableIntentSchemas)) return null;
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    reportedVersion: record.reportedVersion,
    binarySha256: record.binarySha256,
    codexActivationProtocol: record.codexActivationProtocol,
    readableIntentSchemas: [...(record.readableIntentSchemas as number[])],
  };
}

// ============================================================================
// Capability sidecar (paired with a backup binary)
// ============================================================================

export interface CapabilitySidecar {
  schemaVersion: 1;
  /** Binds to A's authenticated delivery record transaction id. */
  deliveryId: string;
  /** The backup slot identity (basename of the backup binary). */
  backupSlot: string;
  /** The version this backup restores TO (the probe's reportedVersion must equal it). */
  expectedPreviousVersion: string;
  /** SHA-256 of the backup binary, no-follow, at publication. */
  binarySha256: string;
  codexActivationProtocol: number;
  readableIntentSchemas: number[];
}

const SIDECAR_KEYS = new Set([
  'schemaVersion',
  'deliveryId',
  'backupSlot',
  'expectedPreviousVersion',
  'binarySha256',
  'codexActivationProtocol',
  'readableIntentSchemas',
]);

/** Derive the sidecar path paired with a backup binary. */
export function capabilitySidecarPath(backupBinaryPath: string): string {
  return `${backupBinaryPath}.capabilities.json`;
}

export interface PublishBackupSidecarInput {
  backupBinaryPath: string;
  expectedPreviousVersion: string;
  deliveryId: string;
}

/**
 * Publish the digest-bound sidecar next to a backup binary. Opens the backup
 * no-follow, fstat-confirms a regular file, hashes it under a bounded read,
 * writes the sidecar atomically (fsyncing the parent), then immediately
 * revalidates the backup's device/inode identity so a swap during publication
 * is refused rather than sealed into the sidecar.
 */
export function publishBackupCapabilitySidecar(input: PublishBackupSidecarInput): CapabilitySidecar {
  if (!isAbsolute(input.backupBinaryPath)) {
    throw new Error(`backup binary path must be absolute: ${input.backupBinaryPath}`);
  }
  if (!isHex128(input.deliveryId)) {
    throw new Error('sidecar deliveryId must be 32 lowercase hex characters');
  }
  const before = hashRegularFileNoFollow(input.backupBinaryPath);
  const sidecar: CapabilitySidecar = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    deliveryId: input.deliveryId,
    backupSlot: basename(input.backupBinaryPath),
    expectedPreviousVersion: input.expectedPreviousVersion,
    binarySha256: before.digest,
    codexActivationProtocol: CODEX_ACTIVATION_PROTOCOL,
    readableIntentSchemas: [...READABLE_INTENT_SCHEMAS],
  };
  const path = capabilitySidecarPath(input.backupBinaryPath);
  atomicWriteFileSync(path, `${JSON.stringify(sidecar, null, 2)}\n`, { backup: false });
  const after = hashRegularFileNoFollow(input.backupBinaryPath);
  if (after.identity !== before.identity || after.digest !== before.digest) {
    throw new Error('backup binary changed while publishing its capability sidecar');
  }
  return sidecar;
}

function parseCapabilitySidecar(text: string): CapabilitySidecar | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SIDECAR_KEYS.has(key))) return null;
  if (record.schemaVersion !== CAPABILITY_SCHEMA_VERSION) return null;
  if (!isHex128(record.deliveryId)) return null;
  if (typeof record.backupSlot !== 'string' || record.backupSlot.length === 0) return null;
  if (typeof record.expectedPreviousVersion !== 'string' || record.expectedPreviousVersion.length === 0) return null;
  if (!isSha256(record.binarySha256)) return null;
  if (typeof record.codexActivationProtocol !== 'number' || !Number.isInteger(record.codexActivationProtocol))
    return null;
  if (!isSchemaList(record.readableIntentSchemas)) return null;
  return {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    deliveryId: record.deliveryId,
    backupSlot: record.backupSlot,
    expectedPreviousVersion: record.expectedPreviousVersion,
    binarySha256: record.binarySha256,
    codexActivationProtocol: record.codexActivationProtocol,
    readableIntentSchemas: [...(record.readableIntentSchemas as number[])],
  };
}

// ============================================================================
// Rollback capability floor (probe + agreement + TOCTOU revalidation)
// ============================================================================

export type RollbackFloorResult =
  | { ok: true; restoredVersion: string; binarySha256: string }
  | { ok: false; reason: string };

export interface RollbackFloorOptions {
  backupBinaryPath: string;
  /** Injectable probe runner (tests); production spawns the backup no-shell. */
  runProbe?: (backupBinaryPath: string) => ProbeOutcome;
}

export interface ProbeOutcome {
  status: 'ok' | 'timeout' | 'overflow' | 'spawn-failed' | 'nonzero' | 'stderr' | 'unparsable';
  report?: UpdateCapabilityReport;
  detail: string;
}

/**
 * Prove a candidate backup binary satisfies the activation-protocol floor before
 * any exchange. Every refusal precedes mutation and leaves the live binary,
 * backup, and every integration file untouched.
 */
export function enforceRollbackCapabilityFloor(options: RollbackFloorOptions): RollbackFloorResult {
  const backupPath = options.backupBinaryPath;
  if (!isAbsolute(backupPath)) return refuse(`backup binary path must be absolute: ${backupPath}`);

  const first = tryHashRegularFileNoFollow(backupPath);
  if (!first.ok) return refuse(`backup binary is not a safe regular file: ${first.detail}`);

  const sidecarText = tryReadRegularFileNoFollow(capabilitySidecarPath(backupPath), MAX_SIDECAR_BYTES);
  if (!sidecarText.ok) {
    return refuse(
      `no digest-bound capability sidecar for this backup (${sidecarText.detail}); refusing to restore a pre-contract binary. Select a compatible signed release.`,
    );
  }
  const sidecar = parseCapabilitySidecar(sidecarText.content);
  if (sidecar === null) return refuse('capability sidecar failed schema-1 validation');

  const staticFloor = checkStaticFloor(sidecar, first.digest);
  if (!staticFloor.ok) return staticFloor;

  const probe = (options.runProbe ?? runBackupCapabilityProbe)(backupPath);
  const agreement = checkProbeAgreement(probe, sidecar, first.digest);
  if (!agreement.ok) return agreement;

  // Revalidate BOTH identities immediately before returning ok: a replacement
  // of the backup or its sidecar between the check/probe and the exchange must
  // be caught here, not sealed as verified.
  const second = tryHashRegularFileNoFollow(backupPath);
  if (!second.ok || second.identity !== first.identity || second.digest !== first.digest) {
    return refuse('backup binary changed between capability check and exchange');
  }
  const sidecarRecheck = tryReadRegularFileNoFollow(capabilitySidecarPath(backupPath), MAX_SIDECAR_BYTES);
  if (!sidecarRecheck.ok || sidecarRecheck.content !== sidecarText.content) {
    return refuse('capability sidecar changed between capability check and exchange');
  }
  return { ok: true, restoredVersion: sidecar.expectedPreviousVersion, binarySha256: first.digest };
}

/** Static (non-probe) floor: sidecar binds this exact backup and clears protocol/intent-schema. */
function checkStaticFloor(sidecar: CapabilitySidecar, rehash: string): RollbackFloorResult {
  if (sidecar.binarySha256 !== rehash) {
    return refuse('capability sidecar hash does not match the current backup binary (tampered or replaced)');
  }
  if (sidecar.codexActivationProtocol < CODEX_ACTIVATION_PROTOCOL) {
    return refuse(
      `backup activation protocol ${sidecar.codexActivationProtocol} is below the required floor ${CODEX_ACTIVATION_PROTOCOL}`,
    );
  }
  if (!coversEveryExtantIntentSchema(sidecar.readableIntentSchemas)) {
    return refuse('backup does not declare support for every extant activation intent schema');
  }
  return { ok: true, restoredVersion: sidecar.expectedPreviousVersion, binarySha256: rehash };
}

/** The runtime probe must agree with the sidecar and the on-disk rehash exactly. */
function checkProbeAgreement(probe: ProbeOutcome, sidecar: CapabilitySidecar, rehash: string): RollbackFloorResult {
  if (probe.status !== 'ok' || probe.report === undefined) {
    return refuse(`capability probe did not return a valid report (${probe.status}: ${probe.detail})`);
  }
  const report = probe.report;
  if (report.binarySha256 !== rehash || report.binarySha256 !== sidecar.binarySha256) {
    return refuse('capability probe hash disagrees with the backup binary or its sidecar');
  }
  if (report.reportedVersion !== sidecar.expectedPreviousVersion) {
    return refuse('capability probe version disagrees with the sidecar expected version');
  }
  if (report.codexActivationProtocol < CODEX_ACTIVATION_PROTOCOL) {
    return refuse(`capability probe reports activation protocol ${report.codexActivationProtocol} below floor`);
  }
  if (!coversEveryExtantIntentSchema(report.readableIntentSchemas)) {
    return refuse('capability probe does not declare support for every extant activation intent schema');
  }
  return { ok: true, restoredVersion: sidecar.expectedPreviousVersion, binarySha256: rehash };
}

/**
 * Run the capability probe by spawning the backup binary directly (no shell),
 * with an absolute path, a sterile allow-list environment, a 5-second timeout,
 * and a 64-KiB output cap. Any deviation is a typed non-ok outcome.
 */
export function runBackupCapabilityProbe(backupBinaryPath: string): ProbeOutcome {
  if (!isAbsolute(backupBinaryPath)) {
    return { status: 'spawn-failed', detail: `backup binary path is not absolute: ${backupBinaryPath}` };
  }
  const result = spawnSync(backupBinaryPath, [...CAPABILITIES_ARGS], {
    env: sterileProbeEnv(),
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: PROBE_MAX_OUTPUT_BYTES,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  return evaluateProbeResult(result);
}

function evaluateProbeResult(result: SpawnSyncReturns<string>): ProbeOutcome {
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { status: 'timeout', detail: 'probe exceeded the 5-second timeout' };
    if (code === 'ENOBUFS') return { status: 'overflow', detail: 'probe exceeded the 64-KiB output cap' };
    return { status: 'spawn-failed', detail: `probe spawn failed: ${result.error.message}` };
  }
  if (result.signal) return { status: 'spawn-failed', detail: `probe terminated by signal ${result.signal}` };
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  if (Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > PROBE_MAX_OUTPUT_BYTES) {
    return { status: 'overflow', detail: 'probe combined output exceeded the 64-KiB cap' };
  }
  if (result.status !== 0) return { status: 'nonzero', detail: `probe exited ${result.status ?? 'null'}` };
  if (stderr.length > 0) return { status: 'stderr', detail: 'probe wrote to stderr' };
  const report = parseUpdateCapabilityReport(stdout);
  if (report === null)
    return { status: 'unparsable', detail: 'probe stdout was not exactly one schema-valid JSON object' };
  return { status: 'ok', report, detail: 'probe ok' };
}

/** A from-scratch allow-list environment; no inherited GENIE_UPDATE / CI / CODEX_THREAD_ID leaks in. */
function sterileProbeEnv(): NodeJS.ProcessEnv {
  if (process.platform === 'win32') {
    return {
      Path: process.env.Path ?? process.env.PATH ?? '',
      USERPROFILE: process.env.USERPROFILE ?? '',
      TEMP: process.env.TEMP ?? '',
      TMP: process.env.TMP ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      ComSpec: process.env.ComSpec ?? '',
      PATHEXT: process.env.PATHEXT ?? '',
    };
  }
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '',
    LANG: 'C',
  };
}

// ============================================================================
// No-follow bounded filesystem primitives
// ============================================================================

interface HashOutcome {
  digest: string;
  identity: string;
}

type SafeHashOutcome = { ok: true; digest: string; identity: string } | { ok: false; detail: string };
type SafeReadOutcome = { ok: true; content: string; identity: string } | { ok: false; detail: string };

const NO_FOLLOW = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0;

/** Hash a regular file opened no-follow, returning its dev:ino identity; throws on any unsafe path. */
function hashRegularFileNoFollow(path: string): HashOutcome {
  const outcome = tryHashRegularFileNoFollow(path);
  if (!outcome.ok) throw new Error(`cannot hash ${path}: ${outcome.detail}`);
  return { digest: outcome.digest, identity: outcome.identity };
}

function tryHashRegularFileNoFollow(path: string): SafeHashOutcome {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    return { ok: false, detail: openErrorDetail(error) };
  }
  try {
    const stat = fstatSync(fd);
    const unsafe = assertRegular(stat);
    if (unsafe) return { ok: false, detail: unsafe };
    if (stat.size > MAX_BINARY_BYTES) return { ok: false, detail: `file exceeds ${MAX_BINARY_BYTES} bytes` };
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(HASH_BUFFER_BYTES);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      total += read;
      if (total > MAX_BINARY_BYTES) return { ok: false, detail: 'file grew past the read cap' };
      digest.update(buffer.subarray(0, read));
    }
    return { ok: true, digest: digest.digest('hex'), identity: `${stat.dev}:${stat.ino}` };
  } finally {
    closeSync(fd);
  }
}

function tryReadRegularFileNoFollow(path: string, maxBytes: number): SafeReadOutcome {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    return { ok: false, detail: openErrorDetail(error) };
  }
  try {
    const stat = fstatSync(fd);
    const unsafe = assertRegular(stat);
    if (unsafe) return { ok: false, detail: unsafe };
    if (stat.size > maxBytes) return { ok: false, detail: `file exceeds ${maxBytes} bytes` };
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
    let total = 0;
    while (total < buffer.length) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read <= 0) break;
      total += read;
    }
    return { ok: true, content: buffer.subarray(0, total).toString('utf8'), identity: `${stat.dev}:${stat.ino}` };
  } finally {
    closeSync(fd);
  }
}

function assertRegular(stat: Stats): string | null {
  if (stat.isSymbolicLink()) return 'path is a symlink';
  if (!stat.isFile()) return 'path is not a regular file';
  return null;
}

function openErrorDetail(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ELOOP') return 'path is a symlink (no-follow open rejected)';
  if (code === 'ENOENT') return 'path is absent';
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// Small validators
// ============================================================================

function refuse(reason: string): RollbackFloorResult {
  return { ok: false, reason };
}

function coversEveryExtantIntentSchema(readable: readonly number[]): boolean {
  const set = new Set(readable);
  return EXTANT_INTENT_SCHEMAS.every((schema) => set.has(schema));
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isHex128(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
}

function isSchemaList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 1);
}
