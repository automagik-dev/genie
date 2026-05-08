/**
 * `genie omni handshake` — register this genie host with the local omni
 * server using a per-host ed25519 keypair.
 *
 * Wish: omni-host-fingerprint-trust, Group 2.
 *
 * Flow:
 *   1. Find or generate a keypair at ~/.genie/keys/genie-host.{ed25519,ed25519.pub}
 *      (perms 0600; refuse to write keys inside a git working tree).
 *   2. POST { pubkey, hostname, capabilities } to omni's
 *      /api/v2/trust/handshake (which is idempotent on pubkey).
 *   3. Persist the returned host_id to ~/.genie/keys/host.json so the
 *      signing middleware (Group 3) can attach `X-Genie-Host-Id` to every
 *      outgoing request.
 *   4. `--rotate` issues a fresh keypair and revokes the old in a single
 *      round-trip (atomically from the operator's perspective — the old
 *      key is revoked AFTER the new one registers, so we never lose
 *      access).
 *
 * Auth: bearer token from genie config / $OMNI_API_KEY. The first
 * handshake always uses bearer because that's the only way to bootstrap
 * trust for a brand-new host. Subsequent handshakes (and the eventual
 * Group 3 signing path) can use signatures.
 *
 * What's NOT in this command (subsequent groups):
 *   - Signing outgoing requests (Group 3): the keypair lands here, but
 *     `omni-registration.ts` doesn't read it yet.
 *   - Verification middleware on omni (Group 4): the host record is
 *     stored, but no request is verified yet.
 */

import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { loadGenieConfig } from '../../lib/genie-config.js';
import { resolveOmniApiUrl } from '../../lib/omni-registration.js';

interface KeyPaths {
  dir: string;
  privateKey: string;
  publicKey: string;
  hostJson: string;
}

interface HostRecord {
  hostId: string;
  pubkey: string;
  hostname: string;
  registeredAt: string;
  rotatedFrom?: string;
}

function keyPaths(): KeyPaths {
  const home = process.env.GENIE_HOME ?? join(process.env.HOME ?? '/root', '.genie');
  const dir = join(home, 'keys');
  return {
    dir,
    privateKey: join(dir, 'genie-host.ed25519'),
    publicKey: join(dir, 'genie-host.ed25519.pub'),
    hostJson: join(dir, 'host.json'),
  };
}

/**
 * Refuse to write the keypair inside a git working tree. Operators that
 * accidentally `genie omni handshake` from a project root would otherwise
 * stage their secret key for the next commit. This is a sanity check; not
 * a security guarantee — operators with custom GENIE_HOME values are on
 * their own.
 */
function assertNotInsideGitRepo(dir: string): void {
  let probe = resolvePath(dir);
  for (let depth = 0; depth < 16; depth++) {
    if (existsSync(join(probe, '.git'))) {
      throw new Error(
        `Refusing to write keys to ${dir} — it lives inside a git working tree (${join(probe, '.git')}). Set $GENIE_HOME to a path outside any git repo and re-run.`,
      );
    }
    const parent = dirname(probe);
    if (parent === probe) return; // hit fs root
    probe = parent;
  }
}

