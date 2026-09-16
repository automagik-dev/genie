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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('omni serve — unreachable NATS', () => {
  const GENIE_CLI = join(import.meta.dir, '..', 'genie.ts');

  /** A port nothing is listening on: bind an ephemeral one, then release it. */
  function closedPort(): number {
    const server = Bun.serve({ port: 0, fetch: () => new Response('') });
    const port = server.port ?? 0;
    server.stop(true);
    if (port === 0) throw new Error('could not reserve an ephemeral port');
    return port;
  }

  test('prints one operator diagnostic and exits 1, never a stack trace', () => {
    const home = mkdtempSync(join(tmpdir(), 'omni-serve-refused-'));
    try {
      const result = Bun.spawnSync(['bun', GENIE_CLI, 'omni', 'serve'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          GENIE_HOME: home,
          OMNI_APPROVALS_ENABLED: '1',
          OMNI_INSTANCE: 'inst-A',
          OMNI_APPROVAL_CHAT: 'chat-42',
          OMNI_NATS_URL: `nats://127.0.0.1:${closedPort()}`,
        },
      });

      const stderr = result.stderr.toString();
      expect(result.exitCode).toBe(1);
      expect(stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(stderr).toMatch(/^Error: omni serve failed: .+ \(NATS nats:\/\/127\.0\.0\.1:\d+\)\n$/);
      // No Bun stack frames, no bundle line numbers, no version banner.
      expect(stderr).not.toContain('    at ');
      expect(stderr).not.toContain('Bun v');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
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

/**
 * Dogfood r2 §3.3 #4 — SIGINT/SIGTERM were ignored for the entire ~20 s NATS
 * connect: `process.once('SIGINT', stop)` aborted a controller the connect path
 * never observed, so Ctrl-C left the operator waiting for the transport's own
 * timeout (measured 19 255 ms / 19 351 ms).
 */
describe('omni serve — a stop signal during the NATS connect', () => {
  const GENIE_CLI = join(import.meta.dir, '..', 'genie.ts');

  /** A socket that accepts the connection and then never speaks NATS, so the
   *  transport sits in its retry window instead of failing fast. */
  function silentListener(): { port: number; stop: () => void } {
    const server = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data: () => {}, open: () => {}, close: () => {}, error: () => {} },
    });
    return { port: server.port, stop: () => server.stop(true) };
  }

  async function serveThenSignal(signal: 'SIGINT' | 'SIGTERM'): Promise<{
    code: number | null;
    signalled: number;
    stdout: string;
    stderr: string;
  }> {
    const listener = silentListener();
    const home = mkdtempSync(join(tmpdir(), 'omni-serve-signal-'));
    try {
      const proc = Bun.spawn(['bun', GENIE_CLI, 'omni', 'serve'], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          GENIE_HOME: home,
          OMNI_APPROVALS_ENABLED: '1',
          OMNI_INSTANCE: 'inst-A',
          OMNI_APPROVAL_CHAT: 'chat-42',
          OMNI_NATS_URL: `nats://127.0.0.1:${listener.port}`,
        },
      });
      // Let the process reach the connect, then ask it to stop.
      await Bun.sleep(1_500);
      const sentAt = Date.now();
      proc.kill(signal === 'SIGINT' ? 2 : 15);
      const code = await proc.exited;
      const signalled = Date.now() - sentAt;
      return {
        code,
        signalled,
        stdout: await new Response(proc.stdout).text(),
        stderr: await new Response(proc.stderr).text(),
      };
    } finally {
      listener.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('SIGINT aborts the in-flight connect within a second and exits 130', async () => {
    const res = await serveThenSignal('SIGINT');
    expect(res.signalled).toBeLessThan(1_000);
    expect(res.code).toBe(130);
    expect(res.stdout.trimEnd().split('\n')).toEqual(['[omni] stopped']);
    expect(res.stderr).toBe('');
  }, 30_000);

  test('SIGTERM does the same and exits 143', async () => {
    const res = await serveThenSignal('SIGTERM');
    expect(res.signalled).toBeLessThan(1_000);
    expect(res.code).toBe(143);
    expect(res.stdout.trimEnd().split('\n')).toEqual(['[omni] stopped']);
    expect(res.stderr).toBe('');
  }, 30_000);
});

/**
 * A signalled stop is not a failure — but a shutdown that FAILED during one is
 * not silent either. Treating "a stop signal was seen" as "discard every error"
 * hid a rejecting transport close, a spawned agent that never settled inside the
 * drain budget, and — worst — a lease that would not release, which refuses the
 * next `genie omni serve` for the whole TTL with nothing ever printed.
 */
describe('omni serve — a shutdown failure during a signalled stop is still reported', () => {
  const OMNI_MODULE = join(import.meta.dir, 'omni.ts');
  const NATS_URL = 'nats://omni-badclose-user:omni-badclose-secret@127.0.0.1:4222';

  /** A child that reaches the fully-connected state through a fake NATS whose
   *  `close()` rejects, so SIGINT lands on a shutdown that cannot succeed. */
  const CHILD_SOURCE = `
import { __test__ } from ${JSON.stringify(OMNI_MODULE)};
let stopped = false;
let wake;
const subscription = {
  unsubscribe() { stopped = true; wake?.(); },
  async *[Symbol.asyncIterator]() {
    while (!stopped) await new Promise((resolve) => { wake = resolve; });
  },
};
const nats = {
  subscribe: () => subscription,
  publish: () => {},
  flush: async () => {},
  close: async () => { throw new Error('nats close exploded'); },
};
await __test__.serveCommand(async () => nats);
process.stdout.write('[probe] serveCommand returned normally\\n');
`;

  async function signalConnectedServeWithFailingClose(): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }> {
    const home = mkdtempSync(join(tmpdir(), 'omni-serve-badclose-'));
    try {
      const child = join(home, 'connected-badclose.mjs');
      writeFileSync(child, CHILD_SOURCE);
      const proc = Bun.spawn(['bun', child], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          NO_COLOR: '1',
          GENIE_HOME: home,
          OMNI_APPROVALS_ENABLED: '1',
          OMNI_INSTANCE: 'inst-A',
          OMNI_APPROVAL_CHAT: 'chat-42',
          OMNI_NATS_URL: NATS_URL,
        },
      });
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let stdout = '';
      // Signal only once the resident is fully connected and serving.
      while (!stdout.includes('[omni] serving')) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
      proc.kill(2);
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        stdout += decoder.decode(value, { stream: true });
      }
      return { code: await proc.exited, stdout, stderr: await new Response(proc.stderr).text() };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test('SIGINT keeps exit 130 but names the shutdown failure in one redacted line', async () => {
    const res = await signalConnectedServeWithFailingClose();
    expect(res.code).toBe(130);
    expect(res.stdout).toContain('[omni] serving');
    expect(res.stdout).toContain('[omni] stopped');

    const stderrLines = res.stderr.trimEnd().split('\n').filter(Boolean);
    expect(stderrLines.length).toBe(1);
    const [line] = stderrLines;
    expect(line).toContain('omni serve stopped with errors');
    // The AggregateError members are named, not just its own summary message.
    expect(line).toContain('Omni NATS close: nats close exploded');
    expect(line).toContain('(NATS ');
    // Still a diagnostic, never a stack trace, and never raw credentials.
    expect(line).not.toContain('    at ');
    expect(line).not.toContain('omni-badclose-secret');
    expect(line).toContain('[REDACTED]');
  }, 30_000);
});

