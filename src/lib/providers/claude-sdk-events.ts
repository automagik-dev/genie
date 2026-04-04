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

/**
 * Derive the genie event type from an SDKMessage.
 *
 * Pure function — no side effects, safe for testing.
 * Returns null for unknown/unmapped message shapes.
 */
export function getEventType(msg: SDKMessage): string | null {
  switch (msg.type) {
    case 'assistant':
      return 'sdk.assistant.message';

    case 'result': {
      const sub = (msg as { subtype?: string }).subtype;
      if (sub === 'success') return 'sdk.result.success';
      if (sub === 'error_max_turns') return 'sdk.result.max_turns';
      if (sub === 'error_max_budget_usd') return 'sdk.result.max_budget';
      // error_during_execution, error_max_structured_output_retries → generic error
      return 'sdk.result.error';
    }

    case 'system': {
      const sub = (msg as { subtype?: string }).subtype;
      switch (sub) {
        case 'init':
          return 'sdk.system';
        case 'api_retry':
          return 'sdk.api.retry';
        case 'compact_boundary':
          return 'sdk.context.compacted';
        case 'elicitation_complete':
          return 'sdk.elicitation.complete';
        case 'files_persisted':
          return 'sdk.files.persisted';
        case 'hook_progress':
          return 'sdk.hook.progress';
        case 'hook_response':
          return 'sdk.hook.response';
        case 'hook_started':
          return 'sdk.hook.started';
        case 'local_command_output':
          return 'sdk.command.output';
        case 'session_state_changed':
          return 'sdk.session.state';
        case 'status':
          return 'sdk.status';
        case 'task_notification':
          return 'sdk.task.notification';
        case 'task_progress':
          return 'sdk.task.progress';
        case 'task_started':
          return 'sdk.task.started';
        default:
          return null;
      }
    }

    case 'stream_event':
      return 'sdk.stream.partial';

    case 'tool_progress':
      return 'sdk.tool.progress';

    case 'tool_use_summary':
      return 'sdk.tool.summary';

    case 'rate_limit_event':
      return 'sdk.rate_limit';

    case 'auth_status':
      return 'sdk.auth.status';

    case 'prompt_suggestion':
      return 'sdk.prompt.suggestion';

    case 'user':
      return 'sdk.user.message';

    default:
      return null;
  }
}

// ============================================================================
// Detail Extraction
// ============================================================================

/**
 * Build a lean details payload from an SDKMessage.
 *
 * Extracts only the fields useful for auditing — never the full message body.
 */
