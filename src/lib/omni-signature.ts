/**
 * Omni Request Signing — attach `X-Genie-Signature` headers to every
 * outgoing genie→omni write so omni can verify the request came from a
 * registered host.
 *
 * Wish: omni-host-fingerprint-trust, Group 3.
 *
 * Reads the keypair that `genie omni handshake` (Group 2) drops at
 * `~/.genie/keys/genie-host.ed25519` and `~/.genie/keys/host.json`.
 *
 * Signature scheme (matches the wish's Group 4 verifier on the omni side):
 *   - Canonical input: `<iso8601-timestamp>\n<METHOD>\n<path>\n<sha256(body)>`
 *   - Algorithm: ed25519 sign over the UTF-8 bytes of the canonical input
 *   - Encoding: base64url (no padding) for the signature
 *   - Body hash: empty string for body-less requests; sha256(body) otherwise
 *
 * Headers attached on success:
 *   X-Genie-Host-Id    UUID from host.json
 *   X-Genie-Timestamp  ISO 8601 UTC (e.g. 2026-04-29T18:00:00.000Z)
 *   X-Genie-Signature  base64url(ed25519(canonical))
 *
 * Bearer-fallback semantics: if the keypair file is missing OR the host
 * record is missing, `signOmniRequest` returns `null` and the caller
 * falls back to bearer-token auth (the existing behavior). A one-time
 * stderr warning is emitted per process so operators see the situation
 * without being spammed on every call.
 *
 * IMPORTANT: this module does NOT decide whether the omni endpoint
 * accepts the signature — that's Group 4's verifier. Group 3 just
 * produces signed requests; the omni server still trusts the bearer
 * token for now (backward-compat mode).
 */

import { type KeyObject, createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface KeyPaths {
  privateKey: string;
  hostJson: string;
}

interface HostRecord {
  hostId: string;
  pubkey: string;
  hostname: string;
}

/** Headers attached to a signed request. */
export interface OmniSignatureHeaders {
  'X-Genie-Host-Id': string;
  'X-Genie-Timestamp': string;
  'X-Genie-Signature': string;
}

let warnedMissingKey = false;

function keyPaths(): KeyPaths {
  const home = process.env.GENIE_HOME ?? join(process.env.HOME ?? '/root', '.genie');
  return {
    privateKey: join(home, 'keys', 'genie-host.ed25519'),
    hostJson: join(home, 'keys', 'host.json'),
  };
}

function loadHostRecord(path: string): HostRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as HostRecord;
  } catch {
    return null;
  }
}

let cachedKey: KeyObject | null = null;
let cachedKeyPath: string | null = null;
function loadPrivateKey(path: string): KeyObject | null {
  if (cachedKey && cachedKeyPath === path) return cachedKey;
  if (!existsSync(path)) return null;
  try {
    const pem = readFileSync(path, 'utf-8');
    const key = createPrivateKey(pem);
    cachedKey = key;
    cachedKeyPath = path;
    return key;
  } catch {
    return null;
  }
}

/**
 * Build the canonical input the verifier on the omni side will reconstruct
 * from the incoming request. Both sides must produce byte-identical input
 * or the signature will fail. Keep this function tiny and obvious — every
 * change here is a wire-protocol change.
 */
export function canonicalSigningInput(timestamp: string, method: string, path: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf-8').digest('hex');
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/**
 * Produce the signature header set for a single outgoing request.
 *
 * @param method  HTTP method (any case; canonicalized to upper).
 * @param path    Request path INCLUDING query string. The omni verifier
 *                reconstructs this from `req.url.pathname + req.url.search`.
 * @param body    Stringified body. Empty string for body-less GETs.
 * @returns Header set on success, `null` when the local keypair is missing.
 */
export function signOmniRequest(method: string, path: string, body: string): OmniSignatureHeaders | null {
  const paths = keyPaths();
  const host = loadHostRecord(paths.hostJson);
  const key = loadPrivateKey(paths.privateKey);

  if (!host || !key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      // One-time warning per process. Stderr-only so JSON consumers stay clean.
      // Note: this is informational, not an error — bearer fallback still
      // works for hosts that haven't run `genie omni handshake` yet.
      const reason = !host
        ? 'host record at ~/.genie/keys/host.json'
        : 'private key at ~/.genie/keys/genie-host.ed25519';
      process.stderr.write(
        `[omni-signature] Falling back to bearer auth — missing ${reason}.\n[omni-signature] Run \`genie omni handshake\` to register this host and enable signed requests.\n`,
      );
    }
    return null;
  }

  const timestamp = new Date().toISOString();
  const canonical = canonicalSigningInput(timestamp, method, path, body);
  const signature = sign(null, Buffer.from(canonical, 'utf-8'), key).toString('base64url');

  return {
    'X-Genie-Host-Id': host.hostId,
    'X-Genie-Timestamp': timestamp,
    'X-Genie-Signature': signature,
  };
}

/** Test-only: reset the one-shot warn flag and the cached key. */
export const __test__ = {
  resetState(): void {
    warnedMissingKey = false;
    cachedKey = null;
    cachedKeyPath = null;
  },
  keyPaths,
};
