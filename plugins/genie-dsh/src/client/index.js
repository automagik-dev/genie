// Genie's browser half: the wishes Genie granted that have ended, listed under Genie's row
// in the wide sidebar with their outcome (a local branch, no change, stopped, failed or lost;
// a failed one names why on hover). Running wishes already show there as the team's
// task threads (bots-dsh sidebar.js); an ended task leaves that list, so this row keeps the
// latest ended wishes in reach. A row opens the wish's thread.
// An ended wish whose task the team saw stop on a permission says so in its tooltip and
// accessible name, beside its own outcome.
import { createElement as h } from 'react';
import { botChildren, chatSuggestions, toolCards } from './core.js';
import { grantRefusalCard, registerGrantCard } from './grant-card.js';
import { registerSuggestions } from './suggestions.js';
import { endedWishesOf, markOf, outcomeOf, stoppedKeyOf } from './wishes.js';

export function GenieWishes({ bot, roster, actions, useWork }) {
  const wishes = bot?.kind === 'genie' ? endedWishesOf(roster, bot.id) : [];
  const stoppedKey =
    typeof useWork === 'function'
      ? useWork((work) =>
          stoppedKeyOf(
            work,
            wishes.map((wish) => wish.sessionId),
          ),
        )
      : '';
  if (wishes.length === 0) return null;
  const stopped = new Set(stoppedKey.split(',').filter(Boolean));
  return h(
    'div',
    { className: 'bt-threads', role: 'group', 'aria-label': `Wishes ${bot.name} granted` },
    wishes.map((wish) => {
      const outcome = outcomeOf(wish, stopped.has(wish.sessionId));
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
        h('span', { className: 'bt-thread-age', 'aria-hidden': true }, markOf(outcome)),
        h('span', { className: 'bt-thread-title' }, wish.title),
        h('span', { className: 'bt-thread-age' }, outcome.short),
      );
    }),
  );
}

export function apply(ctx) {
  ctx.effect(() => botChildren.register({ id: 'genie-wishes', Component: GenieWishes }), 'genie: ended wishes');
  ctx.effect(() => registerSuggestions(chatSuggestions), 'genie: empty-chat suggestions');
  ctx.effect(() => registerGrantCard(toolCards, grantRefusalCard(h)), 'genie: a refused wish start in the chat');
}
