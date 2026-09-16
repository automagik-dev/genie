/**
 * `genie omni` — the Omni integration namespace.
 *
 *   omni serve      Foreground runner: the one resident process that bridges the
 *                   phone (NATS) to the global approval queue.
 *   omni status     Queue counts + config sanity (no network).
 *   omni inbox      List stored inbound messages (no network).
 *   omni handshake  Register this host with omni via a per-host ed25519 keypair.
 *
 * `@nats-io/transport-node` is imported ONLY dynamically inside `serve` (via
 * omni-runner's default factory) so `genie --help` / `status` / `inbox` /
 * `handshake` never touch the transport. Output goes to process.stdout/stderr
 * (no console.* in source).
 */

import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname as osHostname } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import type { Command } from 'commander';
import {
  DEFAULT_APPROVE_REACTIONS,
  DEFAULT_APPROVE_TOKENS,
  DEFAULT_DENY_REACTIONS,
  DEFAULT_DENY_TOKENS,
  type OmniRuntimeConfig,
  isOmniApprovalEnabled,
  resolveOmniRuntimeConfig,
} from '../lib/omni-config.js';
import { resolveOmniApiKey, resolveOmniApiUrl } from '../lib/omni-registration.js';
import {
  type NatsFactory,
  type OmniSend,
  type OmniSendResult,
  type OmniSetReaction,
  createOmniRedactor,
  createOmniRunner,
  makeDefaultOmniSend,
  makeDefaultOmniSetReaction,
  runOmniServe,
} from '../lib/omni-runner.js';
import { openGlobalDb } from '../lib/v5/global-db.js';
import { type ApprovalRow, enqueueApproval, getApproval, listInbox } from '../lib/v5/omni-queue.js';

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

/**
 * The halves of the approval gate this host is missing, each named in BOTH
 * forms it can be supplied in.
 *
 * The refusal used to name only the config keys, while CLAUDE.md documents the
 * `OMNI_*` environment path — so an operator following the docs was told to fix
 * something they had never set (dogfood r2 §3.3 #11).
 */
function missingApprovalSettings(rt: OmniRuntimeConfig): string[] {
  const missing: string[] = [];
  if (!rt.approvals.enabled) missing.push('omni.approvals.enabled=true (OMNI_APPROVALS_ENABLED=1)');
  if (!rt.instance) missing.push('omni.instance (OMNI_INSTANCE)');
  if (!rt.approvalChat) missing.push('omni.approvalChat (OMNI_APPROVAL_CHAT)');
  return missing;
}

/** The one line every not-enabled refusal prints, whichever verb asked. */
function approvalsNotEnabledMessage(rt: OmniRuntimeConfig, verb: string): string {
  return `Omni approvals are not enabled, so ${verb} has nothing to talk to. Missing: ${missingApprovalSettings(rt).join(', ')}.`;
}

/**
 * Flatten any error — `AggregateError` members included — into ONE line.
 *
 * `runOmniServe` reports every shutdown failure (a transport `close()` that
 * rejects, a spawned agent that will not settle inside the drain budget, a
 * lease that will not release) as the members of a single `AggregateError`,
 * whose own `message` is just `Omni shutdown failed`. Printing that message
 * alone would name none of them.
 */
