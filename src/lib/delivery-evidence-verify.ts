/**
 * Offline-verifiable release delivery evidence.
 *
 * A release producer signs the SHA-256 of the exact descriptor bytes in an
 * in-toto DSSE statement. This module is the only runtime minter of
 * `VerifiedDeliveryEvidence`: callers provide selected/downloaded/candidate
 * facts, but cannot provide trusted provenance strings. The production verifier
 * always uses the embedded public-good Sigstore root and the exact release
 * workflow identity. Tests may inject only the cryptographic verification step;
 * descriptor, manifest, statement, and caller-observation bindings remain live.
 *
 * Moved verbatim out of the retired Codex delivery-evidence module (whose content-addressed
 * on-disk pack store belonged to the retired Codex activation protocol) because
 * two surviving release gates consume exactly this verification half:
 * `scripts/verify-delivery-evidence-pack.ts` (the `delivery-evidence-compatibility`
 * and `release-update-path-smoke` jobs) and `genie update --publish-local-delivery`.
 */

import { createHash } from 'node:crypto';
import { parseReleaseVersion } from './release-payload-proof.js';

export const DELIVERY_EVIDENCE_REPOSITORY = 'automagik-dev/genie';
export const DELIVERY_EVIDENCE_PREDICATE_TYPE = 'https://github.com/automagik-dev/genie/delivery-evidence/v1';
export const DELIVERY_EVIDENCE_WORKFLOW_IDENTITY =
  'https://github.com/automagik-dev/genie/.github/workflows/release-publish.yml@refs/heads/main';
export const DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN = `^${escapeRegexLiteral(
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
)}$`;
export const DELIVERY_EVIDENCE_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const DELIVERY_EVIDENCE_DIGEST_ALGORITHM = 'genie-physical-tree-v1';

const IN_TOTO_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const DESCRIPTOR_FILE = 'descriptor.json';
const BUNDLE_FILE = 'bundle.json';
const MANIFEST_FILE = 'manifest.json';
const MAX_DESCRIPTOR_BYTES = 32 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const HEX_160_RE = /^[0-9a-f]{40}$/;
const HEX_256_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const RELEASE_CHANNELS = ['stable', 'dev'] as const;
const PLATFORM_IDS = ['linux-x64-glibc', 'linux-x64-musl', 'linux-arm64', 'darwin-arm64'] as const;

export type DeliveryEvidenceChannel = (typeof RELEASE_CHANNELS)[number];
export type DeliveryEvidencePlatformId = (typeof PLATFORM_IDS)[number];

export interface DeliveryEvidenceDescriptor {
  schemaVersion: 1;
  repository: typeof DELIVERY_EVIDENCE_REPOSITORY;
  version: string;
  channel: DeliveryEvidenceChannel;
  platformId: DeliveryEvidencePlatformId;
  platformTriple: string;
  releaseTag: string;
  releaseName: string;
  releaseManifestSha256: string;
  artifactSha256: string;
  installedBinarySha256: string;
  canonicalPayloadSha256: string;
  sourceSha: string;
  sourceBranch: string;
  sourceCiRunId: string;
  controlSha: string;
  digestAlgorithm: typeof DELIVERY_EVIDENCE_DIGEST_ALGORITHM;
}

/**
 * Caller-observed facts that must agree with the signed descriptor. No
 * provenance field is optional: a caller cannot turn a partly bound descriptor
 * into a verified delivery.
 */
export interface VerifyDownloadedDeliveryEvidenceInput {
  descriptorBytes: Uint8Array | string;
  bundleBytes: Uint8Array | string;
  manifestBytes: Uint8Array | string;
  targetVersion: string;
  channel: DeliveryEvidenceChannel;
  platformId: DeliveryEvidencePlatformId;
  platformTriple: string;
  releaseTag: string;
  releaseName: string;
  artifactSha256: string;
  installedBinarySha256: string;
  canonicalPayloadSha256: string;
}

export interface DeliveryEvidenceBundleVerificationInput {
  /** Parsed serialized-bundle JSON. The default path converts it with bundleFromJSON. */
  bundleJson: unknown;
  /** Exact descriptor bytes whose digest the DSSE subject must name. */
  descriptorBytes: Uint8Array;
}

export interface DeliveryEvidenceVerificationDependencies {
  /**
   * Deterministic test seam for the cryptographic verification step only.
   * Production callers omit this. There is deliberately no env or CLI bypass.
   */
  verifyBundle?: (input: DeliveryEvidenceBundleVerificationInput) => { integratedTime: string | number };
}

