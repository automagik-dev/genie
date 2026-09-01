/**
 * Omni runner — registration and inbox behavior with NO real NATS/Omni/network.
 *
 * The PreToolUse approval hook that used to drive the token/reaction/deny/timeout
 * round-trips through this runner was deleted with the hook runtime; what remains
 * is the CLI-originated surface. The registration test uses a fake Omni HTTP
 * server (Bun.serve, ephemeral port) for the signature only.
 */
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmniRuntimeConfig } from '../lib/omni-config.js';
import { registerAgentInOmni } from '../lib/omni-registration.js';
import { createOmniRunner, natsConnectionCount } from '../lib/omni-runner.js';
import { __test__ as sigTest } from '../lib/omni-signature.js';
import { openGlobalDb } from '../lib/v5/global-db.js';
import { enqueueApproval, listInbox } from '../lib/v5/omni-queue.js';
import { __test__ as omniTest } from './omni.js';

function rt(overrides: Partial<OmniRuntimeConfig> = {}): OmniRuntimeConfig {
  return {
    natsUrl: 'localhost:4222',
    instance: 'inst-A',
    approvalChat: 'chat-42',
    approveTokens: ['y', 'yes', 'approve', 'sim'],
    denyTokens: ['n', 'no', 'deny', 'nao'],
    approveReactions: ['\u{1F44D}', '\u{2705}'],
    denyReactions: ['\u{1F44E}', '\u{274C}'],
    approvals: { enabled: true, toolMatcher: '^Bash$', pollBudgetMs: 10_000, pollIntervalMs: 1 },
    ...overrides,
  };
}

/** Restore an env var to a prior value, deleting it when it was previously unset. */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = prev;
}

let dbs: Database[] = [];
function freshDb(): Database {
  const db = openGlobalDb({ path: ':memory:' });
  dbs.push(db);
  return db;
}
afterEach(() => {
  for (const db of dbs) db.close();
  dbs = [];
});

describe('omni runner — registration (no network)', () => {
  test('registration-signature: signed POST verifies against the host pubkey', async () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-sig-'));
    const prevHome = process.env.GENIE_HOME;
    const prevUrl = process.env.OMNI_API_URL;
    const prevKey = process.env.OMNI_API_KEY;
    process.env.GENIE_HOME = home;
    process.env.OMNI_API_KEY = 'bearer-xyz';
    sigTest.resetState();

    // Provision a keypair + host record exactly as `genie omni handshake` would.
    const paths = omniTest.keyPaths();
    const { pubkeyB64Url } = omniTest.generateAndPersistKeypair(paths);
    omniTest.writeHostJson(paths, {
      hostId: 'host-123',
      pubkey: pubkeyB64Url,
      hostname: 'test-host',
      registeredAt: new Date().toISOString(),
    });

    // Rebuild an Ed25519 public key from the raw base64url the handshake stored.
    const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
    const pub = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkeyB64Url, 'base64url')]),
      format: 'der',
      type: 'spki',
    });

    const captured: { verified: boolean; hostId: string | null } = { verified: false, hostId: null };
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      const body = String(init?.body ?? '');
      const headers = new Headers(init?.headers);
      const ts = headers.get('X-Genie-Timestamp') ?? '';
      const sig = headers.get('X-Genie-Signature') ?? '';
      captured.hostId = headers.get('X-Genie-Host-Id');
      const bodyHash = createHash('sha256').update(body, 'utf-8').digest('hex');
      const canonical = `${ts}\nPOST\n${url.pathname}\n${bodyHash}`;
      captured.verified = verify(null, Buffer.from(canonical, 'utf-8'), pub, Buffer.from(sig, 'base64url'));
      return new Response(JSON.stringify({ data: { id: 'agent-1' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    process.env.OMNI_API_URL = 'http://omni.test';

    try {
      const id = await registerAgentInOmni('genie-agent', { roles: ['dev'], fetchImpl });
      expect(id).toBe('agent-1');
      expect(captured.verified).toBe(true);
      expect(captured.hostId).toBe('host-123');
    } finally {
      rmSync(home, { recursive: true, force: true });
      sigTest.resetState();
      restoreEnv('GENIE_HOME', prevHome);
      restoreEnv('OMNI_API_URL', prevUrl);
      restoreEnv('OMNI_API_KEY', prevKey);
    }
  });
});

