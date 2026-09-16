import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN,
  type VerifyDeliveryEvidenceArtifactInput,
  verifiedDeliveryEvidenceFacts,
  verifyDeliveryEvidenceArtifact,
  verifyDownloadedDeliveryEvidence,
} from './delivery-evidence-verify.js';
import { buildTestDeliveryEvidencePack, mintTestDeliveryEvidence } from './delivery-evidence-verify.test-support.js';

// Moved verbatim from the verification half of the retired Codex delivery-evidence test
// when the verifier was rehomed out of the retired Codex activation protocol.
// The pack-persistence describes left with the store they exercised.
describe('signed delivery evidence verification', () => {
  test('matches only the exact release workflow identity accepted by Sigstore', () => {
    const identityPolicy = new RegExp(DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN);

    expect(identityPolicy.test(DELIVERY_EVIDENCE_WORKFLOW_IDENTITY)).toBe(true);
    expect(identityPolicy.test(`${DELIVERY_EVIDENCE_WORKFLOW_IDENTITY}-evil`)).toBe(false);
    expect(identityPolicy.test(DELIVERY_EVIDENCE_WORKFLOW_IDENTITY.replace('github.com', 'githubXcom'))).toBe(false);
  });

  test('mints an opaque proof only after exact descriptor, manifest, statement, and caller bindings match', () => {
    const { evidence, pack } = mintTestDeliveryEvidence();
    const facts = verifiedDeliveryEvidenceFacts(evidence);

    expect(facts.descriptor).toEqual(pack.descriptor);
    expect(facts.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.deliveredAt).toBe('2025-07-23T00:00:00.000Z');
  });

  test('rejects a structural lookalike at the opaque publication boundary', () => {
    expect(() => verifiedDeliveryEvidenceFacts({} as never)).toThrow('was not minted by the verifier');
  });

  test('binds every descriptor field through the DSSE subject digest', () => {
    const pack = buildTestDeliveryEvidencePack();
    const descriptor = JSON.parse(pack.descriptorBytes) as Record<string, unknown>;

    for (const key of Object.keys(descriptor)) {
      const changed = { ...descriptor, [key]: mutate(descriptor[key]) };
      expect(() =>
        verifyDownloadedDeliveryEvidence(
          { ...pack.input, descriptorBytes: `${JSON.stringify(changed, null, 2)}\n` },
          pack.dependencies,
        ),
      ).toThrow();
    }
  });

  test('rejects descriptor formatting changes because the statement binds exact bytes', () => {
    const pack = buildTestDeliveryEvidencePack();
    expect(() =>
      verifyDownloadedDeliveryEvidence(
        { ...pack.input, descriptorBytes: JSON.stringify(JSON.parse(pack.descriptorBytes)) },
        pack.dependencies,
      ),
    ).toThrow('exact descriptor bytes');
  });

  test('rejects exact manifest-byte tampering even when parsed values are unchanged', () => {
    const pack = buildTestDeliveryEvidencePack();
    expect(() =>
      verifyDownloadedDeliveryEvidence({ ...pack.input, manifestBytes: pack.manifestBytes.trim() }, pack.dependencies),
    ).toThrow('exact fetched manifest bytes');
  });

  test('rejects a bundle whose signed predicate type is changed', () => {
    const pack = buildTestDeliveryEvidencePack();
    const bundle = JSON.parse(pack.bundleBytes) as {
      dsseEnvelope: { payload: string };
    };
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
      predicateType: string;
    };
    statement.predicateType = 'https://example.invalid/predicate';
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');

    expect(() =>
      verifyDownloadedDeliveryEvidence({ ...pack.input, bundleBytes: JSON.stringify(bundle) }, pack.dependencies),
    ).toThrow('predicate type');
  });

  test('production verification cannot accept the deterministic unsigned test bundle', () => {
    const pack = buildTestDeliveryEvidencePack();
    expect(() => verifyDownloadedDeliveryEvidence(pack.input)).toThrow();
  });

  test('does not initialize Sigstore modules or its trusted root when evidence support is only imported', () => {
    const moduleUrl = new URL('./delivery-evidence-verify.ts', import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        `await import(${JSON.stringify(moduleUrl)}); process.stdout.write(String(Object.keys(require.cache).filter((key) => key.includes('@sigstore') || key.endsWith('delivery-public-good-trusted-root.json')).length));`,
      ],
      { encoding: 'utf8' },
    );

    expect(child.status).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toBe('0');
  });
});

function mutate(value: unknown): unknown {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return value.length === 0 ? 'x' : `${value.slice(0, -1)}x`;
  return null;
}