declare const VERIFIED_DELIVERY_EVIDENCE: unique symbol;

/** Opaque, process-local proof. A structural lookalike fails the WeakMap check. */
export interface VerifiedDeliveryEvidence {
  readonly [VERIFIED_DELIVERY_EVIDENCE]: true;
}

export interface VerifiedDeliveryEvidenceFacts {
  descriptor: Readonly<DeliveryEvidenceDescriptor>;
  evidenceDigest: string;
  /** ISO timestamp derived from a transparency-log entry's verified integratedTime. */
  deliveredAt: string;
}

interface VerifiedDeliveryEvidenceState extends VerifiedDeliveryEvidenceFacts {
  descriptorBytes: Buffer;
  bundleBytes: Buffer;
  manifestBytes: Buffer;
}

const VERIFIED_EVIDENCE = new WeakMap<object, VerifiedDeliveryEvidenceState>();

/** Verify exact downloaded bytes and mint the only evidence value publication accepts. */
export function verifyDownloadedDeliveryEvidence(
  input: VerifyDownloadedDeliveryEvidenceInput,
  dependencies: DeliveryEvidenceVerificationDependencies = {},
): VerifiedDeliveryEvidence {
  const descriptorBytes = boundedBytes(input.descriptorBytes, MAX_DESCRIPTOR_BYTES, 'descriptor');
  const bundleBytes = boundedBytes(input.bundleBytes, MAX_BUNDLE_BYTES, 'bundle');
  const manifestBytes = boundedBytes(input.manifestBytes, MAX_MANIFEST_BYTES, 'manifest');
  const descriptor = parseDescriptor(descriptorBytes);
  bindCallerObservation(descriptor, input);
  verifyManifestBytes(descriptor, manifestBytes);

  const bundleJson = parseJson(bundleBytes, 'bundle');
  const statement = parseDsseStatement(bundleJson);
  const descriptorSha256 = sha256(descriptorBytes);
  if (statement.subjectSha256 !== descriptorSha256) {
    throw new Error('delivery evidence DSSE subject does not bind the exact descriptor bytes');
  }
  const integratedTime =
    dependencies.verifyBundle?.({ bundleJson, descriptorBytes }) ?? verifyBundleWithEmbeddedTrustRoot(bundleJson);
  const deliveredAt = deliveredAtFromIntegratedTime(integratedTime.integratedTime);
  const evidenceDigest = computeEvidenceDigest(descriptorBytes, bundleBytes, manifestBytes);
  return mintVerifiedEvidence({
    descriptor: Object.freeze({ ...descriptor }),
    evidenceDigest,
    deliveredAt,
    descriptorBytes,
    bundleBytes,
    manifestBytes,
  });
}

/** Return immutable, independently verified facts or reject a forged lookalike. */
export function verifiedDeliveryEvidenceFacts(evidence: VerifiedDeliveryEvidence): VerifiedDeliveryEvidenceFacts {
  const state = verifiedState(evidence);
  return {
    descriptor: state.descriptor,
    evidenceDigest: state.evidenceDigest,
    deliveredAt: state.deliveredAt,
  };
}

function mintVerifiedEvidence(state: VerifiedDeliveryEvidenceState): VerifiedDeliveryEvidence {
  const evidence = Object.freeze({}) as VerifiedDeliveryEvidence;
  VERIFIED_EVIDENCE.set(evidence, state);
  return evidence;
}

function verifiedState(evidence: VerifiedDeliveryEvidence): VerifiedDeliveryEvidenceState {
  const state = VERIFIED_EVIDENCE.get(evidence as object);
  if (state === undefined) throw new Error('delivery evidence was not minted by the verifier');
  return state;
}

const DESCRIPTOR_KEYS = new Set<keyof DeliveryEvidenceDescriptor>([
  'schemaVersion',
  'repository',
  'version',
  'channel',
  'platformId',
  'platformTriple',
  'releaseTag',
  'releaseName',
  'releaseManifestSha256',
  'artifactSha256',
  'installedBinarySha256',
  'canonicalPayloadSha256',
  'sourceSha',
  'sourceBranch',
  'sourceCiRunId',
  'controlSha',
  'digestAlgorithm',
]);

