/**
 * Hook env identity — prefer GENIE_AGENT_ID (UUID) over GENIE_AGENT_NAME.
 *
 * Migration 061's FK lockdown made bare names unsafe at write time; every
 * hook consumer that previously read GENIE_AGENT_NAME must now prefer the
 * UUID form when present so downstream PG writes satisfy fk_mailbox_from_worker
 * (and peers).
 *
 * Why a separate helper: the spawn flow exports both env vars; consumers
 * should use the UUID for any registry/PG lookup but keep the name available
 * for human-facing display ([from:<agentName>]). This module gives them a
 * uniform read surface so we don't sprinkle the regex check across handlers.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the value looks like a UUID. */
export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Read GENIE_AGENT_ID; return only when it's a UUID (silently drops bad input). */
export function readEnvAgentId(): string | undefined {
  const id = process.env.GENIE_AGENT_ID;
  return isUuid(id) ? id : undefined;
}

/** Read GENIE_AGENT_NAME; returns undefined when unset/empty. */
export function readEnvAgentName(): string | undefined {
  const name = process.env.GENIE_AGENT_NAME;
  return name && name.length > 0 ? name : undefined;
}
