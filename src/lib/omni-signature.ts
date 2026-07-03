/**
 * Omni request signing — attach `X-Genie-*` headers to every outgoing
 * genie→omni write so omni can verify the request came from a registered host.
 *
 * Ported from origin/v4:src/lib/omni-signature.ts (wish omni-host-fingerprint-trust,
 * Group 3). Reads the keypair `genie omni handshake` drops at
 * `~/.genie/keys/genie-host.ed25519` + `~/.genie/keys/host.json`.
 *
 * Signature scheme (must stay byte-identical to omni's verifier):
 *   canonical = `<iso8601>\n<METHOD>\n<path>\n<sha256hex(body)>`
 *   sig       = base64url( ed25519( canonical ) )
 *
 * Bearer fallback: when the keypair or host record is missing, `signOmniRequest`
 * returns null and the caller falls back to bearer-token auth. One stderr
 * warning per process so operators notice without being spammed.
 */

import { type KeyObject, createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
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
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
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
 * Build the canonical input the omni verifier reconstructs from the incoming
 * request. Both sides must produce byte-identical input or the signature
 * fails — every change here is a wire-protocol change.
 */
export function canonicalSigningInput(timestamp: string, method: string, path: string, body: string): string {
  const bodyHash = createHash('sha256').update(body, 'utf-8').digest('hex');
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/**
 * Produce the signature header set for one outgoing request.
 *
 * @param method HTTP method (any case; canonicalized to upper).
 * @param path   Request path INCLUDING query string.
 * @param body   Stringified body; empty string for body-less GETs.
 * @returns Header set, or null when the local keypair/host record is missing.
 */
export function signOmniRequest(method: string, path: string, body: string): OmniSignatureHeaders | null {
  const paths = keyPaths();
  const host = loadHostRecord(paths.hostJson);
  const key = loadPrivateKey(paths.privateKey);

  if (!host || !key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
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

/** Test-only: reset the one-shot warn flag and cached key. */
export const __test__ = {
  resetState(): void {
    warnedMissingKey = false;
    cachedKey = null;
    cachedKeyPath = null;
  },
  keyPaths,
};
