/**
 * Agent CWD Resolution — resolve which agent to launch based on the current working directory.
 *
 * Resolution precedence:
 *   1. cwd IS an agent dir (agents/<name>/ with AGENTS.md) → that agent, source = "exact"
 *   2. cwd is inside an agent dir → walk up to agents/<name>/ → that agent, source = "parent"
 *   3. cwd is workspace root or non-agent subfolder → walk up checking for AGENTS.md,
 *      then fall back to default "genie" agent, source = "default"
 *   4. no workspace → returns null (caller should trigger init flow)
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export type ResolvedSource = 'exact' | 'parent' | 'default';

export interface ResolvedAgent {
  /** Agent name (directory name under agents/) */
  agent: string;
  /** How the agent was resolved */
  source: ResolvedSource;
}

/** Check if `rel` is a relative path that stays within its base (no leading ".." or absolute). */
function isRelativeWithin(rel: string, original: string): boolean {
  return !rel.startsWith('..') && rel !== original;
}

/**
 * Try to resolve from the canonical agents/ directory.
 * Returns the agent if cwd is inside agents/<name>/ and that agent has AGENTS.md.
 */
function resolveFromCanonicalDir(cwd: string, agentsDir: string): ResolvedAgent | null {
  const relToAgents = relative(agentsDir, cwd);
  if (!isRelativeWithin(relToAgents, cwd)) return null;

  const segments = relToAgents.split(sep).filter(Boolean);
  if (segments.length === 0) return null;

  const agentName = segments[0];
  if (!existsSync(join(agentsDir, agentName, 'AGENTS.md'))) return null;

  const source: ResolvedSource = segments.length === 1 ? 'exact' : 'parent';
  return { agent: agentName, source };
}

/**
 * Walk up from cwd toward workspaceRoot, checking for AGENTS.md at each level.
 * Handles non-canonical agent locations (agents placed outside agents/).
 */
function resolveFromWalkUp(cwd: string, workspaceRoot: string): ResolvedAgent | null {
  const wsRel = relative(workspaceRoot, cwd);
  if (!isRelativeWithin(wsRel, cwd)) return null;

  let current = cwd;
  while (current !== workspaceRoot && current !== dirname(current)) {
    if (existsSync(join(current, 'AGENTS.md'))) {
      return { agent: basename(current), source: 'parent' };
    }
    current = dirname(current);
  }
  return null;
}

/**
 * Resolve which agent to attach/start based on the current working directory.
 *
 * @param cwd - Current working directory
 * @param workspaceRoot - Absolute path to the workspace root (contains .genie/)
 * @returns Resolved agent info with source indicating how it was found
 */
export function resolveAgentFromCwd(cwd: string, workspaceRoot: string): ResolvedAgent {
  return (
    resolveFromCanonicalDir(cwd, join(workspaceRoot, 'agents')) ??
    resolveFromWalkUp(cwd, workspaceRoot) ?? { agent: 'genie', source: 'default' }
  );
}