function flattenOmniError(error: unknown): string {
  if (error instanceof AggregateError) {
    const parts = error.errors.map((entry) => flattenOmniError(entry)).filter((part) => part.length > 0);
    return parts.length > 0 ? `${error.message}: ${parts.join('; ')}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// omni serve
// ============================================================================

async function serveCommand(natsFactory?: NatsFactory): Promise<void> {
  const rt = await resolveOmniRuntimeConfig();
  const redact = createOmniRedactor(rt);
  if (!isOmniApprovalEnabled(rt)) fail(approvalsNotEnabledMessage(rt, '`omni serve`'));

  const db = openGlobalDb();
  const controller = new AbortController();
  // Which signal stopped the run, if any. `omni serve` is a foreground resident:
  // the shell contract for one is to leave with 128+signum, and to leave
  // PROMPTLY — the NATS connect used to ignore both signals for its whole ~20s
  // retry window (dogfood r2 §3.3 #4).
  let stopSignal: 'SIGINT' | 'SIGTERM' | undefined;
  const stopOn = (signal: 'SIGINT' | 'SIGTERM') => () => {
    stopSignal ??= signal;
    controller.abort();
  };
  const onInt = stopOn('SIGINT');
  const onTerm = stopOn('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);

  try {
    await runOmniServe({
      db,
      config: rt,
      ...(natsFactory ? { natsFactory } : {}),
      signal: controller.signal,
      log: (line) => out(line),
    });
  } catch (error) {
    // One operator-readable line: what failed and which endpoint it was using,
    // both config-redacted.
    const detail = redact(flattenOmniError(error));
    const line = `${detail} (NATS ${redact(rt.natsUrl)})`;
    // A signal is not itself a failure — the abort path resolves cleanly and
    // never lands here — so a signalled stop keeps its 128+signum exit. But a
    // shutdown that FAILED is never silent: a lease that would not release
    // (the next `omni serve` is then refused for the whole TTL) or an agent
    // that would not settle has to reach the operator either way. The caller
    // turns the thrown form into `Error: <line>` + exit 1.
    if (!stopSignal) throw new Error(`omni serve failed: ${line}`);
    process.stderr.write(`omni serve stopped with errors: ${line}\n`);
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    db.close();
  }

  // An in-flight transport connect keeps the event loop alive long after the
  // run is over, so the exit is explicit rather than awaited.
  if (stopSignal) process.exit(stopSignal === 'SIGINT' ? 130 : 143);
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
  const redact = createOmniRedactor(rt);
  const statusOut = (line = '') => out(redact(line));
  const db = openGlobalDb();
  try {
    const rows = db.query('SELECT status, count(*) AS n FROM approvals GROUP BY status').all() as StatusRow[];
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.n;
    const inboxTotal = listInbox(db).length;
    const inboxUnhandled = listInbox(db, { handled: false }).length;

    const summary = {
      enabled: isOmniApprovalEnabled(rt),
      instance: rt.instance ? redact(rt.instance) : null,
      approvalChat: rt.approvalChat ? redact(rt.approvalChat) : null,
      natsUrl: redact(rt.natsUrl),
      approvals: {
        pending: byStatus.pending ?? 0,
        approved: byStatus.approved ?? 0,
        denied: byStatus.denied ?? 0,
        expired: byStatus.expired ?? 0,
      },
      inbox: { total: inboxTotal, unhandled: inboxUnhandled },
    };

    if (opts.json) {
      statusOut(JSON.stringify(summary, null, 2));
      return;
    }

    statusOut(`Omni approvals: ${summary.enabled ? 'ENABLED' : 'disabled'}`);
    if (!summary.enabled) {
      const missing: string[] = [];
      if (!rt.approvals.enabled) missing.push('approvals.enabled');
      if (!rt.instance) missing.push('instance');
      if (!rt.approvalChat) missing.push('approvalChat');
      statusOut(`  missing config: ${missing.join(', ') || 'none'}`);
    }
    statusOut(`  instance:      ${summary.instance ?? '(unset)'}`);
    statusOut(`  approvalChat:  ${summary.approvalChat ?? '(unset)'}`);
    statusOut(`  natsUrl:       ${summary.natsUrl}`);
    statusOut('Approvals queue:');
    statusOut(
      `  pending=${summary.approvals.pending} approved=${summary.approvals.approved} denied=${summary.approvals.denied} expired=${summary.approvals.expired}`,
    );
    statusOut(`Inbox: total=${summary.inbox.total} unhandled=${summary.inbox.unhandled}`);
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
// omni test-approval — one deliberate approval round-trip (fake by default)
// ============================================================================

const TEST_STANZA_ID = 'test-approval-stanza';
const THUMBS_UP = '\u{1F44D}';

/** A minimal fully-populated runtime config for the CI-safe fake round-trip. */
function fakeApprovalConfig(): OmniRuntimeConfig {
  return {
    natsUrl: 'localhost:4222',
    instance: 'test-instance',
    approvalChat: 'test-chat',
    approveTokens: DEFAULT_APPROVE_TOKENS,
    denyTokens: DEFAULT_DENY_TOKENS,
    approveReactions: DEFAULT_APPROVE_REACTIONS,
    denyReactions: DEFAULT_DENY_REACTIONS,
    approvals: { enabled: true, toolMatcher: '^Bash$', pollBudgetMs: 60_000, pollIntervalMs: 400 },
  };
}

/**
 * Drive ONE approval round-trip against the given transport: enqueue → announce
 * (send + ⏳) → a 👍 reaction on the stored stanza id → resolve (✅). Shared by
 * the fake and `--live` paths; the only difference is which `sendApproval` /
 * `setReaction` are injected. Returns the resolved row so the caller can report.
 */
async function driveApprovalRoundTrip(
  db: ReturnType<typeof openGlobalDb>,
  config: OmniRuntimeConfig,
  sendApproval: OmniSend,
  setReaction: OmniSetReaction,
): Promise<ApprovalRow | null> {
  const runner = createOmniRunner({ db, config, publish: () => {}, sendApproval, setReaction });
  const id = enqueueApproval(db, {
    repo: process.cwd(),
    tool: 'TestApproval',
    inputSummary: 'genie omni test-approval',
  });

  runner.tick(); // announce → send returns the stanza id → ⏳ status reaction
  await runner.whenIdle();

  const stanza = getApproval(db, id)?.omniMessageId;
  if (stanza) {
    // Simulate the human's 👍 on the approval message (correlated by stanza id).
    runner.handleMessage(
      `omni.message.${config.instance}.${config.approvalChat}`,
      JSON.stringify({
        content: `[Reaction: ${THUMBS_UP} on message ${stanza}]`,
        messageId: stanza,
        chatId: config.approvalChat,
        instanceId: config.instance,
        sender: 'test-approval',
      }),
    );
    await runner.whenIdle(); // let the ✅ swap fire
  }
  return getApproval(db, id);
}

async function testApprovalCommand(opts: { live?: boolean }): Promise<void> {
  if (opts.live) {
    await runLiveTestApproval();
    return;
  }

  // Fake, CI-safe path: in-memory DB + recording transports, zero network.
  const db = openGlobalDb({ path: ':memory:' });
  try {
    const reactions: Array<{ messageId: string; emoji: string }> = [];
    const sent: string[] = [];
    const sendApproval: OmniSend = async ({ text }) => {
      sent.push(text);
      return { outcome: 'accepted', messageId: TEST_STANZA_ID };
    };
    const setReaction: OmniSetReaction = async ({ messageId, emoji }) => {
      reactions.push({ messageId, emoji });
      return { success: true };
    };
    const row = await driveApprovalRoundTrip(db, fakeApprovalConfig(), sendApproval, setReaction);

    const pending = reactions.find((r) => r.emoji === '\u{23F3}');
    const approved = reactions.find((r) => r.emoji === '\u{2705}');
    const ok = row?.status === 'approved' && Boolean(pending) && Boolean(approved) && sent.length === 1;
    if (!ok) {
      fail(
        `test-approval round-trip did not complete cleanly (status=${row?.status ?? 'none'}, ` +
          `sends=${sent.length}, ⏳=${Boolean(pending)}, ✅=${Boolean(approved)})`,
      );
    }
    out('genie omni test-approval (fake transport, no network)');
    out(`  send:     1 approval message → stanza ${TEST_STANZA_ID}`);
    out('  status:   ⏳ set on announce → ✅ swapped on approve');
    out('  resolved: approved — round-trip OK');
  } finally {
    db.close();
  }
}

/**
 * ONE real approval round-trip against the configured instance/approvalChat.
 * Emits exactly ONE real WhatsApp message plus its ⏳→✅ status reactions, then
 * resolves it locally so the operator can eyeball the in-place swap (the sole
 * SPIKE-c empirical unknown). Deliberate manual escape hatch — NEVER called by
 * tests.
 */
async function runLiveTestApproval(): Promise<void> {
  const rt = await resolveOmniRuntimeConfig();
  const redact = createOmniRedactor(rt);
  if (!isOmniApprovalEnabled(rt)) fail(approvalsNotEnabledMessage(rt, '`omni test-approval --live`'));
  out('genie omni test-approval --live — sending ONE real WhatsApp approval message.');
  const db = openGlobalDb();
  try {
    // The runner treats a failed send as an un-announced approval and leaves the
    // row pending, which made an unreachable Omni indistinguishable from a real
    // WhatsApp prompt nobody answered (dogfood r2 §3.3 #9). Watch the send
    // outcome so the diagnostic can name the endpoint instead.
    const send = makeDefaultOmniSend(rt);
    let lastSend: OmniSendResult | undefined;
    const watchedSend: OmniSend = async (opts) => {
      lastSend = await send(opts);
      return lastSend;
    };
    const row = await driveApprovalRoundTrip(db, rt, watchedSend, makeDefaultOmniSetReaction(rt));
    if (lastSend && lastSend.outcome !== 'accepted') {
      fail(
        `live round-trip could not deliver the approval message to ${rt.apiUrl ?? '(no OMNI_API_URL / omni.apiUrl configured)'}: ` +
          `${redact(lastSend.error)} (send outcome=${lastSend.outcome})`,
      );
    }
    if (row?.status !== 'approved') {
      fail(
        `live round-trip did not resolve to approved (status=${row?.status ?? 'none'}, omniId=${row?.omniMessageId ?? 'none'})`,
      );
    }
    out(`  sent + resolved on instance ${rt.instance} chat ${rt.approvalChat} (omni id ${row?.omniMessageId ?? '?'})`);
    out('  Check WhatsApp: the approval message should show ⏳ swapped to ✅ in place.');
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
  /**
   * The old host id a `--rotate` could NOT revoke. Recorded so the residue is
   * visible on disk (and clearable by `--revoke <host-id>`) instead of living
   * only in a stderr line the operator has already scrolled past.
   */
  pendingRevocation?: string;
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

/** Wall-clock budget for one trust call; named so the timeout diagnostic can quote it. */
const TRUST_TIMEOUT_MS = 10_000;

async function callTrustEndpoint<T>(
  apiUrl: string,
  apiKey: string | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const url = `${apiUrl.replace(/\/+$/, '')}/api/v2/trust${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TRUST_TIMEOUT_MS),
    });
  } catch (error) {
    // `fetch` reports a refused connection as a bare "Unable to connect. Is the
    // computer able to access the url?" — with several OMNI_* sources able to
    // supply the endpoint, an operator had nothing to check (dogfood r2 §3.3
    // #8). Name the URL that failed, and where it came from.
    const name = error instanceof Error ? error.name : '';
    const reason =
      name === 'TimeoutError' || name === 'AbortError'
        ? `no response within ${TRUST_TIMEOUT_MS / 1000}s`
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `omni trust ${method} ${path}: could not reach ${url} — ${reason}. Check OMNI_API_URL (or omni.apiUrl in your genie config).`,
    );
  }
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
  revoke?: string;
  hostname?: string;
}

