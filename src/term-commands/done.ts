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
 *
 * Group 6 of invincible-genie wish:
 * Permanent agents (team-leads, dir-row placeholders, root identities) have
 * no task lifecycle — calling `genie done` against them flips the identity
 * row to `state='done'` and breaks the boot-pass invariant. The check is
 * database-level (reads `agents.kind` from the GENERATED column added by
 * migration 049, not by convention) and rejects with a typed error and
 * exit code 4.
 */

import { getConnection } from '../lib/db.js';
import { turnClose } from '../lib/turn-close.js';

/**
 * Thrown when `genie done` is invoked from a permanent agent's executor.
 * Permanent identities (team-leads, dir:* placeholders, root agents) have
 * no task lifecycle to close. The CLI maps this to exit code 4.
 */
export class PermanentAgentDoneRejected extends Error {
  readonly agentId: string;
  readonly reason: string;

  constructor(opts: { agentId: string; reason?: string }) {
    super(
      `Permanent agent "${opts.agentId}" cannot call \`genie done\`. Permanent identities (team-leads, dir-row placeholders, root agents) do not have task lifecycles. Use \`genie agent stop ${opts.agentId}\` to halt the executor without marking the identity as done.`,
    );
    this.name = 'PermanentAgentDoneRejected';
    this.agentId = opts.agentId;
    this.reason = opts.reason ?? 'permanent_agents_never_call_done';
  }
}

/**
 * Lookup result for the calling agent's identity + permanence label.
 *
 * Returns null when the executor cannot be resolved (env unset, ghost row),
 * which means we cannot prove permanence and must fall through to the
 * existing turnClose error path.
 */
export interface CallingAgentLookup {
  id: string;
  kind: 'permanent' | 'task' | null;
}

interface DoneActionDeps {
  /** Wish-group-done fallback. Injected for tests. */
  wishDone?: (ref: string) => Promise<void>;
  /** Turn-close path. Injected for tests. */
  turnCloseFn?: typeof turnClose;
  /** Lookup the calling agent's id + kind. Injected for tests. */
  lookupCallingAgent?: () => Promise<CallingAgentLookup | null>;
}

/**
 * Default lookup: resolve the calling agent's id + kind via GENIE_EXECUTOR_ID.
 *
 * Joins `executors → agents` so we read `agents.kind` directly from the
 * GENERATED column (migration 049). Returns null when:
 *   - GENIE_EXECUTOR_ID is unset (caller is not in an executor context)
 *   - The executor row is gone (pgserve reset, ghost row); turnClose has
 *     its own ghost-recovery path so this is not our problem to flag here.
 *
 * We deliberately do NOT fall back to GENIE_AGENT_NAME-by-name lookup: that
 * lookup ambiguously matches when two teams own agents with the same custom
 * name, and the rejection check needs a single deterministic answer. If the
 * executor id is unknown, downstream turnClose fails loudly with a better
 * diagnostic than this check could produce.
 */
async function defaultLookupCallingAgent(): Promise<CallingAgentLookup | null> {
  const executorId = process.env.GENIE_EXECUTOR_ID;
  if (!executorId) return null;
  const sql = await getConnection();
  const rows = await sql<{ id: string; kind: 'permanent' | 'task' | null }[]>`
    SELECT a.id, a.kind
    FROM agents a
    JOIN executors e ON e.agent_id = a.id
    WHERE e.id = ${executorId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function rejectIfPermanent(deps: DoneActionDeps): Promise<void> {
  const lookup = deps.lookupCallingAgent ?? defaultLookupCallingAgent;
  const result = await lookup();
  if (result?.kind === 'permanent') {
    throw new PermanentAgentDoneRejected({ agentId: result.id });
  }
}

async function runAgentSessionPath(deps: DoneActionDeps): Promise<void> {
  await rejectIfPermanent(deps);
  const fn = deps.turnCloseFn ?? turnClose;
  const result = await fn({ outcome: 'done' });
  if (result.noop) {
    console.log(`ℹ️  Executor ${result.executorId} already closed — no-op.`);
  } else {
    console.log(`✅ Turn closed: outcome=done, executor=${result.executorId}`);
  }
}

export async function doneAction(ref: string | undefined, deps: DoneActionDeps = {}): Promise<void> {
  const agentName = process.env.GENIE_AGENT_NAME;

  try {
    if (!ref && agentName) {
      await runAgentSessionPath(deps);
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
  } catch (err) {
    if (err instanceof PermanentAgentDoneRejected) {
      console.error(`❌ ${err.message}`);
      process.exit(4);
    }
    throw err;
  }
}
