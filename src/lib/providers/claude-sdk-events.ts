/**
 * SDKMessage → Genie Events Router
 *
 * Maps all 24 SDKMessage types to structured genie audit events.
 * Fire-and-forget: routing never blocks the message stream.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { recordAuditEvent } from '../audit.js';

// ============================================================================
// Event Type Mapping
// ============================================================================

/** Map system subtypes to event types. */
const SYSTEM_SUBTYPE_MAP: Record<string, string> = {
  init: 'sdk.system',
  api_retry: 'sdk.api.retry',
  compact_boundary: 'sdk.context.compacted',
  elicitation_complete: 'sdk.elicitation.complete',
  files_persisted: 'sdk.files.persisted',
  hook_progress: 'sdk.hook.progress',
  hook_response: 'sdk.hook.response',
  hook_started: 'sdk.hook.started',
  local_command_output: 'sdk.command.output',
  session_state_changed: 'sdk.session.state',
  status: 'sdk.status',
  task_notification: 'sdk.task.notification',
  task_progress: 'sdk.task.progress',
  task_started: 'sdk.task.started',
};

/** Map result subtypes to event types. */
const RESULT_SUBTYPE_MAP: Record<string, string> = {
  success: 'sdk.result.success',
  error_max_turns: 'sdk.result.max_turns',
  error_max_budget_usd: 'sdk.result.max_budget',
};

/** Map top-level types to event types (for non-system, non-result types). */
const TOP_LEVEL_MAP: Record<string, string> = {
  assistant: 'sdk.assistant.message',
  stream_event: 'sdk.stream.partial',
  tool_progress: 'sdk.tool.progress',
  tool_use_summary: 'sdk.tool.summary',
  rate_limit_event: 'sdk.rate_limit',
  auth_status: 'sdk.auth.status',
  prompt_suggestion: 'sdk.prompt.suggestion',
  user: 'sdk.user.message',
};

/**
 * Derive the genie event type from an SDKMessage.
 *
 * Pure function — no side effects, safe for testing.
 * Returns null for unknown/unmapped message shapes.
 */
export function getEventType(msg: SDKMessage): string | null {
  if (msg.type === 'result') {
    const sub = (msg as { subtype?: string }).subtype ?? '';
    return RESULT_SUBTYPE_MAP[sub] ?? 'sdk.result.error';
  }

  if (msg.type === 'system') {
    const sub = (msg as { subtype?: string }).subtype ?? '';
    return SYSTEM_SUBTYPE_MAP[sub] ?? null;
  }

  return TOP_LEVEL_MAP[msg.type] ?? null;
}

// ============================================================================
// Detail Extraction — per-category helpers
// ============================================================================

function truncate(s: string, max = 200): string {
  return s.slice(0, max);
}

function assistantDetails(msg: SDKMessage & { type: 'assistant' }): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const content = msg.message?.content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined;
    if (textBlock?.text) details.textPreview = truncate(textBlock.text);

    // Extract tool_use blocks — name + input summary
    const toolBlocks = content.filter((b: { type: string }) => b.type === 'tool_use') as Array<{
      name?: string;
      input?: Record<string, unknown>;
    }>;
    if (toolBlocks.length > 0) {
      details.toolCalls = toolBlocks.map((t) => {
        const call: Record<string, unknown> = { name: t.name };
        // For Bash, include the command
        if (t.name === 'Bash' && t.input && typeof t.input.command === 'string') {
          call.command = truncate(t.input.command as string, 150);
        }
        if (t.name === 'Read' && t.input && typeof t.input.file_path === 'string') {
          call.path = t.input.file_path;
        }
        return call;
      });
    }
  }
  if (msg.error) details.error = msg.error;
  if (msg.parent_tool_use_id) details.parentToolUseId = msg.parent_tool_use_id;
  return details;
}

function resultDetails(msg: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = {
    subtype: msg.subtype,
    isError: msg.is_error,
    durationMs: msg.duration_ms,
    durationApiMs: msg.duration_api_ms,
    numTurns: msg.num_turns,
    totalCostUsd: msg.total_cost_usd,
  };
  // SDK 0.2.91+ result messages carry `terminal_reason` documenting why
  // the query loop ended (`completed`, `aborted_tools`, `max_turns`,
  // `blocking_limit`, etc.). Surface it so downstream observability sees
  // the actual termination cause instead of a generic 'success'/'error'.
  if (msg.terminal_reason !== undefined) {
    details.terminalReason = msg.terminal_reason;
  }
  if (msg.usage) details.usage = msg.usage;
  if (msg.subtype === 'success' && typeof msg.result === 'string') {
    details.resultPreview = truncate(msg.result as string);
  }
  if (Array.isArray(msg.errors) && (msg.errors as string[]).length > 0) {
    details.errors = msg.errors;
  }
  return details;
}

