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
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmniRuntimeConfig } from './omni-config.js';
import {
  type NatsInboundMsg,
  type NatsLike,
  type NatsSubscription,
  type OmniSend,
  type RawClaudeSpawn,
  type SpawnClaude,
  type SpawnClaudeResult,
  buildClaudeArgs,
  buildCodexArgs,
  createOmniRunner,
  deterministicSessionId,
  extractCodexJsonlReply,
  extractStreamJsonReply,
  isSafeCodexThreadId,
  readBoundedText,
  resolveTrustedHostExecutable,
  runClaudeSession,
  runCodexSession,
  runOmniServe,
} from './omni-runner.js';
import { getAgentSession, openGlobalDb, upsertAgentSession } from './v5/global-db.js';
import { enqueueApproval, getApproval, listInbox } from './v5/omni-queue.js';

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

  test('non-zero exit: the error notice carries the exit code AND the stderr text', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => ({ stdout: '', stderr: 'FATAL: credential expired\nrun `claude login`', exitCode: 1 }),
    });

    runner.handleMessage(...mappedInbound('doomed'));
    await runner.whenIdle();

    const notice = content(published[0]);
    expect(notice).toContain('exit code 1');
    expect(notice).toContain('run `claude login`'); // stderr surfaced, not dropped
  });

  test('non-zero exit with empty stderr: the notice falls back to stdout', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => ({ stdout: 'partial stdout clue', stderr: '', exitCode: 7 }),
    });

    runner.handleMessage(...mappedInbound('doomed too'));
    await runner.whenIdle();

    const notice = content(published[0]);
    expect(notice).toContain('exit code 7');
    expect(notice).toContain('partial stdout clue');
  });

  test('non-zero exit: a long stderr is TAIL-bounded — the notice keeps the end of the stream', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => ({ stdout: '', stderr: `${'x'.repeat(2000)}THE-ACTUAL-CAUSE`, exitCode: 1 }),
    });

    runner.handleMessage(...mappedInbound('noisy failure'));
    await runner.whenIdle();

    const notice = content(published[0]);
    expect(notice).toContain('THE-ACTUAL-CAUSE'); // the end survives the bound
    expect(notice.length).toBeLessThan(700); // bounded, never the whole stream
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

// ---------------------------------------------------------------------------
// Correlated approval identity + inbound reaction resolve (Group 2).
//
// `announce()` sends each approval via the injectable id-returning send and
// stores the REAL stanza id it returns; an inbound reaction (on `omni.message.*`,
// NOT the retired `omni.event.*`) resolves the approval whose stored id it
// targets, falling back to oldest only for bare text. Every test drives a FAKE
// `sendApproval` — zero network.
// ---------------------------------------------------------------------------
const APPROVAL_CHAT = 'approval-chat'; // matches rt() above

const approvalSummary = (marker: 'A' | 'B'): string =>
  JSON.stringify({
    kind: 'Bash',
    commands: [{ executable: `summary-${marker.toLowerCase()}`, options: [], env: [], argumentCount: 0 }],
  });

/** Fake id-returning send: assigns each approval a stanza id derived from its
 *  structural command marker, so correlation is order-independent. */
const sendApproval: OmniSend = async ({ text }) => {
  const marker = text.includes('summary-b') ? 'B' : 'A';
  return { success: true, messageId: `stanza-${marker}` };
};

/** An inbound frame on the approval chat, as omni would publish it. */
function approvalInbound(payload: Record<string, unknown>): [string, string] {
  return [
    `omni.message.${INSTANCE}.${APPROVAL_CHAT}`,
    JSON.stringify({ chatId: APPROVAL_CHAT, instanceId: INSTANCE, sender: 'boss', ...payload }),
  ];
}

const reactionContent = (emoji: string, targetId: string): string => `[Reaction: ${emoji} on message ${targetId}]`;
const THUMBS_UP = '\u{1F44D}';

// A fixed clock so the runner's `expireStale` (pollBudgetMs = 10_000) never
// expires a just-enqueued row: rows are stamped a second or two before NOW.
const NOW = 1_000_000;
const approvalRunner = (db: Database) =>
  createOmniRunner({ db, config: rt(), publish: () => {}, sendApproval, now: () => NOW });

