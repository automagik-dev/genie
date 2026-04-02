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

/** Resolve agent name from available context. */
export function resolveAgentName(payload: HookPayload): string {
  // 1. Env var (genie spawn sets this)
  const envName = process.env.GENIE_AGENT_NAME;
  if (envName) return envName;

  // 2. CC native team teammate name
  const teammate = payload.teammate_name;
  if (teammate) return teammate;

  // 3. .claude/settings.local.json agentName
  const cwd = payload.cwd;
  if (cwd) {
    const localSettings = join(cwd, '.claude', 'settings.local.json');
    if (existsSync(localSettings)) {
      try {
        const parsed = JSON.parse(readFileSync(localSettings, 'utf-8'));
        if (parsed.agentName) return parsed.agentName;
      } catch {
        // ignore parse errors
      }
    }
  }

  // 4. Basename of cwd
  if (cwd) {
    const name = basename(cwd);
    if (name && name !== '/' && name !== '.') return name;
  }

  // 5. Session ID prefix
  const sessionId = payload.session_id;
  if (sessionId) return `session-${sessionId.slice(0, 8)}`;

  // 6. Fallback
  return 'unknown';
}

/** Resolve team name from available context. */
export function resolveTeamName(payload: HookPayload): string | undefined {
  return payload.team_name ?? process.env.GENIE_TEAM ?? undefined;
}
