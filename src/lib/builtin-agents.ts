/**
 * Built-in Agents — Roles and council members that ship with genie.
 *
 * Agents are discovered by scanning `plugins/genie/agents/` for folders
 * containing AGENTS.md files. Metadata is parsed from YAML frontmatter.
 *
 * No inline system prompts — all agent content lives in AGENTS.md files.
 *
 * Resolution: user directory entries override built-ins of the same name.
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { PromptMode } from './agent-directory.js';
import { normalizeValue } from './defaults.js';
import { parseFrontmatter } from './frontmatter.js';

// ============================================================================
// Types
// ============================================================================

export interface BuiltinAgent {
  /** Agent name (globally unique within built-ins). */
  name: string;
  /** Short description of what this agent does. */
  description: string;
  /** Absolute path to the agent's AGENTS.md file. */
  agentPath: string;
  /** Default model for this agent. */
  model?: string;
  /** Prompt mode: 'system' replaces CC default, 'append' preserves it. */
  promptMode?: PromptMode;
  /** Category for display grouping. */
  category: 'role' | 'council';
  /** Display color for tmux pane borders. */
  color?: string;
}

// ============================================================================
// Package Root Resolution
// ============================================================================

/**
 * Resolve the genie package root directory.
 * Works from both `src/lib/` (dev) and `dist/` (compiled).
 */
function resolvePackageRoot(): string {
  // In compiled dist, import.meta.dir returns CWD, not the module's dir.
  // Use the actual script path (process.argv[1]) to find the package root.
  const scriptPath = realpathSync(process.argv[1] || '');
  const candidates = [
    // From dist/genie.js → ../
    resolve(dirname(scriptPath), '..'),
    // From src/lib/builtin-agents.ts → ../../
    resolve(dirname(scriptPath), '..', '..'),
    // Fallback: import.meta.dir-based (works in dev with bun run)
    resolve(dirname(import.meta.dir ?? __dirname), '..', '..'),
    resolve(dirname(import.meta.dir ?? __dirname), '..'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'plugins', 'genie', 'agents'))) {
      return candidate;
    }
  }
  return candidates[0];
}

// ============================================================================
// Agent Scanner
// ============================================================================

/**
 * Scan the built-in agents directory for AGENTS.md files.
 * Each subdirectory with an AGENTS.md becomes a built-in agent.
 */
function scanAgents(agentsDir: string): BuiltinAgent[] {
  if (!existsSync(agentsDir)) return [];

  const agents: BuiltinAgent[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agentsPath = join(agentsDir, entry.name, 'AGENTS.md');
    if (!existsSync(agentsPath)) continue;

    const content = readFileSync(agentsPath, 'utf-8');
    const fm = parseFrontmatter(content);

    const name = fm.name || entry.name;
    const isCouncil = name.startsWith('council');

    agents.push({
      name,
      description: fm.description || '',
      agentPath: agentsPath,
      model: normalizeValue(fm.model),
      promptMode: fm.promptMode || undefined,
      category: isCouncil ? 'council' : 'role',
      color: fm.color,
    });
  }

  return agents;
}

// ============================================================================
// Built-in Agent Registry (loaded at module init)
// ============================================================================

const AGENTS_DIR = join(resolvePackageRoot(), 'plugins', 'genie', 'agents');
const _allAgents = scanAgents(AGENTS_DIR);

/** Built-in roles (engineer, reviewer, qa, fix, etc.). */
export const BUILTIN_ROLES: BuiltinAgent[] = _allAgents.filter((a) => a.category === 'role');

/** Built-in council members (council, council--questioner, etc.). */
export const BUILTIN_COUNCIL_MEMBERS: BuiltinAgent[] = _allAgents.filter((a) => a.category === 'council');

/** All built-in agents (roles + council). */
export const ALL_BUILTINS: BuiltinAgent[] = _allAgents;

// ============================================================================
// Lookup Helpers
// ============================================================================

/** Get a built-in agent by name. */
export function getBuiltin(name: string): BuiltinAgent | null {
  return ALL_BUILTINS.find((a) => a.name === name) ?? null;
}

/** Resolve the AGENTS.md file path for a built-in agent by name. */
export function resolveBuiltinAgentPath(name: string): string | null {
  const agent = getBuiltin(name);
  return agent?.agentPath ?? null;
}

/** List all built-in role names. */
export function listRoleNames(): string[] {
  return BUILTIN_ROLES.map((r) => r.name);
}

/** List all built-in council member names. */
export function listCouncilNames(): string[] {
  return BUILTIN_COUNCIL_MEMBERS.map((m) => m.name);
}
