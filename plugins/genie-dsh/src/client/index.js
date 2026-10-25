// Genie's browser half: the wishes Genie granted that have ended, listed under Genie's row
// in the wide sidebar with their outcome. Running wishes already show there as the team's
// task threads (bots-dsh sidebar.js); an ended task leaves that list, so this row keeps the
// latest ended wishes in reach. A row opens the wish's thread.
import { createElement as h } from 'react';
import { botChildren } from './core.js';
import { endedWishesOf } from './wishes.js';

export function GenieWishes({ bot, roster, actions }) {
  if (bot?.kind !== 'genie') return null;
  const wishes = endedWishesOf(roster, bot.id);
  if (wishes.length === 0) return null;
  return h(
    'div',
    { className: 'bt-threads', role: 'group', 'aria-label': `Wishes ${bot.name} granted` },
    wishes.map((wish) => {
      const failed = wish.status === 'failed';
      const outcome = failed ? 'Stopped' : 'Done';
      return h(
        'button',
        {
          key: wish.sessionId,
          type: 'button',
          className: 'bt-thread',
          'data-state': failed ? 'failed' : 'done',
          'aria-label': `${wish.title}, ${outcome}`,
          title: `${wish.title} · ${wish.branch}`,
          onClick: () => actions.openSession(wish.sessionId),
        },
        h('span', { className: 'bt-thread-age', 'aria-hidden': true }, failed ? '✕' : '✓'),
        h('span', { className: 'bt-thread-title' }, wish.title),
        h('span', { className: 'bt-thread-age' }, outcome),
      );
    }),
  );
}

export function apply(ctx) {
  ctx.effect(() => botChildren.register({ id: 'genie-wishes', Component: GenieWishes }), 'genie: ended wishes');
}