function systemDetails(msg: Record<string, unknown>): Record<string, unknown> {
  const details: Record<string, unknown> = { subtype: msg.subtype };
  const subtype = msg.subtype as string;

  const handlers: Record<string, () => void> = {
    init: () => {
      details.model = msg.model;
      details.cwd = msg.cwd;
      details.version = msg.claude_code_version;
      details.tools = Array.isArray(msg.tools) ? (msg.tools as string[]).length : 0;
      if (msg.session_id) details.sessionId = msg.session_id;
    },
    api_retry: () => {
      details.attempt = msg.attempt;
      details.maxRetries = msg.max_retries;
      details.retryDelayMs = msg.retry_delay_ms;
      details.errorStatus = msg.error_status;
      details.error = msg.error;
    },
    compact_boundary: () => {
      const meta = msg.compact_metadata as Record<string, unknown> | undefined;
      if (meta) {
        details.trigger = meta.trigger;
        details.preTokens = meta.pre_tokens;
      }
    },
    hook_started: () => assignHookDetails(msg, details),
    hook_progress: () => assignHookDetails(msg, details),
    hook_response: () => {
      assignHookDetails(msg, details);
      details.outcome = msg.outcome;
      details.exitCode = msg.exit_code;
    },
    task_notification: () => {
      details.taskId = msg.task_id;
      details.status = msg.status;
      details.summary = typeof msg.summary === 'string' ? truncate(msg.summary as string) : undefined;
      if (msg.usage) details.usage = msg.usage;
    },
    task_started: () => {
      details.taskId = msg.task_id;
      details.description = typeof msg.description === 'string' ? truncate(msg.description as string) : undefined;
      details.taskType = msg.task_type;
    },
    task_progress: () => {
      details.taskId = msg.task_id;
      details.description = typeof msg.description === 'string' ? truncate(msg.description as string) : undefined;
      details.lastToolName = msg.last_tool_name;
      if (msg.usage) details.usage = msg.usage;
    },
    session_state_changed: () => {
      details.state = msg.state;
    },
    status: () => {
      details.status = msg.status;
    },
    files_persisted: () => {
      const files = msg.files as { filename: string }[] | undefined;
      details.fileCount = Array.isArray(files) ? files.length : 0;
      const failed = msg.failed as { filename: string }[] | undefined;
      details.failedCount = Array.isArray(failed) ? failed.length : 0;
    },
    elicitation_complete: () => {
      details.mcpServerName = msg.mcp_server_name;
      details.elicitationId = msg.elicitation_id;
    },
    local_command_output: () => {
      details.contentPreview = typeof msg.content === 'string' ? truncate(msg.content as string) : undefined;
    },
  };

  handlers[subtype]?.();
  return details;
}

function assignHookDetails(msg: Record<string, unknown>, details: Record<string, unknown>): void {
  details.hookId = msg.hook_id;
  details.hookName = msg.hook_name;
  details.hookEvent = msg.hook_event;
}

// ============================================================================
// Detail Extraction — public entry point
// ============================================================================

/**
 * Build a lean details payload from an SDKMessage.
 *
 * Extracts only the fields useful for auditing — never the full message body.
 */
export function buildEventDetails(msg: SDKMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { sdkType: msg.type };

  const extra = DETAIL_BUILDERS[msg.type]?.(msg) ?? {};
  return { ...base, ...extra };
}

// biome-ignore lint/suspicious/noExplicitAny: SDK message types vary by event type
type DetailBuilder = (msg: any) => Record<string, unknown>;

const DETAIL_BUILDERS: Record<string, DetailBuilder> = {
  assistant: (msg) => assistantDetails(msg),
  result: (msg) => resultDetails(msg),
  system: (msg) => systemDetails(msg),
  stream_event: (msg) => (msg.parent_tool_use_id ? { parentToolUseId: msg.parent_tool_use_id } : {}),
  tool_progress: (msg) => {
    const d: Record<string, unknown> = {
      toolName: msg.tool_name,
      toolUseId: msg.tool_use_id,
      elapsedSeconds: msg.elapsed_time_seconds,
    };
    if (msg.task_id) d.taskId = msg.task_id;
    return d;
  },
  tool_use_summary: (msg) => ({
    summaryPreview: truncate(msg.summary),
    toolUseIds: msg.preceding_tool_use_ids,
  }),
  rate_limit_event: (msg) => {
    const d: Record<string, unknown> = { status: msg.rate_limit_info.status };
    if (msg.rate_limit_info.resetsAt) d.resetsAt = msg.rate_limit_info.resetsAt;
    if (msg.rate_limit_info.utilization != null) d.utilization = msg.rate_limit_info.utilization;
    return d;
  },
  auth_status: (msg) => {
    const d: Record<string, unknown> = { isAuthenticating: msg.isAuthenticating };
    if (msg.error) d.error = msg.error;
    return d;
  },
  prompt_suggestion: (msg) => ({ suggestion: truncate(msg.suggestion) }),
  user: (msg) => {
    const d: Record<string, unknown> = {
      isReplay: msg.isReplay === true,
      isSynthetic: msg.isSynthetic === true,
    };
    if (msg.parent_tool_use_id) d.parentToolUseId = msg.parent_tool_use_id;
    // Extract text content — user messages can be string or array of content blocks
    const content = msg.message?.content;
    if (typeof content === 'string') {
      d.textPreview = truncate(content);
    } else if (Array.isArray(content)) {
      const textBlock = content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined;
      if (textBlock?.text) d.textPreview = truncate(textBlock.text);
    }
    return d;
  },
};

// ============================================================================
// Router
// ============================================================================

/**
 * Route an SDKMessage to a genie audit event.
 *
 * Returns the event type string on success, or null if the message
 * type is unmapped. The audit write is best-effort (never throws).
 */
export async function routeSdkMessage(msg: SDKMessage, executorId: string, agentId: string): Promise<string | null> {
  const eventType = getEventType(msg);
  if (!eventType) return null;

  // Skip stream partials — high volume noise with no audit value
  if (eventType === 'sdk.stream.partial') return eventType;

  const details = buildEventDetails(msg);
  details.executorId = executorId;

  await recordAuditEvent('sdk_message', executorId, eventType, agentId, details);

  return eventType;
}
