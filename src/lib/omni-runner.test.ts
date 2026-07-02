/**
 * Omni runner — inbound one-shot routing (Group 4), NO real claude / NATS.
 *
 * Every test drives `createOmniRunner` with a FAKE `publish` recorder and an
 * INJECTED `spawnClaude`, so a mapped inbound is answered by a fake executable
 * and the reply is asserted on the recorded publishes. Covers the six behaviours
 * the group promises: mapped round-trip, unmapped store-only, drop-with-notice
 * concurrency guard, child timeout, child-crash isolation, and the output cap.
 */
import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { OmniRuntimeConfig } from './omni-config.js';
import { type SpawnClaude, type SpawnClaudeResult, createOmniRunner } from './omni-runner.js';
import { openGlobalDb } from './v5/global-db.js';
import { listInbox } from './v5/omni-queue.js';

const INSTANCE = 'inst-A';
const ROUTE_CHAT = 'chat-42';
const ROUTE_REPO = '/tmp/mapped-repo';

function rt(overrides: Partial<OmniRuntimeConfig> = {}): OmniRuntimeConfig {
  return {
    natsUrl: 'localhost:4222',
    instance: INSTANCE,
    approvalChat: 'approval-chat', // deliberately NOT the route chat
    approveTokens: ['y', 'yes'],
    denyTokens: ['n', 'no'],
    approveReactions: ['\u{1F44D}'],
    denyReactions: ['\u{1F44E}'],
    routes: [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: ROUTE_REPO }],
    inboundTimeoutMs: 120_000,
    inboundMaxReplyChars: 4_000,
    approvals: { enabled: true, toolMatcher: '^Bash$', pollBudgetMs: 10_000, pollIntervalMs: 1 },
    ...overrides,
  };
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

interface Published {
  subject: string;
  payload: string;
}

/** Parse the `content` field out of a recorded outbound reply payload. */
function content(p: Published): string {
  return (JSON.parse(p.payload) as { content: string }).content;
}

const routeSubject = `omni.reply.${INSTANCE}.${ROUTE_CHAT}`;

/** An inbound frame on the mapped route, as omni would publish it. */
function mappedInbound(body: string, chat = ROUTE_CHAT): [string, string] {
  return [
    `omni.message.${INSTANCE}.${chat}`,
    JSON.stringify({ content: body, chatId: chat, sender: 'boss', instanceId: INSTANCE }),
  ];
}