function parseDescriptor(bytes: Buffer): DeliveryEvidenceDescriptor {
  const parsed = parseJson(bytes, 'descriptor');
  if (!isPlainObject(parsed)) throw new Error('delivery evidence descriptor is not an object');
  if (
    Object.keys(parsed).length !== DESCRIPTOR_KEYS.size ||
    Object.keys(parsed).some((key) => !DESCRIPTOR_KEYS.has(key as keyof DeliveryEvidenceDescriptor))
  ) {
    throw new Error('delivery evidence descriptor does not have the exact schema-v1 fields');
  }
  if (parsed.schemaVersion !== 1) throw new Error('delivery evidence schemaVersion is invalid');
  if (parsed.repository !== DELIVERY_EVIDENCE_REPOSITORY) throw new Error('delivery evidence repository is invalid');
  if (typeof parsed.version !== 'string' || parseReleaseVersion(parsed.version) === null) {
    throw new Error('delivery evidence version is invalid');
  }
  if (!isReleaseChannel(parsed.channel)) throw new Error('delivery evidence channel is invalid');
  if (!isPlatformId(parsed.platformId)) throw new Error('delivery evidence platformId is invalid');
  const platformTriple = platformTripleFor(parsed.platformId);
  if (parsed.platformTriple !== platformTriple) throw new Error('delivery evidence platformTriple is invalid');
  if (parsed.releaseTag !== `v${parsed.version}`) throw new Error('delivery evidence releaseTag is invalid');
  if (parsed.releaseName !== `genie-${parsed.version}-${parsed.platformId}.tar.gz`) {
    throw new Error('delivery evidence releaseName is invalid');
  }
  for (const key of [
    'releaseManifestSha256',
    'artifactSha256',
    'installedBinarySha256',
    'canonicalPayloadSha256',
  ] as const) {
    if (!HEX_256_RE.test(parsed[key] as string)) throw new Error(`delivery evidence ${key} is invalid`);
  }
  if (!HEX_160_RE.test(parsed.sourceSha as string)) throw new Error('delivery evidence sourceSha is invalid');
  if (!sourceBranchAllowedForChannel(parsed.sourceBranch, parsed.channel)) {
    throw new Error('delivery evidence sourceBranch is invalid');
  }
  if (typeof parsed.sourceCiRunId !== 'string' || !DECIMAL_RE.test(parsed.sourceCiRunId)) {
    throw new Error('delivery evidence sourceCiRunId is invalid');
  }
  if (!HEX_160_RE.test(parsed.controlSha as string)) throw new Error('delivery evidence controlSha is invalid');
  if (parsed.digestAlgorithm !== DELIVERY_EVIDENCE_DIGEST_ALGORITHM) {
    throw new Error('delivery evidence digestAlgorithm is invalid');
  }
  return parsed as unknown as DeliveryEvidenceDescriptor;
}

function bindCallerObservation(
  descriptor: DeliveryEvidenceDescriptor,
  input: VerifyDownloadedDeliveryEvidenceInput,
): void {
  const bindings: ReadonlyArray<[keyof DeliveryEvidenceDescriptor, string]> = [
    ['version', input.targetVersion],
    ['channel', input.channel],
    ['platformId', input.platformId],
    ['platformTriple', input.platformTriple],
    ['releaseTag', input.releaseTag],
    ['releaseName', input.releaseName],
    ['artifactSha256', input.artifactSha256],
    ['installedBinarySha256', input.installedBinarySha256],
    ['canonicalPayloadSha256', input.canonicalPayloadSha256],
  ];
  for (const [field, observed] of bindings) {
    if (descriptor[field] !== observed) {
      throw new Error(`delivery evidence ${field} does not match the selected/downloaded candidate`);
    }
  }
}

function verifyManifestBytes(descriptor: DeliveryEvidenceDescriptor, bytes: Buffer): void {
  if (sha256(bytes) !== descriptor.releaseManifestSha256) {
    throw new Error('delivery evidence manifest digest does not bind the exact fetched manifest bytes');
  }
  const manifest = parseJson(bytes, 'manifest');
  if (!isPlainObject(manifest)) throw new Error('delivery evidence manifest is not an object');
  const keys = Object.keys(manifest).sort();
  const expectedKeys = ['channel', 'platforms', 'released_at', 'schema_version', 'tarball_base', 'version'];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('delivery evidence manifest does not have the exact schema-v1 fields');
  }
  if (manifest.schema_version !== 1) throw new Error('delivery evidence manifest schema is invalid');
  if (manifest.channel !== descriptor.channel) throw new Error('delivery evidence manifest channel mismatch');
  if (manifest.version !== descriptor.version) throw new Error('delivery evidence manifest version mismatch');
  if (typeof manifest.released_at !== 'string' || !Number.isFinite(Date.parse(manifest.released_at))) {
    throw new Error('delivery evidence manifest released_at is invalid');
  }
  const expectedBase = `https://github.com/${DELIVERY_EVIDENCE_REPOSITORY}/releases/download/${descriptor.releaseTag}`;
  if (manifest.tarball_base !== expectedBase) throw new Error('delivery evidence manifest tarball_base mismatch');
  if (
    !Array.isArray(manifest.platforms) ||
    !manifest.platforms.every(isPlatformId) ||
    new Set(manifest.platforms).size !== manifest.platforms.length ||
    !manifest.platforms.includes(descriptor.platformId)
  ) {
    throw new Error('delivery evidence manifest platforms are invalid');
  }
}

