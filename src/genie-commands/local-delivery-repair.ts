/**
 * Release-dogfood-only local delivery input boundary.
 *
 * The hidden update mode accepts one bounded exact-schema JSON value, then
 * snapshots every caller-owned file into a private directory before any
 * evidence verification or archive extraction. Production verification still
 * happens in `repairMissingDelivery`; this module only turns unstable external
 * paths into stable, bounded, physical inputs.
 */

import { createHash } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import type { DeliveryEvidenceChannel, DeliveryEvidencePlatformId } from '../lib/codex-delivery-evidence.js';
import { parseReleaseVersion } from '../lib/codex-release-version.js';
import type { PinnedManifest } from './codex-delivery-repair.js';

export const LOCAL_DELIVERY_REPAIR_ENABLE_ENV = 'GENIE_RELEASE_DOGFOOD';
export const LOCAL_DELIVERY_REPAIR_REQUEST_MAX_BYTES = 16 * 1024;

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const COPY_CHUNK_BYTES = 1024 * 1024;
const O_NOFOLLOW = (constants.O_NOFOLLOW ?? 0) as number;
const CHANNELS = new Set<DeliveryEvidenceChannel>(['stable', 'homolog', 'dev']);
const PLATFORM_IDS = new Set<DeliveryEvidencePlatformId>([
  'linux-x64-glibc',
  'linux-x64-musl',
  'linux-arm64',
  'darwin-arm64',
]);
const REQUEST_KEYS = ['artifact', 'bundle', 'descriptor', 'manifest', 'platformId', 'schemaVersion'] as const;
const MANIFEST_KEYS = ['channel', 'platforms', 'released_at', 'schema_version', 'tarball_base', 'version'] as const;

export interface LocalDeliveryRepairRequest {
  schemaVersion: 1;
  platformId: DeliveryEvidencePlatformId;
  artifact: string;
  manifest: string;
  descriptor: string;
  bundle: string;
}

export interface MaterializedLocalDeliveryRepair {
  platformId: DeliveryEvidencePlatformId;
  manifest: PinnedManifest;
  artifactPath: string;
  descriptorBytes: Buffer;
  bundleBytes: Buffer;
}

interface SnapshottedFile {
  path: string;
  identity: string;
}

export function assertLocalDeliveryRepairEnabled(value: string | undefined): void {
  if (value !== '1') {
    throw new Error(`${LOCAL_DELIVERY_REPAIR_ENABLE_ENV}=1 is required for local delivery publication`);
  }
}