describe('omni runner — correlated approval identity + reactions', () => {
  test('never transmits a legacy raw Bash preview to the approval channel', async () => {
    const db = freshDb();
    const texts: string[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      sendApproval: async ({ text }) => {
        texts.push(text);
        return { success: true, messageId: 'stanza-safe' };
      },
      now: () => NOW,
    });
    enqueueApproval(db, {
      repo: '/r',
      tool: 'Bash',
      inputSummary:
        'curl -u user:password https://user:password@example.test/?X-Amz-Signature=signed-secret&sig=sas-secret',
      now: NOW - 1,
    });
    runner.tick();
    await runner.whenIdle();
    expect(texts).toHaveLength(1);
    for (const secret of ['password', 'signed-secret', 'sas-secret', 'https://']) {
      expect(texts[0]).not.toContain(secret);
    }
    expect(texts[0]).toContain('legacyPreviewOmitted');
  });

  test('announce stores the REAL stanza id returned by the send (not a genId ref)', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    expect(getApproval(db, a)?.omniMessageId).toBe('stanza-A');
  });

  test('reaction resolves the exact approval by stored stanza id, not the oldest', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('B'), now: NOW - 1000 });
    runner.tick();
    await runner.whenIdle();
    // Both rows tagged with their own real stanza ids.
    expect(getApproval(db, a)?.omniMessageId).toBe('stanza-A');
    expect(getApproval(db, b)?.omniMessageId).toBe('stanza-B');

    // A 👍 reaction on B's stanza id resolves B — NOT the older A.
    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-B'), messageId: 'stanza-B' }),
    );
    expect(getApproval(db, b)?.status).toBe('approved');
    expect(getApproval(db, a)?.status).toBe('pending');
  });

  test('dual-emit bare-emoji echo does not double-resolve a second approval', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('B'), now: NOW - 1000 });
    runner.tick();
    await runner.whenIdle();

    // A human 👍 reaches genie twice (SPIKE dual-emit): the id-bearing reaction
    // form resolves A...
    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-A'), messageId: 'stanza-A' }),
    );
    // ...and a bare-emoji echo, which must be ignored (not treated as a reaction,
    // not a text token) so it can't fall through to resolve the oldest (now B).
    runner.handleMessage(...approvalInbound({ content: THUMBS_UP, messageId: 'stanza-A' }));

    expect(getApproval(db, a)?.status).toBe('approved');
    expect(getApproval(db, b)?.status).toBe('pending');
  });

  test('bare text reply still resolves the oldest pending approval (documented fallback)', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('B'), now: NOW - 1000 });
    runner.tick();
    await runner.whenIdle();

    runner.handleMessage(...approvalInbound({ content: 'y' }));
    // Oldest (A) resolves; B untouched — bare text carries no quoted id here.
    expect(getApproval(db, a)?.status).toBe('approved');
    expect(getApproval(db, b)?.status).toBe('pending');
  });

  test('a reaction from another instance is ignored (PR #2507 instance-scope guard)', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();

    // Same emoji + same stored stanza id, but a DIFFERENT instanceId → dropped.
    runner.handleMessage(
      `omni.message.other-instance.${APPROVAL_CHAT}`,
      JSON.stringify({
        content: reactionContent(THUMBS_UP, 'stanza-A'),
        messageId: 'stanza-A',
        chatId: APPROVAL_CHAT,
        instanceId: 'other-instance',
        sender: 'stranger',
      }),
    );
    expect(getApproval(db, a)?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// ⏳→✅/❌ status-reaction lifecycle + the explicit-non-matching-target no-op
// (Group 3). Every test injects a FAKE `setReaction` recorder — zero network —
// and asserts the (target id, emoji) genie sets on its OWN approval message.
// ---------------------------------------------------------------------------
const HOURGLASS = '\u{23F3}'; // ⏳
const CHECK = '\u{2705}'; // ✅
const CROSS = '\u{274C}'; // ❌
const THUMBS_DOWN = '\u{1F44E}'; // 👎 (in rt() denyReactions)

interface ReactionCall {
  messageId: string;
  emoji: string;
}

/** A status runner with a fake set-reaction recorder and a mutable clock. */
function statusRunner(db: Database, reactions: ReactionCall[], clock: { now: number }) {
  return createOmniRunner({
    db,
    config: rt(),
    publish: () => {},
    sendApproval,
    setReaction: async ({ messageId, emoji }) => {
      reactions.push({ messageId, emoji });
      return { success: true };
    },
    now: () => clock.now,
  });
}

describe('omni runner — ⏳→✅/❌ status-reaction lifecycle', () => {
  test('announce sets ⏳ on the stored stanza id', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    expect(reactions).toEqual([{ messageId: 'stanza-A', emoji: HOURGLASS }]);
  });

  test('approve swaps ⏳→✅ on the same stanza id and closes the row', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();

    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-A'), messageId: 'stanza-A' }),
    );
    await runner.whenIdle();

    expect(getApproval(db, a)?.status).toBe('approved'); // row closed
    expect(reactions).toEqual([
      { messageId: 'stanza-A', emoji: HOURGLASS },
      { messageId: 'stanza-A', emoji: CHECK },
    ]);
  });

  test('deny swaps ⏳→❌', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();

    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_DOWN, 'stanza-A'), messageId: 'stanza-A' }),
    );
    await runner.whenIdle();

    expect(getApproval(db, a)?.status).toBe('denied');
    expect(reactions[reactions.length - 1]).toEqual({ messageId: 'stanza-A', emoji: CROSS });
  });

  test('expiry swaps ⏳→❌ and closes the row', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const clock = { now: NOW };
    const runner = statusRunner(db, reactions, clock);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick(); // announce + ⏳
    await runner.whenIdle();

    // Advance past pollBudgetMs (10_000) so the row is stale, then tick to expire.
    clock.now = NOW + 20_000;
    runner.tick();
    await runner.whenIdle();

    expect(getApproval(db, a)?.status).toBe('expired'); // row closed
    expect(reactions[reactions.length - 1]).toEqual({ messageId: 'stanza-A', emoji: CROSS });
  });

  test('reaction with an explicit non-matching target NO-OPs (does not resolve oldest)', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('B'), now: NOW - 1000 });
    runner.tick();
    await runner.whenIdle();

    // A 👍 targeting a stanza id no pending approval carries (already-resolved or
    // unknown) must NOT fall back to resolving the oldest — the MEDIUM fix.
    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-UNKNOWN'), messageId: 'stanza-UNKNOWN' }),
    );
    await runner.whenIdle();

    expect(getApproval(db, a)?.status).toBe('pending');
    expect(getApproval(db, b)?.status).toBe('pending');
    // No ✅ was set — only the two ⏳ announces happened.
    expect(reactions.filter((r) => r.emoji === CHECK)).toEqual([]);
  });

  test('records the glyph on each successful ack (⏳ on announce, ✅ on approve)', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(HOURGLASS); // recorded ⏳

    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-A'), messageId: 'stanza-A' }),
    );
    await runner.whenIdle();
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(CHECK); // recorded ✅ (terminal)
  });
});

