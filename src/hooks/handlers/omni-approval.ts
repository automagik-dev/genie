/**
 * Omni Approval Handler — PreToolUse gate for remote human-in-the-loop approval.
 *
 * When Omni approvals are enabled, a gated tool call enqueues a `pending` row in
 * the GLOBAL genie.db and BLOCKS (polling that row) until the `omni serve`
 * runner resolves it from the phone — then returns the CC PreToolUse envelope:
 *
 *   approved → permissionDecision: 'allow'
 *   denied   → permissionDecision: 'deny'  (+ reason, shown to the model)
 *   timeout  → permissionDecision: 'ask'   (fail-safe; NEVER auto-allow)
 *
 * The `ask` fallback is the SPIKE-verified fail-safe: on self-timeout we expire
 * the row (so the phone stops trying) and emit `ask`, which forces the local
 * prompt interactively and refuses headless — the tool is never silently run.
 *
 * This handler is the ONLY approval touch-point that runs inside the hook fork;
 * it speaks to NATS through nobody — it just writes/reads the DB. The runner
 * owns the transport. That keeps the hot path free of any network client.
 *
 * Registered ONLY when `isOmniApprovalEnabled` (config-gated at dispatch boot).
 * As a belt-and-suspenders guard it re-checks the config and no-ops if a stale
 * registry ever carries it while the feature is off.
 */

import type { Database } from 'bun:sqlite';
import { type OmniRuntimeConfig, isOmniApprovalEnabled, resolveOmniRuntimeConfig } from '../../lib/omni-config.js';
import { openGlobalDb } from '../../lib/v5/global-db.js';
import { enqueueApproval, getApproval } from '../../lib/v5/omni-queue.js';
import type { HandlerResult, HookPayload } from '../types.js';

export interface OmniApprovalDeps {
  /** Open the global DB. Tests inject a shared in-memory handle. */
  openDb?: () => Database;
  /** Resolve runtime config. Tests inject a fixed config. */
  loadConfig?: () => Promise<OmniRuntimeConfig>;
  /** Injectable poll sleep — tests use this hook to resolve the row mid-wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock. */
  now?: () => number;
}

const INPUT_SUMMARY_CAP = 500;

function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const json = JSON.stringify(input);
  return json.length > INPUT_SUMMARY_CAP ? `${json.slice(0, INPUT_SUMMARY_CAP - 3)}...` : json;
}

function allow(): HandlerResult {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
}

function deny(reason: string): HandlerResult {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

function ask(reason: string): HandlerResult {
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  };
}

/**
 * Expire this handler's own pending row on self-timeout. Targeted, idempotent
 * `pending → expired` transition. omni-queue.ts (a committed Wave-1 module) has
 * no single-row expire and is out of this group's edit scope, so the one-line
 * UPDATE lives here rather than reaching for the age-based `expireStale`, which
 * would wrongly sweep other agents' fresh pending rows.
 */
function expireOwnRow(db: Database, id: string, nowMs: number): void {
  db.query("UPDATE approvals SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'").run(
    nowMs,
    id,
  );
}

/**
 * Poll the enqueued row until it resolves or the budget expires. On self-timeout
 * it expires its own row and returns `ask` (the fail-safe). Extracted from the
 * handler so the outer function stays a linear guard/enqueue/return flow.
 */
async function pollForResolution(
  db: Database,
  id: string,
  budgetMs: number,
  intervalMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<HandlerResult> {
  const deadline = now() + budgetMs;
  while (now() < deadline) {
    const row = getApproval(db, id);
    if (!row || row.status === 'expired') break; // externally expired → ask
    if (row.status === 'approved') return allow();
    if (row.status === 'denied') {
      return deny(`Denied via remote approval${row.resolvedBy ? ` by ${row.resolvedBy}` : ''}`);
    }
    await sleep(intervalMs);
  }
  // Self-timeout — expire the row and fall through to the local prompt.
  expireOwnRow(db, id, now());
  return ask('Remote approval timed out — falling back to local prompt');
}

export async function omniApproval(payload: HookPayload, deps: OmniApprovalDeps = {}): Promise<HandlerResult> {
  // No approval needed when CC won't prompt anyway. Cheap guard per the SPIKE.
  const mode = payload.permission_mode;
  if (mode === 'auto' || mode === 'bypassPermissions') return undefined;

  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  try {
    const rt = await (deps.loadConfig ?? resolveOmniRuntimeConfig)();
    // Safety net — registry gating should already ensure this, but never gate a
    // tool call against a phone the config says isn't wired.
    if (!isOmniApprovalEnabled(rt)) return undefined;

    const ownsDb = !deps.openDb;
    const db = (deps.openDb ?? openGlobalDb)();
    try {
      const id = enqueueApproval(db, {
        repo: payload.cwd ?? 'unknown',
        tool: payload.tool_name ?? 'unknown',
        inputSummary: summarizeInput(payload.tool_input),
        sessionHint: payload.session_id ?? null,
        requestedBy: process.env.GENIE_AGENT_NAME ?? null,
        now: now(),
      });
      return await pollForResolution(db, id, rt.approvals.pollBudgetMs, rt.approvals.pollIntervalMs, now, sleep);
    } finally {
      if (ownsDb) db.close();
    }
  } catch (err) {
    // Fail-safe: never hard-deny (an infra hiccup shouldn't wedge the agent) and
    // never auto-allow — force the local prompt.
    process.stderr.write(
      `[omni-approval] error, falling back to ask: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ask('Remote approval unavailable — falling back to local prompt');
  }
}
