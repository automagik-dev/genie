// Genie's browser half: the wishes Genie granted that have ended, listed under Genie's row
// in the wide sidebar with their outcome (a failed one names why on hover). Running wishes already show there as the team's
// task threads (bots-dsh sidebar.js); an ended task leaves that list, so this row keeps the
// latest ended wishes in reach. A row opens the wish's thread.
import { createElement as h } from 'react';
import { botChildren } from './core.js';
import { endedWishesOf, outcomeOf } from './wishes.js';

export function GenieWishes({ bot, roster, actions }) {
  if (bot?.kind !== 'genie') return null;
  const wishes = endedWishesOf(roster, bot.id);
  if (wishes.length === 0) return null;
  return h(
    'div',
    { className: 'bt-threads', role: 'group', 'aria-label': `Wishes ${bot.name} granted` },
    wishes.map((wish) => {
      const outcome = outcomeOf(wish);
      return h(
        'button',
        {
          key: wish.sessionId,
          type: 'button',
          className: 'bt-thread',
          'data-state': outcome.state,
          'aria-label': `${wish.title}, ${outcome.full}`,
          title: `${wish.title} · ${outcome.full} · ${wish.branch}`,
          onClick: () => actions.openSession(wish.sessionId),
        },
        h('span', { className: 'bt-thread-age', 'aria-hidden': true }, outcome.state === 'done' ? '✓' : '✕'),
        h('span', { className: 'bt-thread-title' }, wish.title),
        h('span', { className: 'bt-thread-age' }, outcome.short),
      );
    }),
  );
}

export function apply(ctx) {
  ctx.effect(() => botChildren.register({ id: 'genie-wishes', Component: GenieWishes }), 'genie: ended wishes');
}
