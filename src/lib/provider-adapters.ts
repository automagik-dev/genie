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

/** Common spawn parameters accepted by both providers. */
export interface SpawnParams {
  provider: ProviderName;
  team: string;
  role?: string;
  skill?: string;
  /** Extra CLI flags forwarded verbatim to the provider binary. */
  extraArgs?: string[];
}

/** Result of a successful launch-command build. */
export interface LaunchCommand {
  /** The full shell command string. */
  command: string;
  /** The provider that was used. */
  provider: ProviderName;
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
});

/**
 * Validate spawn parameters and return actionable errors.
 * Throws ZodError on invalid input.
 */
export function validateSpawnParams(params: SpawnParams): SpawnParams {
  const parsed = spawnParamsSchema.parse(params);

  // Provider-specific validation rules
  if (parsed.provider === 'codex' && !parsed.skill) {
    throw new Error(
      'Codex provider requires --skill. ' +
      'Example: genie worker spawn --provider codex --team work --skill work --role tester'
    );
  }

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
  } catch {
    // fallback: assume available
  }
  return true;
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
 * Uses `claude --agent <role>` for role-specific behavior.
 * No hidden teammate flags — public CLI surface only.
 */
export function buildClaudeCommand(params: SpawnParams): LaunchCommand {
  preflightCheck('claude');

  const parts: string[] = ['claude'];

  // Role routing via --agent (DEC-3)
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

  if (!params.skill) {
    throw new Error(
      'Codex adapter requires --skill. ' +
      'The skill provides task instructions for the worker.'
    );
  }

  const parts: string[] = ['codex'];

  // Skill-driven instructions (DEC-4)
  const instructions = `Genie worker. Team: ${params.team}. Skill: ${params.skill}.${params.role ? ` Role: ${params.role} (advisory).` : ''} Execute the ${params.skill} skill instructions.`;
  parts.push('--instructions', escapeShellArg(instructions));

  // Forward extra args
  if (params.extraArgs) {
    for (const arg of params.extraArgs) {
      parts.push(escapeShellArg(arg));
    }
  }

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
