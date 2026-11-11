import { createHash } from 'node:crypto';
import {
  DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
  DELIVERY_EVIDENCE_OIDC_ISSUER,
  DELIVERY_EVIDENCE_REPOSITORY,
  DELIVERY_EVIDENCE_REPOSITORY_ID,
  DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID,
  type DeliveryEvidenceDescriptor,
  type DeliveryEvidenceRepository,
  type DeliveryEvidenceSigner,
  type DeliveryEvidenceVerificationDependencies,
  FULCIO_SOURCE_REPOSITORY_ID_OID,
  FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID,
  type VerifiedDeliveryEvidence,
  type VerifyDownloadedDeliveryEvidenceInput,
  deliveryEvidencePredicateType,
  deliveryEvidenceTarballBase,
  deliveryEvidenceWorkflowIdentity,
  verifyDownloadedDeliveryEvidence,
} from './delivery-evidence-verify.js';

const DEFAULT_VERSION = '5.260723.7';
const DEFAULT_SHA = 'a'.repeat(40);
const DEFAULT_CONTROL_SHA = 'b'.repeat(40);
const DEFAULT_DIGEST = 'c'.repeat(64);
const DEFAULT_BINARY_DIGEST = 'd'.repeat(64);
const DEFAULT_PAYLOAD_DIGEST = 'e'.repeat(64);
const DEFAULT_INTEGRATED_TIME = '1753228800';

export interface TestDeliveryEvidencePack {
  descriptor: DeliveryEvidenceDescriptor;
  descriptorBytes: string;
  bundleBytes: string;
  manifestBytes: string;
  input: VerifyDownloadedDeliveryEvidenceInput;
  dependencies: DeliveryEvidenceVerificationDependencies;
}

export interface TestDeliveryEvidenceOptions {
  descriptor?: Partial<DeliveryEvidenceDescriptor>;
  manifest?: Record<string, unknown>;
  input?: Partial<VerifyDownloadedDeliveryEvidenceInput>;
  integratedTime?: string | number;
  /** The signer the injected cryptographic step reports. Defaults to the one the descriptor's repository signs with. */
  signer?: DeliveryEvidenceSigner;
}

/** A certificate extension as Fulcio encodes it: a DER UTF8String (tag 0x0C) of the value. */
export function testCertificateExtension(oid: string, value: string): { oid: string; value: Uint8Array } {
  const bytes = Buffer.from(value, 'utf8');
  return { oid, value: Buffer.concat([Buffer.from([0x0c, bytes.length]), bytes]) };
}

/**
 * The signer a verified release certificate of `repository` reports: its
 * workflow identity, the GitHub OIDC issuer, and both pinned numeric ids.
 * Tests override one field at a time to prove each is checked.
 */
export function testDeliveryEvidenceSigner(
  repository: DeliveryEvidenceRepository = DELIVERY_EVIDENCE_REPOSITORY,
  overrides: Partial<DeliveryEvidenceSigner> = {},
): DeliveryEvidenceSigner {
  return {
    subjectAlternativeName: deliveryEvidenceWorkflowIdentity(repository),
    issuer: DELIVERY_EVIDENCE_OIDC_ISSUER,
    extensions: [
      testCertificateExtension(FULCIO_SOURCE_REPOSITORY_ID_OID, DELIVERY_EVIDENCE_REPOSITORY_ID),
      testCertificateExtension(FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID, DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID),
    ],
    ...overrides,
  };
}

/** The crypto seam every test injects: signature math only, with the signer policy still live. */
export function testDeliveryEvidenceSeam(
  integratedTime: string | number = DEFAULT_INTEGRATED_TIME,
  signer: DeliveryEvidenceSigner = testDeliveryEvidenceSigner(),
): DeliveryEvidenceVerificationDependencies {
  return { verifyBundle: () => ({ integratedTime, signer }) };
}

/** Deterministic pack builder for tests that keeps the real non-crypto bindings live. */
export function buildTestDeliveryEvidencePack(options: TestDeliveryEvidenceOptions = {}): TestDeliveryEvidencePack {
  const platformId =
    process.platform === 'darwin' ? 'darwin-arm64' : process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64-glibc';
  const platformTriple = `${process.platform}-${process.arch}`;
  const version = options.descriptor?.version ?? DEFAULT_VERSION;
  const channel = options.descriptor?.channel ?? 'stable';
  const releaseTag = options.descriptor?.releaseTag ?? `v${version}`;
  const releaseName = options.descriptor?.releaseName ?? `genie-${version}-${platformId}.tar.gz`;
  const repository = options.descriptor?.repository ?? DELIVERY_EVIDENCE_REPOSITORY;
  const manifest = {
    schema_version: 1,
    channel,
    version,
    released_at: '2025-07-23T00:00:00.000Z',
    tarball_base: deliveryEvidenceTarballBase(repository, releaseTag),
    platforms: [platformId],
    ...options.manifest,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const descriptor: DeliveryEvidenceDescriptor = {
    schemaVersion: 1,
    repository,
    version,
    channel,
    platformId,
    platformTriple,
    releaseTag,
    releaseName,
    releaseManifestSha256: sha256(manifestBytes),
    artifactSha256: DEFAULT_DIGEST,
    installedBinarySha256: DEFAULT_BINARY_DIGEST,
    canonicalPayloadSha256: DEFAULT_PAYLOAD_DIGEST,
    sourceSha: DEFAULT_SHA,
    sourceBranch: channel === 'stable' ? 'main' : channel,
    sourceCiRunId: '123456789',
    controlSha: DEFAULT_CONTROL_SHA,
    digestAlgorithm: DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
    ...options.descriptor,
  };
  const descriptorBytes = `${JSON.stringify(descriptor, null, 2)}\n`;
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: 'delivery-evidence.json',
        digest: { sha256: sha256(descriptorBytes) },
      },
    ],
    predicateType: deliveryEvidencePredicateType(descriptor.repository),
    predicate: { schemaVersion: 1 },
  };
  const bundleBytes = JSON.stringify({
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement), 'utf8').toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [{ keyid: '', sig: 'AA==' }],
    },
    verificationMaterial: {
      certificate: { rawBytes: 'AA==' },
      tlogEntries: [],
    },
  });
  const input: VerifyDownloadedDeliveryEvidenceInput = {
    descriptorBytes,
    bundleBytes,
    manifestBytes,
    targetVersion: descriptor.version,
    channel: descriptor.channel,
    platformId: descriptor.platformId,
    platformTriple: descriptor.platformTriple,
    releaseTag: descriptor.releaseTag,
    releaseName: descriptor.releaseName,
    artifactSha256: descriptor.artifactSha256,
    installedBinarySha256: descriptor.installedBinarySha256,
    canonicalPayloadSha256: descriptor.canonicalPayloadSha256,
    ...options.input,
  };
  const dependencies = testDeliveryEvidenceSeam(
    options.integratedTime ?? DEFAULT_INTEGRATED_TIME,
    options.signer ?? testDeliveryEvidenceSigner(descriptor.repository),
  );
  return { descriptor, descriptorBytes, bundleBytes, manifestBytes, input, dependencies };
}

export function mintTestDeliveryEvidence(options: TestDeliveryEvidenceOptions = {}): {
  evidence: VerifiedDeliveryEvidence;
  pack: TestDeliveryEvidencePack;
} {
  const pack = buildTestDeliveryEvidencePack(options);
  return {
    evidence: verifyDownloadedDeliveryEvidence(pack.input, pack.dependencies),
    pack,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
