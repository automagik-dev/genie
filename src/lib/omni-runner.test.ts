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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OmniRuntimeConfig } from './omni-config.js';
import {
  type OmniSend,
  type RawClaudeSpawn,
  type SpawnClaude,
  type SpawnClaudeResult,
  buildClaudeArgs,
  createOmniRunner,
  deterministicSessionId,
  extractStreamJsonReply,
  runClaudeSession,
} from './omni-runner.js';
import { openGlobalDb } from './v5/global-db.js';
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

/** Fake id-returning send: assigns each approval a stanza id derived from its
 *  input-summary marker (embedded in the formatted message), so correlation is
 *  order-independent. `summary-A` → `stanza-A`, `summary-B` → `stanza-B`. */
const sendApproval: OmniSend = async ({ text }) => {
  const marker = text.includes('summary-B') ? 'B' : 'A';
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
  test('announce stores the REAL stanza id returned by the send (not a genId ref)', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    expect(getApproval(db, a)?.omniMessageId).toBe('stanza-A');
  });

  test('reaction resolves the exact approval by stored stanza id, not the oldest', async () => {
    const db = freshDb();
    const runner = approvalRunner(db);
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-B', now: NOW - 1000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-B', now: NOW - 1000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-B', now: NOW - 1000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    runner.tick();
    await runner.whenIdle();
    expect(reactions).toEqual([{ messageId: 'stanza-A', emoji: HOURGLASS }]);
  });

  test('approve swaps ⏳→✅ on the same stanza id and closes the row', async () => {
    const db = freshDb();
    const reactions: ReactionCall[] = [];
    const runner = statusRunner(db, reactions, { now: NOW });
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
    const b = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-B', now: NOW - 1000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
    const a = enqueueApproval(db, { repo: '/r', tool: 'Bash', inputSummary: 'summary-A', now: NOW - 2000 });
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
