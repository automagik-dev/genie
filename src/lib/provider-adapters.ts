/**
 * Provider Adapters — Fixed launch builders for Claude and Codex.
 *
 * Each adapter translates Genie worker-spawn options into the
 * provider-specific CLI invocation that tmux will execute.
 *
 * - Claude adapter: `claude --agent <role> [flags]`
 * - Codex adapter:  `codex --instructions <skill-instructions> [flags]`
 *
 * Genie owns all orchestration semantics (mailbox, protocol, worker
 * state, task coupling). The provider merely launches the process.
 */

import { z } from 'zod';

// ============================================================================
// Types
// ============================================================================

export type ProviderName = 'claude' | 'codex';

/** Colors available for Claude Code native teammate UI. */
export type ClaudeTeamColor =
  | 'blue' | 'green' | 'yellow' | 'red' | 'magenta' | 'cyan'
  | 'orange' | 'purple' | 'pink' | 'teal';

/** Rotating palette for auto-assigning teammate colors. */
export const CLAUDE_TEAM_COLORS: ClaudeTeamColor[] = [
  'blue', 'green', 'yellow', 'red', 'magenta',
  'cyan', 'orange', 'purple', 'pink', 'teal',
];

/** Parameters for Claude Code native teammate integration. */
export interface NativeTeamParams {
  /** Enable native teammate flags (--agent-id, --team-name, etc.). */
  enabled: boolean;
  /** Parent session UUID (team lead's session ID). */
  parentSessionId?: string;
  /** UI color for the teammate pane border. */
  color?: ClaudeTeamColor;
  /** Agent type string (e.g., "general-purpose"). */
  agentType?: string;
  /** Start the teammate in plan mode. */
  planModeRequired?: boolean;
  /** Permission mode (e.g., "acceptEdits", "bypassPermissions"). */
  permissionMode?: string;
  /** Display name for the agent. */
  agentName?: string;
}

/** Common spawn parameters accepted by both providers. */
export interface SpawnParams {
  provider: ProviderName;
  team: string;
  role?: string;
  skill?: string;
  /** Extra CLI flags forwarded verbatim to the provider binary. */
  extraArgs?: string[];
  /** Claude Code native teammate integration. */
  nativeTeam?: NativeTeamParams;
}

/** Result of a successful launch-command build. */
export interface LaunchCommand {
  /** The full shell command string. */
  command: string;
  /** The provider that was used. */
  provider: ProviderName;
  /** Environment variables to prepend to the command. */
  env?: Record<string, string>;
  /** Metadata recorded in the worker registry. */
  meta: {
    role?: string;
    skill?: string;
  };
}

// ============================================================================
// Validation schemas (Group A contract validation)
// ============================================================================

export const spawnParamsSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  team: z.string().min(1, 'Team name is required'),
  role: z.string().optional(),
  skill: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  nativeTeam: z.object({
    enabled: z.boolean(),
    parentSessionId: z.string().optional(),
    color: z.string().optional(),
    agentType: z.string().optional(),
    planModeRequired: z.boolean().optional(),
    permissionMode: z.string().optional(),
    agentName: z.string().optional(),
  }).optional(),
});

/**
 * Validate spawn parameters and return actionable errors.
 * Throws ZodError on invalid input.
 */
export function validateSpawnParams(params: SpawnParams): SpawnParams {
  const parsed = spawnParamsSchema.parse(params);

  return parsed as SpawnParams;
}

// ============================================================================
// Shell Helpers
// ============================================================================

function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ============================================================================
// Preflight Checks
// ============================================================================

/**
 * Check if a binary exists on PATH.
 * Returns true if found, false otherwise.
 */
