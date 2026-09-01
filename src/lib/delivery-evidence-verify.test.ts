import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN,
  verifiedDeliveryEvidenceFacts,
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