// ---------------------------------------------------------------------------
// Reconciliation: the RUNNER is the authoritative acker even when the hook fork
// wins the expiry race (expires the row but sets NO reaction). Without this, the
// ⏳ set on announce would stick on the phone forever (the G3-review HIGH).
// ---------------------------------------------------------------------------
describe('omni runner — status-ack reconciliation (hook-fork-expiry race)', () => {
  /** Faithful to the hook's expireOwnRow: expire ONE row, no status glyph. */
  function hookForkExpire(db: Database, id: string): void {
    db.query("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(
      NOW,
      id,
    );
  }

  test('hook fork expires the row (no ack) → runner tick reconciles a ❌', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick(); // announce + ⏳
    await runner.whenIdle();
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(HOURGLASS);

    // The hook fork wins the expiry race — row is expired with a stuck ⏳.
    hookForkExpire(db, a);
    expect(getApproval(db, a)?.status).toBe('expired');
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(HOURGLASS); // still ⏳ — no ack

    // The runner's next tick reconciles the stuck ⏳ to ❌.
    runner.tick();
    await runner.whenIdle();
    expect(reactions[reactions.length - 1]).toEqual({ messageId: 'stanza-A', emoji: CROSS });
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(CROSS);
  });

  test('reconciliation is idempotent — a second tick does not re-emit ❌', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    hookForkExpire(db, a);

    runner.tick(); // reconciles → ❌ recorded
    await runner.whenIdle();
    const countAfterFirst = reactions.length;

    runner.tick(); // glyph now terminal → nothing to reconcile
    await runner.whenIdle();
    expect(reactions.length).toBe(countAfterFirst);
    // Exactly one ❌ ever emitted for this row.
    expect(reactions.filter((r) => r.emoji === CROSS).length).toBe(1);
  });

  test('a transport-dropped resolve ack is retried by reconciliation', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    // setReaction FAILS the first call (the ⏳ or the ✅), succeeds afterwards —
    // so the terminal glyph is not recorded until reconciliation retries it.
    let calls = 0;
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      sendApproval,
      setReaction: async ({ messageId, emoji }) => {
        calls++;
        reactions.push({ messageId, emoji });
        return calls === 2 ? { success: false, error: 'dropped' } : { success: true };
      },
      now: () => NOW,
    });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick(); // announce ⏳ (call 1, ok → recorded)
    await runner.whenIdle();

    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-A'), messageId: 'stanza-A' }),
    );
    await runner.whenIdle(); // resolve ✅ (call 2, DROPPED → glyph stays ⏳)
    expect(getApproval(db, a)?.status).toBe('approved');
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(HOURGLASS); // not recorded — drop

    runner.tick(); // reconciliation retries ✅ (call 3, ok → recorded)
    await runner.whenIdle();
    expect(getApproval(db, a)?.lastStatusGlyph).toBe(CHECK);
    expect(reactions[reactions.length - 1]).toEqual({ messageId: 'stanza-A', emoji: CHECK });
  });
});

// ---------------------------------------------------------------------------
// Model A pure helpers — argv contract, stream-json parsing, and the stable
// session-id derivation. Pure functions, no runner / fork / HTTP.
// ---------------------------------------------------------------------------
describe('buildClaudeArgs — Model A argv contract', () => {
  test('create mode binds --session-id, streams stream-json, appends the persona', () => {
    const args = buildClaudeArgs({
      message: 'hi',
      sessionId: 'sess-1',
      personaFile: '/repo/AGENTS.md',
      mode: 'create',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--session-id',
      'sess-1',
      '--append-system-prompt-file',
      '/repo/AGENTS.md',
      '--',
      'hi',
    ]);
  });

  test('resume mode binds --resume (not --session-id)', () => {
    const args = buildClaudeArgs({ message: 'again', sessionId: 'sess-1', mode: 'resume' });
    expect(args).toContain('--resume');
    expect(args).not.toContain('--session-id');
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-1');
  });

  test('omits the persona flag when no persona file is resolved; message stays last', () => {
    const args = buildClaudeArgs({ message: 'hello there', sessionId: 'sess-2', mode: 'create' });
    expect(args).not.toContain('--append-system-prompt-file');
    expect(args).toContain('--session-id');
    expect(args).toContain('stream-json');
    expect(args[args.length - 1]).toBe('hello there');
  });

  test('terminates options with -- so a hyphen-leading message is a prompt, never a flag', () => {
    // Verified live: `claude -p -- '-ping'` accepts the token as the prompt.
    const args = buildClaudeArgs({ message: '--version', sessionId: 'sess-3', mode: 'resume' });
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('--version');
  });
});

describe('extractStreamJsonReply — stream-json parsing', () => {
  test('prefers the terminal result success text over partial assistant deltas', () => {
    const nd = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking…' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'THE FINAL ANSWER' }),
    ].join('\n');
    expect(extractStreamJsonReply(nd)).toEqual({ reply: 'THE FINAL ANSWER', isError: false });
  });

  test('falls back to concatenated assistant text when there is no success result', () => {
    const nd = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hello ' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'world' }] } }),
    ].join('\n');
    expect(extractStreamJsonReply(nd)).toEqual({ reply: 'Hello world', isError: false });
  });

  test('falls back to the raw stdout when the output is not stream-json at all', () => {
    expect(extractStreamJsonReply('plain non-json output')).toEqual({ reply: 'plain non-json output', isError: false });
  });

  test('flags is_error on an error terminal result and never returns the raw NDJSON blob', () => {
    const nd = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } }),
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, result: 'hit max turns' }),
    ].join('\n');
    const parsed = extractStreamJsonReply(nd);
    expect(parsed.isError).toBe(true);
    expect(parsed.reply).not.toContain('"type":"result"'); // never the raw blob
  });

  test('flags an empty success result as an error (no happy blank reply)', () => {
    const nd = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' });
    expect(extractStreamJsonReply(nd).isError).toBe(true);
  });
});