describe('omni runner — inbound one-shot routing', () => {
  test('mapped round-trip: inbound → claude → truncated reply published + markHandled', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const calls: Array<{ message: string; cwd: string }> = [];
    const spawnClaude: SpawnClaude = async ({ message, cwd }) => {
      calls.push({ message, cwd });
      return { stdout: 'agent says hi', exitCode: 0 };
    };
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude,
    });

    runner.handleMessage(...mappedInbound('do the thing'));
    await runner.whenIdle();

    // Exactly one spawn, in the mapped repo, with the message as the prompt.
    expect(calls).toEqual([{ message: 'do the thing', cwd: ROUTE_REPO }]);
    // Reply published to the route's reply subject with the stdout text.
    expect(published.length).toBe(1);
    expect(published[0].subject).toBe(routeSubject);
    expect(content(published[0])).toBe('agent says hi');
    // Inbound stored AND marked handled.
    const inbox = listInbox(db);
    expect(inbox.length).toBe(1);
    expect(inbox[0].handledAt).not.toBeNull();
  });

  test('unmapped chat: store-only — never spawns, no reply', async () => {
    const db = freshDb();
    const published: Published[] = [];
    let spawns = 0;
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => {
        spawns++;
        return { stdout: '', exitCode: 0 };
      },
    });

    runner.handleMessage(...mappedInbound('hello?', 'random-chat'));
    await runner.whenIdle();

    expect(spawns).toBe(0);
    expect(published.length).toBe(0);
    const inbox = listInbox(db);
    expect(inbox.length).toBe(1);
    expect(inbox[0].chat).toBe('random-chat');
    expect(inbox[0].handledAt).toBeNull(); // store-only, untouched
  });

  test('drop-with-notice: second message on a busy route gets busy reply + stored, one spawn', async () => {
    const db = freshDb();
    const published: Published[] = [];
    let spawns = 0;
    let release!: (r: SpawnClaudeResult) => void;
    const gate = new Promise<SpawnClaudeResult>((resolve) => {
      release = resolve;
    });
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => {
        spawns++;
        return gate; // stays in-flight until released
      },
    });

    // Two rapid inbounds on the same route, synchronously — the first is in-flight
    // the instant it is recorded, so the second is dropped before either spawn runs.
    runner.handleMessage(...mappedInbound('first'));
    runner.handleMessage(...mappedInbound('second'));

    // The busy notice is published synchronously by the second call (the guard is
    // synchronous even though the spawn itself is deferred to a microtask).
    expect(published.length).toBe(1);
    expect(content(published[0])).toContain('busy');

    release({ stdout: 'done', exitCode: 0 });
    await runner.whenIdle();

    // Exactly one spawn ever ran; the real reply arrives after the busy notice.
    expect(spawns).toBe(1);
    expect(published.length).toBe(2);
    expect(content(published[1])).toBe('done');
    // Both inbounds are stored; only the one that ran is handled.
    const inbox = listInbox(db);
    expect(inbox.length).toBe(2);
    expect(inbox.filter((m) => m.handledAt !== null).length).toBe(1);
  });

  test('child timeout: bounded error notice, in-flight cleared so the route recovers', async () => {
    const db = freshDb();
    const published: Published[] = [];
    let spawns = 0;
    // First run honours the abort signal (rejects), so the timeout can win cleanly.
    const spawnClaude: SpawnClaude = ({ signal }) => {
      spawns++;
      if (spawns === 1) {
        return new Promise<SpawnClaudeResult>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('killed')), { once: true });
        });
      }
      return Promise.resolve({ stdout: 'second run ok', exitCode: 0 });
    };
    const runner = createOmniRunner({
      db,
      config: rt({ inboundTimeoutMs: 10 }),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude,
    });

    runner.handleMessage(...mappedInbound('slow one'));
    await runner.whenIdle();

    expect(published.length).toBe(1);
    expect(content(published[0])).toContain('timed out');

    // Route recovered — a subsequent message spawns again and replies.
    runner.handleMessage(...mappedInbound('fast one'));
    await runner.whenIdle();
    expect(spawns).toBe(2);
    expect(content(published[1])).toBe('second run ok');
  });

  test('child crash / non-zero exit: runner survives, publishes error notice, clears in-flight', async () => {
    const db = freshDb();
    const published: Published[] = [];
    let spawns = 0;
    const spawnClaude: SpawnClaude = () => {
      spawns++;
      if (spawns === 1) throw new Error('boom'); // synchronous crash
      if (spawns === 2) return Promise.resolve({ stdout: 'ignored', exitCode: 3 }); // non-zero exit
      return Promise.resolve({ stdout: 'recovered', exitCode: 0 });
    };
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude,
    });

    // 1) synchronous throw → error notice, runner alive.
    runner.handleMessage(...mappedInbound('crash'));
    await runner.whenIdle();
    expect(content(published[0])).toContain('failed');

    // 2) non-zero exit → error notice.
    runner.handleMessage(...mappedInbound('nonzero'));
    await runner.whenIdle();
    expect(content(published[1])).toContain('failed');

    // 3) recovery → normal reply. In-flight was cleared each time.
    runner.handleMessage(...mappedInbound('ok now'));
    await runner.whenIdle();
    expect(spawns).toBe(3);
    expect(content(published[2])).toBe('recovered');
    // Every inbound was still marked handled despite the failures.
    expect(listInbox(db).every((m) => m.handledAt !== null)).toBe(true);
  });

  test('output cap: an over-long reply is truncated to the configured max', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const runner = createOmniRunner({
      db,
      config: rt({ inboundMaxReplyChars: 10 }),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => ({ stdout: 'x'.repeat(50), exitCode: 0 }),
    });

    runner.handleMessage(...mappedInbound('big output'));
    await runner.whenIdle();

    const reply = content(published[0]);
    expect(reply.length).toBe(10);
    expect(reply.endsWith('…')).toBe(true);
  });
});