export function buildEventDetails(msg: SDKMessage): Record<string, unknown> {
  const base: Record<string, unknown> = { sdkType: msg.type };

  switch (msg.type) {
    case 'assistant': {
      // Extract text preview from the first text content block
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        const textBlock = content.find((b: { type: string }) => b.type === 'text') as { text?: string } | undefined;
        if (textBlock?.text) {
          base.textPreview = textBlock.text.slice(0, 200);
        }
      }
      if (msg.error) base.error = msg.error;
      if (msg.parent_tool_use_id) base.parentToolUseId = msg.parent_tool_use_id;
      break;
    }

    case 'result': {
      const r = msg as Record<string, unknown>;
      base.subtype = r.subtype;
      base.isError = r.is_error;
      base.durationMs = r.duration_ms;
      base.durationApiMs = r.duration_api_ms;
      base.numTurns = r.num_turns;
      base.totalCostUsd = r.total_cost_usd;
      if (r.usage) base.usage = r.usage;
      if (r.subtype === 'success' && typeof r.result === 'string') {
        base.resultPreview = (r.result as string).slice(0, 200);
      }
      if (Array.isArray(r.errors) && (r.errors as string[]).length > 0) {
        base.errors = r.errors;
      }
      break;
    }

    case 'system': {
      const s = msg as Record<string, unknown>;
      base.subtype = s.subtype;
      switch (s.subtype) {
        case 'init':
          base.model = s.model;
          base.cwd = s.cwd;
          base.version = s.claude_code_version;
          base.tools = Array.isArray(s.tools) ? (s.tools as string[]).length : 0;
          break;
        case 'api_retry':
          base.attempt = s.attempt;
          base.maxRetries = s.max_retries;
          base.retryDelayMs = s.retry_delay_ms;
          base.errorStatus = s.error_status;
          base.error = s.error;
          break;
        case 'compact_boundary': {
          const meta = s.compact_metadata as Record<string, unknown> | undefined;
          if (meta) {
            base.trigger = meta.trigger;
            base.preTokens = meta.pre_tokens;
          }
          break;
        }
        case 'hook_started':
        case 'hook_progress':
        case 'hook_response':
          base.hookId = s.hook_id;
          base.hookName = s.hook_name;
          base.hookEvent = s.hook_event;
          if (s.subtype === 'hook_response') {
            base.outcome = s.outcome;
            base.exitCode = s.exit_code;
          }
          break;
        case 'task_notification':
          base.taskId = s.task_id;
          base.status = s.status;
          base.summary = typeof s.summary === 'string' ? (s.summary as string).slice(0, 200) : undefined;
          if (s.usage) base.usage = s.usage;
          break;
        case 'task_started':
          base.taskId = s.task_id;
          base.description = typeof s.description === 'string' ? (s.description as string).slice(0, 200) : undefined;
          base.taskType = s.task_type;
          break;
        case 'task_progress':
          base.taskId = s.task_id;
          base.description = typeof s.description === 'string' ? (s.description as string).slice(0, 200) : undefined;
          base.lastToolName = s.last_tool_name;
          if (s.usage) base.usage = s.usage;
          break;
        case 'session_state_changed':
          base.state = s.state;
          break;
        case 'status':
          base.status = s.status;
          break;
        case 'files_persisted': {
          const files = s.files as { filename: string }[] | undefined;
          base.fileCount = Array.isArray(files) ? files.length : 0;
          const failed = s.failed as { filename: string }[] | undefined;
          base.failedCount = Array.isArray(failed) ? failed.length : 0;
          break;
        }
        case 'elicitation_complete':
          base.mcpServerName = s.mcp_server_name;
          base.elicitationId = s.elicitation_id;
          break;
        case 'local_command_output':
          base.contentPreview = typeof s.content === 'string' ? (s.content as string).slice(0, 200) : undefined;
          break;
      }
      break;
    }

    case 'stream_event':
      // Intentionally sparse — stream events are high-frequency
      if (msg.parent_tool_use_id) base.parentToolUseId = msg.parent_tool_use_id;
      break;

    case 'tool_progress':
      base.toolName = msg.tool_name;
      base.toolUseId = msg.tool_use_id;
      base.elapsedSeconds = msg.elapsed_time_seconds;
      if (msg.task_id) base.taskId = msg.task_id;
      break;

    case 'tool_use_summary':
      base.summaryPreview = msg.summary.slice(0, 200);
      base.toolUseIds = msg.preceding_tool_use_ids;
      break;

    case 'rate_limit_event':
      base.status = msg.rate_limit_info.status;
      if (msg.rate_limit_info.resetsAt) base.resetsAt = msg.rate_limit_info.resetsAt;
      if (msg.rate_limit_info.utilization != null) base.utilization = msg.rate_limit_info.utilization;
      break;

    case 'auth_status':
      base.isAuthenticating = msg.isAuthenticating;
      if (msg.error) base.error = msg.error;
      break;

    case 'prompt_suggestion':
      base.suggestion = msg.suggestion.slice(0, 200);
      break;

    case 'user': {
      const u = msg as Record<string, unknown>;
      base.isReplay = u.isReplay === true;
      base.isSynthetic = u.isSynthetic === true;
      if (u.parent_tool_use_id) base.parentToolUseId = u.parent_tool_use_id;
      break;
    }
  }

  return base;
}

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

  const details = buildEventDetails(msg);
  details.executorId = executorId;

  await recordAuditEvent('sdk_message', executorId, eventType, agentId, details);

  return eventType;
}