describe('Codex executor JSONL and resume', () => {
  const successJsonl = (text: string, threadId = 'thread-1'): string =>
    [
      JSON.stringify({ type: 'thread.started', thread_id: threadId }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

  test('extracts the thread id and final agent message', () => {
    const jsonl = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 2 } }),
    ].join('\n');
    expect(extractCodexJsonlReply(jsonl)).toEqual({
      stdout: 'final',
      exitCode: 0,
      isError: false,
      threadId: 'thread-1',
    });
  });

  test('terminates options before every option-like prompt on fresh and resumed turns', () => {
    for (const message of ['--version', '--help', '-m']) {
      const fresh = buildCodexArgs({ message });
      expect(fresh).toEqual(['exec', '--json', '--sandbox', 'workspace-write', '--', message]);

      const resumed = buildCodexArgs({ message, threadId: 'thread-1' });
      expect(resumed.slice(0, 3)).toEqual(['exec', 'resume', '--json']);
      expect(resumed).toContain('thread-1');
      expect(resumed.slice(-3)).toEqual(['--', 'thread-1', message]);
    }
  });

  test('rejects option-like, control-character, and oversized persisted thread ids', () => {
    for (const unsafe of ['--last', '-m', 'thread\nnext', 'x'.repeat(257)]) {
      expect(isSafeCodexThreadId(unsafe)).toBe(false);
      expect(() => buildCodexArgs({ message: 'hello', threadId: unsafe })).toThrow('unsafe persisted Codex thread id');
    }
    expect(isSafeCodexThreadId('0190abcd-1234-7abc-8def-0123456789ab')).toBe(true);
    const emitted = extractCodexJsonlReply(
      [
        JSON.stringify({ type: 'thread.started', thread_id: '--dangerously-bypass-approvals-and-sandbox' }),
        JSON.stringify({ type: 'turn.started' }),
      ].join('\n'),
    );
    expect(emitted.isError).toBe(true);
    expect(emitted.stdout).toContain('unsafe thread_id');
  });

  test('rejects blank, unrelated, malformed, unknown, and valid-but-incomplete JSONL', () => {
    const invalidStreams = [
      '',
      '  \n',
      JSON.stringify({ status: 'ok' }),
      'null',
      '{"type":"item.completed"',
      JSON.stringify({ type: 'future.event', payload: {} }),
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-only' }),
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'thread-empty' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '   ' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
    ];
    for (const jsonl of invalidStreams) {
      const result = extractCodexJsonlReply(jsonl);
      expect(result.isError).toBe(true);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stdout.toLowerCase()).toContain('retry');
    }
  });

  test('requires the reply before turn.completed and rejects every non-blank event or fragment after it', () => {
    const completionBeforeReply = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'too late' } }),
    ].join('\n');
    const eventAfterCompletion = `${successJsonl('done')}\n${JSON.stringify({ type: 'turn.started' })}`;
    const fragmentAfterCompletion = `${successJsonl('done')}\ntrailing process noise`;

    const early = extractCodexJsonlReply(completionBeforeReply);
    expect(early.isError).toBe(true);
    expect(early.stdout).toContain('before a non-empty agent reply');
    for (const jsonl of [eventAfterCompletion, fragmentAfterCompletion]) {
      const result = extractCodexJsonlReply(jsonl);
      expect(result.isError).toBe(true);
      expect(result.stdout).toContain('after turn.completed');
    }
  });

  test('bounds oversized JSONL lines instead of scanning or acknowledging them', () => {
    const oversized = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'x'.repeat(300_000) },
    });
    const result = extractCodexJsonlReply(oversized);
    expect(result.isError).toBe(true);
    expect(result.stdout).toContain('exceeded');
  });

  test('runs codex exec resume and parses its final response', async () => {
    const calls: string[][] = [];
    const result = await runCodexSession(
      {
        provider: 'codex',
        message: 'again',
        cwd: '/repo',
        signal: new AbortController().signal,
        threadId: 'thread-1',
      },
      async (args) => {
        calls.push(args);
        return {
          stdout: successJsonl('resumed'),
          stderr: '',
          exitCode: 0,
        };
      },
    );
    expect(calls[0].slice(0, 3)).toEqual(['exec', 'resume', '--json']);
    expect(calls[0].slice(-3)).toEqual(['--', 'thread-1', 'again']);
    expect(result.stdout).toBe('resumed');
    expect(result.threadId).toBe('thread-1');
  });

  test('a missing persisted thread retries fresh exactly once and returns an atomic replacement', async () => {
    const calls: string[][] = [];
    const result = await runCodexSession(
      {
        provider: 'codex',
        message: '--help',
        cwd: '/repo',
        signal: new AbortController().signal,
        threadId: 'stale-thread',
      },
      async (args) => {
        calls.push(args);
        if (args.includes('resume')) {
          return {
            stdout: JSON.stringify({ type: 'error', message: 'Thread not found: stale-thread' }),
            stderr: '',
            exitCode: 1,
          };
        }
        return { stdout: successJsonl('recovered', 'fresh-thread'), stderr: '', exitCode: 0 };
      },
    );

    expect(calls.length).toBe(2);
    expect(calls[0].slice(-3)).toEqual(['--', 'stale-thread', '--help']);
    expect(calls[1]).not.toContain('resume');
    expect(calls[1].slice(-2)).toEqual(['--', '--help']);
    expect(result).toMatchObject({
      stdout: 'recovered',
      exitCode: 0,
      isError: false,
      threadId: 'fresh-thread',
      replacesThreadId: 'stale-thread',
    });
  });

  test('never treats a truncated agent reply containing "thread not found" as a recovery signal', async () => {
    const db = freshDb();
    const published: Published[] = [];
    upsertAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT, 'live-thread', 1);
    let calls = 0;
    const runner = createOmniRunner({
      db,
      config: rt({ routes: [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: ROUTE_REPO, agent: 'codex' }] }),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnAgent: (opts) =>
        runCodexSession(opts, async () => {
          calls++;
          return {
            stdout: [
              JSON.stringify({ type: 'thread.started', thread_id: 'live-thread' }),
              JSON.stringify({ type: 'turn.started' }),
              JSON.stringify({
                type: 'item.completed',
                item: { type: 'agent_message', text: 'The documentation says thread not found' },
              }),
            ].join('\n'),
            stderr: '',
            exitCode: 0,
          };
        }),
    });

    runner.handleMessage(...mappedInbound('question'));
    await runner.whenIdle();

    expect(calls).toBe(1);
    expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBe('live-thread');
    expect(content(published[0])).toContain('turn.completed was not emitted');
  });

  test('a failed fresh recovery is actionable, clears the known-dead id, and never loops', async () => {
    const calls: string[][] = [];
    const result = await runCodexSession(
      {
        provider: 'codex',
        message: 'retry me',
        cwd: '/repo',
        signal: new AbortController().signal,
        threadId: 'stale-thread',
      },
      async (args) => {
        calls.push(args);
        if (args.includes('resume')) {
          return { stdout: '', stderr: 'Session expired', exitCode: 1 };
        }
        return { stdout: '{"type":"turn.started"', stderr: '', exitCode: 0 };
      },
    );

    expect(calls.length).toBe(2);
    expect(result.isError).toBe(true);
    expect(result.clearThreadId).toBe('stale-thread');
    expect(result.threadId).toBeUndefined();
    expect(result.stdout).toContain('one-time fresh retry failed');
    expect(result.stdout).toContain('send the message again');
  });

  test('runner replaces a stale id only after valid recovery, then clears it after a failed recovery', async () => {
    const db = freshDb();
    const published: Published[] = [];
    upsertAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT, 'stale-thread', 1);
    let phase: 'recover-success' | 'resume-missing' | 'fresh-failure' | 'final-fresh' | 'retry-fresh' =
      'recover-success';
    const calls: string[][] = [];
    const runner = createOmniRunner({
      db,
      config: rt({ routes: [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: ROUTE_REPO, agent: 'codex' }] }),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnAgent: (opts) =>
        runCodexSession(opts, async (args) => {
          calls.push(args);
          if (phase === 'recover-success') {
            expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBe('stale-thread');
            phase = 'resume-missing';
            return { stdout: '', stderr: 'Conversation not found', exitCode: 1 };
          }
          if (phase === 'resume-missing') {
            expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBe('stale-thread');
            phase = 'fresh-failure';
            return { stdout: successJsonl('first recovered reply', 'fresh-thread'), stderr: '', exitCode: 0 };
          }
          if (phase === 'fresh-failure') {
            phase = 'final-fresh';
            return { stdout: '', stderr: 'Thread not found', exitCode: 1 };
          }
          if (phase === 'final-fresh') {
            phase = 'retry-fresh';
            return { stdout: '{"type":"turn.started"', stderr: '', exitCode: 0 };
          }
          return { stdout: successJsonl('retry succeeded', 'retry-thread'), stderr: '', exitCode: 0 };
        }),
    });

    runner.handleMessage(...mappedInbound('first'));
    await runner.whenIdle();
    expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBe('fresh-thread');
    expect(content(published[0])).toBe('first recovered reply');

    runner.handleMessage(...mappedInbound('second'));
    await runner.whenIdle();
    expect(calls.length).toBe(4);
    expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBeUndefined();
    expect(content(published[1])).toContain('send the message again');

    runner.handleMessage(...mappedInbound('third'));
    await runner.whenIdle();
    expect(calls.length).toBe(5);
    expect(calls[4]).not.toContain('resume');
    expect(getAgentSession(db, 'codex', INSTANCE, ROUTE_CHAT)).toBe('retry-thread');
    expect(content(published[2])).toBe('retry succeeded');
  });
});

