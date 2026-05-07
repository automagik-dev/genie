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
  wishDone?: (ref: string, report: string) => Promise<void>;
  /** Turn-close path. Injected for tests. */
  turnCloseFn?: typeof turnClose;
  /** Lookup the calling agent's id + kind. Injected for tests. */
  lookupCallingAgent?: () => Promise<CallingAgentLookup | null>;
}

/** User-facing nudge when --report is missing. Mandatory so every close
 * leaves a full handoff trail in events + mailbox notifications, instead
 * of the silent "agent vanished" mystery. The report is the orchestrator's
 * primary view into what happened — make it count. */
const REPORT_MISSING_HINT = [
  '❌ genie done requires --report "<session handoff>".',
  '',
  '   This is your handoff to the orchestrator. It lands in the audit trail and the',
  '   wave/wish-complete notification, and is the ONLY summary anyone reading later',
  '   will see without replaying your transcript. Write it like you are briefing the',
  '   next person on call.',
  '',
  '   Cover:',
  '     • What you attempted (the actual goal of this turn / group)',
  '     • What shipped — files changed, PRs opened, migrations run, services touched',
  '     • What is verified vs unverified (tests passed? smoke run? CI green?)',
  '     • What is left, blocked, or deferred — and why',
  '     • Surprises or decisions a future agent needs to know (data losses, infra',
  '       quirks, hooks fired, anything non-obvious)',
  '',
  '   Length: as long as it needs to be. A one-liner is almost never enough.',
  '   Multi-line is fine — pass via heredoc or a file:',
  "     genie done --report \"$(cat <<'EOF'",
  '       Goal: wire dev-local auth bridge for hv tenant.',
  '       Shipped: PR #143 (fixtures), PR #144 (smoke). Both green on CI.',
  "       Verified: 'make smoke' passed locally; tenant-A login round-trip OK.",
  '       Left: CSRF rotation deferred to followup (issue #1245).',
  '       Notes: had to bump core@1.260507.5 — desktop shell rebuild required.',
  '     EOF',
  '     )"',
].join('\n');

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

async function runAgentSessionPath(deps: DoneActionDeps, report: string): Promise<void> {
  await rejectIfPermanent(deps);
  const fn = deps.turnCloseFn ?? turnClose;
  const result = await fn({ outcome: 'done', reason: report });
  if (result.noop) {
    console.log(`ℹ️  Executor ${result.executorId} already closed — no-op.`);
  } else {
    console.log(`✅ Turn closed: outcome=done, executor=${result.executorId}`);
    console.log('--- Handoff ---');
    console.log(report.trimEnd());
    console.log('--- End handoff ---');
  }
}

export async function doneAction(
  ref: string | undefined,
  options: { report?: string },
  deps: DoneActionDeps = {},
): Promise<void> {
  const agentName = process.env.GENIE_AGENT_NAME;
  const report = options.report?.trim();

  if (!report) {
    console.error(REPORT_MISSING_HINT);
    process.exit(2);
  }

  try {
    if (!ref && agentName) {
      await runAgentSessionPath(deps, report);
      return;
    }

    if (ref) {
      const fallback =
        deps.wishDone ??
        (async (r: string, rpt: string) => {
          const { doneCommand } = await import('./state.js');
          await doneCommand(r, rpt);
        });
      await fallback(ref, report);
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
