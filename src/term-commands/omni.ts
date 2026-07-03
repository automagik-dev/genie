/**
 * `genie omni` — the Omni integration namespace.
 *
 *   omni serve      Foreground runner: the one resident process that bridges the
 *                   phone (NATS) to the global approval queue.
 *   omni status     Queue counts + config sanity (no network).
 *   omni inbox      List stored inbound messages (no network).
 *   omni handshake  Register this host with omni via a per-host ed25519 keypair.
 *
 * `nats` is imported ONLY dynamically inside `serve` (via omni-runner's default
 * factory) so `genie --help` / `status` / `inbox` / `handshake` never touch the
 * transport. Output goes to process.stdout/stderr (no console.* in source).
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import { isOmniApprovalEnabled, resolveOmniRuntimeConfig } from '../lib/omni-config.js';
import { resolveOmniApiKey, resolveOmniApiUrl } from '../lib/omni-registration.js';
import { runOmniServe } from '../lib/omni-runner.js';
import { openGlobalDb } from '../lib/v5/global-db.js';
import { listInbox } from '../lib/v5/omni-queue.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

// ============================================================================
// omni serve
// ============================================================================

async function serveCommand(): Promise<void> {
  const rt = await resolveOmniRuntimeConfig();
  if (!isOmniApprovalEnabled(rt)) {
    fail(
      'Omni approvals are not enabled. Set omni.approvals.enabled=true and omni.instance + omni.approvalChat ' +
        '(or OMNI_APPROVALS_ENABLED=1 + OMNI_INSTANCE + OMNI_APPROVAL_CHAT).',
    );
  }

  const db = openGlobalDb();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    await runOmniServe({
      db,
      config: rt,
      signal: controller.signal,
      log: (line) => out(line),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    db.close();
  }
}

// ============================================================================
// omni status
// ============================================================================

interface StatusRow {
  status: string;
  n: number;
}

async function statusCommand(opts: { json?: boolean }): Promise<void> {
  const rt = await resolveOmniRuntimeConfig();
  const db = openGlobalDb();
  try {
    const rows = db.query('SELECT status, count(*) AS n FROM approvals GROUP BY status').all() as StatusRow[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.n;
    const inboxTotal = listInbox(db).length;
    const inboxUnhandled = listInbox(db, { handled: false }).length;

    const summary = {
      enabled: isOmniApprovalEnabled(rt),
      instance: rt.instance ?? null,
      approvalChat: rt.approvalChat ?? null,
      natsUrl: rt.natsUrl,
      approvals: {
        pending: byStatus.pending ?? 0,
        approved: byStatus.approved ?? 0,
        denied: byStatus.denied ?? 0,
        expired: byStatus.expired ?? 0,
      },
      inbox: { total: inboxTotal, unhandled: inboxUnhandled },
    };

    if (opts.json) {
      out(JSON.stringify(summary, null, 2));
      return;
    }

    out(`Omni approvals: ${summary.enabled ? 'ENABLED' : 'disabled'}`);
    if (!summary.enabled) {
      const missing: string[] = [];
      if (!rt.approvals.enabled) missing.push('approvals.enabled');
      if (!rt.instance) missing.push('instance');
      if (!rt.approvalChat) missing.push('approvalChat');
      out(`  missing config: ${missing.join(', ') || 'none'}`);
    }
    out(`  instance:      ${summary.instance ?? '(unset)'}`);
    out(`  approvalChat:  ${summary.approvalChat ?? '(unset)'}`);
    out(`  natsUrl:       ${summary.natsUrl}`);
    out('Approvals queue:');
    out(
      `  pending=${summary.approvals.pending} approved=${summary.approvals.approved} denied=${summary.approvals.denied} expired=${summary.approvals.expired}`,
    );
    out(`Inbox: total=${summary.inbox.total} unhandled=${summary.inbox.unhandled}`);
  } finally {
    db.close();
  }
}

// ============================================================================
// omni inbox
// ============================================================================

async function inboxCommand(opts: {
  json?: boolean;
  unhandled?: boolean;
  instance?: string;
  chat?: string;
}): Promise<void> {
  const db = openGlobalDb();
  try {
    const rows = listInbox(db, {
      handled: opts.unhandled ? false : undefined,
      instance: opts.instance,
      chat: opts.chat,
    });
    if (opts.json) {
      out(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      out('Inbox empty.');
      return;
    }
    for (const r of rows) {
      const when = new Date(r.receivedAt).toISOString();
      const state = r.handledAt ? 'handled' : 'new';
      out(`[${state}] ${when} ${r.instance}/${r.chat} <${r.sender}>: ${r.body}`);
    }
  } finally {
    db.close();
  }
}

// ============================================================================
// omni handshake — ported from origin/v4:src/term-commands/omni/handshake.ts
// ============================================================================

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
  const home = process.env.GENIE_HOME ?? join(homedir(), '.genie');
  const dir = join(home, 'keys');
  return {
    dir,
    privateKey: join(dir, 'genie-host.ed25519'),
    publicKey: join(dir, 'genie-host.ed25519.pub'),
    hostJson: join(dir, 'host.json'),
  };
}

/**
 * Refuse to write the keypair inside a git working tree — a `genie omni
 * handshake` from a project root would otherwise stage the secret key for the
 * next commit. Sanity check, not a security guarantee.
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
    if (parent === probe) return;
    probe = parent;
  }
}

function generateAndPersistKeypair(paths: KeyPaths): { pubkeyB64Url: string } {
  if (!existsSync(paths.dir)) mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' });
  // The DER prefix for ed25519 is 12 bytes; the last 32 bytes are the raw key.
  const rawKey = rawPub.subarray(rawPub.length - 32);
  const pubkeyB64Url = rawKey.toString('base64url');

  writeFileSync(paths.privateKey, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  writeFileSync(paths.publicKey, pubkeyB64Url, { mode: 0o644 });
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
    signal: AbortSignal.timeout(10_000),
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

interface HandshakeOptions {
  rotate?: boolean;
  hostname?: string;
}

async function handleHandshake(options: HandshakeOptions): Promise<void> {
  const apiUrl = await resolveOmniApiUrl();
  if (!apiUrl) {
    throw new Error('Omni is not configured. Set OMNI_API_URL or `omni.apiUrl` in your genie config first.');
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
    pubkey = generateAndPersistKeypair(paths).pubkeyB64Url;
  } else if (!pubkey) {
    pubkey = generateAndPersistKeypair(paths).pubkeyB64Url;
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

  // Revoke the OLD host AFTER the new one registers — order matters, so a
  // revoke failure never loses access.
  if (options.rotate && previousRecord && previousRecord.hostId !== host.id) {
    try {
      await callTrustEndpoint<{ data: unknown }>(apiUrl, apiKey, 'DELETE', `/hosts/${previousRecord.hostId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `Rotated key registered as ${host.id}, but revoking the old host (${previousRecord.hostId}) failed: ${message}\n  Finish manually: omni trust revoke ${previousRecord.hostId}\n`,
      );
    }
  }

  out(`Genie host registered: ${host.id}`);
  out(`  Hostname:     ${host.hostname}`);
  out(`  Public key:   ${host.pubkey}`);
  out(`  Private key:  ${paths.privateKey} (perms 0600)`);
  if (options.rotate && previousRecord) out(`  Rotated from: ${previousRecord.hostId} (revoked)`);
}

// ============================================================================
// Registration
// ============================================================================

export function registerOmniCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'omni');
  const omni = existing ?? program.command('omni').description('Omni integration (serve, status, inbox, handshake)');

  omni
    .command('serve')
    .description('Run the resident Omni runner (NATS bridge → approval queue). Foreground.')
    .action(async () => {
      await serveCommand();
    });

  omni
    .command('status')
    .description('Show approval-queue counts and Omni config sanity (no network)')
    .option('--json', 'Emit JSON instead of human output')
    .action(async (opts: { json?: boolean }) => {
      await statusCommand(opts);
    });

  omni
    .command('inbox')
    .description('List stored inbound Omni messages (no network)')
    .option('--json', 'Emit JSON instead of human output')
    .option('--unhandled', 'Only messages still awaiting handling')
    .option('--instance <id>', 'Filter by Omni instance')
    .option('--chat <id>', 'Filter by chat')
    .action(async (opts: { json?: boolean; unhandled?: boolean; instance?: string; chat?: string }) => {
      await inboxCommand(opts);
    });

  omni
    .command('handshake')
    .description('Register this genie host with the omni server (ed25519 keypair, idempotent)')
    .option('--rotate', 'Issue a new keypair and revoke the existing host record')
    .option('--hostname <name>', 'Override the hostname reported to omni (defaults to os.hostname())')
    .action(async (options: HandshakeOptions) => {
      try {
        await handleHandshake(options);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
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
};
