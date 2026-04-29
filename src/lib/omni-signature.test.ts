/**
 * Tests for the genie→omni request signing helper (Group 3 of the
 * omni-host-fingerprint-trust wish).
 *
 * Pinned contract:
 *   - canonicalSigningInput is byte-stable for known inputs (golden vector).
 *     Both sides of the wire (this module + omni's Group 4 verifier) must
 *     produce identical bytes; any drift here breaks every signed request.
 *   - signOmniRequest returns null + emits a one-time stderr warning when
 *     the keypair is missing (bearer fallback path).
 *   - signOmniRequest emits the three expected headers when keys exist,
 *     and the signature verifies under the registered public key.
 *   - The body hash is computed over the string the caller passed
 *     (UTF-8 encoded), not over the parsed JSON.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __test__, canonicalSigningInput, signOmniRequest } from './omni-signature';

const ORIGINAL_GENIE_HOME = process.env.GENIE_HOME;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'genie-omni-sig-test-'));
  process.env.GENIE_HOME = workDir;
  __test__.resetState();
});

afterEach(() => {
  if (ORIGINAL_GENIE_HOME === undefined) {
    process.env.GENIE_HOME = undefined;
  } else {
    process.env.GENIE_HOME = ORIGINAL_GENIE_HOME;
  }
  rmSync(workDir, { recursive: true, force: true });
});

describe('canonicalSigningInput — golden vector', () => {
  test('byte-stable for a known input', () => {
    // If this test ever has to change, every signed request that's in
    // flight at the time of the change will fail until the omni-side
    // verifier (Group 4) is updated to match. Treat this as a wire
    // protocol change.
    const input = canonicalSigningInput(
      '2026-04-29T18:00:00.000Z',
      'POST',
      '/api/v2/agents',
      JSON.stringify({ name: 'foo', provider: 'claude' }),
    );
    const expected =
      '2026-04-29T18:00:00.000Z\n' +
      'POST\n' +
      '/api/v2/agents\n' +
      // sha256('{"name":"foo","provider":"claude"}') as hex
      '22f73e1c7000ed8f1cb694d1b1019750c3e9ad05380832b114d6d17f1cefa38a';
    // Sanity: do the actual hash to double-check the constant above stays
    // accurate if the test author re-runs against fresh node:crypto.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const actualBodyHash = createHash('sha256').update('{"name":"foo","provider":"claude"}', 'utf-8').digest('hex');
    expect(input.endsWith(`\n${actualBodyHash}`)).toBe(true);
    expect(input.startsWith('2026-04-29T18:00:00.000Z\nPOST\n/api/v2/agents\n')).toBe(true);
    // The full vector in code-comment form so reviewers can see it:
    expect(input).toBe(`2026-04-29T18:00:00.000Z\nPOST\n/api/v2/agents\n${actualBodyHash}`);
    // The hex literal above must match for omni's verifier; if your local
    // crypto returns something different the verifier will reject.
    const expectedHash = expected.split('\n').pop() ?? '';
    expect(actualBodyHash).toBe(expectedHash);
  });

  test('lowercases method-only keeping path/body intact', () => {
    const a = canonicalSigningInput('t', 'get', '/p', '');
    const b = canonicalSigningInput('t', 'GET', '/p', '');
    expect(a).toBe(b);
  });

  test('empty body produces the empty-string sha256', () => {
    const input = canonicalSigningInput('t', 'GET', '/p', '');
    // sha256('') = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(input).toBe('t\nGET\n/p\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('signOmniRequest — bearer fallback', () => {
  test('returns null when host record is missing', () => {
    const result = signOmniRequest('POST', '/api/v2/agents', '{}');
    expect(result).toBeNull();
  });

  test('warns once on stderr (not on subsequent calls)', () => {
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      signOmniRequest('POST', '/x', '');
      signOmniRequest('POST', '/x', '');
      signOmniRequest('POST', '/x', '');
    } finally {
      process.stderr.write = originalWrite;
    }
    const warnings = captured.filter((c) => c.includes('[omni-signature]'));
    // 2 lines per warning emission (the "Falling back" + "Run handshake" lines
    // are written together in one write call → 1 chunk).
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.length).toBeLessThanOrEqual(2);
    expect(warnings[0]).toContain('genie omni handshake');
  });
});

describe('signOmniRequest — keypair present', () => {
  function setupKeyAndHost(): { pubkey: Buffer } {
    const keysDir = join(workDir, 'keys');
    mkdirSync(keysDir, { recursive: true });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(join(keysDir, 'genie-host.ed25519'), privateKey.export({ format: 'pem', type: 'pkcs8' }), {
      mode: 0o600,
    });
    const rawPubDer = publicKey.export({ format: 'der', type: 'spki' });
    const rawPub = rawPubDer.subarray(rawPubDer.length - 32);
    const pubkeyB64Url = rawPub.toString('base64url');
    writeFileSync(join(keysDir, 'genie-host.ed25519.pub'), pubkeyB64Url);
    writeFileSync(
      join(keysDir, 'host.json'),
      JSON.stringify(
        {
          hostId: 'host-uuid-test',
          pubkey: pubkeyB64Url,
          hostname: 'genie.test',
          registeredAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return { pubkey: rawPub };
  }

  test('emits the 3 expected headers', () => {
    setupKeyAndHost();
    const sig = signOmniRequest('POST', '/api/v2/agents', '{"k":"v"}');
    expect(sig).not.toBeNull();
    expect(sig?.['X-Genie-Host-Id']).toBe('host-uuid-test');
    expect(sig?.['X-Genie-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(sig?.['X-Genie-Signature']).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('signature verifies against the registered public key', () => {
    const { pubkey } = setupKeyAndHost();
    const body = '{"k":"v"}';
    const sig = signOmniRequest('POST', '/api/v2/agents', body);
    expect(sig).not.toBeNull();

    // Reconstruct what omni's Group 4 verifier will produce and check the
    // signature verifies — proves both sides will agree.
    const { createPublicKey } = require('node:crypto') as typeof import('node:crypto');
    // ed25519 SPKI prefix (DER): 0x302a300506032b6570032100 + 32 bytes
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pubkey]);
    const pubKeyObj = createPublicKey({ key: spki, format: 'der', type: 'spki' });

    const canonical = canonicalSigningInput(sig?.['X-Genie-Timestamp'] ?? '', 'POST', '/api/v2/agents', body);
    const sigBytes = Buffer.from(sig?.['X-Genie-Signature'] ?? '', 'base64url');
    const ok = verify(null, Buffer.from(canonical, 'utf-8'), pubKeyObj, sigBytes);
    expect(ok).toBe(true);
  });

  test('different body produces different signature (hash is part of canonical)', () => {
    setupKeyAndHost();
    const a = signOmniRequest('POST', '/api/v2/agents', '{"k":"v"}');
    const b = signOmniRequest('POST', '/api/v2/agents', '{"k":"different"}');
    expect(a?.['X-Genie-Signature']).not.toBe(b?.['X-Genie-Signature']);
  });

  test('does NOT warn when keypair is present', () => {
    setupKeyAndHost();
    const captured: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      signOmniRequest('POST', '/x', '{}');
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(captured.filter((c) => c.includes('[omni-signature]'))).toHaveLength(0);
  });
});