describe('Codex host process boundaries', () => {
  test('stdout overflow cancels the stream immediately without waiting for EOF', async () => {
    let cancelled = false;
    let overflowed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123456789'));
        // Deliberately never close: bounded reading must cancel after byte 9.
      },
      cancel() {
        cancelled = true;
      },
    });
    const started = performance.now();
    const result = await readBoundedText(stream, 8, () => {
      overflowed = true;
    });
    expect(result).toEqual({ text: '12345678', truncated: true });
    expect(overflowed).toBe(true);
    expect(cancelled).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  test('uses an absolute host executable and rejects nested-route and common-repo decoys', () => {
    const route = mkdtempSync(join(tmpdir(), 'genie-codex-route-'));
    try {
      const trustedNode = Bun.which('node');
      if (!trustedNode) throw new Error('Node is required');
      const repo = join(route, 'repo');
      const nested = join(repo, 'packages', 'app');
      mkdirSync(join(repo, '.git'), { recursive: true });
      mkdirSync(nested, { recursive: true });
      expect(resolveTrustedHostExecutable('codex', nested, () => trustedNode)).toBe(realpathSync(trustedNode));

      const decoy = join(repo, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
      mkdirSync(join(repo, 'bin'), { recursive: true });
      writeFileSync(decoy, 'decoy');
      chmodSync(decoy, 0o755);
      expect(() => resolveTrustedHostExecutable('codex', nested, () => decoy)).toThrow('repository-local');

      const main = join(route, 'main');
      const linked = join(route, 'linked');
      const linkedGitDir = join(main, '.git', 'worktrees', 'linked');
      const linkedNested = join(linked, 'src', 'nested');
      mkdirSync(linkedGitDir, { recursive: true });
      mkdirSync(linkedNested, { recursive: true });
      writeFileSync(join(linked, '.git'), `gitdir: ${linkedGitDir}\n`);
      writeFileSync(join(linkedGitDir, 'commondir'), '../..\n');
      const commonDecoy = join(main, 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
      mkdirSync(join(main, 'bin'), { recursive: true });
      writeFileSync(commonDecoy, 'common repo decoy');
      chmodSync(commonDecoy, 0o755);
      expect(() => resolveTrustedHostExecutable('claude', linkedNested, () => commonDecoy)).toThrow('repository-local');
    } finally {
      rmSync(route, { recursive: true, force: true });
    }
  });

  test('fails closed when repository trust metadata points at a missing git directory', () => {
    const route = mkdtempSync(join(tmpdir(), 'genie-broken-git-route-'));
    try {
      const trustedNode = Bun.which('node');
      if (!trustedNode) throw new Error('Node is required');
      const nested = join(route, 'src', 'nested');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(route, '.git'), `gitdir: ${join(route, 'missing-git-dir')}\n`);
      expect(() => resolveTrustedHostExecutable('codex', nested, () => trustedNode)).toThrow();
    } finally {
      rmSync(route, { recursive: true, force: true });
    }
  });
});

