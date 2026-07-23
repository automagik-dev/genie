import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY,
  DELIVERY_EVIDENCE_WORKFLOW_IDENTITY_PATTERN,
  deriveDeliveryId,
  observePersistedDeliveryEvidence,
  persistVerifiedDeliveryEvidence,
  verifiedDeliveryEvidenceFacts,
  verifyDownloadedDeliveryEvidence,
} from './codex-delivery-evidence.js';
import { buildTestDeliveryEvidencePack, mintTestDeliveryEvidence } from './codex-delivery-evidence.test-support.js';

describe('Codex signed delivery evidence', () => {
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

  test('persists exact bytes content-addressed and re-verifies them offline', () => {
    const genieHome = createTempDir('delivery-evidence');
    try {
      const { evidence, pack } = mintTestDeliveryEvidence();
      const persisted = persistVerifiedDeliveryEvidence(genieHome, evidence);
      const observed = observePersistedDeliveryEvidence(genieHome, persisted.evidenceDigest, pack.dependencies);

      expect(observed.status).toBe('present');
      if (observed.status === 'present') {
        expect(observed.facts).toEqual(persisted);
      }
      // Idempotency is exact-byte based.
      expect(persistVerifiedDeliveryEvidence(genieHome, evidence)).toEqual(persisted);
    } finally {
      removeTempDir(genieHome);
    }
  });

  test('fails closed on descriptor, bundle, and manifest tampering in stored packs', () => {
    for (const file of ['descriptor.json', 'bundle.json', 'manifest.json']) {
      const genieHome = createTempDir(`delivery-evidence-${file}`);
      try {
        const { evidence, pack } = mintTestDeliveryEvidence();
        const facts = persistVerifiedDeliveryEvidence(genieHome, evidence);
        const path = join(genieHome, '.codex-delivery-evidence-v1', facts.evidenceDigest, file);
        writeFileSync(path, `${readFileSync(path, 'utf8')} `, { mode: 0o600 });

        const observed = observePersistedDeliveryEvidence(genieHome, facts.evidenceDigest, pack.dependencies);
        expect(observed.status).toBe('invalid');
      } finally {
        removeTempDir(genieHome);
      }
    }
  });

  test('fails closed on symlinked or non-private evidence storage', () => {
    const genieHome = createTempDir('delivery-evidence-unsafe');
    const target = createTempDir('delivery-evidence-target');
    try {
      symlinkSync(target, join(genieHome, '.codex-delivery-evidence-v1'));
      expect(observePersistedDeliveryEvidence(genieHome, 'a'.repeat(64)).status).toBe('invalid');

      const otherHome = createTempDir('delivery-evidence-mode');
      try {
        mkdirSync(join(otherHome, '.codex-delivery-evidence-v1'), { mode: 0o700 });
        chmodSync(join(otherHome, '.codex-delivery-evidence-v1'), 0o755);
        expect(observePersistedDeliveryEvidence(otherHome, 'a'.repeat(64)).status).toBe('invalid');
      } finally {
        removeTempDir(otherHome);
      }
    } finally {
      removeTempDir(genieHome);
      removeTempDir(target);
    }
  });

  test('derives a domain-separated stable 128-bit id from evidence and physical root', () => {
    const a = deriveDeliveryId('a'.repeat(64), '/physical/a');
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(deriveDeliveryId('a'.repeat(64), '/physical/a')).toBe(a);
    expect(deriveDeliveryId('b'.repeat(64), '/physical/a')).not.toBe(a);
    expect(deriveDeliveryId('a'.repeat(64), '/physical/b')).not.toBe(a);
  });
});

function mutate(value: unknown): unknown {
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'string') return value.length === 0 ? 'x' : `${value.slice(0, -1)}x`;
  return null;
}

function createTempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `genie-${label}-`));
}

function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
