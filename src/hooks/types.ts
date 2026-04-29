/**
 * Hook system types — shared across dispatch, handlers, and injection.
 */

/** Events that block execution until handlers complete. */
type BlockingEvent = 'PreToolUse' | 'UserPromptSubmit' | 'TeammateIdle' | 'TaskCompleted' | 'PermissionRequest';

/** Events that are fire-and-forget. */
type NonBlockingEvent =
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
  /** @deprecated Use hookSpecificOutput.permissionDecision instead for PreToolUse */
  decision?: 'allow' | 'deny' | 'ask';
  reason?: string;
  updatedInput?: Record<string, unknown>;
  /** CC hookSpecificOutput — the correct format for PreToolUse decisions. */
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: 'allow' | 'deny' | 'ask';
    permissionDecisionReason?: string;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
  };
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

/**
 * Hook events that CC settings.json wires to `genie hook dispatch`, mapped
 * to the per-event tool-name matcher.
 *
 * Mac-CPU fix D — narrow matchers + drop empty events.
 *
 * Previous DISPATCHED_EVENTS list wired SessionStart/SessionEnd/TeammateIdle/
 * TaskCompleted with matcher='*' even though zero handlers exist for those
 * events — every fire was a wasted `bun` cold-start (each start runs the full
 * hook-dispatch entrypoint and PG init). Combined with PostToolUse:* (only
 * `runtime-emit-msg` exists, and only matches `SendMessage`), the inject
 * config was producing dozens of useless dispatcher invocations per user
 * action on a busy dev machine.
 *
 * The matcher value is the CC-settings `matcher` field — `*` means all
 * tools, otherwise an exact tool name (or pipe-separated list).
 *
 * To add a new dispatched event: register the handler in `index.ts` AND
 * add the (event, matcher) pair here. To deprecate: remove from this map
 * — `injectIntoFile` will prune existing entries on the next inject.
 */
export const DISPATCHED_EVENT_MATCHERS: Partial<Record<HookEventName, string>> = {
  // PreToolUse handlers: branch-guard (Bash), orchestration-guard (Bash),
  //   brain-inject (.*), freshness (Read), audit-context (Write|Edit),
  //   identity-inject (SendMessage), auto-spawn (SendMessage),
  //   runtime-emit-tool (.*), session-sync-tool (.*) — broad coverage.
  PreToolUse: '*',
  // PostToolUse handler: runtime-emit-msg matches `^SendMessage$` only.
  // Wiring '*' caused the dispatcher to run on every Bash/Read/Write/Edit
  // post-use even though those produce no event — pure waste.
  PostToolUse: 'SendMessage',
};

/**
 * Codex-side counterpart to DISPATCHED_EVENT_MATCHERS — wider because codex
 * has additional handlers that don't exist on claude:
 *   - codex-inbox-deliver runs on UserPromptSubmit
 *   - runtime-emit-assistant-response runs on Stop
 *
 * Like DISPATCHED_EVENT_MATCHERS, only events that actually have a handler
 * are wired. Pre-fix, codex-inject.ts wired 6 events (PreToolUse, PostToolUse,
 * UserPromptSubmit, SessionStart, Stop, PermissionRequest) all with matcher='*'
 * — including SessionStart and PermissionRequest which have no handlers,
 * causing wasted bun cold-starts on every codex hook fire.
 *
 * dog-fooder-da66 verdict 2026-04-29 surfaced the codex-side leak after
 * Fix D #1479 closed only the claude side.
 */
export const CODEX_DISPATCHED_EVENT_MATCHERS: Partial<Record<HookEventName, string>> = {
  PreToolUse: '*',
  // Same as claude — only runtime-emit-msg matches SendMessage.
  PostToolUse: 'SendMessage',
  // codex-inbox-deliver + runtime-emit-user-prompt + session-sync-prompt all run here.
  UserPromptSubmit: '*',
  // runtime-emit-assistant-response runs here.
  Stop: '*',
  // SessionStart, PermissionRequest dropped — no handlers (verified against
  // src/hooks/index.ts handler registry as of 2026-04-29).
};

/**
 * Convenience array — derived from DISPATCHED_EVENT_MATCHERS.
 * Kept so callers that need the event list (without matcher) are unchanged.
 */
export const DISPATCHED_EVENTS: HookEventName[] = Object.keys(DISPATCHED_EVENT_MATCHERS) as HookEventName[];

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
