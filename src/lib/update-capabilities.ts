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

import { createHash } from 'node:crypto';
import { type Stats, closeSync, existsSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';
import { VERSION } from './version.js';

/**
 * Current Codex activation protocol. Protocol 1 includes the rollback-floor
 * rule itself, so any binary reporting `>= 1` is known to enforce the same gate.
 */
export const CODEX_ACTIVATION_PROTOCOL = 1 as const;

/** Intent schemas this binary can read; a rollback target must cover every extant schema. */
export const READABLE_INTENT_SCHEMAS: readonly number[] = [1];

const CAPABILITY_SCHEMA_VERSION = 1 as const;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_BINARY_BYTES = 256 * 1024 * 1024;

/**
 * The on-disk file this process runs AS — the file the sidecar hashes and the
 * rollback floor rehashes. Two shapes exist and each must resolve to a real,
 * hashable file:
 *
 * - Interpreted (`bun src/genie.ts`, or the shebang'd `dist/genie.js`):
 *   `process.execPath` is the `bun` interpreter and `argv[1]` is the genie
 *   script itself. The script is the payload, so we return `argv[1]`.
 * - Compiled single-file (`bun build --compile`, the shipped release binary):
 *   `argv[1]` is the virtual `/$bunfs/root/genie` entry embedded inside the
 *   executable — absent on the real filesystem (a no-follow open ENOENTs) — and
 *   `process.execPath` IS the real on-disk binary. We return `execPath`.
 *
 * Probing a backup spawns that backup path, so under a compiled backup this
 * resolves to `execPath` = the backup binary being verified, which is exactly
 * the file `publishBackupCapabilitySidecar` hashed. Preferring `execPath` when
 * `argv[1]` is a virtual bunfs entry or is absent on disk keeps probe/sidecar
 * hashes in agreement on shipped binaries while preserving script-hashing in
 * interpreted mode.
 */
export function resolveSelfBinaryPath(): string {
  const argvScript = process.argv[1];
  if (
    typeof argvScript === 'string' &&
    argvScript.length > 0 &&
    !isEmbeddedBunfsPath(argvScript) &&
    existsSync(argvScript)
  ) {
    return argvScript;
  }
  return process.execPath;
}

/**
 * Detect the virtual entrypoint path a `bun --compile` single-file executable
 * reports as `argv[1]`: `/$bunfs/root/...` on posix, `B:\~BUN\root\...` on
 * Windows. Neither names a real on-disk file, so the self-hash must target the
 * executable (`process.execPath`) instead.
 */
function isEmbeddedBunfsPath(path: string): boolean {
  return path.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(path);
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
// No-follow bounded filesystem primitives
// ============================================================================

interface HashOutcome {
  digest: string;
  identity: string;
}

type SafeHashOutcome = { ok: true; digest: string; identity: string } | { ok: false; detail: string };

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

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isSchemaList(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => Number.isInteger(item) && item >= 1);
}
