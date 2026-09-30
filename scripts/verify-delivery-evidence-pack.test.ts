import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'verify-delivery-evidence-pack.ts');

// Real evidence pack produced by release run 30212680700 (v5.260726.3, dev).
// These fixtures exercise the full embedded-trust-root verification with no
// cryptographic seam, under the same runtime that ships to production. Bun's
// BoringSSL-backed crypto has no default digest for ECDSA, so an unpatched
// @sigstore/core silently fails every EC signature check here (the
// TLOG_INCLUSION_PROMISE_ERROR release outage); Node infers SHA-256.
const REAL_EVIDENCE_DIR = join(import.meta.dir, '..', 'tests', 'fixtures', 'delivery-evidence');
const REAL_DESCRIPTOR = join(REAL_EVIDENCE_DIR, 'genie-5.260726.3-darwin-arm64.tar.gz.dev.delivery.json');
const REAL_BUNDLE = join(REAL_EVIDENCE_DIR, 'genie-5.260726.3-darwin-arm64.tar.gz.dev.delivery.json.sigstore.json');
const REAL_MANIFEST = join(REAL_EVIDENCE_DIR, 'dev.json');
const REAL_EVIDENCE_DIGEST = '360781fb83029b4fe2feace547fca43ee47b440947c680ef8b08d97f3fbd3425';

function runVerifier(descriptor: string, bundle: string, manifest: string): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(['bun', SCRIPT, '--descriptor', descriptor, '--bundle', bundle, '--manifest', manifest]);
  return { exitCode: result.exitCode, stdout: result.stdout.toString('utf8') };
}

describe('production offline delivery evidence compatibility CLI', () => {
  test('verifies a real production endorsement bundle with real cryptography', () => {
    const result = runVerifier(REAL_DESCRIPTOR, REAL_BUNDLE, REAL_MANIFEST);
    expect(result.stdout.trim()).toBe(`verified offline delivery evidence ${REAL_EVIDENCE_DIGEST}`);
    expect(result.exitCode).toBe(0);
  });

  test.each([
    [
      'transparency-log inclusion promise',
      (bundle: Record<string, any>) => {
        const entry = bundle.verificationMaterial.tlogEntries[0];
        entry.inclusionPromise.signedEntryTimestamp = flipFirstByte(entry.inclusionPromise.signedEntryTimestamp);
      },
    ],
    [
      'DSSE envelope signature',
      (bundle: Record<string, any>) => {
        const signature = bundle.dsseEnvelope.signatures[0];
        signature.sig = flipFirstByte(signature.sig);
      },
    ],
  ])('rejects the real bundle with a tampered %s', (_label, tamper) => {
    const root = mkdtempSync(join(tmpdir(), 'genie-evidence-tamper-'));
    try {
      const bundle = JSON.parse(readFileSync(REAL_BUNDLE, 'utf8')) as Record<string, any>;
      tamper(bundle);
      const bundlePath = join(root, 'bundle.json');
      writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`);
      const result = runVerifier(REAL_DESCRIPTOR, bundlePath, REAL_MANIFEST);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function flipFirstByte(base64: string): string {
  const bytes = Buffer.from(base64, 'base64');
  bytes[0] ^= 0xff;
  return bytes.toString('base64');
}
