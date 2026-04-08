/**
 * Smart Agent Name Resolution — derive meaningful agent identity from context.
 *
 * Cascade (first non-empty wins):
 *   1. GENIE_AGENT_NAME env var (set by genie spawn)
 *   2. payload.teammate_name (CC native team context)
 *   3. .claude/settings.local.json → agentName in cwd
 *   4. Basename of payload.cwd (project name)
 *   5. Prefix of payload.session_id
 *   6. 'unknown'
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HookPayload } from './types.js';

/** Try to read agentName from .claude/settings.local.json in the given directory. */
function readAgentNameFromSettings(cwd: string): string | undefined {
  const localSettings = join(cwd, '.claude', 'settings.local.json');
  if (!existsSync(localSettings)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(localSettings, 'utf-8'));
    return parsed.agentName || undefined;
  } catch {
    return undefined;
  }
}

/** Derive a name from the cwd basename, if it looks like a project name. */
function nameFromCwd(cwd: string): string | undefined {
  const name = basename(cwd);
  return name && name !== '/' && name !== '.' ? name : undefined;
}

/** Resolve agent name from available context. */
export function resolveAgentName(payload: HookPayload): string {
  const cwd = payload.cwd;
  return (
    process.env.GENIE_AGENT_NAME ||
    payload.teammate_name ||
    (cwd && readAgentNameFromSettings(cwd)) ||
    (cwd && nameFromCwd(cwd)) ||
    (payload.session_id && `session-${payload.session_id.slice(0, 8)}`) ||
    'unknown'
  );
}

/** Resolve team name from available context. */
export function resolveTeamName(payload: HookPayload): string | undefined {
  return payload.team_name ?? process.env.GENIE_TEAM ?? undefined;
}
