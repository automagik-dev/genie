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

// These read bots-dsh's work.stops, which lives in memory only.
// Open and closed stops both count as a wish's history.
export function permissionStopped(work, sessionId) {
  return (
    typeof sessionId === 'string' &&
    Array.isArray(work?.stops) &&
    work.stops.some((entry) => entry?.taskId === sessionId)
  );
}

export const stoppedKeyOf = (work, sessionIds) => sessionIds.filter((id) => permissionStopped(work, id)).join(',');

const PERMISSION_STOP_SUFFIX = '; a step stopped on a permission';
const PERMISSION_STOP_SENTENCE = ' A step stopped on a permission.';

/**
 * How an ended wish turned out: `short` keeps its row's outcome, while `full` names a
 * failure's reason and any permission stop in the tooltip and accessible name.
 * A step's permission stop is history beside the outcome, never why the wish ended.
 */
export function outcomeOf(wish, stopped = false) {
  const base = endedOutcome(wish);
  if (stopped !== true) return base;
  const end = /[.!?]$/.test(base.full) ? PERMISSION_STOP_SENTENCE : PERMISSION_STOP_SUFFIX;
  return { ...base, full: `${base.full}${end}` };
}

function endedOutcome(wish) {
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