// ============================================================================
// Credential-free release verification (dogfood round 6, Z1).
//
// `genie update --stable` used to refuse any host whose GitHub CLI was absent
// or unauthenticated, even though every Genie release is public. The offline
// route below is now the security FLOOR, so it is exercised against the real
// published assets of release v5.260726.3 (darwin-arm64, dev channel) that this
// repository already carries under tests/fixtures/delivery-evidence/:
//
//   genie-5.260726.3-darwin-arm64.tar.gz.dev.delivery.json[.sigstore.json]
//   dev.json  — .well-known/dev.json at that release; its sha256 is pinned by
//               the descriptor's releaseManifestSha256
//
// These tests run the PRODUCTION verifier — embedded public-good trust root, no
// injected crypto seam, no network, no GitHub credential.
// ============================================================================

const REAL_RELEASE_DIR = join(import.meta.dir, '..', '..', 'tests', 'fixtures', 'delivery-evidence');
const REAL_RELEASE_DESCRIPTOR = 'genie-5.260726.3-darwin-arm64.tar.gz.dev.delivery.json';
const REAL_RELEASE_ARTIFACT_SHA256 = '6167292a0e4e693ecb11b2a3280a5ad93b2df731357f2ef31abb8349634a6cc3';

function realReleaseInput(): VerifyDeliveryEvidenceArtifactInput {
  return {
    descriptorBytes: readFileSync(join(REAL_RELEASE_DIR, REAL_RELEASE_DESCRIPTOR)),
    bundleBytes: readFileSync(join(REAL_RELEASE_DIR, `${REAL_RELEASE_DESCRIPTOR}.sigstore.json`)),
    manifestBytes: readFileSync(join(REAL_RELEASE_DIR, 'dev.json')),
    targetVersion: '5.260726.3',
    channel: 'dev',
    platformId: 'darwin-arm64',
    platformTriple: 'darwin-arm64',
    releaseTag: 'v5.260726.3',
    releaseName: 'genie-5.260726.3-darwin-arm64.tar.gz',
    artifactSha256: REAL_RELEASE_ARTIFACT_SHA256,
  };
}

describe('verifyDeliveryEvidenceArtifact — credential-free pre-execution gate', () => {
  test('verifies a real published release offline, with no GitHub credential and no crypto seam', () => {
    const facts = verifyDeliveryEvidenceArtifact(realReleaseInput());

    expect(facts.descriptor.version).toBe('5.260726.3');
    expect(facts.descriptor.artifactSha256).toBe(REAL_RELEASE_ARTIFACT_SHA256);
    expect(facts.descriptor.sourceSha).toBe('7f91dbcee3d46eb558a0bc241a01484f1074f0c9');
    expect(facts.deliveredAt).toBe('2026-07-26T17:35:15.000Z');
  });

  test('rejects a tarball whose digest is not the signed artifactSha256', () => {
    expect(() => verifyDeliveryEvidenceArtifact({ ...realReleaseInput(), artifactSha256: 'f'.repeat(64) })).toThrow(
      'artifactSha256 does not match',
    );
  });

  test('rejects a tampered predicate type on the real bundle', () => {
    const input = realReleaseInput();
    const bundle = JSON.parse(Buffer.from(input.bundleBytes as Uint8Array).toString('utf8')) as {
      dsseEnvelope: { payload: string };
    };
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
      predicateType: string;
    };
    statement.predicateType = 'https://slsa.dev/provenance/v1';
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');

    expect(() => verifyDeliveryEvidenceArtifact({ ...input, bundleBytes: JSON.stringify(bundle) })).toThrow(
      'predicate type',
    );
  });

  test('rejects a DSSE subject that does not bind the exact descriptor bytes', () => {
    const input = realReleaseInput();
    const descriptor = JSON.parse(Buffer.from(input.descriptorBytes as Uint8Array).toString('utf8')) as Record<
      string,
      unknown
    >;
    // Same parsed values, different exact bytes — the subject digest must fail.
    expect(() =>
      verifyDeliveryEvidenceArtifact({ ...input, descriptorBytes: `${JSON.stringify(descriptor, null, 2)}\n` }),
    ).toThrow('exact descriptor bytes');
  });

  test('rejects a real bundle whose certificate identity is not the pinned release workflow', async () => {
    // The identity is a module constant, so the only way to prove the pin is
    // live end-to-end is to build a copy of the verifier that pins a DIFFERENT
    // workflow and watch the genuine release bundle get rejected by it.
    const verifierPath = join(import.meta.dir, 'delivery-evidence-verify.ts');
    const probePath = join(import.meta.dir, 'delivery-evidence-verify.identity-probe.tmp.ts');
    const mutated = readFileSync(verifierPath, 'utf8').replace(
      '/.github/workflows/release-publish.yml@refs/heads/main',
      '/.github/workflows/release-publish-evil.yml@refs/heads/main',
    );
    expect(mutated).toContain('release-publish-evil.yml');
    writeFileSync(probePath, mutated);
    try {
      const probe = (await import(probePath)) as {
        verifyDeliveryEvidenceArtifact: typeof verifyDeliveryEvidenceArtifact;
      };
      expect(() => probe.verifyDeliveryEvidenceArtifact(realReleaseInput())).toThrow('certificate identity');
    } finally {
      rmSync(probePath, { force: true });
    }
  });
});
