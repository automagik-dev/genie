/**
 * Remote Approval Gate — PG-backed human-in-the-loop tool approval.
 *
 * When an agent uses `permissionMode: 'remoteApproval'`, every tool use
 * blocks until a human approves or denies via Omni (WhatsApp), the desktop
 * app, or CLI (`genie approval resolve`).
 *
 * Resolution delivery uses PG LISTEN/NOTIFY with a 5s safety-net poll.
 * Timeout auto-resolves with the configured `defaultAction` (default: deny).
 */

import type { HookCallback, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { getConnection } from '../db.js';
import type { PermissionsConfig } from '../workspace.js';

// ============================================================================
// Omni notification — send approval requests to WhatsApp via Omni CLI
// ============================================================================

/** Recent Omni send timestamps for rate limiting. */
const recentOmniSends: number[] = [];
const BATCH_WINDOW_MS = 10_000;
const BATCH_THRESHOLD = 3;

function pruneRecentSends(): void {
  const cutoff = Date.now() - BATCH_WINDOW_MS;
  while (recentOmniSends.length > 0 && recentOmniSends[0] < cutoff) {
    recentOmniSends.shift();
  }
}

/** Format an approval request as a WhatsApp-friendly message. */
function formatApprovalMessage(approvalId: string, agentName: string, toolName: string, preview: string): string {
  const shortPreview = preview.length > 200 ? `${preview.slice(0, 197)}...` : preview;
  return [
    '\u{1F514} *Approval Required*',
    '',
    `Agent: *${agentName}*`,
    `Tool: \`${toolName}\``,
    `Preview: ${shortPreview}`,
    '',
    'Reply *y* to approve or *n* to deny',
    'Or react \u{1F44D} / \u{1F44E}',
    '',
    `_ID: ${approvalId}_`,
  ].join('\n');
}

function formatBatchMessage(pendingCount: number): string {
  return [
    `\u{1F514} *${pendingCount} Approvals Pending*`,
    '',
    'Multiple tool approvals are queued.',
    'Reply *y* to approve next or *n* to deny.',
    'Use `genie approval list` for details.',
  ].join('\n');
}

/** Store the Omni message ID for reaction matching. Best-effort. */
async function updateOmniMessageId(approvalId: string, omniMessageId: string): Promise<void> {
  try {
    const sql = await getConnection();
    await sql`UPDATE approvals SET omni_message_id = ${omniMessageId} WHERE id = ${approvalId}`;
  } catch {
    /* best-effort — reaction matching degrades to text-only */
  }
}

/**
 * Send approval notification to WhatsApp via Omni CLI. Fire-and-forget.
 *
 * Rate limiting: if >3 approval sends within 10s, sends a batched summary
 * instead of individual messages to avoid flooding the chat.
 */
export async function sendApprovalToOmni(
  approvalId: string,
  agentName: string,
  toolName: string,
  preview: string,
  permissions: PermissionsConfig,
): Promise<void> {
  const { omniChat, omniInstance } = permissions;
  if (!omniChat || !omniInstance) return;

  pruneRecentSends();

  let text: string;
  if (recentOmniSends.length >= BATCH_THRESHOLD) {
    const sql = await getConnection();
    const [row] = await sql`SELECT count(*)::int AS count FROM approvals WHERE decision = 'pending'`;
    text = formatBatchMessage(row.count);
  } else {
    text = formatApprovalMessage(approvalId, agentName, toolName, preview);
  }

  recentOmniSends.push(Date.now());

  try {
    const proc = Bun.spawn(['omni', 'send', '--instance', omniInstance, '--to', omniChat, '--text', text, '--json'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    // Capture message ID for reaction matching
    try {
      const result = JSON.parse(stdout);
      const messageId = result.messageId ?? result.message_id ?? result.id;
      if (messageId) await updateOmniMessageId(approvalId, String(messageId));
    } catch {
      /* JSON parse failed — message sent, ID not captured */
    }
  } catch (err) {
    console.warn(`[remote-approval] Omni notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// Types
// ============================================================================

export interface RemoteApprovalConfig {
  /** Executor ID for the agent session. */
  executorId: string;
  /** Human-readable agent name. */
  agentName: string;
  /** Workspace-level permissions config (tokens, timeout, defaultAction, omni). */
  permissions?: PermissionsConfig;
}

// ============================================================================
// Approval DB Operations
// ============================================================================

/** Insert a pending approval row. Returns the generated approval ID. */
export async function insertApproval(
  executorId: string,
  agentName: string,
  toolName: string,
  toolInputPreview: string,
  timeoutAt: Date,
): Promise<string> {
  const sql = await getConnection();
  const [row] = await sql`
    INSERT INTO approvals (executor_id, agent_name, tool_name, tool_input_preview, timeout_at)
    VALUES (${executorId}, ${agentName}, ${toolName}, ${toolInputPreview}, ${timeoutAt})
    RETURNING id
  `;
  return row.id;
}

/** Resolve a pending approval. Returns true if a row was updated. */
export async function resolveApproval(
  approvalId: string,
  decision: 'allow' | 'deny',
  decidedBy: string,
): Promise<boolean> {
  const sql = await getConnection();
  const result = await sql`
    UPDATE approvals
    SET decision = ${decision}, decided_by = ${decidedBy}, decided_at = now()
    WHERE id = ${approvalId} AND decision = 'pending'
  `;
  return result.count > 0;
}

/** List pending approvals, optionally filtered by agent name. */
export async function listPendingApprovals(agentName?: string) {
  const sql = await getConnection();
  if (agentName) {
    return sql`
      SELECT id, executor_id, agent_name, tool_name, tool_input_preview, timeout_at, created_at
      FROM approvals WHERE decision = 'pending' AND agent_name = ${agentName}
      ORDER BY created_at ASC
    `;
  }
  return sql`
    SELECT id, executor_id, agent_name, tool_name, tool_input_preview, timeout_at, created_at
    FROM approvals WHERE decision = 'pending'
    ORDER BY created_at ASC
  `;
}

// ============================================================================
// Wait for Resolution
// ============================================================================

type Decision = 'allow' | 'deny';

/**
 * Query PG for the current state of an approval.
 * Returns the decision if resolved, or null if still pending.
 * Auto-resolves if the timeout has passed.
 */
async function pollApprovalState(approvalId: string, defaultAction: Decision): Promise<Decision | null> {
  const sql = await getConnection();
  const [approval] = await sql`
    SELECT decision, timeout_at FROM approvals WHERE id = ${approvalId}
  `;
  if (!approval) return 'deny';
  if (approval.decision === 'allow' || approval.decision === 'deny') return approval.decision;
  if (new Date(approval.timeout_at) <= new Date()) {
    await resolveApproval(approvalId, defaultAction, 'timeout');
    return defaultAction;
  }
  return null;
}

/**
 * Wait for an approval to be resolved via LISTEN/NOTIFY + polling safety net.
 * Returns the decision ('allow' or 'deny').
 */
export async function waitForResolution(
  approvalId: string,
  timeoutAt: Date,
  defaultAction: Decision,
): Promise<Decision> {
  const sql = await getConnection();

  return new Promise<Decision>((resolve) => {
    let resolved = false;
    let listener: { unlisten: () => Promise<void> } | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const finish = (decision: Decision) => {
      if (resolved) return;
      resolved = true;
      if (listener) listener.unlisten().catch(() => {});
      if (pollTimer) clearInterval(pollTimer);
      resolve(decision);
    };

    const checkResolution = async () => {
      if (resolved) return;
      try {
        const result = await pollApprovalState(approvalId, defaultAction);
        if (result !== null) finish(result);
      } catch {
        finish('deny');
      }
    };

    // Subscribe to LISTEN channel
    sql
      .listen('genie_approval_resolved', (payload: string) => {
        if (payload === approvalId) checkResolution();
      })
      .then((l: { unlisten: () => Promise<void> }) => {
        listener = l;
        if (resolved) l.unlisten().catch(() => {});
      })
      .catch(() => {
        // LISTEN failed — rely on polling only
      });

    // Safety-net poll every 5s
    pollTimer = setInterval(checkResolution, 5000);

    // Hard timeout failsafe
    const msUntilTimeout = Math.max(0, timeoutAt.getTime() - Date.now() + 1000);
    setTimeout(() => {
      if (!resolved) {
        resolveApproval(approvalId, defaultAction, 'timeout').catch(() => {});
        finish(defaultAction);
      }
    }, msUntilTimeout).unref();

    // Initial check (handles race between insert and listen)
    checkResolution();
  });
}

// ============================================================================
// Hook Factory
// ============================================================================

/**
 * Create a PreToolUse hook that blocks until a human approves or denies.
 *
 * Inserts an approval row into PG, subscribes to LISTEN/NOTIFY for
 * resolution, and polls every 5s as a safety net. Returns the human's
 * decision as `permissionDecision: 'allow' | 'deny'`.
 */
export function createRemoteApprovalGate(config: RemoteApprovalConfig): HookCallback {
  const timeoutSec = config.permissions?.timeout ?? 300;
  const defaultAction = config.permissions?.defaultAction ?? 'deny';

  return async (input): Promise<SyncHookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const toolName = hookInput.tool_name;
    const toolInput = hookInput.tool_input ?? {};

    // Generate truncated preview for display
    const preview = JSON.stringify(toolInput).slice(0, 500);
    const timeoutAt = new Date(Date.now() + timeoutSec * 1000);

    // Insert pending approval
    const approvalId = await insertApproval(config.executorId, config.agentName, toolName, preview, timeoutAt);

    // Fire-and-forget Omni notification (WhatsApp)
    if (config.permissions?.omniChat && config.permissions?.omniInstance) {
      sendApprovalToOmni(approvalId, config.agentName, toolName, preview, config.permissions).catch(() => {});
    }

    // Block until resolved
    const decision = await waitForResolution(approvalId, timeoutAt, defaultAction);

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
      },
    };
  };
}