describe('omni runner — inbox + non-matching traffic', () => {
  test('non-approval-chat message is stored but resolves nothing', async () => {
    const config = rt();
    const db = freshDb();
    const runner = createOmniRunner({ db, config, publish: () => {} });
    runner.handleMessage(
      `omni.message.${config.instance}.other-chat`,
      JSON.stringify({ content: 'yes', chatId: 'other-chat', sender: 'stranger' }),
    );
    // Stored to inbox, but there was nothing pending to resolve anyway.
    expect(listInbox(db).length).toBe(1);
    expect(listInbox(db)[0].chat).toBe('other-chat');
  });

  test('unknown token in the approval chat is ignored (still inboxed)', async () => {
    const config = rt();
    const db = freshDb();
    const runner = createOmniRunner({ db, config, publish: () => {} });
    runner.handleMessage(
      `omni.message.${config.instance}.${config.approvalChat}`,
      JSON.stringify({ content: 'maybe later', chatId: config.approvalChat, sender: 'boss' }),
    );
    expect(listInbox(db).length).toBe(1);
  });
});

describe('transport is not initialized without `omni serve`', () => {
  test('natsConnectionCount stays 0 after runner + inbox operations', () => {
    const db = freshDb();
    const runner = createOmniRunner({ db, config: rt(), publish: () => {} });
    runner.tick();
    listInbox(db);
    expect(natsConnectionCount()).toBe(0);
  });
});