export function hasBinary(name: string): boolean {
  try {
    // @ts-ignore — Bun.which is available at runtime
    if (typeof (Bun as any).which === 'function') {
      return Boolean((Bun as any).which(name));
    }
    const { execSync } = require('child_process');
    execSync(`which ${name}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run preflight checks for a provider.
 * Throws with an actionable error if the binary is not found.
 */
export function preflightCheck(provider: ProviderName): void {
  if (!hasBinary(provider)) {
    throw new Error(
      `Provider binary "${provider}" not found on PATH. ` +
      `Install ${provider} or check your environment.`
    );
  }
}

// ============================================================================
// Claude Adapter
// ============================================================================

/**
 * Build the launch command for a Claude worker.
 *
 * When nativeTeam is enabled, emits Claude Code's internal teammate
 * flags (--agent-id, --team-name, etc.) and env vars so the worker
 * auto-polls its inbox and participates in the native IPC protocol.
 *
 * When nativeTeam is NOT enabled, uses `claude --agent <role>` only.
 */
export function buildClaudeCommand(params: SpawnParams): LaunchCommand {
  preflightCheck('claude');

  const parts: string[] = ['claude', '--dangerously-skip-permissions'];
  const env: Record<string, string> = {};
  const nt = params.nativeTeam;

  if (nt?.enabled) {
    // Native teammate env vars
    env['CLAUDECODE'] = '1';
    env['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'] = '1';

    const agentName = nt.agentName ?? params.role ?? 'worker';
    const teamName = params.team;
    const agentId = `${agentName}@${teamName}`;

    parts.push('--agent-id', escapeShellArg(agentId));
    parts.push('--agent-name', escapeShellArg(agentName));
    parts.push('--team-name', escapeShellArg(teamName));

    if (nt.color) {
      parts.push('--agent-color', escapeShellArg(nt.color));
    }

    if (nt.parentSessionId) {
      parts.push('--parent-session-id', escapeShellArg(nt.parentSessionId));
    }

    if (nt.agentType) {
      parts.push('--agent-type', escapeShellArg(nt.agentType));
    }

    if (nt.planModeRequired) {
      parts.push('--plan-mode-required');
    }

    if (nt.permissionMode) {
      parts.push('--permission-mode', escapeShellArg(nt.permissionMode));
    }
  }

  // Role routing via --agent (loads agent .md file — coexists with --agent-id)
  if (params.role) {
    parts.push('--agent', escapeShellArg(params.role));
  }

  // Forward extra args
  if (params.extraArgs) {
    for (const arg of params.extraArgs) {
      parts.push(escapeShellArg(arg));
    }
  }

  return {
    command: parts.join(' '),
    provider: 'claude',
    env: Object.keys(env).length > 0 ? env : undefined,
    meta: {
      role: params.role,
      skill: params.skill,
    },
  };
}

// ============================================================================
// Codex Adapter
// ============================================================================

/**
 * Build the launch command for a Codex worker.
 *
 * Uses `codex` with `--instructions` to inject skill-based task
 * instructions. Role is advisory metadata only (DEC-4).
 */
export function buildCodexCommand(params: SpawnParams): LaunchCommand {
  preflightCheck('codex');

  const parts: string[] = ['codex'];

  // Full autonomous execution — no permission prompts
  parts.push('--yolo');

  // Inline mode for tmux compatibility (no alternate screen)
  parts.push('--no-alt-screen');

  // Forward extra args before the positional prompt
  if (params.extraArgs) {
    for (const arg of params.extraArgs) {
      parts.push(escapeShellArg(arg));
    }
  }

  // Build prompt from available context (skill + role are both optional)
  const promptParts = [`Genie worker. Team: ${params.team}.`];
  if (params.skill) promptParts.push(`Skill: ${params.skill}.`);
  if (params.role) promptParts.push(`Role: ${params.role}.`);
  if (params.skill) promptParts.push(`Execute the ${params.skill} skill instructions.`);
  const prompt = promptParts.join(' ');
  parts.push(escapeShellArg(prompt));

  return {
    command: parts.join(' '),
    provider: 'codex',
    meta: {
      role: params.role,
      skill: params.skill,
    },
  };
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Build a launch command for the given provider.
 *
 * This is the main entry point. It validates params, runs preflight
 * checks, and delegates to the appropriate adapter.
 */
export function buildLaunchCommand(params: SpawnParams): LaunchCommand {
  const validated = validateSpawnParams(params);

  switch (validated.provider) {
    case 'claude':
      return buildClaudeCommand(validated);
    case 'codex':
      return buildCodexCommand(validated);
    default:
      throw new Error(
        `Unknown provider "${(validated as any).provider}". ` +
        'Valid providers: claude, codex'
      );
  }
}
