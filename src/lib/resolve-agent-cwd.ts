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

type ResolvedSource = 'exact' | 'parent' | 'default';

interface ResolvedAgent {
  /** Agent name (directory name under agents/) */
  agent: string;
  /** How the agent was resolved */
  source: ResolvedSource;
}

/**
 * Resolve which agent to attach/start based on the current working directory.
 *
 * @param cwd - Current working directory
 * @param workspaceRoot - Absolute path to the workspace root (contains .genie/)
 * @returns Resolved agent info, or null if no workspace is provided
 */
export function resolveAgentFromCwd(cwd: string, workspaceRoot: string): ResolvedAgent {
  const agentsDir = join(workspaceRoot, 'agents');

  // Check if cwd is inside the agents/ directory tree
  const relToAgents = relative(agentsDir, cwd);
  const isInsideAgents = !relToAgents.startsWith('..') && relToAgents !== cwd;

  if (isInsideAgents) {
    // Extract the top-level agent name (first path segment under agents/)
    const segments = relToAgents.split(sep).filter(Boolean);
    if (segments.length > 0) {
      const agentName = segments[0];
      const agentsMd = join(agentsDir, agentName, 'AGENTS.md');

      if (existsSync(agentsMd)) {
        // cwd IS the agent dir → exact; cwd is deeper inside → parent
        const source: ResolvedSource = segments.length === 1 ? 'exact' : 'parent';
        return { agent: agentName, source };
      }
    }
  }

  // Walk up from cwd toward workspace root, checking for AGENTS.md at each level.
  // This handles non-canonical agent locations (e.g., someone placed an agent
  // outside agents/ but still inside the workspace).
  let current = cwd;
  const wsRel = relative(workspaceRoot, cwd);
  if (!wsRel.startsWith('..') && wsRel !== cwd) {
    while (current !== workspaceRoot && current !== dirname(current)) {
      if (existsSync(join(current, 'AGENTS.md'))) {
        return { agent: basename(current), source: 'parent' };
      }
      current = dirname(current);
    }
  }

  // Fall back to default specialist agent
  return { agent: 'genie', source: 'default' };
}
