// chat-backend.test.ts — the conductor substrate's spec (G3). Covers AC3 (@-mention deliver
// + transcript + streamed reply), AC4a (non-mutating chat face), AC5 (lazy spawn + named
// fail-loud events), AC6 (the greppable isolation wall), AC7 (capability-table badges).
//
// The transport is exercised for REAL against a deterministic stub ACP agent
// (chat-backend.stub-agent.mjs) speaking the vendor SDK over stdio — no live LLM, so the
// client half under test (spawn → ndJsonStream → ClientSideConnection → session/prompt →
// session/update) runs end-to-end deterministically. One live-adapter round-trip (the R1
// proof) is recorded separately in the wish; here we prove the routing.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AcpLauncher, ChatBackend, type ChatEvent, parseMentions } from './chat-backend';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'chat-backend.stub-agent.mjs');

/** A launcher that spawns the stub ACP agent under node in the given mode. */
function stubLauncher(mode: 'echo' | 'permission' | 'slow' = 'echo'): AcpLauncher {
  return () => ({ command: 'node', args: [STUB, mode] });
}

/** Collect this agent's events until `pred` is true; subscribe BEFORE delivering (no race). */
function waitFor(backend: ChatBackend, agentId: string, pred: (e: ChatEvent) => boolean): Promise<ChatEvent[]> {
  return new Promise((resolve) => {
    const events: ChatEvent[] = [];
    const unsub = backend.onEvent((e) => {
      if (e.agentId !== agentId) return;
      events.push(e);
      if (pred(e)) {
        unsub();
        resolve(events);
      }
    });
  });
}

/** Assemble the agent_message_chunk text from a collected event list. */
function replyText(events: ChatEvent[]): string {
  return events
    .filter((e): e is Extract<ChatEvent, { type: 'message-chunk' }> => e.type === 'message-chunk')
    .map((e) => e.text)
    .join('');
}

const backends: ChatBackend[] = [];
function makeBackend(launcher: AcpLauncher): ChatBackend {
  const b = new ChatBackend({ launcher });
  backends.push(b);
  return b;
}

afterEach(() => {
  for (const b of backends.splice(0)) b.shutdown();
});

// ============================================================================
// AC6 — the load-bearing isolation wall (greppable)
// ============================================================================

