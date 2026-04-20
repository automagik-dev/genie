/**
 * `genie done` — context-dispatched close verb.
 *
 * Two paths:
 *   1. Agent session (GENIE_AGENT_NAME set) + no positional ref →
 *      write terminal state to the current executor via turnClose().
 *   2. Wish group (positional ref like `slug#group`) →
 *      delegate to the existing wish-group-done flow in state.ts.
 *
 * If neither a ref nor GENIE_AGENT_NAME is provided we error loudly —
 * the verb is ambiguous and silently picking one path hides bugs.
 */

import { turnClose } from '../lib/turn-close.js';

interface DoneActionDeps {
  /** Wish-group-done fallback. Injected for tests. */
  wishDone?: (ref: string) => Promise<void>;
  /** Turn-close path. Injected for tests. */
  turnCloseFn?: typeof turnClose;
}

export async function doneAction(ref: string | undefined, deps: DoneActionDeps = {}): Promise<void> {
  const agentName = process.env.GENIE_AGENT_NAME;

  if (!ref && agentName) {
    const fn = deps.turnCloseFn ?? turnClose;
    const result = await fn({ outcome: 'done' });
    if (result.noop) {
      console.log(`ℹ️  Executor ${result.executorId} already closed — no-op.`);
    } else {
      console.log(`✅ Turn closed: outcome=done, executor=${result.executorId}`);
    }
    return;
  }

  if (ref) {
    const fallback =
      deps.wishDone ??
      (async (r: string) => {
        const { doneCommand } = await import('./state.js');
        await doneCommand(r);
      });
    await fallback(ref);
    return;
  }

  console.error(
    '❌ genie done requires either a <slug>#<group> ref (team-lead) or GENIE_AGENT_NAME (inside agent session).',
  );
  process.exit(2);
}
