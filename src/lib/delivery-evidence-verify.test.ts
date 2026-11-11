import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES,
  DELIVERY_EVIDENCE_PRE_RENAME_REPOSITORY,
  DELIVERY_EVIDENCE_REPOSITORY,
  DELIVERY_EVIDENCE_REPOSITORY_ID,
  DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN,
  type DeliveryEvidenceRepository,
  type DeliveryEvidenceSigner,
  FULCIO_SOURCE_REPOSITORY_ID_OID,
  FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID,
  type VerifyDeliveryEvidenceArtifactInput,
  assertPinnedDeliveryEvidenceSigner,
  deliveryEvidencePredicateType,
  deliveryEvidenceTarballBase,
  deliveryEvidenceWorkflowIdentity,
  deliveryEvidenceWorkflowIdentityPattern,
  verifiedDeliveryEvidenceFacts,
  verifyDeliveryEvidenceArtifact,
  verifyDownloadedDeliveryEvidence,
} from './delivery-evidence-verify.js';
import {
  buildTestDeliveryEvidencePack,
  mintTestDeliveryEvidence,
  testCertificateExtension,
  testDeliveryEvidenceSigner,
} from './delivery-evidence-verify.test-support.js';

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

  test('accepts exactly two repository names, each with one literal identity pattern of its own', () => {
    expect([...DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES]).toEqual(['automagik-si/genie', 'automagik-dev/genie']);
    expect(DELIVERY_EVIDENCE_REPOSITORY).toBe('automagik-si/genie');
    expect(DELIVERY_EVIDENCE_PRE_RENAME_REPOSITORY).toBe('automagik-dev/genie');
    for (const repository of DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES) {
      const pattern = deliveryEvidenceWorkflowIdentityPattern(repository);
      const identity = deliveryEvidenceWorkflowIdentity(repository);
      // One literal, anchored at both ends, with no alternation or wildcard left unescaped.
      expect(pattern.startsWith('^') && pattern.endsWith('$')).toBe(true);
      expect(pattern.slice(1, -1).replace(/\\./g, '')).not.toMatch(/[|*+?()[\]{}]/);
      const policy = new RegExp(pattern);
      expect(policy.test(identity)).toBe(true);
      for (const other of DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES) {
        if (other !== repository) expect(policy.test(deliveryEvidenceWorkflowIdentity(other))).toBe(false);
      }
      expect(policy.test(identity.replace(repository, 'automagik-evil/genie'))).toBe(false);
      expect(policy.test(identity.replace('release-publish.yml', 'sign-attest.yml'))).toBe(false);
      expect(policy.test(identity.replace('refs/heads/main', 'refs/heads/dev'))).toBe(false);
      expect(policy.test(`x${identity}`)).toBe(false);
    }
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

  test('rejects exact manifest-byte tampering even when parsed values are unchanged', () => {
    const pack = buildTestDeliveryEvidencePack();
    expect(() =>
      verifyDownloadedDeliveryEvidence({ ...pack.input, manifestBytes: pack.manifestBytes.trim() }, pack.dependencies),
    ).toThrow('exact fetched manifest bytes');
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

// ============================================================================
// Repository identity survives a rename (2026-11-11).
//
// The organization that owns this repository was renamed. GitHub kept the
// repository's numeric id and the organization's numeric id, and Fulcio writes
// both into every certificate. The verifier therefore accepts a descriptor that
// names the repository either way, requires the ONE workflow identity of the
// name the descriptor carries, and requires both numeric ids on the verified
// certificate. These tests inject only the signature math: the signer policy is
// applied to whatever the cryptographic step reports and cannot be skipped.
// ============================================================================

const OTHER_REPOSITORY_ID = '1030039431';
const OTHER_OWNER_ID = '245047547';

function signerWith(
  repository: DeliveryEvidenceRepository,
  ids: { repositoryId?: string | null; ownerId?: string | null },
): DeliveryEvidenceSigner {
  const extensions: Array<{ oid: string; value: Uint8Array }> = [];
  const repositoryId = ids.repositoryId === undefined ? DELIVERY_EVIDENCE_REPOSITORY_ID : ids.repositoryId;
  const ownerId = ids.ownerId === undefined ? DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID : ids.ownerId;
  if (repositoryId !== null) extensions.push(testCertificateExtension(FULCIO_SOURCE_REPOSITORY_ID_OID, repositoryId));
  if (ownerId !== null) extensions.push(testCertificateExtension(FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID, ownerId));
  return testDeliveryEvidenceSigner(repository, { extensions });
}

function verifyWith(repository: DeliveryEvidenceRepository, signer: DeliveryEvidenceSigner) {
  const pack = buildTestDeliveryEvidencePack({ descriptor: { repository }, signer });
  return verifiedDeliveryEvidenceFacts(verifyDownloadedDeliveryEvidence(pack.input, pack.dependencies));
}

describe('signer policy — the repository is its numeric ids, under either of its two names', () => {
  test('the pinned ids are the ones GitHub and the published certificates carry', () => {
    expect(DELIVERY_EVIDENCE_REPOSITORY_ID).toBe('1030039430');
    expect(DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID).toBe('245047546');
    expect(FULCIO_SOURCE_REPOSITORY_ID_OID).toBe('1.3.6.1.4.1.57264.1.15');
    expect(FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID).toBe('1.3.6.1.4.1.57264.1.17');
  });

  test('(a) evidence under the current name, with both ids, verifies', () => {
    const facts = verifyWith('automagik-si/genie', testDeliveryEvidenceSigner('automagik-si/genie'));
    expect(facts.descriptor.repository).toBe('automagik-si/genie');
  });

  test('(b) evidence under the pre-rename name, with both ids, still verifies', () => {
    const facts = verifyWith('automagik-dev/genie', testDeliveryEvidenceSigner('automagik-dev/genie'));
    expect(facts.descriptor.repository).toBe('automagik-dev/genie');
  });

  test.each([...DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES])('(c) %s: another repository id is refused', (repository) => {
    expect(() => verifyWith(repository, signerWith(repository, { repositoryId: OTHER_REPOSITORY_ID }))).toThrow(
      'source repository identifier (1.3.6.1.4.1.57264.1.15) is not the pinned id',
    );
  });

  test.each([...DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES])('(d) %s: another owner id is refused', (repository) => {
    expect(() => verifyWith(repository, signerWith(repository, { ownerId: OTHER_OWNER_ID }))).toThrow(
      'source repository owner identifier (1.3.6.1.4.1.57264.1.17) is not the pinned id',
    );
  });

  test.each([...DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES])('(e) %s: a missing id extension is refused', (repository) => {
    expect(() => verifyWith(repository, signerWith(repository, { repositoryId: null }))).toThrow(
      'has no source repository identifier (1.3.6.1.4.1.57264.1.15)',
    );
    expect(() => verifyWith(repository, signerWith(repository, { ownerId: null }))).toThrow(
      'has no source repository owner identifier (1.3.6.1.4.1.57264.1.17)',
    );
    expect(() => verifyWith(repository, testDeliveryEvidenceSigner(repository, { extensions: [] }))).toThrow(
      'has no source repository identifier',
    );
  });

  test('an id is refused unless it is exactly the DER UTF8String of the pinned decimal', () => {
    const repository = DELIVERY_EVIDENCE_REPOSITORY;
    const owner = testCertificateExtension(
      FULCIO_SOURCE_REPOSITORY_OWNER_ID_OID,
      DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID,
    );
    const id = Buffer.from(DELIVERY_EVIDENCE_REPOSITORY_ID, 'ascii');
    const encodings: Array<[string, Buffer]> = [
      ['the bare digits with no DER header', id],
      ['an IA5String instead of a UTF8String', Buffer.concat([Buffer.from([0x16, id.length]), id])],
      [
        'a longer value that starts with the id',
        Buffer.concat([Buffer.from([0x0c, id.length + 1]), id, Buffer.from('0')]),
      ],
      ['trailing bytes after the string', Buffer.concat([Buffer.from([0x0c, id.length]), id, Buffer.from([0x00])])],
      ['an empty value', Buffer.alloc(0)],
    ];
    for (const [label, value] of encodings) {
      const signer = testDeliveryEvidenceSigner(repository, {
        extensions: [{ oid: FULCIO_SOURCE_REPOSITORY_ID_OID, value }, owner],
      });
      expect(() => verifyWith(repository, signer), label).toThrow('is not the pinned id');
    }
  });

  test('a certificate that repeats an id extension is refused, whatever the copies say', () => {
    const repository = DELIVERY_EVIDENCE_REPOSITORY;
    const good = testDeliveryEvidenceSigner(repository);
    const repeated = testDeliveryEvidenceSigner(repository, {
      extensions: [...good.extensions, testCertificateExtension(FULCIO_SOURCE_REPOSITORY_ID_OID, OTHER_REPOSITORY_ID)],
    });
    expect(() => verifyWith(repository, repeated)).toThrow('repeats its source repository identifier');
  });

  test('a third owner name is refused in the certificate, in the descriptor, and in both', () => {
    const evil = 'automagik-evil/genie' as DeliveryEvidenceRepository;
    const evilSigner = testDeliveryEvidenceSigner(DELIVERY_EVIDENCE_REPOSITORY, {
      subjectAlternativeName:
        'https://github.com/automagik-evil/genie/.github/workflows/release-publish.yml@refs/heads/main',
    });
    for (const repository of DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES) {
      expect(() => verifyWith(repository, evilSigner)).toThrow(
        `certificate identity is not the release workflow of ${repository}`,
      );
    }
    expect(() => verifyWith(evil, testDeliveryEvidenceSigner())).toThrow('delivery evidence repository is invalid');
    expect(() => verifyWith(evil, evilSigner)).toThrow('delivery evidence repository is invalid');
  });

  test.each([...DELIVERY_EVIDENCE_ACCEPTED_REPOSITORIES])(
    '%s: another workflow file, another ref, or a longer identity is refused',
    (repository) => {
      const identity = deliveryEvidenceWorkflowIdentity(repository);
      for (const subjectAlternativeName of [
        identity.replace('release-publish.yml', 'sign-attest.yml'),
        identity.replace('release-publish.yml', 'release-publish-evil.yml'),
        identity.replace('refs/heads/main', 'refs/heads/dev'),
        identity.replace('refs/heads/main', 'refs/tags/main'),
        `${identity}-evil`,
        identity.toUpperCase(),
        undefined,
      ]) {
        expect(() =>
          verifyWith(repository, testDeliveryEvidenceSigner(repository, { subjectAlternativeName })),
        ).toThrow('certificate identity is not the release workflow');
      }
    },
  );

  test('the certificate must carry the identity of the name the descriptor uses, not the other accepted one', () => {
    expect(() => verifyWith('automagik-si/genie', testDeliveryEvidenceSigner('automagik-dev/genie'))).toThrow(
      'certificate identity is not the release workflow of automagik-si/genie',
    );
    expect(() => verifyWith('automagik-dev/genie', testDeliveryEvidenceSigner('automagik-si/genie'))).toThrow(
      'certificate identity is not the release workflow of automagik-dev/genie',
    );
  });

  test('the manifest and the predicate type must belong to the name the descriptor uses', () => {
    for (const [repository, other] of [
      ['automagik-si/genie', 'automagik-dev/genie'],
      ['automagik-dev/genie', 'automagik-si/genie'],
    ] as const) {
      const foreignManifest = buildTestDeliveryEvidencePack({
        descriptor: { repository },
        manifest: { tarball_base: deliveryEvidenceTarballBase(other, 'v5.260723.7') },
      });
      expect(() => verifyDownloadedDeliveryEvidence(foreignManifest.input, foreignManifest.dependencies)).toThrow(
        'tarball_base mismatch',
      );

      const pack = buildTestDeliveryEvidencePack({ descriptor: { repository } });
      const bundle = JSON.parse(pack.bundleBytes) as { dsseEnvelope: { payload: string } };
      const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')) as {
        predicateType: string;
      };
      expect(statement.predicateType).toBe(deliveryEvidencePredicateType(repository));
      statement.predicateType = deliveryEvidencePredicateType(other);
      bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(statement), 'utf8').toString('base64');
      expect(() =>
        verifyDownloadedDeliveryEvidence({ ...pack.input, bundleBytes: JSON.stringify(bundle) }, pack.dependencies),
      ).toThrow('predicate type');
    }
  });

  test('another OIDC issuer is refused', () => {
    const signer = testDeliveryEvidenceSigner(DELIVERY_EVIDENCE_REPOSITORY, { issuer: 'https://issuer.example' });
    expect(() => verifyWith(DELIVERY_EVIDENCE_REPOSITORY, signer)).toThrow('issuer is not the pinned OIDC issuer');
    expect(() =>
      verifyWith(
        DELIVERY_EVIDENCE_REPOSITORY,
        testDeliveryEvidenceSigner(DELIVERY_EVIDENCE_REPOSITORY, { issuer: undefined }),
      ),
    ).toThrow('issuer is not the pinned OIDC issuer');
  });

  test('a cryptographic step that reports no signer cannot mint evidence', () => {
    const pack = buildTestDeliveryEvidencePack();
    const noSigner = { verifyBundle: () => ({ integratedTime: '1753228800' }) } as never;
    expect(() => verifyDownloadedDeliveryEvidence(pack.input, noSigner)).toThrow(
      'signer certificate was not reported by the verification step',
    );
    expect(() => assertPinnedDeliveryEvidenceSigner(undefined, DELIVERY_EVIDENCE_REPOSITORY)).toThrow(
      'signer certificate was not reported',
    );
  });

  test('the ids are never taken from the descriptor: a descriptor cannot carry them at all', () => {
    const pack = buildTestDeliveryEvidencePack({
      signer: signerWith(DELIVERY_EVIDENCE_REPOSITORY, { repositoryId: null }),
    });
    const descriptor = { ...JSON.parse(pack.descriptorBytes), repositoryId: DELIVERY_EVIDENCE_REPOSITORY_ID };
    expect(() =>
      verifyDownloadedDeliveryEvidence(
        { ...pack.input, descriptorBytes: `${JSON.stringify(descriptor, null, 2)}\n` },
        pack.dependencies,
      ),
    ).toThrow('exact schema-v1 fields');
  });
});

// The same rule against real certificates, with the production trust root and
// no seam. Every release published before the rename is signed under the old
// name and carries the same two ids, so each of these must keep verifying.
const PUBLISHED_BEFORE_RENAME: ReadonlyArray<{
  label: string;
  descriptor: string;
  manifest: string;
  channel: 'stable' | 'dev';
  version: string;
  platformId: 'linux-x64-glibc' | 'darwin-arm64';
  platformTriple: string;
  artifactSha256: string;
}> = [
  {
    label: 'stable v6.261108.1 (the current stable)',
    descriptor: 'genie-6.261108.1-linux-x64-glibc.tar.gz.stable.delivery.json',
    manifest: 'v6.261108.1.latest.json',
    channel: 'stable',
    version: '6.261108.1',
    platformId: 'linux-x64-glibc',
    platformTriple: 'linux-x64',
    artifactSha256: 'ac6575fd7349d8f2dca242af52c62af969c792e783d6d0467bed1de55e0cbf59',
  },
  {
    label: 'dev v6.261109.9 (the newest pre-rename dev release)',
    descriptor: 'genie-6.261109.9-linux-x64-glibc.tar.gz.dev.delivery.json',
    manifest: 'v6.261109.9.dev.json',
    channel: 'dev',
    version: '6.261109.9',
    platformId: 'linux-x64-glibc',
    platformTriple: 'linux-x64',
    artifactSha256: 'd583469de0aa78763faea54ae16421bdf74234ffae1529ffb6af4d53eb83bdbc',
  },
];

function publishedInput(release: (typeof PUBLISHED_BEFORE_RENAME)[number]): VerifyDeliveryEvidenceArtifactInput {
  return {
    descriptorBytes: readFileSync(join(REAL_RELEASE_DIR, release.descriptor)),
    bundleBytes: readFileSync(join(REAL_RELEASE_DIR, `${release.descriptor}.sigstore.json`)),
    manifestBytes: readFileSync(join(REAL_RELEASE_DIR, release.manifest)),
    targetVersion: release.version,
    channel: release.channel,
    platformId: release.platformId,
    platformTriple: release.platformTriple,
    releaseTag: `v${release.version}`,
    releaseName: `genie-${release.version}-${release.platformId}.tar.gz`,
    artifactSha256: release.artifactSha256,
  };
}

/** A copy of the verifier with one literal changed, to prove that literal is live against a real certificate. */
async function withVerifierProbe<T>(
  name: string,
  from: string,
  to: string,
  run: (probe: { verifyDeliveryEvidenceArtifact: typeof verifyDeliveryEvidenceArtifact }) => T,
): Promise<T> {
  const verifierPath = join(import.meta.dir, 'delivery-evidence-verify.ts');
  const probePath = join(import.meta.dir, `delivery-evidence-verify.${name}-probe.tmp.ts`);
  const source = readFileSync(verifierPath, 'utf8');
  expect(source.split(from).length - 1).toBe(1);
  writeFileSync(probePath, source.replace(from, to));
  try {
    return run((await import(probePath)) as { verifyDeliveryEvidenceArtifact: typeof verifyDeliveryEvidenceArtifact });
  } finally {
    rmSync(probePath, { force: true });
  }
}

describe('signer policy — real certificates published before the rename', () => {
  test.each([...PUBLISHED_BEFORE_RENAME])('(b) $label verifies offline under the id rule', (release) => {
    const facts = verifyDeliveryEvidenceArtifact(publishedInput(release));
    expect(facts.descriptor.repository).toBe('automagik-dev/genie');
    expect(facts.descriptor.version).toBe(release.version);
  });

  test('(c) the real certificate is refused by a verifier that pins another repository id', async () => {
    await withVerifierProbe(
      'repository-id',
      "DELIVERY_EVIDENCE_REPOSITORY_ID = '1030039430'",
      `DELIVERY_EVIDENCE_REPOSITORY_ID = '${OTHER_REPOSITORY_ID}'`,
      (probe) => {
        for (const release of PUBLISHED_BEFORE_RENAME) {
          expect(() => probe.verifyDeliveryEvidenceArtifact(publishedInput(release))).toThrow('1.3.6.1.4.1.57264.1.15');
        }
        expect(() => probe.verifyDeliveryEvidenceArtifact(realReleaseInput())).toThrow('1.3.6.1.4.1.57264.1.15');
      },
    );
  });

  test('(d) the real certificate is refused by a verifier that pins another owner id', async () => {
    await withVerifierProbe(
      'owner-id',
      "DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID = '245047546'",
      `DELIVERY_EVIDENCE_REPOSITORY_OWNER_ID = '${OTHER_OWNER_ID}'`,
      (probe) => {
        for (const release of PUBLISHED_BEFORE_RENAME) {
          expect(() => probe.verifyDeliveryEvidenceArtifact(publishedInput(release))).toThrow('1.3.6.1.4.1.57264.1.17');
        }
      },
    );
  });

  test('(e) the real certificate is refused when the verifier requires an extension it does not carry', async () => {
    // 1.3.6.1.4.1.57264.1.99 is not a Fulcio extension, so to this verifier the
    // real certificate is one whose repository identifier is missing.
    await withVerifierProbe(
      'missing-extension',
      "FULCIO_SOURCE_REPOSITORY_ID_OID = '1.3.6.1.4.1.57264.1.15'",
      "FULCIO_SOURCE_REPOSITORY_ID_OID = '1.3.6.1.4.1.57264.1.99'",
      (probe) => {
        for (const release of PUBLISHED_BEFORE_RENAME) {
          expect(() => probe.verifyDeliveryEvidenceArtifact(publishedInput(release))).toThrow('1.3.6.1.4.1.57264.1.99');
        }
      },
    );
  });

  test('the real certificate is refused when the descriptor is edited to the other accepted name', () => {
    // Same real signature, but the descriptor now claims the current name: the
    // subject digest no longer binds it, and no accepted name can be swapped in.
    const input = publishedInput(PUBLISHED_BEFORE_RENAME[0]);
    const descriptor = Buffer.from(input.descriptorBytes as Uint8Array)
      .toString('utf8')
      .replace('"repository":"automagik-dev/genie"', '"repository":"automagik-si/genie"');
    expect(descriptor).toContain('automagik-si/genie');
    expect(() => verifyDeliveryEvidenceArtifact({ ...input, descriptorBytes: descriptor })).toThrow(
      'tarball_base mismatch',
    );
  });
});