describe('AC6 isolation wall', () => {
  test('chat-backend.ts imports nothing from the PTY layer', () => {
    const src = readFileSync(join(HERE, 'chat-backend.ts'), 'utf8');
    for (const forbidden of ['pty-session', 'TerminalMirror', 'transport', 'client']) {
      const importsForbidden = new RegExp(`from ['"][^'"]*${forbidden}`).test(src);
      expect(importsForbidden).toBe(false);
    }
  });

  test('the exact wish validation grep pattern finds no match', () => {
    const src = readFileSync(join(HERE, 'chat-backend.ts'), 'utf8');
    // Mirrors: grep -RnE "from ['\"].*(pty-session|TerminalMirror|transport|client)"
    const wishGrep = /from ['"].*(pty-session|TerminalMirror|transport|client)/;
    const offending = src.split('\n').filter((l) => wishGrep.test(l));
    expect(offending).toEqual([]);
  });
});

// ============================================================================
// AC7 — capability table drives minimal badges
// ============================================================================

describe('AC7 capability table', () => {
  test('"shared memory" badge appears only for Hermes', () => {
    const b = makeBackend(stubLauncher());
    expect(b.badges('hermes')).toEqual(['shared memory']);
    expect(b.badges('claude')).toEqual([]);
    expect(b.badges('codex')).toEqual([]);
    expect(b.badges('rlmx')).toEqual([]);
  });

  test('capability rows are non-mutating in v1 and only Hermes demonstrates bridging', () => {
    const b = makeBackend(stubLauncher());
    for (const h of ['claude', 'codex', 'hermes', 'rlmx'] as const) {
      expect(b.capabilities(h).writeCapable).toBe(false); // AC4a — chat face is read-only
    }
    expect(b.capabilities('hermes').sessionBridgingDemonstrated).toBe(true);
    expect(b.capabilities('hermes').bridge).toBe('~/.hermes/state.db');
    expect(b.capabilities('rlmx').sessionBridgingDemonstrated).toBe(false);
  });
});

// ============================================================================
// @-mention parsing (the routing primitive)
// ============================================================================

describe('parseMentions', () => {
  test('extracts deduped @ids, ignores emails and mid-word @', () => {
    expect(parseMentions('@fable please review with @codex')).toEqual(['fable', 'codex']);
    expect(parseMentions('hey @fable @fable again')).toEqual(['fable']);
    expect(parseMentions('mail me at a@b.com')).toEqual([]);
    expect(parseMentions('no mentions here')).toEqual([]);
    expect(parseMentions('@hermes-review looks good')).toEqual(['hermes-review']);
  });
});

// ============================================================================
// AC5 — lazy spawn (no process before the first @-mention)
// ============================================================================

describe('AC5 lazy spawn', () => {
  test('registering an agent spawns no ACP process; the first @-mention does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'genie-chat-'));
    const marker = join(dir, 'spawned');
    process.env.GENIE_STUB_MARKER = marker;
    try {
      const b = makeBackend(stubLauncher());
      b.registerAgent({ agentId: 'fable', harness: 'claude', cwd: dir, wishContext: 'ctx' });

      expect(b.hasFace('fable')).toBe(false);
      expect(existsSync(marker)).toBe(false); // no OS process yet

      const done = waitFor(b, 'fable', (e) => e.type === 'reply-done');
      b.deliverMessage('fable', '@fable hi', '');
      await done;

      expect(b.hasFace('fable')).toBe(true);
      expect(existsSync(marker)).toBe(true); // the process ran exactly on first mention
    } finally {
      process.env.GENIE_STUB_MARKER = undefined;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// AC3 — @-mention delivers message + transcript + seed; reply streams back
// ============================================================================

describe('AC3 delivery + streamed reply', () => {
  test('first prompt carries wish-context seed + room transcript + the message', async () => {
    const b = makeBackend(stubLauncher('echo'));
    b.registerAgent({ agentId: 'fable', harness: 'claude', cwd: HERE, wishContext: 'WISH-SEED-XYZ' });

    const done = waitFor(b, 'fable', (e) => e.type === 'reply-done');
    b.deliverMessage('fable', '@fable summarize', 'human: kick off\nfable: earlier line');
    const events = await done;

    // The echo stub replies `echo:<full composed prompt>`, so the reply proves what arrived.
    const reply = replyText(events);
    expect(reply).toContain('WISH-SEED-XYZ'); // seeded (D6)
    expect(reply).toContain('Room transcript');
    expect(reply).toContain('earlier line'); // transcript delivered (AC3)
    expect(reply).toContain('@fable summarize'); // the message itself
    expect(events.at(-1)).toMatchObject({ type: 'reply-done', stopReason: 'end_turn' });
  });

  test('the wish-context seed is sent only on the FIRST prompt, not the second', async () => {
    const b = makeBackend(stubLauncher('echo'));
    b.registerAgent({ agentId: 'fable', harness: 'claude', cwd: HERE, wishContext: 'SEED-ONCE' });

    const first = waitFor(b, 'fable', (e) => e.type === 'reply-done');
    b.deliverMessage('fable', '@fable one', 't1');
    expect(replyText(await first)).toContain('SEED-ONCE');

    const second = waitFor(b, 'fable', (e) => e.type === 'reply-done');
    b.deliverMessage('fable', '@fable two', 't2');
    const secondReply = replyText(await second);
    expect(secondReply).not.toContain('SEED-ONCE'); // not re-seeded
    expect(secondReply).toContain('@fable two');
  });

  test('streamReply(agentId) yields the same events as an async iterable (the DESIGN interface)', async () => {
    const b = makeBackend(stubLauncher('echo'));
    b.registerAgent({ agentId: 'codex', harness: 'codex', cwd: HERE, wishContext: '' });

    const gen = b.streamReply('codex');
    const primer = gen.next(); // starts the generator → subscribes before we deliver
    b.deliverMessage('codex', '@codex ping', '');

    const collected: ChatEvent[] = [];
    let res = await primer;
    while (!res.done) {
      collected.push(res.value);
      if (res.value.type === 'reply-done') break;
      res = await gen.next();
    }
    await gen.return(undefined);
    expect(replyText(collected)).toContain('@codex ping');
    expect(collected.at(-1)?.type).toBe('reply-done');
  });
});

// ============================================================================
// @-mention-only routing (D4)
// ============================================================================

describe('D4 @-mention-only routing', () => {
  test('routeMessage delivers only to mentioned, registered agents', async () => {
    const b = makeBackend(stubLauncher('echo'));
    b.registerAgent({ agentId: 'fable', harness: 'claude', cwd: HERE, wishContext: '' });
    b.registerAgent({ agentId: 'codex', harness: 'codex', cwd: HERE, wishContext: '' });

    const fableDone = waitFor(b, 'fable', (e) => e.type === 'reply-done');
    const delivered = b.routeMessage('@fable and @ghost take a look', 'transcript');

    expect(delivered).toEqual(['fable']); // codex not mentioned; ghost not on roster
    await fableDone;
    expect(b.hasFace('fable')).toBe(true);
    expect(b.hasFace('codex')).toBe(false); // unmentioned agent never spawned
  });
});

// ============================================================================
// AC4a — non-mutating chat face (read-only): every permission request is cancelled
// ============================================================================

describe('AC4a non-mutating chat face', () => {
  test('a permission request from the agent is cancelled (read-only enforcement)', async () => {
    const b = makeBackend(stubLauncher('permission'));
    b.registerAgent({ agentId: 'fable', harness: 'claude', cwd: HERE, wishContext: '' });

    const done = waitFor(b, 'fable', (e) => e.type === 'reply-done');
    b.deliverMessage('fable', '@fable write a file', '');
    const reply = replyText(await done);

    expect(reply).toBe('permission:cancelled'); // the stub reports the outcome our client returned
  });
});

// ============================================================================
// AC5 — named fail-loud events (never silence)
// ============================================================================

describe('AC5 fail-loud events', () => {
  test('a missing adapter surfaces a NAMED spawn-failed event, not silence', async () => {
    const b = makeBackend(() => ({ command: 'genie-nonexistent-adapter-xyz', args: [] }));
    b.registerAgent({ agentId: 'codex', harness: 'codex', cwd: HERE, wishContext: '' });

    const failedP = waitFor(b, 'codex', (e) => e.type === 'spawn-failed');
    b.deliverMessage('codex', '@codex hi', ''); // lazy spawn tries to launch the missing adapter
    const evt = (await failedP).at(-1) as Extract<ChatEvent, { type: 'spawn-failed' }>;
    expect(evt.type).toBe('spawn-failed');
    expect(evt.message).toContain('@codex could not start');
    expect(evt.message).toContain('check PATH');
  });

  test('an unbound worktree (group not launched) fails loud instead of minting a stray cwd', async () => {
    const b = makeBackend(stubLauncher());
    b.registerAgent({ agentId: 'rlmx', harness: 'rlmx', cwd: null, wishContext: '' });

    const failedP = waitFor(b, 'rlmx', (e) => e.type === 'spawn-failed');
    b.deliverMessage('rlmx', '@rlmx hi', '');
    const evt = (await failedP).at(-1) as Extract<ChatEvent, { type: 'spawn-failed' }>;
    expect(evt.message).toContain('worktree not launched');
    expect(b.hasFace('rlmx')).toBe(true); // a failed face row exists, but no live process
  });

  test('delivering to an unregistered agent fails loud', async () => {
    const b = makeBackend(stubLauncher());
    const failedP = waitFor(b, 'nobody', (e) => e.type === 'delivery-failed');
    b.deliverMessage('nobody', 'hello', '');
    const evt = (await failedP).at(-1) as Extract<ChatEvent, { type: 'delivery-failed' }>;
    expect(evt.message).toContain('not on the roster');
  });
});
