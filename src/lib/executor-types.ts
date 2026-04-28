/**
 * Executor Model Types — Core type definitions for the executor model.
 *
 * The executor model separates agent identity (durable) from executor
 * runtime (ephemeral). An agent can have many executors over its lifetime;
 * only one is current at any time.
 */

import type { NativeTeamParams, ProviderName } from './provider-adapters.js';

// ============================================================================
// Enums / Union Types
// ============================================================================

/** State of an executor process. Source of truth for agent "effective state". */
export type ExecutorState =
  | 'spawning'
  | 'running'
  | 'idle'
  | 'working'
  | 'permission'
  | 'question'
  | 'done'
  | 'error'
  | 'terminated';

/** Transport mechanism for executor communication. */
export type TransportType = 'tmux' | 'api' | 'process';

/** Outcome of a completed assignment. */
export type AssignmentOutcome = 'completed' | 'failed' | 'reassigned' | 'abandoned';

/**
 * Turn close outcome written by the turn-close contract (migration 042).
 * - 'done' / 'blocked' / 'failed' are written by the explicit close verbs.
 * - 'clean_exit_unverified' is the sentinel written by the pane-exit trap
 *   when a pane dies without any verb firing.
 */
export type TurnOutcome = 'done' | 'blocked' | 'failed' | 'clean_exit_unverified';

// ============================================================================
// Data Interfaces
// ============================================================================

/**
 * Agent identity — durable, survives executor restarts.
 * This is the canonical slim agent after migration (<= 12 fields).
 * The existing `Agent` in agent-registry.ts retains runtime fields
 * during transition; consumers migrate to this type in Groups 3-7.
 */
export interface AgentIdentity {
  id: string;
  startedAt: string;
  role?: string;
  customName?: string;
  team?: string;
  nativeAgentId?: string;
  nativeColor?: string;
  nativeTeamEnabled?: boolean;
  parentSessionId?: string;
  currentExecutorId: string | null;
  reportsTo?: string | null;
  title?: string | null;
  /**
   * Schema-derived permanence label (migration 049). Computed by the
   * GENERATED column from `id` shape + `reports_to` — never authored
   * directly by consumers, never drifts.
   */
  kind?: 'permanent' | 'task';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Executor — ephemeral process runtime. One agent can have many executors.
 * Maps 1:1 to the `executors` DB table (camelCase).
 */
export interface Executor {
  id: string;
  agentId: string;
  provider: ProviderName;
  transport: TransportType;
  pid: number | null;
  tmuxSession: string | null;
  tmuxPaneId: string | null;
  tmuxWindow: string | null;
  tmuxWindowId: string | null;
  claudeSessionId: string | null;
  state: ExecutorState;
  metadata: Record<string, unknown>;
  worktree: string | null;
  repoPath: string | null;
  paneColor: string | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Turn identifier — set at turn open, preserved across close. NULL for pre-contract executors. */
  turnId: string | null;
  /** Explicit close outcome. NULL while the turn is still open. */
  outcome: TurnOutcome | null;
  /** Monotonic close timestamp written by the single close transaction. */
  closedAt: string | null;
  /** Free-form rationale supplied with `--reason`, or 'clean_exit_unverified' for trap-written rows. */
  closeReason: string | null;
}

/** DB row shape for the executors table (snake_case). */
export interface ExecutorRow {
  id: string;
  agent_id: string;
  provider: ProviderName;
  transport: TransportType;
  pid: number | null;
  tmux_session: string | null;
  tmux_pane_id: string | null;
  tmux_window: string | null;
  tmux_window_id: string | null;
  claude_session_id: string | null;
  state: ExecutorState;
  metadata: Record<string, unknown> | string;
  worktree: string | null;
  repo_path: string | null;
  pane_color: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  turn_id: string | null;
  outcome: TurnOutcome | null;
  closed_at: Date | string | null;
  close_reason: string | null;
}

/**
 * Assignment — records executor <-> task pairings (work history).
 * Many-to-many: one executor can work multiple tasks, one task can be
 * worked by multiple executors (reassignment).
 */
export interface Assignment {
  id: string;
  executorId: string;
  taskId: string | null;
  wishSlug: string | null;
  groupNumber: number | null;
  startedAt: string;
  endedAt: string | null;
  outcome: AssignmentOutcome | null;
  createdAt: string;
}

/** DB row shape for the assignments table (snake_case). */
export interface AssignmentRow {
  id: string;
  executor_id: string;
  task_id: string | null;
  wish_slug: string | null;
  group_number: number | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  outcome: AssignmentOutcome | null;
  created_at: Date | string;
}

// ============================================================================
// Row Mappers
// ============================================================================

function ts(v: Date | string | null | undefined): string {
  if (!v) return new Date().toISOString();
  return v instanceof Date ? v.toISOString() : v;
}

/** Convert a DB executor row (snake_case) to an Executor (camelCase). */
export function rowToExecutor(r: ExecutorRow): Executor {
  return {
    id: r.id,
    agentId: r.agent_id,
    provider: r.provider,
    transport: r.transport,
    pid: r.pid,
    tmuxSession: r.tmux_session,
    tmuxPaneId: r.tmux_pane_id,
    tmuxWindow: r.tmux_window,
    tmuxWindowId: r.tmux_window_id,
    claudeSessionId: r.claude_session_id,
    state: r.state,
    metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {}),
    worktree: r.worktree,
    repoPath: r.repo_path,
    paneColor: r.pane_color,
    startedAt: ts(r.started_at),
    endedAt: r.ended_at ? ts(r.ended_at) : null,
    createdAt: ts(r.created_at),
    updatedAt: ts(r.updated_at),
    turnId: r.turn_id ?? null,
    outcome: r.outcome ?? null,
    closedAt: r.closed_at ? ts(r.closed_at) : null,
    closeReason: r.close_reason ?? null,
  };
}

