/**
 * Hook system types — shared across dispatch, handlers, and injection.
 */

/** Events that block execution until handlers complete. */
export type BlockingEvent = 'PreToolUse' | 'UserPromptSubmit' | 'TeammateIdle' | 'TaskCompleted' | 'PermissionRequest';

/** Events that are fire-and-forget. */
export type NonBlockingEvent =
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'Notification'
  | 'ConfigChange'
  | 'WorktreeCreate'
  | 'WorktreeRemove'
  | 'PreCompact';

export type HookEventName = BlockingEvent | NonBlockingEvent;

/** The JSON payload CC sends to hook commands on stdin. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  hook_event_name: string;
  permission_mode?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  /** TeammateIdle / TaskCompleted specific fields */
  teammate_name?: string;
  team_name?: string;
  task_id?: string;
  task_subject?: string;
  /** Catch-all for event-specific fields */
  [key: string]: unknown;
}

/** Decision a PreToolUse handler can return. */
export interface HookDecision {
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
}

/** Result from a handler — either a decision or void (implicit allow). */
export type HandlerResult = HookDecision | undefined;

/** A registered handler in the chain. */
export interface Handler {
  name: string;
  event: HookEventName;
  /** Regex matched against tool_name (only for PreToolUse/PostToolUse). */
  matcher?: RegExp;
  /** Lower = runs first. */
  priority: number;
  fn: (payload: HookPayload) => Promise<HandlerResult>;
}

/** The hook events that CC settings.json supports for the dispatch command. */
export const DISPATCHED_EVENTS: HookEventName[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'TeammateIdle',
  'TaskCompleted',
];

const BLOCKING_EVENTS = new Set<string>([
  'PreToolUse',
  'UserPromptSubmit',
  'TeammateIdle',
  'TaskCompleted',
  'PermissionRequest',
]);

export function isBlockingEvent(event: string): boolean {
  return BLOCKING_EVENTS.has(event);
}
