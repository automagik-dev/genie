/**
 * Smart Agent Name Resolution — derive meaningful agent identity from context.
 *
 * Cascade (first non-empty wins) per wish observability-signal-normalization Group 3:
 *   1. payload context (CC native team `teammate_name`)
 *   2. executor env (`GENIE_AGENT_NAME` set by `genie spawn`)
 *   3. session context (`.claude/settings.local.json` agentName in cwd)
 *   4. cwd basename (project name)
 *   5. session_id prefix (last-resort identity)
 *   6. `'harness'` — explicit non-agent classification, NOT `'unknown'`
 *
 * The `'harness'` sentinel marks hook activity that originated from the harness
 * itself (CLI command, daemon background work, tests) rather than an
 * identifiable agent. Downstream queries can then distinguish harness/system
 * traffic from real agent traffic without relying on the `'unknown'` bucket
 * which previously masked both unknown agents AND legitimate non-agent work.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HookPayload } from './types.js';

/** Sentinel value emitted when no agent context can be derived. */
export const HARNESS_AGENT = 'harness';

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

/**
 * Resolve agent name from available context.
 *
 * Returns `HARNESS_AGENT` ('harness') when no agent context is present.
 * Callers can use `isHarnessAgent()` to distinguish system/harness rows from
 * real agent rows for filtering and aggregation.
 */
export function resolveAgentName(payload: HookPayload): string {
  const cwd = payload.cwd;
  return (
    payload.teammate_name ||
    process.env.GENIE_AGENT_NAME ||
    (cwd && readAgentNameFromSettings(cwd)) ||
    (cwd && nameFromCwd(cwd)) ||
    (payload.session_id && `session-${payload.session_id.slice(0, 8)}`) ||
    HARNESS_AGENT
  );
}

/** True when the resolved name represents harness/system activity, not an agent. */
export function isHarnessAgent(name: string): boolean {
  return name === HARNESS_AGENT;
}

/** Resolve team name from available context. */
export function resolveTeamName(payload: HookPayload): string | undefined {
  return payload.team_name ?? process.env.GENIE_TEAM ?? undefined;
}
