// Which of a Genie's wishes its row lists: the ended ones, newest first, with the team's
// task status (a running wish is already one of the team's task threads).
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
    .filter((wish) => wish.status !== 'working')
    .slice(0, ENDED_SHOWN);
}

/**
 * How an ended wish turned out: `short` fits its row, `full` names a failure's reason
 * (the first line of the error the team kept as the task's summary).
 */
export function outcomeOf(wish) {
  if (wish.status === 'failed') {
    const reason = String(wish.summary ?? '')
      .split('\n')[0]
      .trim();
    return { state: 'failed', short: 'Failed', full: reason ? `Failed: ${reason}` : 'Failed' };
  }
  if (wish.status === 'stopped') return { state: 'stopped', short: 'Stopped', full: 'Stopped' };
  return { state: 'done', short: 'Done', full: 'Done' };
}