describe('Omni serve shutdown ownership', () => {
  test('aborts and drains an in-flight route before closing NATS or SQLite ownership returns', async () => {
    const db = freshDb();
    const order: string[] = [];
    const queue: NatsInboundMsg[] = [];
    let closed = false;
    let wake: (() => void) | undefined;
    const subscription: NatsSubscription = {
      unsubscribe() {
        closed = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        while (!closed) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
        }
      },
    };
    const nats: NatsLike = {
      subscribe: () => subscription,
      publish: () => order.push('publish'),
      close: async () => {
        order.push('nats-close');
      },
    };
    const serveAbort = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const serve = runOmniServe({
      db,
      config: rt(),
      natsFactory: async () => nats,
      signal: serveAbort.signal,
      onReady: ready,
      runnerDeps: {
        spawnAgent: ({ signal }) =>
          new Promise((resolve) => {
            childStarted();
            signal.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  order.push('child-settled');
                  resolve({ stdout: 'cancelled', exitCode: 1, isError: true });
                }, 20);
              },
              { once: true },
            );
          }),
      },
    });
    await readyPromise;
    queue.push({
      subject: `omni.message.${INSTANCE}.${ROUTE_CHAT}`,
      data: new TextEncoder().encode(
        JSON.stringify({ content: 'in flight', chatId: ROUTE_CHAT, sender: 'boss', instanceId: INSTANCE }),
      ),
    });
    wake?.();
    await childStartedPromise;
    serveAbort.abort();
    await serve;

    expect(order.indexOf('child-settled')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('child-settled')).toBeLessThan(order.indexOf('nats-close'));
    expect(listInbox(db, { handled: true })).toHaveLength(1);
    expect(() => db.query('SELECT 1').get()).not.toThrow();
  });
});

describe('runClaudeSession — resume-first session continuity', () => {
  const noSignal = () => new AbortController().signal;
  const successNd = (text: string) =>
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text });
  const base = { message: 'm', cwd: '/repo', sessionId: 'sess-x' };

  test('turn 2+ (session exists): resume succeeds in ONE spawn, no create', async () => {
    const calls: string[][] = [];
    const rawSpawn: RawClaudeSpawn = async (args) => {
      calls.push(args);
      return { stdout: successNd('RESUMED'), stderr: '', exitCode: 0 };
    };
    const res = await runClaudeSession({ ...base, signal: noSignal() }, rawSpawn);
    expect(res).toEqual({ stdout: 'RESUMED', stderr: '', exitCode: 0, isError: false });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('--resume');
  });

  test('turn 1 (no session): resume reports missing → falls back to --session-id create', async () => {
    const calls: string[][] = [];
    const rawSpawn: RawClaudeSpawn = async (args) => {
      calls.push(args);
      if (args.includes('--resume')) {
        return { stdout: '', stderr: 'No conversation found with session ID: sess-x', exitCode: 1 };
      }
      return { stdout: successNd('CREATED'), stderr: '', exitCode: 0 };
    };
    const res = await runClaudeSession({ ...base, signal: noSignal() }, rawSpawn);
    expect(res.stdout).toBe('CREATED');
    expect(res.exitCode).toBe(0);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain('--resume');
    expect(calls[1]).toContain('--session-id');
  });

  test('regression: resume-first never re-triggers "already in use" (session-id would fail, resume wins)', async () => {
    // Models the LIVE-verified CRITICAL: a second --session-id on an existing id
    // exits 1 "already in use". Resume-first must reach the session via --resume
    // and NEVER re-issue --session-id.
    const calls: string[][] = [];
    const rawSpawn: RawClaudeSpawn = async (args) => {
      calls.push(args);
      if (args.includes('--session-id')) {
        return { stdout: '', stderr: 'Error: Session ID sess-x is already in use.', exitCode: 1 };
      }
      return { stdout: successNd('RESUMED'), stderr: '', exitCode: 0 };
    };
    const res = await runClaudeSession({ ...base, signal: noSignal() }, rawSpawn);
    expect(res.stdout).toBe('RESUMED');
    expect(calls.every((a) => !a.includes('--session-id'))).toBe(true);
  });

  test('a resume failure that is NOT a missing session is surfaced as-is (no create fallback)', async () => {
    const calls: string[][] = [];
    const rawSpawn: RawClaudeSpawn = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: 'Error: something else entirely', exitCode: 1 };
    };
    const res = await runClaudeSession({ ...base, signal: noSignal() }, rawSpawn);
    expect(res.exitCode).toBe(1);
    expect(calls.length).toBe(1); // never fell back to create
  });

  test('a generic "… not found" resume failure is NOT treated as a missing session', async () => {
    // The session EXISTS; some other resource is missing. A bare "not found" must
    // not trigger a --session-id create (which would then error "already in use").
    const calls: string[][] = [];
    const rawSpawn: RawClaudeSpawn = async (args) => {
      calls.push(args);
      return { stdout: '', stderr: 'Error: model "sonnet-99" not found', exitCode: 1 };
    };
    const res = await runClaudeSession({ ...base, signal: noSignal() }, rawSpawn);
    expect(res.exitCode).toBe(1);
    expect(calls.length).toBe(1); // resume only — no spurious create
    expect(calls[0]).toContain('--resume');
  });
});

describe('deterministicSessionId — stable per conversation', () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('is stable for the same (instance, chat) and a valid v5-shaped uuid', () => {
    const a = deterministicSessionId(INSTANCE, ROUTE_CHAT);
    expect(a).toBe(deterministicSessionId(INSTANCE, ROUTE_CHAT));
    expect(a).toMatch(UUID_RE);
  });

  test('differs when the chat (or instance) differs', () => {
    const base = deterministicSessionId(INSTANCE, ROUTE_CHAT);
    expect(deterministicSessionId(INSTANCE, 'other-chat')).not.toBe(base);
    expect(deterministicSessionId('other-instance', ROUTE_CHAT)).not.toBe(base);
  });
});

// ---------------------------------------------------------------------------
// Model A route-scoped run acks (⏳→✅/❌) + persona / session threading. Every
// test injects a FAKE spawnClaude AND a FAKE setReaction — zero fork, zero HTTP.
// ---------------------------------------------------------------------------
interface RouteReactionCall {
  instance: string;
  chat: string;
  messageId: string;
  emoji: string;
}

/** An inbound frame on the mapped route carrying a WhatsApp stanza id. */
function mappedInboundWithId(body: string, messageId: string, chat = ROUTE_CHAT): [string, string] {
  return [
    `omni.message.${INSTANCE}.${chat}`,
    JSON.stringify({ content: body, chatId: chat, sender: 'boss', instanceId: INSTANCE, messageId }),
  ];
}

