// Which of a Genie's wishes its row lists: the ended ones, newest first, with the team's
// task status (a running wish is already one of the team's task threads).
export const ENDED_SHOWN = 3;

/** The ended wishes of one Genie, newest first, with the team's task status. */
export function endedWishesOf(roster, botId) {
  const tasks = roster?.tasks ?? {};
  return (roster?.genie?.wishes ?? [])
    .filter((wish) => wish.botId === botId)
    .map((wish) => ({ ...wish, status: tasks[wish.sessionId]?.status ?? 'ended' }))
    .filter((wish) => wish.status !== 'working')
    .slice(0, ENDED_SHOWN);
}
