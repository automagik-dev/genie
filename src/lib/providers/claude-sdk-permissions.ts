/**
 * Claude Agent SDK Permission Gate
 *
 * Allowlist-only permission model. If a tool is not in the allow list, it's denied.
 * Bash commands can be further restricted via regex allowlist patterns.
 *
 * Enforced via PreToolUse hooks (canUseTool is ignored under bypassPermissions).
 */

import type { HookCallback, PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { hasShellMetacharacters, normalizeCommand } from '../auto-approve.js';

// ============================================================================
// Types
// ============================================================================

export interface PermissionConfig {
  /** Tool names that are allowed. '*' = allow all. */
  allow: string[];
  /** Regex patterns for allowed bash commands. Only checked when Bash is in allow list. */
  bashAllowPatterns?: string[];
}

// ============================================================================
// Presets
// ============================================================================

export const PRESET_FULL: PermissionConfig = {
  allow: ['*'],
};

export const PRESET_READ_ONLY: PermissionConfig = {
  allow: ['Read', 'Glob', 'Grep', 'WebFetch'],
};

export const PRESET_CHAT_ONLY: PermissionConfig = {
  allow: ['SendMessage', 'Read'],
};

const PRESETS: Record<string, PermissionConfig> = {
  full: PRESET_FULL,
  'read-only': PRESET_READ_ONLY,
  'chat-only': PRESET_CHAT_ONLY,
};

export function resolvePreset(name: string): PermissionConfig {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown permission preset "${name}". Valid: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

/**
 * Resolve a PermissionConfig from an agent entry's optional permissions field.
 *
 * Resolution order:
 * 1. If a preset name is specified, resolve it.
 * 2. If an explicit allow list is given, use it (with optional bashAllowPatterns).
 * 3. Fall back to PRESET_FULL (allow everything).
 */
export function resolvePermissionConfig(permissions?: {
  preset?: string;
  allow?: string[];
  bashAllowPatterns?: string[];
}): PermissionConfig {
  if (permissions?.preset) {
    return resolvePreset(permissions.preset);
  }
  if (permissions?.allow) {
    return {
      allow: permissions.allow,
      bashAllowPatterns: permissions.bashAllowPatterns,
    };
  }
  return PRESET_FULL;
}

// ============================================================================
// Bash Pattern Matching
// ============================================================================

function matchesBashAllow(command: string, patterns: string[]): boolean {
  const normalized = normalizeCommand(command);

  // Compound commands (&&, ||, |, ;) require full match
  if (hasShellMetacharacters(normalized)) {
    for (const pattern of patterns) {
      try {
        const match = normalized.match(new RegExp(pattern));
        if (match && match[0] === normalized) return true;
      } catch {
        /* invalid regex — skip */
      }
    }
    return false;
  }

  // Simple commands — substring regex match
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern).test(normalized)) return true;
    } catch {
      if (normalized.includes(pattern)) return true;
    }
  }
  return false;
}

// ============================================================================
// Gate Factory
// ============================================================================

/**
 * Create a PreToolUse hook from a PermissionConfig.
 *
 * Logic:
 * 1. Tool not in allow list? Denied.
 * 2. Tool is Bash and bashAllowPatterns exist? Command must match a pattern.
 * 3. Otherwise allowed.
 */
export function createPermissionGate(config: PermissionConfig): HookCallback {
  const { allow, bashAllowPatterns = [] } = config;
  const allowAll = allow.includes('*');
  const allowSet = new Set(allow);

  return async (input): Promise<SyncHookJSONOutput> => {
    const hookInput = input as PreToolUseHookInput;
    const toolName = hookInput.tool_name;

    // 1. Not in allow list → denied
    if (!allowAll && !allowSet.has(toolName)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `Tool "${toolName}" is not allowed. Allowed: ${allow.join(', ')}`,
        },
      };
    }

    // 2. Bash + patterns → command must match
    if (toolName === 'Bash' && bashAllowPatterns.length > 0) {
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
      const command = typeof toolInput.command === 'string' ? toolInput.command : '';
      if (!command || !matchesBashAllow(command, bashAllowPatterns)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Bash command not in allow patterns: ${command || '(empty)'}`,
          },
        };
      }
    }

    // 3. Allowed
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } };
  };
}