describe('omni runner — Model A route-scoped run acks (⏳→✅/❌)', () => {
  test('sets ⏳ before the spawn and ✅ after a successful reply, route-scoped to the inbound id', async () => {
    const db = freshDb();
    const reactions: RouteReactionCall[] = [];
    const order: string[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => order.push('publish'),
      spawnClaude: async () => {
        order.push('spawn');
        return { stdout: 'agent reply', exitCode: 0 };
      },
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        order.push(`react:${emoji}`);
        return { success: true };
      },
    });

    runner.handleMessage(...mappedInboundWithId('do it', 'wamid-1'));
    await runner.whenIdle();

    // ⏳ then ✅, both on the INBOUND stanza id and the ROUTE's (instance, chat).
    expect(reactions.map((r) => r.emoji)).toEqual([HOURGLASS, CHECK]);
    for (const r of reactions) {
      expect(r.instance).toBe(INSTANCE);
      expect(r.chat).toBe(ROUTE_CHAT);
      expect(r.messageId).toBe('wamid-1');
    }
    // ⏳ strictly before the spawn; ✅ strictly after the reply is published.
    expect(order.indexOf(`react:${HOURGLASS}`)).toBeLessThan(order.indexOf('spawn'));
    expect(order.indexOf(`react:${CHECK}`)).toBeGreaterThan(order.indexOf('publish'));
  });

  test('sets ❌ on a non-zero exit', async () => {
    const db = freshDb();
    const reactions: RouteReactionCall[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      spawnClaude: async () => ({ stdout: 'ignored', exitCode: 2 }),
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        return { success: true };
      },
    });

    runner.handleMessage(...mappedInboundWithId('bad run', 'wamid-2'));
    await runner.whenIdle();

    expect(reactions.map((r) => r.emoji)).toEqual([HOURGLASS, CROSS]);
    expect(reactions[reactions.length - 1].messageId).toBe('wamid-2');
  });

  test('sets ❌ on a timeout', async () => {
    const db = freshDb();
    const reactions: RouteReactionCall[] = [];
    const runner = createOmniRunner({
      db,
      config: rt({ inboundTimeoutMs: 10 }),
      publish: () => {},
      // Honour the abort so the timeout wins cleanly.
      spawnClaude: ({ signal }) =>
        new Promise<SpawnClaudeResult>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('killed')), { once: true });
        }),
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        return { success: true };
      },
    });

    runner.handleMessage(...mappedInboundWithId('slow', 'wamid-3'));
    await runner.whenIdle();

    expect(reactions.map((r) => r.emoji)).toEqual([HOURGLASS, CROSS]);
  });

  test('a soft-error result (exit 0 but isError) publishes an error notice + ❌, not the reply + ✅', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const reactions: RouteReactionCall[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      // exit 0 but the terminal result was an error — must NOT publish `stdout` as ✅.
      spawnClaude: async () => ({ stdout: 'hit max turns', exitCode: 0, isError: true }),
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        return { success: true };
      },
    });

    runner.handleMessage(...mappedInboundWithId('soft-error', 'wamid-e'));
    await runner.whenIdle();

    expect(content(published[0])).toContain('failed'); // errorNotice, not the raw reply
    expect(reactions.map((r) => r.emoji)).toEqual([HOURGLASS, CROSS]);
  });

  test('sets NO reaction when the inbound carries no messageId', async () => {
    const db = freshDb();
    const reactions: RouteReactionCall[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      spawnClaude: async () => ({ stdout: 'ok', exitCode: 0 }),
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        return { success: true };
      },
    });

    // mappedInbound (no messageId) still spawns + replies, but never reacts.
    runner.handleMessage(...mappedInbound('no stanza id'));
    await runner.whenIdle();

    expect(reactions).toEqual([]);
  });

  test('a failed status reaction never throws or blocks the run/publish', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => ({ stdout: 'still replies', exitCode: 0 }),
      setReaction: async () => ({ success: false, error: 'boom' }),
    });

    runner.handleMessage(...mappedInboundWithId('react-fails', 'wamid-4'));
    await runner.whenIdle();

    // The reply is published regardless of the reaction outcome.
    expect(published.length).toBe(1);
    expect(content(published[0])).toBe('still replies');
  });

  test('the ✅ HTTP call is not dispatched until the ⏳ call settles, even when the run finishes first', async () => {
    const db = freshDb();
    const dispatched: string[] = []; // emojis in HTTP-dispatch order
    let releasePending: (() => void) | undefined;
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      // The run completes instantly — long before the ⏳ HTTP call lands.
      spawnClaude: async () => ({ stdout: 'instant', exitCode: 0 }),
      setReaction: ({ emoji }) => {
        dispatched.push(emoji);
        if (emoji === HOURGLASS) {
          // Hold the ⏳ call open until the test releases it.
          return new Promise((resolve) => {
            releasePending = () => resolve({ success: true });
          });
        }
        return Promise.resolve({ success: true });
      },
    });

    runner.handleMessage(...mappedInboundWithId('fast run, slow ack', 'wamid-seq'));
    // Give the run every chance to finish while the ⏳ call is still in flight.
    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toEqual([HOURGLASS]); // ✅ must wait for the ⏳ to settle

    releasePending?.();
    await runner.whenIdle();
    expect(dispatched).toEqual([HOURGLASS, CHECK]); // ⏳ strictly before ✅ at the API
  });

  test('the final ✅ is still dispatched when the ⏳ emit REJECTS', async () => {
    const db = freshDb();
    const dispatched: string[] = [];
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: () => {},
      spawnClaude: async () => ({ stdout: 'ok', exitCode: 0 }),
      setReaction: async ({ emoji }) => {
        dispatched.push(emoji);
        if (emoji === HOURGLASS) throw new Error('network down');
        return { success: true };
      },
    });

    runner.handleMessage(...mappedInboundWithId('resilient', 'wamid-rej'));
    await runner.whenIdle();

    // The chain survives a rejected ⏳ — the final ack still goes out.
    expect(dispatched).toEqual([HOURGLASS, CHECK]);
  });
});

