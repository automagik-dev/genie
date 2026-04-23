/**
 * Frontmatter Parser — Shared YAML frontmatter extraction + Zod validation.
 *
 * Single source of truth for parsing AGENTS.md frontmatter.
 * Used by both builtin-agents.ts (built-in discovery) and agent-sync.ts (user agent sync).
 *
 * Validation strategy: warn on invalid/unknown fields, never reject.
 * Agents should always be discoverable even with malformed frontmatter.
 */

import * as yaml from 'js-yaml';
import { z } from 'zod';

// ============================================================================
// Schema
// ============================================================================

/** Known prompt modes for agent identity injection. */
const promptModeValues = ['system', 'append'] as const;

/** Known provider values for spawn resolution. */
const providerValues = ['claude', 'codex', 'claude-sdk'] as const;

/**
 * Zod schema for AGENTS.md frontmatter.
 * Uses .optional() on all fields — missing fields are fine.
 * Invalid enum values fall back to undefined (with a warning).
 */
export const AgentFrontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  model: z.string().optional(),
  color: z.string().optional(),
  promptMode: z.enum(promptModeValues).optional(),
  provider: z.enum(providerValues).optional(),
  tools: z.array(z.string()).optional(),
  permissionMode: z.string().optional(),
  /** Tools the agent is NOT allowed to use (Claude Code --disallowedTools). */
  disallowedTools: z.array(z.string()).optional(),
  /** Claude Code permission rules — allow/deny lists with Bash() patterns. */
  permissions: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    })
    .optional(),
  /** Omni API scopes the agent is restricted to (e.g., 'say', 'react'). */
  omniScopes: z.array(z.string()).optional(),
  /** Claude Code hooks configuration — permissive record for forward compatibility. */
  hooks: z.record(z.unknown()).optional(),
  /** SDK configuration block — permissive record so new SDK options don't require parser updates. */
  sdk: z.record(z.unknown()).optional(),
  /** Override for the tmux session name the Omni bridge spawns into. See `DirectoryEntry.bridgeTmuxSession`. */
  bridgeTmuxSession: z.string().optional(),
});

type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

const knownKeys = new Set(Object.keys(AgentFrontmatterSchema.shape));

// ============================================================================
// Helpers
// ============================================================================

/** Extract raw YAML object from frontmatter delimiters. Returns null on failure. */
function extractRawYaml(content: string): Record<string, unknown> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  try {
    const parsed = yaml.load(match[1]);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Log warnings for keys not in the schema. */
function warnUnknownFields(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      console.warn(`[frontmatter] Unknown field "${key}" — ignored.`);
    }
  }
}

/** Validate field-by-field, warning on invalid values and collecting valid ones. */
function validateFieldByField(raw: Record<string, unknown>): AgentFrontmatter {
  const out: Record<string, unknown> = {};
  for (const key of knownKeys) {
    const fieldSchema = AgentFrontmatterSchema.shape[key as keyof typeof AgentFrontmatterSchema.shape];
    const fieldResult = fieldSchema.safeParse(raw[key]);
    if (fieldResult.success) {
      if (fieldResult.data !== undefined) out[key] = fieldResult.data;
    } else if (raw[key] !== undefined) {
      console.warn(`[frontmatter] Invalid value for "${key}": ${JSON.stringify(raw[key])} — using default.`);
    }
  }
  return out as AgentFrontmatter;
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse YAML frontmatter from a markdown file and validate against schema.
 *
 * - Returns empty object if no frontmatter found or YAML is malformed.
 * - Warns on unknown fields (extra keys not in schema).
 * - Warns on invalid enum values and falls back to undefined for that field.
 * - Never throws — agents should always be discoverable.
 */
export function parseFrontmatter(content: string): AgentFrontmatter {
  const raw = extractRawYaml(content);
  if (!raw) return {};

  warnUnknownFields(raw);

  const result = AgentFrontmatterSchema.safeParse(raw);
  if (result.success) return result.data;

  return validateFieldByField(raw);
}
