// Which of a Genie's wishes its row lists: the ended ones, newest first. A wish granted
// since records v2 carries its own outcome (`state`, src/host/wishes.js); an older one has
// only the team's task status (a running wish is already one of the team's task threads).
export const ENDED_SHOWN = 3;

/** The ended wishes of one Genie, newest first, with the team's task status. */
export function endedWishesOf(roster, botId) {
  const tasks = roster?.tasks ?? {};
  return (roster?.genie?.wishes ?? [])
    .filter((wish) => wish.botId === botId)
    .map((wish) => ({
      ...wish,
      status: tasks[wish.sessionId]?.status ?? 'ended',
      summary: tasks[wish.sessionId]?.summary,
    }))
    .filter((wish) => (wish.state === undefined ? wish.status !== 'working' : wish.state !== 'working'))
    .slice(0, ENDED_SHOWN);
}

// A v2 wish's words: a local branch is never "Done", since nothing was published.
const STATE_WORDS = {
  'local-only': { short: 'Local branch', full: 'Local branch, not published' },
  'no-change': { short: 'No change', full: 'No change: no branch moved' },
  stopped: { short: 'Stopped', full: 'Stopped' },
  lost: { short: 'Lost', full: 'Lost: the team no longer has its record' },
};

/** The sign in a row: ✓ only for a v1 wish the team called done, • for a local branch or no change. */
export const markOf = (outcome) =>
  outcome.state === 'done' ? '✓' : outcome.state === 'local-only' || outcome.state === 'no-change' ? '•' : '✕';

/**
 * How an ended wish turned out: `short` fits its row, `full` names a failure's reason
 * (the first line of the error the team kept as the task's summary).
 */
export function outcomeOf(wish) {
  const state = wish.state ?? wish.status;
  if (state === 'failed') {
    const reason = String(wish.summary ?? '')
      .split('\n')[0]
      .trim();
    return { state: 'failed', short: 'Failed', full: reason ? `Failed: ${reason}` : 'Failed' };
  }
  if (wish.state !== undefined) {
    const words = STATE_WORDS[wish.state] ?? { short: 'Ended', full: 'Ended' };
    return { state: wish.state, ...words };
  }
  if (state === 'stopped') return { state: 'stopped', short: 'Stopped', full: 'Stopped' };
  return { state: 'done', short: 'Done', full: 'Done' };
}
