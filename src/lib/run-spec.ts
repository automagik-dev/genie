/**
 * RunSpec / RunState — Execution specification and state machine for scheduled runs.
 *
 * RunSpec describes HOW a trigger should be executed: which repo, provider,
 * command, concurrency class, and lease timeout. Stored as JSONB in the
 * schedules table and resolved at fire time.
 *
 * RunState tracks WHERE a run is in its lifecycle, from spawning through
 * completion or failure.
 */

// ============================================================================
// RunState — lifecycle state machine
// ============================================================================

/**
 * Lifecycle states for a scheduled run:
 *   spawning      → process being created
 *   running       → process alive and executing
 *   waiting_input → agent waiting for permission or user input
 *   completed     → finished successfully
 *   failed        → terminated with error or timeout
 *   cancelled     → manually cancelled
 */
export type RunState = 'spawning' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled';

/** Valid transitions from each state. */
export const RUN_STATE_TRANSITIONS: Record<RunState, RunState[]> = {
  spawning: ['running', 'failed', 'cancelled'],
  running: ['waiting_input', 'completed', 'failed', 'cancelled'],
  waiting_input: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Terminal states — no further transitions possible. */
export const TERMINAL_STATES: ReadonlySet<RunState> = new Set(['completed', 'failed', 'cancelled']);

// ============================================================================
// RunSpec — execution specification
// ============================================================================

export interface RunSpec {
  /** Repository path to execute in. Defaults to cwd. */
  repo?: string;

  /** Git ref policy: 'current' uses HEAD, 'default' uses default branch. */
  ref_policy?: 'current' | 'default';

  /** AI provider to use for spawning. */
  provider?: 'claude' | 'codex';

  /** Agent role (e.g., 'engineer', 'reviewer'). */
  role?: string;

  /** Model override (e.g., 'sonnet', 'opus'). */
  model?: string;

  /** Full command string to execute (e.g., 'genie spawn reviewer'). */
  command: string;

  /** Approval policy for the spawned agent. */
  approval_policy?: 'auto' | 'manual';

  /** Concurrency class — runs in the same class share the max_concurrent limit. */
  concurrency_class?: string;

  /** Lease timeout in milliseconds. How long before an unresponsive run is considered dead. Default: 300000 (5m). */
  lease_timeout_ms?: number;
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULTS: Required<Omit<RunSpec, 'command'>> = {
  repo: process.cwd(),
  ref_policy: 'current',
  provider: 'claude',
  role: 'worker',
  model: '',
  approval_policy: 'auto',
  concurrency_class: 'default',
  lease_timeout_ms: 300_000, // 5 minutes
};

// ============================================================================
// Resolve
// ============================================================================

const VALID_PROVIDERS = new Set(['claude', 'codex']);
const VALID_REF_POLICIES = new Set(['current', 'default']);
const VALID_APPROVAL_POLICIES = new Set(['auto', 'manual']);

/** Validate RunSpec fields. Throws with descriptive error on invalid input. */
function validateRunSpec(input: Partial<RunSpec>): void {
  if (!input.command || input.command.trim().length === 0) {
    throw new Error('RunSpec.command is required and cannot be empty');
  }
  if (input.lease_timeout_ms !== undefined && input.lease_timeout_ms < 10_000) {
    throw new Error(`RunSpec.lease_timeout_ms must be >= 10000ms, got ${input.lease_timeout_ms}`);
  }
  if (input.lease_timeout_ms !== undefined && input.lease_timeout_ms > 3_600_000) {
    throw new Error(`RunSpec.lease_timeout_ms must be <= 3600000ms (1h), got ${input.lease_timeout_ms}`);
  }
  if (input.provider && !VALID_PROVIDERS.has(input.provider)) {
    throw new Error(`RunSpec.provider must be 'claude' or 'codex', got '${input.provider}'`);
  }
  if (input.ref_policy && !VALID_REF_POLICIES.has(input.ref_policy)) {
    throw new Error(`RunSpec.ref_policy must be 'current' or 'default', got '${input.ref_policy}'`);
  }
  if (input.approval_policy && !VALID_APPROVAL_POLICIES.has(input.approval_policy)) {
    throw new Error(`RunSpec.approval_policy must be 'auto' or 'manual', got '${input.approval_policy}'`);
  }
}

/**
 * Validate a RunSpec and fill in defaults for missing fields.
 * Throws on invalid input (missing command, bad lease timeout, etc.).
 */
export function resolveRunSpec(input: Partial<RunSpec> & { command: string }): Required<Omit<RunSpec, 'command'>> & {
  command: string;
} {
  validateRunSpec(input);

  return {
    repo: input.repo ?? DEFAULTS.repo,
    ref_policy: input.ref_policy ?? DEFAULTS.ref_policy,
    provider: input.provider ?? DEFAULTS.provider,
    role: input.role ?? DEFAULTS.role,
    model: input.model ?? DEFAULTS.model,
    command: input.command.trim(),
    approval_policy: input.approval_policy ?? DEFAULTS.approval_policy,
    concurrency_class: input.concurrency_class ?? DEFAULTS.concurrency_class,
    lease_timeout_ms: input.lease_timeout_ms ?? DEFAULTS.lease_timeout_ms,
  };
}

/**
 * Check if a state transition is valid.
 */
export function isValidTransition(from: RunState, to: RunState): boolean {
  return RUN_STATE_TRANSITIONS[from].includes(to);
}
