// chat-room.test.ts — the composition-root glue (G3). Proves wish-scoped @-mention routing,
// transcript accumulation, the drawer roster + badges, and that named fail-loud backend
// events are forwarded to the wire (never dropped). Uses the same deterministic stub ACP
// agent as chat-backend.test.ts via an injected launcher.

import { afterEach, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcpLauncher } from './chat-backend';
import { ChatRoom } from './chat-room';
import type { PaneSpec } from './fleet-config';
import type { ServerMsg } from './transport';

const HERE = dirname(fileURLToPath(import.meta.url));
const STUB = join(HERE, 'chat-backend.stub-agent.mjs');
const stubLauncher: AcpLauncher = () => ({ command: 'node', args: [STUB, 'echo'] });

function pane(id: string, harness: PaneSpec['harness'], wish: string | null): PaneSpec {
  return {
    id,
    name: id,
    role: null,
    wishId: wish,
    harness,
    command: 'bash',
    args: [],
    cwd: HERE,
    env: {},
    cols: 80,
    rows: 24,
  };
}

const rooms: ChatRoom[] = [];
function makeRoom(fleet: PaneSpec[]): { room: ChatRoom; out: ServerMsg[] } {
  const room = new ChatRoom(fleet, { launcher: stubLauncher, seedContext: (w) => `seed:${w}` });
  rooms.push(room);
  const out: ServerMsg[] = [];
  room.onOutbound((m) => out.push(m));
  return { room, out };
}
afterEach(() => {
  for (const r of rooms.splice(0)) r.shutdown();
});

/** Resolve when the outbound list contains a message matching `pred`. */
function waitForMsg(out: ServerMsg[], pred: (m: ServerMsg) => boolean): Promise<ServerMsg> {
  return new Promise((resolve) => {
    const tick = () => {
      const hit = out.find(pred);
      if (hit) resolve(hit);
      else setTimeout(tick, 5);
    };
    tick();
  });
}

test('roster is built from panes with a harness; only Hermes carries the shared-memory badge', () => {
  const { room } = makeRoom([
    pane('fable', 'claude', 'w1'),
    pane('hermes-reviewer', 'hermes', 'w1'),
    pane('monitor', null, 'w1'), // terminal-only pane → NOT in the chat roster
  ]);
  const roster = room.agentRoster();
  expect(roster.map((a) => a.id)).toEqual(['fable', 'hermes-reviewer']);
  expect(roster.find((a) => a.id === 'hermes-reviewer')?.badges).toEqual(['shared memory']);
  expect(roster.find((a) => a.id === 'fable')?.badges).toEqual([]);
});

test('a wish-scoped @-mention delivers, streams a reply, and commits both lines to the transcript', async () => {
  const { room, out } = makeRoom([pane('fable', 'claude', 'w1')]);

  room.send('w1', '@fable please summarize');

  // The human line is emitted immediately.
  const human = out.find((m) => m.t === 'chat-message' && m.line.from === 'human');
  expect(human).toBeTruthy();

  // The agent reply commits as a chat-message once the stream completes.
  const agentMsg = (await waitForMsg(out, (m) => m.t === 'chat-message' && m.line.from === 'fable')) as Extract<
    ServerMsg,
    { t: 'chat-message' }
  >;
  expect(agentMsg.line.wish).toBe('w1');
  expect(agentMsg.line.text).toContain('@fable please summarize'); // echo stub returned the delivered prompt

  // The seed was delivered on this first prompt (the echo proves it).
  expect(agentMsg.line.text).toContain('seed:w1');

  // History carries both lines, wish-scoped.
  expect(
    room
      .history()
      .filter((l) => l.wish === 'w1')
      .map((l) => l.from),
  ).toEqual(['human', 'fable']);
});

test('@-mention-only + wish scope: an agent in another wish is never delivered to', async () => {
  const { room, out } = makeRoom([pane('fable', 'claude', 'w1'), pane('codex', 'codex', 'w2')]);

  room.send('w1', '@codex over here'); // codex belongs to w2, not w1 → no delivery
  await new Promise((r) => setTimeout(r, 150));

  const codexReply = out.find((m) => m.t === 'chat-message' && m.line.from === 'codex');
  expect(codexReply).toBeUndefined();
  // Only the human line exists for w1.
  expect(room.history().map((l) => l.from)).toEqual(['human']);
});

test('a named fail-loud backend event is forwarded to the wire as a CHAT_EVENT (never dropped)', async () => {
  const room = new ChatRoom([pane('codex', 'codex', 'w1')], {
    launcher: () => ({ command: 'genie-nonexistent-adapter-xyz', args: [] }),
  });
  rooms.push(room);
  const out: ServerMsg[] = [];
  room.onOutbound((m) => out.push(m));

  room.send('w1', '@codex hello');
  const evt = (await waitForMsg(out, (m) => m.t === 'chat-event' && m.event.kind === 'spawn-failed')) as Extract<
    ServerMsg,
    { t: 'chat-event' }
  >;
  expect(evt.event.kind).toBe('spawn-failed');
  if (evt.event.kind === 'spawn-failed') expect(evt.event.message).toContain('@codex could not start');
});