/**
 * Dogfood r2 §3.3 #8–#11 — every omni failure path is ONE line that names what
 * to check: the URL that could not be reached, the lease that is held, or the
 * settings that are missing (in both their config and `OMNI_*` spellings).
 */
describe('omni failure paths are one actionable line (r2 §3.3 #8–#11)', () => {
  const GENIE_CLI = join(import.meta.dir, '..', 'genie.ts');
  /** Port 1 is privileged and never listening: the connection is refused at once. */
  const UNREACHABLE = 'http://127.0.0.1:1';

  function runOmni(args: string[], env: Record<string, string>, home: string) {
    const res = Bun.spawnSync(['bun', GENIE_CLI, 'omni', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 30_000,
      env: {
        ...process.env,
        NO_COLOR: '1',
        GENIE_HOME: home,
        OMNI_APPROVALS_ENABLED: '',
        OMNI_INSTANCE: '',
        OMNI_APPROVAL_CHAT: '',
        OMNI_API_URL: '',
        OMNI_API_KEY: '',
        OMNI_NATS_URL: '',
        ...env,
      },
    });
    return { code: res.exitCode, stdout: res.stdout.toString(), stderr: res.stderr.toString() };
  }

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function sandbox(): string {
    const home = mkdtempSync(join(tmpdir(), 'omni-failure-'));
    homes.push(home);
    return home;
  }

  /** Hold the machine-wide service lease in `home` the way a resident would. */
  function seedHeldServiceLease(home: string): void {
    const seeded = Bun.spawnSync(
      [
        'bun',
        '-e',
        [
          `const { OMNI_SERVICE_LEASE_NAME, acquireServiceLeaseEpoch, openGlobalDb } = await import(${JSON.stringify(join(import.meta.dir, '..', 'lib', 'v5', 'global-db.ts'))});`,
          'const db = openGlobalDb();',
          "acquireServiceLeaseEpoch(db, OMNI_SERVICE_LEASE_NAME, 'other-resident', Date.now(), 300000);",
          'db.close();',
        ].join('\n'),
      ],
      { env: { ...process.env, GENIE_HOME: home }, stdout: 'pipe', stderr: 'pipe' },
    );
    if (seeded.exitCode !== 0) throw new Error(`could not seed the lease: ${seeded.stderr.toString()}`);
  }

  /** Diagnostic lines only — the signature helper's advisory notes are not failures. */
  function diagnostics(stderr: string): string[] {
    return stderr
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('[omni-signature]'));
  }

  test('handshake names the URL it could not reach, and never a stack', () => {
    const res = runOmni(['handshake'], { OMNI_API_URL: UNREACHABLE, OMNI_API_KEY: 'dummy' }, sandbox());

    expect(res.code).toBe(1);
    expect(diagnostics(res.stderr)).toHaveLength(1);
    expect(res.stderr).toContain(`${UNREACHABLE}/api/v2/trust/handshake`);
    expect(res.stderr).toContain('OMNI_API_URL');
    expect(res.stderr).not.toContain('    at ');
    expect(res.stderr).not.toContain('Bun v');
  });

  test('test-approval --live reports an unreachable endpoint, not a pending approval', () => {
    const res = runOmni(
      ['test-approval', '--live'],
      {
        OMNI_APPROVALS_ENABLED: '1',
        OMNI_INSTANCE: 'inst-A',
        OMNI_APPROVAL_CHAT: 'chat-42',
        OMNI_API_URL: UNREACHABLE,
        OMNI_API_KEY: 'dummy',
      },
      sandbox(),
    );

    expect(res.code).toBe(1);
    expect(diagnostics(res.stderr)).toHaveLength(1);
    expect(res.stderr).toContain('could not deliver the approval message');
    expect(res.stderr).toContain(UNREACHABLE);
    expect(res.stderr).not.toContain('status=pending');
    expect(res.stderr).not.toContain('    at ');
  });

  test('a held service lease is a diagnostic, not an uncaught exception', () => {
    const home = sandbox();
    seedHeldServiceLease(home);

    const res = runOmni(
      ['test-approval', '--live'],
      {
        OMNI_APPROVALS_ENABLED: '1',
        OMNI_INSTANCE: 'inst-A',
        OMNI_APPROVAL_CHAT: 'chat-42',
        OMNI_API_URL: UNREACHABLE,
        OMNI_API_KEY: 'dummy',
      },
      home,
    );

    expect(res.code).toBe(1);
    expect(diagnostics(res.stderr)).toHaveLength(1);
    expect(res.stderr).toContain('owns the machine-wide service lease');
    expect(res.stderr).toContain('genie omni serve');
    expect(res.stderr).not.toContain('    at ');
    expect(res.stderr).not.toContain('Bun v');
  });

  test('the not-enabled refusal names the OMNI_* env vars, not just the config keys', () => {
    const res = runOmni(
      ['test-approval', '--live'],
      { OMNI_APPROVALS_ENABLED: '1', OMNI_INSTANCE: 'inst-A' },
      sandbox(),
    );

    expect(res.code).toBe(1);
    expect(diagnostics(res.stderr)).toHaveLength(1);
    expect(res.stderr).toContain('OMNI_APPROVAL_CHAT');
    expect(res.stderr).not.toContain('OMNI_INSTANCE');
  });

  test('omni serve names every missing setting in both spellings', () => {
    const res = runOmni(['serve'], {}, sandbox());

    expect(res.code).toBe(1);
    expect(diagnostics(res.stderr)).toHaveLength(1);
    expect(res.stderr).toContain('OMNI_APPROVALS_ENABLED=1');
    expect(res.stderr).toContain('OMNI_INSTANCE');
    expect(res.stderr).toContain('OMNI_APPROVAL_CHAT');
    expect(res.stderr).toContain('omni.approvals.enabled=true');
  });
});