function parseDsseStatement(bundleJson: unknown): { subjectSha256: string } {
  if (!isPlainObject(bundleJson)) throw new Error('delivery evidence bundle is not an object');
  const envelope = bundleJson.dsseEnvelope;
  if (!isPlainObject(envelope)) throw new Error('delivery evidence bundle is not a DSSE bundle');
  if (envelope.payloadType !== IN_TOTO_PAYLOAD_TYPE) {
    throw new Error('delivery evidence DSSE payload type is invalid');
  }
  if (typeof envelope.payload !== 'string' || envelope.payload.length === 0) {
    throw new Error('delivery evidence DSSE payload is missing');
  }
  let statement: unknown;
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('delivery evidence DSSE statement is malformed');
  }
  if (!isPlainObject(statement)) throw new Error('delivery evidence DSSE statement is not an object');
  if (statement._type !== IN_TOTO_STATEMENT_TYPE) throw new Error('delivery evidence statement type is invalid');
  if (statement.predicateType !== DELIVERY_EVIDENCE_PREDICATE_TYPE) {
    throw new Error('delivery evidence predicate type is invalid');
  }
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error('delivery evidence statement must have exactly one subject');
  }
  const subject = statement.subject[0];
  if (!isPlainObject(subject) || !isPlainObject(subject.digest)) {
    throw new Error('delivery evidence statement subject is malformed');
  }
  if (Object.keys(subject.digest).length !== 1 || !HEX_256_RE.test(subject.digest.sha256 as string)) {
    throw new Error('delivery evidence statement subject digest is malformed');
  }
  return { subjectSha256: subject.digest.sha256 as string };
}

function verifyBundleWithEmbeddedTrustRoot(bundleJson: unknown): { integratedTime: string } {
  const {
    bundleFromJSON,
    isBundleWithDsseEnvelope,
    publicGoodTrustedRoot,
    TrustedRoot,
    Verifier,
    toSignedEntity,
    toTrustMaterial,
  } = loadSigstoreVerifier();
  const bundle = bundleFromJSON(bundleJson);
  if (!isBundleWithDsseEnvelope(bundle)) throw new Error('delivery evidence bundle is not a DSSE bundle');
  const root = TrustedRoot.fromJSON(publicGoodTrustedRoot);
  const verifier = new Verifier(toTrustMaterial(root), {
    tlogThreshold: 1,
    ctlogThreshold: 1,
    timestampThreshold: 1,
  });
  verifier.verify(toSignedEntity(bundle), {
    // @sigstore/verify interprets this field as a JavaScript regular
    // expression. Escape and anchor the literal identity so sibling workflow
    // names and branches such as `main-evil` cannot satisfy the policy.
    subjectAlternativeName: DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN,
    extensions: { issuer: DELIVERY_EVIDENCE_OIDC_ISSUER },
  });
  const integratedTimes = bundle.verificationMaterial.tlogEntries
    .map((entry) => entry.integratedTime)
    .filter((value) => value !== '0');
  if (integratedTimes.length === 0) throw new Error('delivery evidence bundle has no integrated transparency-log time');
  return {
    integratedTime: integratedTimes.reduce((earliest, value) => (BigInt(value) < BigInt(earliest) ? value : earliest)),
  };
}