/** Convert a DB assignment row (snake_case) to an Assignment (camelCase). */
export function rowToAssignment(r: AssignmentRow): Assignment {
  return {
    id: r.id,
    executorId: r.executor_id,
    taskId: r.task_id,
    wishSlug: r.wish_slug,
    groupNumber: r.group_number,
    startedAt: ts(r.started_at),
    endedAt: r.ended_at ? ts(r.ended_at) : null,
    outcome: r.outcome,
    createdAt: ts(r.created_at),
  };
}

// ============================================================================
// Provider Interface
// ============================================================================

/**
 * Context for spawning a new executor. Includes identity info from the agent
 * and spawn configuration.
 */
export interface SpawnContext {
  /** Agent identity this executor belongs to. */
  agentId: string;
  /** Executor ID (pre-generated before spawn). */
  executorId: string;
  /** Team name. */
  team: string;
  /** Role within the team (e.g., 'engineer', 'reviewer'). */
  role?: string;
  /** Skill to execute. */
  skill?: string;
  /** Working directory for the executor. */
  cwd: string;
  /** Extra CLI flags forwarded to the provider binary. */
  extraArgs?: string[];
  /** Model override (e.g., 'sonnet', 'opus'). */
  model?: string;
  /** Claude session ID for session tracking. */
  sessionId?: string;
  /** System prompt file path (AGENTS.md). */
  systemPromptFile?: string;
  /** Inline system prompt text. */
  systemPrompt?: string;
  /** How to inject the system prompt. */
  promptMode?: 'system' | 'append';
  /** Initial prompt (first user message). */
  initialPrompt?: string;
  /** Display name for the session. */
  name?: string;
  /** Native team integration parameters. */
  nativeTeam?: NativeTeamParams;
  /** OTel telemetry port. */
  otelPort?: number;
  /** Whether to log user prompts via OTel. */
  otelLogPrompts?: boolean;
  /** Wish slug for OTel correlation. */
  otelWishSlug?: string;
}

/** Context for resuming an existing executor session. */
export interface ResumeContext {
  /** Agent identity this executor belongs to. */
  agentId: string;
  /** New executor ID for the resumed session. */
  executorId: string;
  /** Team name. */
  team: string;
  /** Role within the team. */
  role?: string;
  /** Working directory. */
  cwd: string;
  /** The Claude session ID to resume. */
  claudeSessionId: string;
  /** Extra CLI flags. */
  extraArgs?: string[];
  /** Model override. */
  model?: string;
  /** Native team integration parameters. */
  nativeTeam?: NativeTeamParams;
  /** OTel telemetry port. */
  otelPort?: number;
  /** Whether to log user prompts via OTel. */
  otelLogPrompts?: boolean;
  /** Wish slug for OTel correlation. */
  otelWishSlug?: string;
}

/** Result of building a launch command from a provider. */
export interface LaunchCommand {
  /** The full shell command string. */
  command: string;
  /** The provider name. */
  provider: ProviderName;
  /** Environment variables to prepend to the command. */
  env?: Record<string, string>;
  /** Metadata for the executor registry. */
  meta: {
    role?: string;
    skill?: string;
  };
}

/**
 * ExecutorProvider — interface for executor lifecycle management.
 *
 * Each provider (Claude Code, Codex, future providers) implements this
 * interface to handle spawning, state detection, session extraction,
 * termination, and optionally resume.
 *
 * Genie is the USB port; providers are the devices you plug in.
 */
export interface ExecutorProvider {
  /** Provider identifier (e.g., 'claude-code', 'codex'). */
  readonly name: string;

  /** Transport mechanism used by this provider. */
  readonly transport: TransportType;

  /** Build the shell command to spawn a new executor. */
  buildSpawnCommand(ctx: SpawnContext): LaunchCommand;

  /** Extract session metadata from a running executor (e.g., JSONL path discovery). */
  extractSession(executor: Executor): Promise<{ sessionId: string; logPath?: string } | null>;

  /** Detect the current state of an executor (e.g., via pane capture or API polling). */
  detectState(executor: Executor): Promise<ExecutorState>;

  /** Terminate an executor process. */
  terminate(executor: Executor): Promise<void>;

  /** Whether this provider supports session resume. */
  canResume(): boolean;

  /** Build the shell command to resume an existing session. Only if canResume() is true. */
  buildResumeCommand?(ctx: ResumeContext): LaunchCommand;

  /** Deliver a message to a running executor's native inbox. Optional — not all providers support it. */
  deliverMessage?(executorId: string, message: { text: string; traceId: string }): Promise<void>;
}