/** The two credentials every trust call needs, or the one-line refusal naming both spellings. */
async function requireTrustCredentials(): Promise<{ apiUrl: string; apiKey: string }> {
  const apiUrl = await resolveOmniApiUrl();
  if (!apiUrl) {
    throw new Error('Omni is not configured. Set OMNI_API_URL or `omni.apiUrl` in your genie config first.');
  }
  const apiKey = await resolveOmniApiKey();
  if (!apiKey) {
    throw new Error('Omni API key not configured. Set OMNI_API_KEY or `omni.apiKey` in your genie config.');
  }
  return { apiUrl, apiKey };
}

/** `DELETE /api/v2/trust/hosts/<id>` — the one revocation call both modes make. */
async function revokeTrustHost(apiUrl: string, apiKey: string, hostId: string): Promise<void> {
  await callTrustEndpoint<{ data: unknown }>(apiUrl, apiKey, 'DELETE', `/hosts/${encodeURIComponent(hostId)}`);
}

/**
 * `genie omni handshake --revoke <host-id>` — the remedy a failed rotation
 * points at. It used to point at `omni trust revoke <id>`, which is not a genie
 * command at all, so the only documented way to clear a still-live key was a
 * command that could not be run (dogfood r5 Z2).
 */
async function handleRevoke(apiUrl: string, apiKey: string, options: HandshakeOptions): Promise<void> {
  if (options.rotate) {
    throw new Error('`--rotate` and `--revoke` are mutually exclusive: rotate issues a key, revoke retires one.');
  }
  const hostId = (options.revoke ?? '').trim();
  if (!hostId) {
    throw new Error('`--revoke` needs the omni host id to retire, e.g. `genie omni handshake --revoke host-1`.');
  }
  await revokeTrustHost(apiUrl, apiKey, hostId);
  const paths = keyPaths();
  const record = loadHostJson(paths);
  if (record?.pendingRevocation === hostId) {
    const { pendingRevocation: _cleared, ...rest } = record;
    writeHostJson(paths, rest);
  }
  out(`Revoked omni host: ${hostId}`);
  if (record?.hostId === hostId) {
    out("  That was THIS host's own registration — run `genie omni handshake` to register again.");
  }
}