// ---------------------------------------------------------------------------
// Routed-run reaction/empty guard: a reaction frame (or blank body) on a MAPPED
// chat must never start a run. Its `messageId` is the REACTED-TO message — a
// spawn would prompt claude with `[Reaction: …]`, publish a reply to the chat,
// and swap the ⏳/✅ ack on the referenced message. The prior tests never caught
// this because they only send reactions to the (distinct) approval chat.
// ---------------------------------------------------------------------------
describe('omni runner — routed-run reaction/empty guard', () => {
  test('a reaction frame on a mapped route never spawns, replies, or acks', async () => {
    const db = freshDb();
    const published: Published[] = [];
    const reactions: RouteReactionCall[] = [];
    let spawns = 0;
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => {
        spawns++;
        return { stdout: 'never', exitCode: 0 };
      },
      setReaction: async ({ instance, chat, messageId, emoji }) => {
        reactions.push({ instance, chat, messageId, emoji });
        return { success: true };
      },
    });

    // A 👍 reaction in the ROUTE chat — messageId is the REACTED-TO message.
    runner.handleMessage(...mappedInboundWithId(reactionContent(THUMBS_UP, 'wamid-prior'), 'wamid-prior'));
    await runner.whenIdle();

    expect(spawns).toBe(0);
    expect(published).toEqual([]); // no spurious reply to the chat
    expect(reactions).toEqual([]); // no ⏳/✅/❌ mutation on the reacted-to message
    // Still stored to the inbox (store-only), untouched.
    const inbox = listInbox(db);
    expect(inbox.length).toBe(1);
    expect(inbox[0].handledAt).toBeNull();
  });

  test('an empty / whitespace-only inbound on a mapped route never spawns or replies', async () => {
    const db = freshDb();
    const published: Published[] = [];
    let spawns = 0;
    const runner = createOmniRunner({
      db,
      config: rt(),
      publish: (subject, payload) => published.push({ subject, payload }),
      spawnClaude: async () => {
        spawns++;
        return { stdout: 'never', exitCode: 0 };
      },
    });

    runner.handleMessage(...mappedInbound(''));
    runner.handleMessage(...mappedInbound('   \n\t'));
    await runner.whenIdle();

    expect(spawns).toBe(0);
    expect(published).toEqual([]);
    expect(listInbox(db).length).toBe(2); // both stored, neither run
  });

  test('when the route chat IS the approval chat, a reaction skips the run but still resolves', async () => {
    const db = freshDb();
    let spawns = 0;
    const runner = createOmniRunner({
      db,
      // Map the approval chat itself — both paths now see the same inbound.
      config: rt({ routes: [{ instance: INSTANCE, chat: APPROVAL_CHAT, repo: ROUTE_REPO }] }),
      publish: () => {},
      sendApproval,
      spawnClaude: async () => {
        spawns++;
        return { stdout: 'never', exitCode: 0 };
      },
      now: () => NOW,
    });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: approvalSummary('A'), now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();

    runner.handleMessage(
      ...approvalInbound({ content: reactionContent(THUMBS_UP, 'stanza-A'), messageId: 'stanza-A' }),
    );
    await runner.whenIdle();

    expect(spawns).toBe(0); // guard: the reaction never became a prompt
    expect(getApproval(db, a)?.status).toBe('approved'); // approval path intact
  });
});

describe('omni runner — Model A persona + session threading', () => {
  interface SeenSpawn {
    cwd: string;
    sessionId?: string;
    personaFile?: string;
  }

  function threadingRunner(db: Database, seen: SeenSpawn[], routes?: OmniRuntimeConfig['routes']) {
    return createOmniRunner({
      db,
      config: rt(routes ? { routes } : {}),
      publish: () => {},
      spawnClaude: async ({ cwd, sessionId, personaFile }) => {
        seen.push({ cwd, sessionId, personaFile });
        return { stdout: 'ok', exitCode: 0 };
      },
    });
  }

  test('threads a stable session id (same across messages) and the explicit route persona', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-omni-explicit-'));
    try {
      const persona = join(dir, 'persona-A.md');
      writeFileSync(persona, '# persona A');
      const db = freshDb();
      const seen: SeenSpawn[] = [];
      const runner = threadingRunner(db, seen, [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: ROUTE_REPO, persona }]);

      runner.handleMessage(...mappedInboundWithId('m1', 'id1'));
      await runner.whenIdle();
      runner.handleMessage(...mappedInboundWithId('m2', 'id2'));
      await runner.whenIdle();

      expect(seen.length).toBe(2);
      expect(seen[0].personaFile).toBe(persona);
      expect(seen[0].sessionId).toBe(deterministicSessionId(INSTANCE, ROUTE_CHAT));
      // Stable session id ⇒ the conversation resumes across messages.
      expect(seen[1].sessionId).toBe(seen[0].sessionId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('drops a typo’d explicit route.persona that does not exist (never passes it to claude)', async () => {
    const db = freshDb();
    const seen: SeenSpawn[] = [];
    const missing = join(tmpdir(), 'genie-omni-does-not-exist', 'persona.md');
    const runner = threadingRunner(db, seen, [
      { instance: INSTANCE, chat: ROUTE_CHAT, repo: ROUTE_REPO, persona: missing },
    ]);

    runner.handleMessage(...mappedInboundWithId('m', 'id'));
    await runner.whenIdle();

    expect(seen[0].personaFile).toBeUndefined();
  });

  test('falls back to <repo>/AGENTS.md when route.persona is unset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-omni-persona-'));
    try {
      writeFileSync(join(dir, 'AGENTS.md'), '# persona');
      const db = freshDb();
      const seen: SeenSpawn[] = [];
      const runner = threadingRunner(db, seen, [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: dir }]);

      runner.handleMessage(...mappedInboundWithId('m', 'id'));
      await runner.whenIdle();

      expect(seen[0].personaFile).toBe(join(dir, 'AGENTS.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves no persona when neither route.persona nor <repo>/AGENTS.md exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-omni-nopersona-'));
    try {
      const db = freshDb();
      const seen: SeenSpawn[] = [];
      const runner = threadingRunner(db, seen, [{ instance: INSTANCE, chat: ROUTE_CHAT, repo: dir }]);

      runner.handleMessage(...mappedInboundWithId('m', 'id'));
      await runner.whenIdle();

      expect(seen[0].personaFile).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