/** Parse the command argument without accepting aliases, defaults, or extension fields. */
export function parseLocalDeliveryRepairRequest(raw: string): LocalDeliveryRepairRequest {
  const byteLength = Buffer.byteLength(raw, 'utf8');
  if (byteLength === 0 || byteLength > LOCAL_DELIVERY_REPAIR_REQUEST_MAX_BYTES) {
    throw new Error(`local delivery request must be 1-${LOCAL_DELIVERY_REPAIR_REQUEST_MAX_BYTES} UTF-8 bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('local delivery request is malformed JSON');
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, REQUEST_KEYS)) {
    throw new Error('local delivery request does not have the exact schema-v1 fields');
  }
  if (parsed.schemaVersion !== 1) throw new Error('local delivery request schemaVersion is invalid');
  if (typeof parsed.platformId !== 'string' || !PLATFORM_IDS.has(parsed.platformId as DeliveryEvidencePlatformId)) {
    throw new Error('local delivery request platformId is invalid');
  }
  for (const field of ['artifact', 'manifest', 'descriptor', 'bundle'] as const) {
    assertCanonicalPathSyntax(parsed[field], field);
  }
  const paths = [parsed.artifact, parsed.manifest, parsed.descriptor, parsed.bundle] as string[];
  if (new Set(paths).size !== paths.length) {
    throw new Error('local delivery request paths must be distinct');
  }
  return parsed as unknown as LocalDeliveryRepairRequest;
}

/**
 * Snapshot all external inputs into `privateRoot`. The root is created by
 * update's mode-0700 staging primitive; no caller path is used after return.
 */
export function materializeLocalDeliveryRepair(
  raw: string,
  privateRoot: string,
  expectedPlatformId: string,
  runningVersion: string,
): MaterializedLocalDeliveryRepair {
  const request = parseLocalDeliveryRepairRequest(raw);
  if (request.platformId !== expectedPlatformId) {
    throw new Error(`local delivery platform ${request.platformId} differs from this runtime (${expectedPlatformId})`);
  }

  const manifestSnapshot = snapshotPhysicalFile(
    request.manifest,
    join(privateRoot, '.local-release-manifest.json'),
    MAX_MANIFEST_BYTES,
    'manifest',
  );
  const manifestBytes = readSnapshotBytes(manifestSnapshot.path, MAX_MANIFEST_BYTES, 'manifest');
  const manifest = parsePinnedManifest(manifestBytes, request.platformId);
  const expectedVersion = parseReleaseVersion(runningVersion)?.canonical;
  if (expectedVersion === undefined || manifest.version !== expectedVersion) {
    throw new Error(
      `local delivery manifest version ${manifest.version} differs from the running binary VERSION ${runningVersion}`,
    );
  }

  const releaseName = `genie-${manifest.version}-${request.platformId}.tar.gz`;
  if (basename(request.artifact) !== releaseName) {
    throw new Error(`local delivery artifact name must be ${releaseName}`);
  }
  const artifact = snapshotPhysicalFile(
    request.artifact,
    join(privateRoot, releaseName),
    MAX_ARTIFACT_BYTES,
    'artifact',
  );
  const descriptor = snapshotPhysicalFile(
    request.descriptor,
    join(privateRoot, '.local-delivery-descriptor.json'),
    MAX_DESCRIPTOR_BYTES,
    'descriptor',
  );
  const bundle = snapshotPhysicalFile(
    request.bundle,
    join(privateRoot, '.local-delivery-bundle.json'),
    MAX_BUNDLE_BYTES,
    'bundle',
  );
  const identities = [artifact, manifestSnapshot, descriptor, bundle].map((file) => file.identity);
  if (new Set(identities).size !== identities.length) {
    throw new Error('local delivery request files must be distinct physical files');
  }
  return {
    platformId: request.platformId,
    manifest,
    artifactPath: artifact.path,
    descriptorBytes: readSnapshotBytes(descriptor.path, MAX_DESCRIPTOR_BYTES, 'descriptor'),
    bundleBytes: readSnapshotBytes(bundle.path, MAX_BUNDLE_BYTES, 'bundle'),
  };
}

function parsePinnedManifest(bytes: Buffer, platformId: DeliveryEvidencePlatformId): PinnedManifest {
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw new Error('local delivery manifest is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('local delivery manifest is malformed JSON');
  }
  if (!isPlainObject(parsed) || !hasExactKeys(parsed, MANIFEST_KEYS)) {
    throw new Error('local delivery manifest does not have the exact schema-v1 fields');
  }
  if (parsed.schema_version !== 1) throw new Error('local delivery manifest schema_version is invalid');
  if (typeof parsed.channel !== 'string' || !CHANNELS.has(parsed.channel as DeliveryEvidenceChannel)) {
    throw new Error('local delivery manifest channel is invalid');
  }
  if (typeof parsed.version !== 'string' || parseReleaseVersion(parsed.version) === null) {
    throw new Error('local delivery manifest version is invalid');
  }
  if (typeof parsed.released_at !== 'string' || !Number.isFinite(Date.parse(parsed.released_at))) {
    throw new Error('local delivery manifest released_at is invalid');
  }
  const releaseTag = `v${parsed.version}`;
  if (parsed.tarball_base !== `https://github.com/automagik-dev/genie/releases/download/${releaseTag}`) {
    throw new Error('local delivery manifest tarball_base is invalid');
  }
  if (
    !Array.isArray(parsed.platforms) ||
    parsed.platforms.length === 0 ||
    !parsed.platforms.every(
      (platform) => typeof platform === 'string' && PLATFORM_IDS.has(platform as DeliveryEvidencePlatformId),
    ) ||
    new Set(parsed.platforms).size !== parsed.platforms.length ||
    !parsed.platforms.includes(platformId)
  ) {
    throw new Error('local delivery manifest platforms are invalid');
  }
  const manifestBytes = bytes.toString('utf8');
  return {
    schema_version: 1,
    channel: parsed.channel as DeliveryEvidenceChannel,
    version: parsed.version,
    released_at: parsed.released_at,
    tarball_base: parsed.tarball_base as string,
    platforms: [...parsed.platforms] as string[],
    manifestBytes,
    manifestSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function snapshotPhysicalFile(source: string, destination: string, maxBytes: number, label: string): SnapshottedFile {
  let canonical: string;
  try {
    canonical = realpathSync(source);
  } catch (cause) {
    throw new Error(`local delivery ${label} path is unavailable: ${errorText(cause)}`);
  }
  if (canonical !== source) {
    throw new Error(`local delivery ${label} path is not its absolute canonical physical path`);
  }
  let visible: BigIntStats;
  try {
    visible = lstatSync(source, { bigint: true });
  } catch (cause) {
    throw new Error(`local delivery ${label} path is unreadable: ${errorText(cause)}`);
  }
  assertSourceStat(visible, maxBytes, label);

  let sourceFd: number | null = null;
  let destinationFd: number | null = null;
  try {
    sourceFd = openSync(source, constants.O_RDONLY | O_NOFOLLOW);
    const held = fstatSync(sourceFd, { bigint: true });
    assertSourceStat(held, maxBytes, label);
    if (!sameFileSnapshot(visible, held)) {
      throw new Error(`local delivery ${label} changed before snapshot`);
    }
    destinationFd = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    copyBounded(sourceFd, destinationFd, Number(held.size), maxBytes, label);
    fsyncSync(destinationFd);
    const after = fstatSync(sourceFd, { bigint: true });
    const afterVisible = lstatSync(source, { bigint: true });
    if (!sameFileSnapshot(held, after) || !sameFileSnapshot(after, afterVisible) || realpathSync(source) !== source) {
      throw new Error(`local delivery ${label} changed during snapshot`);
    }
    return { path: destination, identity: `${held.dev}:${held.ino}` };
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('local delivery ')) throw cause;
    throw new Error(`local delivery ${label} could not be snapshotted: ${errorText(cause)}`);
  } finally {
    if (destinationFd !== null) closeSync(destinationFd);
    if (sourceFd !== null) closeSync(sourceFd);
  }
}

function readSnapshotBytes(path: string, maxBytes: number, label: string): Buffer {
  const stat = lstatSync(path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > BigInt(maxBytes)) {
    throw new Error(`private local delivery ${label} snapshot has an unsafe shape`);
  }
  const bytes = readFileSync(path);
  if (bytes.length !== Number(stat.size)) throw new Error(`private local delivery ${label} snapshot changed`);
  return bytes;
}

function copyBounded(
  sourceFd: number,
  destinationFd: number,
  expectedBytes: number,
  maxBytes: number,
  label: string,
): void {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_CHUNK_BYTES, Math.max(expectedBytes, 1)));
  let total = 0;
  while (total < expectedBytes) {
    const count = readSync(sourceFd, buffer, 0, Math.min(buffer.length, expectedBytes - total), null);
    if (count === 0) break;
    total += count;
    if (total > maxBytes) throw new Error(`local delivery ${label} exceeds the byte limit`);
    let written = 0;
    while (written < count) {
      written += writeSync(destinationFd, buffer, written, count - written, null);
    }
  }
  if (total !== expectedBytes) throw new Error(`local delivery ${label} changed during snapshot`);
  const trailing = readSync(sourceFd, buffer, 0, 1, null);
  if (trailing !== 0) throw new Error(`local delivery ${label} changed during snapshot`);
}

function assertSourceStat(stat: BigIntStats, maxBytes: number, label: string): void {
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`local delivery ${label} is not a physical regular file`);
  }
  if (stat.size > BigInt(maxBytes)) throw new Error(`local delivery ${label} exceeds the byte limit`);
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertCanonicalPathSyntax(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    !isAbsolute(value)
  ) {
    throw new Error(`local delivery request ${field} must be a bounded absolute canonical path`);
  }
}

function hasExactKeys<const T extends readonly string[]>(value: Record<string, unknown>, expected: T): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