function generateAndPersistKeypair(paths: KeyPaths): { pubkeyB64Url: string } {
  if (!existsSync(paths.dir)) {
    mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // Raw 32-byte public key, base64url encoded (matches omni's regex gate).
  const rawPub = publicKey.export({ format: 'der', type: 'spki' });
  // The DER prefix for ed25519 is 12 bytes; the last 32 bytes are the raw key.
  const rawKey = rawPub.subarray(rawPub.length - 32);
  const pubkeyB64Url = rawKey.toString('base64url');

  writeFileSync(paths.privateKey, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  writeFileSync(paths.publicKey, pubkeyB64Url, { mode: 0o644 });
  // Belt-and-suspenders chmod in case writeFileSync's mode flag was ignored
  chmodSync(paths.privateKey, 0o600);

  return { pubkeyB64Url };
}

function loadExistingPubkey(paths: KeyPaths): string | null {
  if (!existsSync(paths.publicKey)) return null;
  return readFileSync(paths.publicKey, 'utf-8').trim();
}

function loadHostJson(paths: KeyPaths): HostRecord | null {
  if (!existsSync(paths.hostJson)) return null;
  try {
    return JSON.parse(readFileSync(paths.hostJson, 'utf-8')) as HostRecord;
  } catch {
    return null;
  }
}

function writeHostJson(paths: KeyPaths, record: HostRecord): void {
  writeFileSync(paths.hostJson, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
}

async function resolveOmniApiKey(): Promise<string | undefined> {
  const envKey = process.env.OMNI_API_KEY;
  if (envKey) return envKey;
  const config = await loadGenieConfig();
  return config.omni?.apiKey;
}

async function callTrustEndpoint<T>(
  apiUrl: string,
  apiKey: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v2/trust${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`omni trust ${method} ${path}: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  return (await res.json()) as T;
}

interface TrustHostResponse {
  data: { id: string; pubkey: string; hostname: string };
}

/** Detect the parent process is a TTY (so we know whether to inject color). */
function gitRevParseSafe(): string | undefined {
  try {
    return execSync('git rev-parse --git-dir', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

interface HandshakeOptions {
  rotate?: boolean;
  hostname?: string;
}

async function handleHandshake(options: HandshakeOptions): Promise<void> {
  const apiUrl = await resolveOmniApiUrl();
  if (!apiUrl) {
    throw new Error(
      'Omni is not configured. Set OMNI_API_URL or `omni.apiUrl` in your genie config first.\nExample: omni install',
    );
  }
  const apiKey = await resolveOmniApiKey();
  if (!apiKey) {
    throw new Error('Omni API key not configured. Set OMNI_API_KEY or `omni.apiKey` in your genie config.');
  }

  const paths = keyPaths();
  assertNotInsideGitRepo(paths.dir);

  const previousRecord = loadHostJson(paths);
  let pubkey = loadExistingPubkey(paths);

  if (options.rotate) {
    if (!previousRecord) {
      throw new Error(
        'Cannot --rotate: no existing host record at ~/.genie/keys/host.json. Run a plain handshake first.',
      );
    }
    // Generate fresh keypair (overwrites old keys on disk).
    const fresh = generateAndPersistKeypair(paths);
    pubkey = fresh.pubkeyB64Url;
  } else if (!pubkey) {
    const fresh = generateAndPersistKeypair(paths);
    pubkey = fresh.pubkeyB64Url;
  }

  const hostname = options.hostname ?? previousRecord?.hostname ?? osHostname() ?? 'unknown-host';
  const capabilities = {
    genieVersion: process.env.GENIE_VERSION ?? 'unknown',
    platform: process.platform,
    nodeVersion: process.version,
  };

  const { data: host } = await callTrustEndpoint<TrustHostResponse>(apiUrl, apiKey, 'POST', '/handshake', {
    pubkey,
    hostname,
    capabilities,
  });

  const newRecord: HostRecord = {
    hostId: host.id,
    pubkey: host.pubkey,
    hostname: host.hostname,
    registeredAt: new Date().toISOString(),
    ...(options.rotate && previousRecord ? { rotatedFrom: previousRecord.hostId } : {}),
  };
  writeHostJson(paths, newRecord);

  // Step 4 of the rotate flow: revoke the OLD host record AFTER the new one
  // registers. Order matters — if revoke fails, we still have a working new
  // host_id; if revoke succeeds before register, we'd have lost access.
  if (options.rotate && previousRecord && previousRecord.hostId !== host.id) {
    try {
      await callTrustEndpoint<{ data: unknown }>(apiUrl, apiKey, 'DELETE', `/hosts/${previousRecord.hostId}`);
    } catch (err) {
      // Non-fatal — operator can finish revoking via `omni trust revoke <id>`
      // if needed. Surface the manual recovery path explicitly.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `\n⚠ Rotated key registered as ${host.id}, but revoking the old host (${previousRecord.hostId}) failed:\n  ${message}\n  Finish manually: omni trust revoke ${previousRecord.hostId}\n`,
      );
    }
  }

  console.log(`Genie host registered: ${host.id}`);
  console.log(`  Hostname:     ${host.hostname}`);
  console.log(`  Public key:   ${host.pubkey}`);
  console.log(`  Private key:  ${paths.privateKey} (perms 0600)`);
  if (options.rotate && previousRecord) {
    console.log(`  Rotated from: ${previousRecord.hostId} (revoked)`);
  }
}

export function registerOmniNamespace(program: Command): void {
  // Avoid clobbering an existing `omni` command if one was registered earlier
  // in startup. Commander throws on duplicate command names, but
  // `program.commands.find` is the cheap pre-check.
  const existing = program.commands.find((c) => c.name() === 'omni');
  const omni = existing ?? program.command('omni').description('Omni integration commands (handshake, etc.)');

  omni
    .command('handshake')
    .description('Register this genie host with the local omni server (ed25519 keypair, idempotent).')
    .option('--rotate', 'Issue a new keypair and revoke the existing host record')
    .option('--hostname <name>', 'Override the hostname reported to omni (defaults to os.hostname())')
    .action(async (options: HandshakeOptions) => {
      try {
        await handleHandshake(options);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${message}`);
        process.exit(1);
      }
    });
}

// Exported for tests to exercise without driving Commander.
export const __test__ = {
  keyPaths,
  assertNotInsideGitRepo,
  loadExistingPubkey,
  loadHostJson,
  writeHostJson,
  generateAndPersistKeypair,
  gitRevParseSafe,
};
