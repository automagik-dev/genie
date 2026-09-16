import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { cardSchema } from './schema';

/**
 * The browser half, rendered on a DOM stand-in.
 *
 * DSH serves React and its own UI primitives from a frozen browser module table
 * that exists only inside the Host, so the primitives are stubbed to the plain
 * elements they wrap; React itself is real, and so is every component under
 * test.
 */
mock.module('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: unknown }) => createElement('button', { type: 'button' }, children as never),
  Tag: ({ children }: { children?: unknown }) => createElement('span', { className: 'tag' }, children as never),
  StateDot: () => null,
  IconPlusOutline16: () => null,
  IconRefreshOutline16: () => null,
  IconSkillOutline16: () => null,
  IconSearchOutline16: () => null,
  Input: () => null,
}));

const { Audit, auditLabel, BoardPicker, boardOptionLabel, Conversation, showingLabel } = await import(
  './client/BoardPanel'
);

/** A card exactly as `genie board --board <id> --json` emits it, through the shipped schema. */
function seedCard(comments: number, otherEvents: number) {
  const events: { id: number; kind: string; note: string; authorKind: string; author: string; createdAt: number }[] =
    [];
  for (let index = 0; index < comments; index++)
    events.push({
      id: events.length + 1,
      kind: 'comment',
      note: `comment ${index + 1}`,
      authorKind: 'human',
      author: 'felipe',
      createdAt: 1_000 + events.length,
    });
  for (let index = 0; index < otherEvents; index++)
    events.push({
      id: events.length + 1,
      kind: index % 2 === 0 ? 'claim' : 'release',
      note: null as unknown as string,
      authorKind: 'agent',
      author: 'claude',
      createdAt: 1_000 + events.length,
    });
  // The emitter keeps the newest 25 of each stream independently and reports the
  // true totals; see BOARD_JSON_EVENT_LIMIT in src/lib/v5/task-state.ts.
  const limit = 25;
  const commentEvents = events.filter((event) => event.kind === 'comment');
  return cardSchema.parse({
    id: 't_seed',
    boardId: 'b_seed',
    title: 'Seeded card',
    status: 'in_progress',
    claimedBy: 'claude',
    claimedAt: 1_000,
    wish: null,
    group: null,
    assignedAgent: null,
    assignedReason: null,
    createdAt: 900,
    updatedAt: 2_000,
    lane: 'Work',
    enforcedBlock: null,
    agentKind: 'agent',
    heartbeatAt: null,
    blockedBy: null,
    blockedReason: null,
    liveness: 'idle',
    dependencies: [],
    timeline: events.slice(-limit),
    eventCount: events.length,
    eventsTruncated: events.length > limit,
    comments: commentEvents
      .slice(-limit)
      .map(({ id, note, authorKind, author, createdAt }) => ({ id, note, authorKind, author, createdAt })),
    commentCount: commentEvents.length,
  });
}

const render = (element: ReturnType<typeof createElement>) => renderToStaticMarkup(element);

test('the picker marks a board that carries no lanes, and only that board', () => {
  const boards = [
    { id: 'b_lanes', name: 'Roadmap', laneCount: 4, cardCount: 12 },
    { id: 'b_none', name: 'trulyNoLanes', laneCount: 0, cardCount: 1 },
  ];
  expect(boardOptionLabel(boards[0])).toBe('Roadmap · 12');
  expect(boardOptionLabel(boards[1])).toBe('trulyNoLanes · 1 (no lanes)');
  const html = render(
    createElement(BoardPicker, { boards, value: 'b_lanes', disabled: false, onSelect: () => undefined }),
  );
  expect(html).toContain('trulyNoLanes · 1 (no lanes)');
  // The lane board is not marked, so the mark means something.
  expect(html).toContain('>Roadmap · 12<');
  expect(html.match(/\(no lanes\)/g)?.length).toBe(1);
});

test('the Comments pane renders the comment window and says how much of it is showing', () => {
  const card = seedCard(30, 6);
  // The fixture is the aggregate's own shape: two independently capped windows.
  expect([card.comments.length, card.commentCount]).toEqual([25, 30]);
  expect([card.timeline.length, card.eventCount, card.eventsTruncated]).toEqual([25, 36, true]);
  const html = render(createElement(Conversation, { card, busy: false, onSend: () => undefined }));
  // Every rendered message is a comment from `comments`, never a filter over the
  // 25-event window (which holds only 19 of them).
  expect(html.match(/<article/g)?.length).toBe(25);
  expect(html).toContain('comment 6');
  expect(html).toContain('comment 30');
  expect(html).not.toContain('comment 5<');
  expect(html).toContain('showing last 25 of 30');
});

test('an untruncated card shows the pane without a window label', () => {
  const card = seedCard(3, 2);
  expect([card.comments.length, card.commentCount, card.eventsTruncated]).toEqual([3, 3, false]);
  const html = render(createElement(Conversation, { card, busy: false, onSend: () => undefined }));
  expect(html.match(/<article/g)?.length).toBe(3);
  expect(html).not.toContain('showing last');
  expect(showingLabel(3, 3)).toBeUndefined();
  expect(showingLabel(25, 30)).toBe('showing last 25 of 30');
});

test('a worker report is readable in History, body and all', () => {
  const body = 'done: 12 tests pass, migration applied';
  const card = seedCard(1, 0);
  const reported = cardSchema.parse({
    ...card,
    timeline: [
      ...card.timeline,
      { id: 99, kind: 'report', note: body, authorKind: 'agent', author: 'eng-A', createdAt: 1_500 },
    ],
    eventCount: card.eventCount + 1,
  });
  // The Comments pane is the `comments` window, which the emitter builds from
  // comment events only, so a report never appears there...
  const chat = render(createElement(Conversation, { card: reported, busy: false, onSend: () => undefined }));
  expect(chat).not.toContain(body);
  // ...which makes History the only surface that can carry the handoff text.
  const history = render(createElement(Audit, { card: reported, now: 2_000 }));
  expect(history).toContain(`Reported: ${body}`);
  expect(auditLabel({ id: 1, kind: 'report', note: body, author: null, authorKind: null, createdAt: 0 })).toBe(
    `Reported: ${body}`,
  );
  // A report with no note is still just the label, and the other kinds are unchanged.
  expect(auditLabel({ id: 2, kind: 'report', note: null, author: null, authorKind: null, createdAt: 0 })).toBe(
    'Reported',
  );
  expect(auditLabel({ id: 3, kind: 'comment', note: 'hi', author: null, authorKind: null, createdAt: 0 })).toBe(
    'Commented',
  );
  expect(auditLabel({ id: 4, kind: 'move', note: null, author: null, authorKind: null, createdAt: 0 })).toBe('move');
  expect(auditLabel({ id: 5, kind: 'move', note: 'to Work', author: null, authorKind: null, createdAt: 0 })).toBe(
    'Moved to Work',
  );
  expect(
    auditLabel({ id: 6, kind: 'claim', note: 'claimed by eng-A', author: null, authorKind: null, createdAt: 0 }),
  ).toBe('Claimed (eng-A)');
  expect(auditLabel({ id: 7, kind: 'nova', note: 'x', author: null, authorKind: null, createdAt: 0 })).toBe('nova: x');
});