describe('omni status credential redaction', () => {
  async function captureStatus(json: boolean): Promise<string> {
    const realWrite = process.stdout.write.bind(process.stdout);
    const home = mkdtempSync(join(tmpdir(), 'omni-status-'));
    const keys = ['GENIE_HOME', 'OMNI_API_KEY', 'OMNI_NATS_URL', 'OMNI_INSTANCE', 'OMNI_APPROVAL_CHAT'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
      (typeof keys)[number],
      string | undefined
    >;
    let buffer = '';
    process.env.GENIE_HOME = home;
    for (const key of keys.slice(1)) Reflect.deleteProperty(process.env, key);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        omni: {
          apiUrl: 'https://status-api.example.test',
          apiKey: 'STATUS_API_KEY_SENTINEL',
          natsUrl: 'nats://status-user:status-password@nats.example:4222?tls=1&opaque=STATUS_QUERY_SECRET',
          instance: 'instance-STATUS_API_KEY_SENTINEL',
          approvalChat: 'approval-chat',
        },
      }),
    );
    const db = openGlobalDb();
    enqueueApproval(db, { repo: '/status', tool: 'Bash', inputSummary: 'status fixture' });
    db.close();
    process.stdout.write = ((chunk: string) => {
      buffer += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await omniTest.statusCommand({ json });
      return buffer;
    } finally {
      process.stdout.write = realWrite;
      for (const key of keys) restoreEnv(key, previous[key]);
      rmSync(home, { recursive: true, force: true });
    }
  }

  function expectStatusRedacted(output: string): void {
    for (const secret of [
      'STATUS_API_KEY_SENTINEL',
      'status-user',
      'status-password',
      'STATUS_QUERY_SECRET',
      'tls=1',
    ]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain('[REDACTED]');
  }

  test('human status redacts configured API keys and credential URL userinfo/query', async () => {
    const output = await captureStatus(false);
    expectStatusRedacted(output);
    expect(output).toContain('tls=[REDACTED]&opaque=[REDACTED]');
    expect(output).toContain('pending=1');
  });

  test('JSON status remains valid while redacting configured API keys and credential URL userinfo/query', async () => {
    const output = await captureStatus(true);
    expectStatusRedacted(output);
    expect(JSON.parse(output)).toMatchObject({
      instance: 'instance-[REDACTED]',
      natsUrl: 'nats://[REDACTED]@nats.example:4222?tls=[REDACTED]&opaque=[REDACTED]',
      approvals: { pending: 1 },
    });
  });

  test('serve passes the raw URL inward but exposes only a config-redacted startup error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-serve-error-'));
    const keys = [
      'GENIE_HOME',
      'OMNI_API_KEY',
      'OMNI_NATS_URL',
      'OMNI_INSTANCE',
      'OMNI_APPROVAL_CHAT',
      'OMNI_APPROVALS_ENABLED',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<
      (typeof keys)[number],
      string | undefined
    >;
    const apiKey = 'SERVE_API_KEY_SENTINEL';
    const apiUrl = 'https://serve-api-user:serve-api-password@api.example.test?opaque=SERVE_API_QUERY_SECRET';
    const natsUrl = 'nats://serve-user:serve-password@nats.example:4222?opaque=SERVE_QUERY_SECRET';
    let observedServers: string | undefined;
    process.env.GENIE_HOME = home;
    for (const key of keys.slice(1)) Reflect.deleteProperty(process.env, key);
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        omni: {
          apiUrl,
          apiKey,
          natsUrl,
          instance: 'instance',
          approvalChat: 'approval-chat',
          approvals: { enabled: true },
        },
      }),
    );
    try {
      let thrown: unknown;
      try {
        await omniTest.serveCommand(async ({ servers }) => {
          observedServers = servers;
          throw new Error(`startup rejected ${servers} via ${apiUrl} with ${apiKey}`);
        });
      } catch (error) {
        thrown = error;
      }
      expect(observedServers).toBe(natsUrl);
      expect(thrown).toBeInstanceOf(Error);
      const rendered = `${String(thrown)}\n${thrown instanceof Error ? thrown.stack : ''}`;
      for (const secret of [
        apiKey,
        'serve-user',
        'serve-password',
        'SERVE_QUERY_SECRET',
        'serve-api-user',
        'serve-api-password',
        'SERVE_API_QUERY_SECRET',
      ]) {
        expect(rendered).not.toContain(secret);
      }
      expect(rendered).toContain('[REDACTED]');
    } finally {
      for (const key of keys) restoreEnv(key, previous[key]);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('omni test-approval — fake round-trip (no network)', () => {
  /** Capture stdout during `fn`, restoring the real writer afterwards. */
  async function captureStdout(fn: () => Promise<void>): Promise<string> {
    const realWrite = process.stdout.write.bind(process.stdout);
    let buffer = '';
    process.stdout.write = ((chunk: string) => {
      buffer += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await fn();
      return buffer;
    } finally {
      process.stdout.write = realWrite;
    }
  }

  test('drives one clean ⏳→✅ round-trip and prints a success line', async () => {
    const output = await captureStdout(() => omniTest.testApprovalCommand({}));
    expect(output).toMatch(/round-trip OK/);
    expect(output).toMatch(/approved/);
    // The fake path is fully offline — no NATS transport ever opened.
    expect(natsConnectionCount()).toBe(0);
  });
});

describe('omni handshake keypair provisioning', () => {
  test('generateAndPersistKeypair writes a 0600 private key and a raw base64url pubkey', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-hs-'));
    const prevHome = process.env.GENIE_HOME;
    process.env.GENIE_HOME = home;
    try {
      const paths = omniTest.keyPaths();
      const { pubkeyB64Url } = omniTest.generateAndPersistKeypair(paths);
      // Raw ed25519 public key is 32 bytes → 43 base64url chars (no padding).
      expect(Buffer.from(pubkeyB64Url, 'base64url').length).toBe(32);
      expect(omniTest.loadExistingPubkey(paths)).toBe(pubkeyB64Url);
    } finally {
      rmSync(home, { recursive: true, force: true });
      restoreEnv('GENIE_HOME', prevHome);
    }
  });

  test('assertNotInsideGitRepo throws when the key dir is under a git worktree', () => {
    // The repo root of this test IS a git worktree, so a keys dir inside it must throw.
    expect(() => omniTest.assertNotInsideGitRepo(join(process.cwd(), '.genie', 'keys'))).toThrow(/git working tree/);
  });
});
