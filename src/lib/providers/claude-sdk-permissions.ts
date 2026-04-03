/**
 * Claude Agent SDK Permission Gate
 *
 * Factory for creating CanUseTool callbacks compatible with the
 * @anthropic-ai/claude-agent-sdk query() options. Reuses the existing
 * normalizeCommand() and hasShellMetacharacters() from auto-approve.ts
 * to keep bash inspection logic DRY.
 */

import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { hasShellMetacharacters, normalizeCommand } from '../auto-approve.js';

// ============================================================================
// Types
// ============================================================================

export interface PermissionConfig {
  /** Tool names that are allowed. Empty = allow none (unless preset). */
  allow: string[];
  /** Tool names that are denied. Deny always wins over allow. */
  deny: string[];
  /** Regex patterns for allowed bash commands. */
  bashAllowPatterns?: string[];
  /** Regex patterns for denied bash commands. */
  bashDenyPatterns?: string[];
}

// ============================================================================
// Presets
// ============================================================================

/** Full access — all tools allowed, no restrictions. */
export const PRESET_FULL: PermissionConfig = {
  allow: ['*'],
  deny: [],
};

/** Read-only — safe observation tools only. */
export const PRESET_READ_ONLY: PermissionConfig = {
  allow: ['Read', 'Glob', 'Grep', 'WebFetch'],
  deny: [],
};

/** Chat-only — messaging and reading, no mutations. */
export const PRESET_CHAT_ONLY: PermissionConfig = {
  allow: ['SendMessage', 'Read'],
  deny: [],
};

const PRESETS: Record<string, PermissionConfig> = {
  full: PRESET_FULL,
  'read-only': PRESET_READ_ONLY,
  'chat-only': PRESET_CHAT_ONLY,
};

/**
 * Resolve a named preset to its PermissionConfig.
 * Throws if the preset name is not recognized.
 */
export function resolvePreset(name: string): PermissionConfig {
  const preset = PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown permission preset "${name}". Valid presets: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

// ============================================================================
// Bash Pattern Matching
// ============================================================================

/**
 * Check if a bash command matches any pattern in the given list.
 * Patterns are treated as regular expressions (substring match).
 */
function matchBashPattern(command: string, patterns: string[]): string | null {
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern);
      if (regex.test(command)) return pattern;
    } catch {
      // Invalid regex — fallback to substring match
      if (command.includes(pattern)) return pattern;
    }
  }
  return null;
}

/**
 * Check if a compound command (with shell metacharacters) fully matches any allow pattern.
 */
function matchCompoundCommand(command: string, bashAllowPatterns: string[]): boolean {
  for (const pattern of bashAllowPatterns) {
    try {
      const match = command.match(new RegExp(pattern));
      if (match && match[0] === command) return true;
    } catch {
      // Invalid regex — skip
    }
  }
  return false;
}

/**
 * Evaluate a bash command against allow/deny patterns.
 * Returns an allow/deny PermissionResult.
 */
function evaluateBashCommand(
  command: string,
  bashAllowPatterns: string[],
  bashDenyPatterns: string[],
): PermissionResult {
  const normalized = normalizeCommand(command);

  // Deny patterns always win
  const denyMatch = bashDenyPatterns.length > 0 ? matchBashPattern(normalized, bashDenyPatterns) : null;
  if (denyMatch) {
    return { behavior: 'deny', message: `Bash command matches deny pattern "${denyMatch}": ${normalized}` };
  }

  // No patterns at all — allow (tool-level allow is sufficient)
  if (bashAllowPatterns.length === 0 && bashDenyPatterns.length === 0) {
    return { behavior: 'allow' };
  }

  // Shell metacharacters — require full match against allow patterns
  if (hasShellMetacharacters(normalized)) {
    if (matchCompoundCommand(normalized, bashAllowPatterns)) return { behavior: 'allow' };
    return { behavior: 'deny', message: `Bash compound command does not fully match any allow pattern: ${normalized}` };
  }

  // Simple command — check allow patterns
  const allowMatch = bashAllowPatterns.length > 0 ? matchBashPattern(normalized, bashAllowPatterns) : null;
  if (allowMatch) return { behavior: 'allow' };

  return { behavior: 'deny', message: `Bash command does not match any allow pattern: ${normalized}` };
}

// ============================================================================
// Gate Factory
// ============================================================================

/**
 * Create a CanUseTool callback from a PermissionConfig.
 *
 * Gate logic:
 * 1. Deny list wins — if tool is denied, reject immediately.
 * 2. Allow list check — if tool is not in allow list (and no wildcard), reject.
 * 3. For Bash tools — inspect the command against bash patterns.
 * 4. Otherwise allow.
 */
export function createPermissionGate(config: PermissionConfig): CanUseTool {
  const { allow, deny, bashAllowPatterns = [], bashDenyPatterns = [] } = config;
  const allowAll = allow.includes('*');

  return async (toolName, input, _options): Promise<PermissionResult> => {
    // 1. Deny list wins
    if (deny.includes(toolName)) {
      return { behavior: 'deny', message: `Tool "${toolName}" is denied by permission config` };
    }

    // 2. Allow list check
    if (!allowAll && !allow.includes(toolName)) {
      return { behavior: 'deny', message: `Tool "${toolName}" is not in the allow list` };
    }

    // 3. Bash pattern inspection
    if (toolName === 'Bash' && (bashAllowPatterns.length > 0 || bashDenyPatterns.length > 0)) {
      const command = typeof input.command === 'string' ? input.command : '';
      if (command) {
        return evaluateBashCommand(command, bashAllowPatterns, bashDenyPatterns);
      }
    }

    // 4. Allow
    return { behavior: 'allow' };
  };
}