/**
 * Dogfood r5 Z2 — `--rotate` printed `Rotated from: <old> (revoked)` on stdout
 * immediately after a stderr line saying the revoke had FAILED, pointed the
 * operator at `omni trust revoke <id>` (not a genie command at all), and exited
 * 0 while the old key was still live on the omni server.
 *
 */
describe('omni handshake — rotation, revocation and reported capabilities (r5 Z2)', () => {
  const GENIE_CLI = join(import.meta.dir, '..', 'genie.ts');

  interface TrustStub {
    url: string;
    stop: () => void;
    handshakes: Array<Record<string, unknown>>;
    deletes: string[];
  }

  /** A trust endpoint that hands out a fresh host id per handshake; DELETE status is the knob. */
  function startTrustStub(deleteStatus: number): TrustStub {
    const handshakes: Array<Record<string, unknown>> = [];
    const deletes: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method === 'POST' && path === '/api/v2/trust/handshake') {
          const body = (await req.json()) as Record<string, unknown>;
          handshakes.push(body);
          const id = `host-${handshakes.length}`;
          return Response.json({
            data: { id, pubkey: String(body.pubkey ?? ''), hostname: String(body.hostname ?? '') },
          });
        }
        if (req.method === 'DELETE' && path.startsWith('/api/v2/trust/hosts/')) {
          deletes.push(decodeURIComponent(path.slice('/api/v2/trust/hosts/'.length)));
          if (deleteStatus !== 200) return new Response('{"error":"boom"}', { status: deleteStatus });
          return Response.json({ data: { revoked: true } });
        }
        return new Response('not found', { status: 404 });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), handshakes, deletes };
  }

  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  function sandbox(): string {
    const home = mkdtempSync(join(tmpdir(), 'omni-rotate-'));
    homes.push(home);
    return home;
  }

  /**
   * ASYNC on purpose: the stub is a `Bun.serve` on this test process's own loop,
   * and `Bun.spawnSync` would block that loop until the CLI gives up on a server
   * that can never answer.
   */
  async function runHandshake(args: string[], home: string, apiUrl: string) {
    const proc = Bun.spawn(['bun', GENIE_CLI, 'omni', 'handshake', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, NO_COLOR: '1', GENIE_HOME: home, OMNI_API_URL: apiUrl, OMNI_API_KEY: 'dummy' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test('a rotation whose revoke fails never claims the old host was revoked, and exits 1', async () => {
    const stub = startTrustStub(500);
    const home = sandbox();
    try {
      expect((await runHandshake([], home, stub.url)).code).toBe(0);

      const rotated = await runHandshake(['--rotate'], home, stub.url);

      expect(rotated.code).toBe(1);
      expect(rotated.stdout).toContain('Genie host registered: host-2');
      expect(rotated.stdout).toContain('Rotated from: host-1 (revoke FAILED — old key still live)');
      expect(rotated.stdout).not.toContain('(revoked)');
      // The remedy must be a command that exists, never `omni trust revoke`.
      expect(rotated.stderr).toContain('genie omni handshake --revoke host-1');
      expect(rotated.stderr).not.toContain('omni trust revoke host-1');
      expect(rotated.stderr).not.toContain('    at ');
      // The still-live key is recorded on disk, not only in a scrolled-past line.
      const record = JSON.parse(readFileSync(join(home, 'keys', 'host.json'), 'utf8')) as Record<string, unknown>;
      expect(record.pendingRevocation).toBe('host-1');
    } finally {
      stub.stop();
    }
  }, 30_000);

  test('a rotation whose revoke succeeds says (revoked), exits 0 and records nothing pending', async () => {
    const stub = startTrustStub(200);
    const home = sandbox();
    try {
      await runHandshake([], home, stub.url);
      const rotated = await runHandshake(['--rotate'], home, stub.url);

      expect(rotated.code).toBe(0);
      expect(rotated.stdout).toContain('Rotated from: host-1 (revoked)');
      expect(rotated.stdout).not.toContain('revoke FAILED');
      expect(stub.deletes).toEqual(['host-1']);
      const record = JSON.parse(readFileSync(join(home, 'keys', 'host.json'), 'utf8')) as Record<string, unknown>;
      expect(record.pendingRevocation).toBeUndefined();
      expect(record.rotatedFrom).toBe('host-1');
    } finally {
      stub.stop();
    }
  }, 30_000);

  test('`handshake --revoke <host-id>` is a real command that retires the named host', async () => {
    const failing = startTrustStub(500);
    const home = sandbox();
    try {
      await runHandshake([], home, failing.url);
      await runHandshake(['--rotate'], home, failing.url);
    } finally {
      failing.stop();
    }

    const stub = startTrustStub(200);
    try {
      const revoked = await runHandshake(['--revoke', 'host-1'], home, stub.url);

      expect(revoked.code).toBe(0);
      expect(revoked.stdout).toContain('Revoked omni host: host-1');
      expect(stub.deletes).toEqual(['host-1']);
      const record = JSON.parse(readFileSync(join(home, 'keys', 'host.json'), 'utf8')) as Record<string, unknown>;
      expect(record.pendingRevocation).toBeUndefined();
    } finally {
      stub.stop();
    }
  }, 30_000);

  test('a failed `--revoke` is one diagnostic line and a non-zero exit', async () => {
    const stub = startTrustStub(500);
    const home = sandbox();
    try {
      const revoked = await runHandshake(['--revoke', 'host-9'], home, stub.url);

      expect(revoked.code).toBe(1);
      expect(revoked.stderr).toContain('HTTP 500');
      expect(revoked.stdout).not.toContain('Revoked omni host');
      expect(revoked.stderr).not.toContain('    at ');
    } finally {
      stub.stop();
    }
  }, 30_000);

  test('`--rotate --revoke` is refused instead of half-applied', async () => {
    const stub = startTrustStub(200);
    const home = sandbox();
    try {
      const res = await runHandshake(['--rotate', '--revoke', 'host-1'], home, stub.url);

      expect(res.code).toBe(1);
      expect(res.stderr).toContain('mutually exclusive');
      expect(stub.handshakes).toHaveLength(0);
      expect(stub.deletes).toHaveLength(0);
    } finally {
      stub.stop();
    }
  }, 30_000);
});