type SigstoreVerifierModules = {
  bundleFromJSON: typeof import('@sigstore/bundle')['bundleFromJSON'];
  isBundleWithDsseEnvelope: typeof import('@sigstore/bundle')['isBundleWithDsseEnvelope'];
  TrustedRoot: typeof import('@sigstore/protobuf-specs')['TrustedRoot'];
  Verifier: typeof import('@sigstore/verify')['Verifier'];
  toSignedEntity: typeof import('@sigstore/verify')['toSignedEntity'];
  toTrustMaterial: typeof import('@sigstore/verify')['toTrustMaterial'];
  publicGoodTrustedRoot: Parameters<typeof import('@sigstore/protobuf-specs')['TrustedRoot']['fromJSON']>[0];
};

let sigstoreVerifierModules: SigstoreVerifierModules | undefined;

/** Load the heavy verifier graph only on a production cryptographic check. */
function loadSigstoreVerifier(): SigstoreVerifierModules {
  if (sigstoreVerifierModules !== undefined) return sigstoreVerifierModules;
  const bundle = require('@sigstore/bundle') as typeof import('@sigstore/bundle');
  const protobuf = require('@sigstore/protobuf-specs') as typeof import('@sigstore/protobuf-specs');
  const verify = require('@sigstore/verify') as typeof import('@sigstore/verify');
  sigstoreVerifierModules = {
    bundleFromJSON: bundle.bundleFromJSON,
    isBundleWithDsseEnvelope: bundle.isBundleWithDsseEnvelope,
    TrustedRoot: protobuf.TrustedRoot,
    Verifier: verify.Verifier,
    toSignedEntity: verify.toSignedEntity,
    toTrustMaterial: verify.toTrustMaterial,
    publicGoodTrustedRoot: require('../fixtures/delivery-public-good-trusted-root.json'),
  };
  return sigstoreVerifierModules;
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deliveredAtFromIntegratedTime(value: string | number): string {
  const text = String(value);
  if (!DECIMAL_RE.test(text)) throw new Error('delivery evidence integratedTime is invalid');
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 8_640_000_000_000) {
    throw new Error('delivery evidence integratedTime is out of range');
  }
  const deliveredAt = new Date(seconds * 1000);
  if (!Number.isFinite(deliveredAt.getTime())) throw new Error('delivery evidence integratedTime is out of range');
  return deliveredAt.toISOString();
}

function computeEvidenceDigest(descriptor: Buffer, bundle: Buffer, manifest: Buffer): string {
  const digest = createHash('sha256');
  digest.update('genie-delivery-evidence-pack-v1\0');
  for (const [name, bytes] of [
    [DESCRIPTOR_FILE, descriptor],
    [BUNDLE_FILE, bundle],
    [MANIFEST_FILE, manifest],
  ] as const) {
    digest.update(name);
    digest.update('\0');
    digest.update(String(bytes.length));
    digest.update('\0');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function boundedBytes(value: Uint8Array | string, maxBytes: number, label: string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
  if (bytes.length === 0) throw new Error(`delivery evidence ${label} is empty`);
  if (bytes.length > maxBytes) throw new Error(`delivery evidence ${label} exceeds the byte limit`);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
    throw new Error(`delivery evidence ${label} is not valid UTF-8`);
  }
  return bytes;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`delivery evidence ${label} is malformed JSON`);
  }
}

function platformTripleFor(platformId: DeliveryEvidencePlatformId): string {
  if (platformId === 'darwin-arm64') return 'darwin-arm64';
  if (platformId === 'linux-arm64') return 'linux-arm64';
  return 'linux-x64';
}

function sourceBranchAllowedForChannel(branch: unknown, channel: DeliveryEvidenceChannel): branch is string {
  if (typeof branch !== 'string') return false;
  if (channel === 'stable') return branch === 'main';
  // Accepting "main" on the dev channel is LOAD-BEARING, not a loose check: a
  // stable release cross-publishes dev (reconcile-channel-manifests.sh advances
  // both latest.json and dev.json; release-publish.yml builds descriptors for
  // EVIDENCE_CHANNELS=(stable dev) with SOURCE_BRANCH=main), so dev clients on a
  // stable-promoted version verify a {channel:'dev', sourceBranch:'main'}
  // descriptor. Narrowing this to "dev" aborts every dev update after a stable
  // release. Same asymmetry documented in validate-live-dogfood-evidence.ts.
  return branch === 'main' || branch === 'dev';
}

function isReleaseChannel(value: unknown): value is DeliveryEvidenceChannel {
  return typeof value === 'string' && (RELEASE_CHANNELS as readonly string[]).includes(value);
}

function isPlatformId(value: unknown): value is DeliveryEvidencePlatformId {
  return typeof value === 'string' && (PLATFORM_IDS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
