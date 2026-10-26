import { describe, expect, test } from 'bun:test';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  KEY_ID,
  PLUGIN_DIR,
  type Packed,
  ROOT,
  baseOf,
  describe as describeTarball,
  manifest,
  pack,
  sequenceOf,
  signLane,
  verifyLane,
} from './plugin-lane';

const PACKED: Packed = {
  name: '@automagik/genie-dsh',
  version: '0.1.2',
  file: 'automagik-genie-dsh-0.1.2.tgz',
  integrity: 'sha512-abc',
  sha256: 'f'.repeat(64),
  size: 10302,
  dsh: '>=0.2.1-rc.2 <0.3.0',
  base: '3.3.0',
};
const COMMIT = 'a'.repeat(40);

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keys: [{ keyId: KEY_ID, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() }],
  };
}

describe('plugin lane', () => {
  test('sequence grows with every version, so an older lane is refused', () => {
    expect(sequenceOf('0.1.2')).toBe(10_002);
    expect(sequenceOf('0.2.0')).toBeGreaterThan(sequenceOf('0.1.9999'));
    expect(sequenceOf('1.0.0')).toBeGreaterThan(sequenceOf('0.9999.9999'));
    expect(() => sequenceOf('0.1.2-rc.1')).toThrow('not a release version');
  });

  test('base is the floor of the Bot team peer range, and a range without one is refused', () => {
    expect(baseOf('>=3.3.0')).toBe('3.3.0');
    expect(baseOf('>= 3.24.0 <4')).toBe('3.24.0');
    expect(() => baseOf('^3.3.0')).toThrow('no >= floor');
    expect(() => baseOf(undefined)).toThrow('no >= floor');
  });

  test("the manifest is Automagik's schema 1, publisher genie, the tarball on its own versioned release", () => {
    const lane = manifest(PACKED, { commit: COMMIT, issuedAt: '2026-10-26T04:00:00Z' });
    expect(lane).toMatchObject({
      schemaVersion: 1,
      publisher: 'genie',
      keyId: KEY_ID,
      sequence: 10_002,
      version: '0.1.2',
      commit: COMMIT,
      base: '3.3.0',
    });
    expect(lane.plugins).toEqual([
      {
        name: '@automagik/genie-dsh',
        version: '0.1.2',
        url: 'https://github.com/automagik-dev/genie/releases/download/genie-dsh-v0.1.2/automagik-genie-dsh-0.1.2.tgz',
        integrity: 'sha512-abc',
        sha256: 'f'.repeat(64),
        size: 10302,
        engines: { dsh: '>=0.2.1-rc.2 <0.3.0' },
      },
    ]);
    expect(() => manifest(PACKED, { commit: 'HEAD', issuedAt: 'x' })).toThrow('not a commit');
  });

  test('a signed lane verifies, and a changed byte, another key or another publisher does not', () => {
    const { privatePem, keys } = keyPair();
    const bytes = Buffer.from(JSON.stringify(manifest(PACKED, { commit: COMMIT, issuedAt: '2026-10-26T04:00:00Z' })));
    const signature = signLane(bytes, privatePem);
    expect(verifyLane(bytes, `${signature}\n`, keys).version).toBe('0.1.2');
    const tampered = Buffer.from(bytes.toString().replace('0.1.2', '0.1.3'));
    expect(() => verifyLane(tampered, signature, keys)).toThrow('signature does not match');
    expect(() => verifyLane(bytes, signature, keyPair().keys)).toThrow('signature does not match');
    expect(() => verifyLane(bytes, signature, [{ ...keys[0], keyId: 'other' }] as typeof keys)).toThrow(
      'no key genie-2026-10',
    );
    const automagik = Buffer.from(bytes.toString().replace('"publisher":"genie"', '"publisher":"automagik"'));
    expect(() => verifyLane(automagik, signLane(automagik, privatePem), keys)).toThrow('publisher automagik');
  });

  test('plugin-lane/keys.json lists the key the lane is signed with, as an ed25519 SPKI PEM', () => {
    const { keys } = JSON.parse(readFileSync(join(ROOT, 'plugin-lane', 'keys.json'), 'utf8'));
    const key = keys.find((entry: { keyId: string }) => entry.keyId === KEY_ID);
    expect(key).toBeDefined();
    expect(createPublicKey(key.publicKey).asymmetricKeyType).toBe('ed25519');
  });

  test('the real genie-dsh packs, and a released tarball is described from its own bytes as npm did', () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-lane-'));
    try {
      const packed = pack(dir);
      const version = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version;
      expect(packed).toMatchObject({
        name: '@automagik/genie-dsh',
        version,
        file: `automagik-genie-dsh-${version}.tgz`,
      });
      expect(packed.integrity).toStartWith('sha512-');
      expect(describeTarball(join(dir, packed.file))).toEqual(packed);
      // The workflow passes a folder relative to the checkout root; npm packs from the plugin's.
      rmSync(join(dir, packed.file));
      expect(pack(relative(process.cwd(), dir))).toEqual(packed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
