// The Bot team's tool card for grant_wish (bots-dsh extend.js): only a refused start
// draws a line. Its text is English only.
export const NOT_STARTED = 'The wish did not start:';

export function wishRefusal(content) {
  const text = String(content ?? '').trim();
  if (!text.startsWith(NOT_STARTED)) return undefined;
  const reason = text.slice(NOT_STARTED.length).split('\n')[0].trim().slice(0, 160);
  return { reason, title: text };
}

export function grantRefusalCard(h) {
  return ({ done, content }) => {
    if (done !== true) return null;
    const refusal = wishRefusal(content);
    if (refusal === undefined) return null;
    const { reason, title } = refusal;
    return h(
      'div',
      { className: 'bt-event bt-event-error', role: 'status', title },
      h('span', null, 'Wish not started'),
      reason ? h('span', null, ` · ${reason}`) : null,
    );
  };
}

export function registerGrantCard(toolCards, render) {
  return typeof toolCards?.register === 'function' ? toolCards.register('grant_wish', render) : () => {};
}
