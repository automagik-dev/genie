/**
 * Omni Approval Handler — remote human-in-the-loop approval policy.
 *
 * When Omni approvals are enabled, a gated tool call enqueues a `pending` row in
 * the GLOBAL genie.db and BLOCKS (polling that row) until the `omni serve`
 * runner resolves it from the phone — then returns the provider-neutral
 * allow/deny/ask decision consumed by the runtime-specific dispatcher:
 *
 *   approved → permissionDecision: 'allow'
 *   denied   → permissionDecision: 'deny'  (+ reason, shown to the model)
 *   timeout  → permissionDecision: 'ask'   (fail-safe; NEVER auto-allow)
 *
 * On Claude PreToolUse, `ask` retains the native local-prompt fallback. On
 * Codex PermissionRequest, the dispatcher converts `ask` to a documented deny
 * because Codex PreToolUse does not support ask and infrastructure failure must
 * not silently allow the operation.
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
import {
  MAX_APPROVAL_POLL_BUDGET_MS,
  type OmniRuntimeConfig,
  isOmniApprovalEnabled,
  resolveOmniRuntimeConfig,
} from '../../lib/omni-config.js';
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
  /** Register cleanup for process interruption; tests capture and invoke it. */
  registerInterruptCleanup?: (cleanup: () => void) => () => void;
}

const INPUT_SUMMARY_CAP = 500;
const SUMMARY_PATH_CAP = 10;
const SUMMARY_PATH_CHARS = 240;
const PATCH_PATH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
const PATCH_MOVE_HEADER = /^\*\*\* Move to: (.+)$/gm;

function redactString(value: string): string {
  return value
    .replace(
      /(\b(?:proxy-authorization|authorization|set-cookie|cookie)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^"'\r\n]*)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY(?:_ID)?)[A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    )
    .replace(
      /((?:--)?(?:password|passwd|secret|token|api[-_]?key)\s*(?:=|:)\s*|--(?:password|passwd|secret|token|api[-_]?key)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[REDACTED]',
    );
}

function boundedPaths(values: unknown[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue;
      const safe = redactString(candidate).slice(0, SUMMARY_PATH_CHARS);
      if (!safe || seen.has(safe)) continue;
      seen.add(safe);
      paths.push(safe);
      if (paths.length >= SUMMARY_PATH_CAP) return paths;
    }
  }
  return paths;
}

function patchPaths(command: string): string[] {
  const values: string[] = [];
  for (const pattern of [PATCH_PATH_HEADER, PATCH_MOVE_HEADER]) {
    pattern.lastIndex = 0;
    for (const match of command.matchAll(pattern)) values.push(match[1] ?? '');
  }
  return boundedPaths(values);
}

/**
 * Build an allowlisted, tool-shaped preview. File-content and arbitrary object
 * values never cross the approval boundary: Bash gets only its sanitized
 * command, edit tools get bounded paths, and unknown tools disclose only that
 * input fields exist. This is deliberately not a generic JSON serializer.
 */
function summarizeInput(tool: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  let summary: Record<string, unknown>;
  if (tool === 'Bash') {
    summary = {
      kind: 'Bash',
      command: typeof input.command === 'string' ? redactString(input.command) : '[invalid command]',
    };
  } else if (tool === 'apply_patch') {
    const command = typeof input.command === 'string' ? input.command : '';
    summary = { kind: 'apply_patch', paths: patchPaths(command) };
  } else if (tool === 'Write' || tool === 'Edit') {
    summary = { kind: tool, paths: boundedPaths([input.file_path, input.file_paths, input.path]) };
  } else if (tool === 'NotebookEdit') {
    summary = {
      kind: 'NotebookEdit',
      paths: boundedPaths([input.notebook_path, input.file_path, input.path]),
      cellId: typeof input.cell_id === 'string' ? redactString(input.cell_id).slice(0, 80) : undefined,
    };
  } else {
    summary = { kind: 'other', inputFieldCount: Object.keys(input).length };
  }

  const json = JSON.stringify(summary);
  const encoded = Buffer.from(json, 'utf8');
  if (encoded.byteLength <= INPUT_SUMMARY_CAP) return json;
  const prefix = encoded
    .subarray(0, INPUT_SUMMARY_CAP - 3)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
  return `${prefix}...`;
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

function registerProcessInterruptCleanup(cleanup: () => void): () => void {
  const signals = ['SIGINT', 'SIGTERM'] as const;
  const listeners = signals.map((signal) => {
    const listener = () => {
      try {
        cleanup();
      } finally {
        process.off(signal, listener);
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exitCode = 1;
        }
      }
    };
    process.once(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) process.off(signal, listener);
  };
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
  const safeBudget = Number.isFinite(budgetMs)
    ? Math.min(Math.max(0, Math.floor(budgetMs)), MAX_APPROVAL_POLL_BUDGET_MS)
    : 0;
  const safeInterval = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.floor(intervalMs) : 1;
  const deadline = now() + safeBudget;
  while (now() < deadline) {
    const row = getApproval(db, id);
    if (!row || row.status === 'expired') break; // externally expired → ask
    if (row.status === 'approved') return allow();
    if (row.status === 'denied') {
      return deny(`Denied via remote approval${row.resolvedBy ? ` by ${row.resolvedBy}` : ''}`);
    }
    await sleep(Math.min(safeInterval, Math.max(1, deadline - now())));
  }
  // Self-timeout — expire the row and fall through to the local prompt.
  expireOwnRow(db, id, now());
  return ask('Remote approval timed out — falling back to local prompt');
}

export async function omniApproval(payload: HookPayload, deps: OmniApprovalDeps = {}): Promise<HandlerResult> {
  // No approval needed when the host cannot prompt anyway. Cheap guard per the SPIKE.
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
        inputSummary: summarizeInput(payload.tool_name ?? 'unknown', payload.tool_input),
        sessionHint: payload.session_id ?? null,
        requestedBy: process.env.GENIE_AGENT_NAME ?? null,
        now: now(),
      });
      const unregisterInterrupt = (deps.registerInterruptCleanup ?? registerProcessInterruptCleanup)(() =>
        expireOwnRow(db, id, now()),
      );
      try {
        return await pollForResolution(db, id, rt.approvals.pollBudgetMs, rt.approvals.pollIntervalMs, now, sleep);
      } finally {
        unregisterInterrupt();
        // Handler errors and external cancellation must not strand a request.
        // The guarded UPDATE is a no-op for approved/denied/expired rows.
        expireOwnRow(db, id, now());
      }
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