async function handleHandshake(options: HandshakeOptions): Promise<void> {
  const { apiUrl, apiKey } = await requireTrustCredentials();

  if (options.revoke !== undefined) {
    await handleRevoke(apiUrl, apiKey, options);
    return;
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
  let revokeError: string | undefined;
  const staleHostId =
    options.rotate && previousRecord && previousRecord.hostId !== host.id ? previousRecord.hostId : undefined;
  if (staleHostId) {
    try {
      await revokeTrustHost(apiUrl, apiKey, staleHostId);
    } catch (err) {
      revokeError = err instanceof Error ? err.message : String(err);
      writeHostJson(paths, { ...newRecord, pendingRevocation: staleHostId });
    }
  }

  out(`Genie host registered: ${host.id}`);
  out(`  Hostname:     ${host.hostname}`);
  out(`  Public key:   ${host.pubkey}`);
  out(`  Private key:  ${paths.privateKey} (perms 0600)`);
  if (options.rotate && previousRecord) {
    // The summary used to say `(revoked)` unconditionally, contradicting the
    // warning printed one line earlier (dogfood r5 Z2). The old key being live
    // is a security-relevant residue, so it is also a non-zero exit.
    out(
      `  Rotated from: ${previousRecord.hostId} ${revokeError ? '(revoke FAILED — old key still live)' : '(revoked)'}`,
    );
  }
  if (revokeError && staleHostId) {
    throw new Error(
      `the rotated key registered as ${host.id}, but revoking the old host ${staleHostId} failed: ${revokeError} ` +
        `The old key is STILL LIVE — retire it with: genie omni handshake --revoke ${staleHostId}`,
    );
  }
}

// ============================================================================
// Registration
// ============================================================================

/**
 * The group summary names every subcommand registered below. Listing four of
 * the five was the CLI-side half of the CLAUDE.md drift the 2026-09-15 dogfood
 * run found; `claude-md-drift.test.ts` now compares both against the registry.
 */
const OMNI_GROUP_DESCRIPTION = 'Omni integration (serve, status, inbox, test-approval, handshake)';

export function registerOmniCommands(program: Command): void {
  const existing = program.commands.find((c) => c.name() === 'omni');
  const omni = existing ?? program.command('omni').description(OMNI_GROUP_DESCRIPTION);

  omni
    .command('serve')
    .description('Run the resident Omni runner (NATS bridge → approval queue). Foreground.')
    .action(async () => {
      try {
        await serveCommand();
      } catch (err) {
        // An unreachable NATS endpoint is an operator-fixable environment
        // problem: print the same one-line diagnostic every other omni failure
        // uses, never a stack trace.
        fail(err instanceof Error ? err.message : String(err));
      }
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
    .command('test-approval')
    .description('Drive one approval round-trip (enqueue → ⏳ → approve → ✅). Fake transport by default.')
    .option('--live', 'Send ONE real WhatsApp approval to the configured instance/approvalChat (deliberate)')
    .action(async (opts: { live?: boolean }) => {
      try {
        await testApprovalCommand(opts);
      } catch (err) {
        // A held machine-wide service lease (a resident `omni serve`, or a
        // second `--live` inside the 300 s TTL) used to escape as an uncaught
        // exception with six bundle frames (dogfood r2 §3.3 #10). Every
        // guardrail on this command is one line.
        fail(err instanceof Error ? err.message : String(err));
      }
    });

  omni
    .command('handshake')
    .description('Register this genie host with the omni server (ed25519 keypair, idempotent)')
    .option('--rotate', 'Issue a new keypair and revoke the existing host record')
    .option('--revoke <host-id>', 'Revoke one omni host record server-side (the remedy for a failed --rotate)')
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
  serveCommand,
  statusCommand,
  testApprovalCommand,
};
