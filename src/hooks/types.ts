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

/** Source tier for a handler — determines load precedence. */
export type HandlerSource = 'builtin' | 'team' | 'repo' | 'global' | 'absorbed';

/**
 * v1 Handler — the only version shipped in delivery #2 of the hookify umbrella.
 *
 * Future-proofed as a discriminated union on `version`. v2 (and later) will be
 * a new variant of the union; v1 and v2 handlers run side-by-side in the same
 * dispatch chain until v1 sunset is announced. The loader rejects unknown
 * versions as `[BROKEN]`. Versioning the contract before any external consumers
 * exist costs nothing today and is impossible to retrofit later.
 */
export interface HandlerV1 {
  /** Discriminator — locked to '1' for this delivery. */
  version: '1';
  name: string;
  event: HookEventName;
  /** Regex matched against tool_name (only for PreToolUse/PostToolUse). */
  matcher?: RegExp;
  /** Lower = runs first. */
  priority: number;
  fn: (payload: HookPayload) => Promise<HandlerResult>;
  /**
   * Source tier — set by the loader when registering. Builtin handlers (defined
   * inside src/hooks/index.ts) are 'builtin'; loaded files are 'team' / 'repo' /
   * 'global' depending on which tier the file lives in; generated absorption
   * wrappers are 'absorbed'.
   */
  source: HandlerSource;
  /**
   * Filesystem path the handler was loaded from. For builtins, points at
   * src/hooks/index.ts (the registration site). External handlers point at
   * the actual `.ts` file. Surfaced by `genie hook list` for debugging.
   */
  manifest_path: string;
}

/**
 * A registered handler in the chain.
 *
 * Today, this is `HandlerV1`; once v2 ships it becomes `HandlerV1 | HandlerV2`.
 * Code that only reads `name`/`event`/`matcher`/`priority`/`fn` works against
 * the union without changes (those fields exist in every version). Code that
 * needs version-specific behavior must `switch` on `handler.version`.
 */
export type Handler = HandlerV1;

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
