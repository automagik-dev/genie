import { createHash } from 'node:crypto';
import {
  DELIVERY_EVIDENCE_DIGEST_ALGORITHM,
  DELIVERY_EVIDENCE_PREDICATE_TYPE,
  DELIVERY_EVIDENCE_REPOSITORY,
  type DeliveryEvidenceDescriptor,
  type DeliveryEvidenceVerificationDependencies,
  type VerifiedDeliveryEvidence,
  type VerifyDownloadedDeliveryEvidenceInput,
  verifyDownloadedDeliveryEvidence,
} from './codex-delivery-evidence.js';

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
  const manifest = {
    schema_version: 1,
    channel,
    version,
    released_at: '2025-07-23T00:00:00.000Z',
    tarball_base: `https://github.com/${DELIVERY_EVIDENCE_REPOSITORY}/releases/download/${releaseTag}`,
    platforms: [platformId],
    ...options.manifest,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const descriptor: DeliveryEvidenceDescriptor = {
    schemaVersion: 1,
    repository: DELIVERY_EVIDENCE_REPOSITORY,
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
    predicateType: DELIVERY_EVIDENCE_PREDICATE_TYPE,
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
  const dependencies: DeliveryEvidenceVerificationDependencies = {
    verifyBundle: () => ({ integratedTime: options.integratedTime ?? DEFAULT_INTEGRATED_TIME }),
  };
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
