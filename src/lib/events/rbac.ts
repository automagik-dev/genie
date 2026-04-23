/**
 * RBAC matrix for the observability event substrate.
 *
 * Four roles:
 *   - `events:admin`      — break-glass admin; un-hash, export-audit, rotate keys
 *   - `events:operator`   — internal genie subsystems write events
 *   - `events:subscriber` — external consumer agents read non-audit events
 *   - `events:audit`      — compliance reader; WORM tier only
 *
 * This module is the app-layer enforcement. Migration 041_rbac_roles.sql
 * replicates the matrix at the PG role level as defense-in-depth; if one
 * layer is misconfigured the other still catches the violation.
 *
 * Channel prefixes mirror `DEFAULT_CHANNEL_PREFIXES` in v2-query.ts plus the
 * dedicated `audit` prefix for the WORM table.
 */

import type { EventType } from './registry.js';
import { listTypes } from './registry.js';

export type Role = 'events:admin' | 'events:operator' | 'events:subscriber' | 'events:audit';

export const ALL_ROLES: readonly Role[] = [
  'events:admin',
  'events:operator',
  'events:subscriber',
  'events:audit',
] as const;

export type TableName = 'genie_runtime_events' | 'genie_runtime_events_debug' | 'genie_runtime_events_audit';
export type Privilege = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

/** Per-role (table, privilege) allow-list. Matches migration 041. */
const TABLE_MATRIX: Record<Role, Record<TableName, readonly Privilege[]>> = {
  'events:admin': {
    genie_runtime_events: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    genie_runtime_events_debug: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
    // Admin reads audit but CANNOT INSERT — only the dedicated audit role can
    // write the WORM tier. Admin also cannot UPDATE/DELETE (enforced both by
    // the WORM trigger in migration 039 and by this matrix).
    genie_runtime_events_audit: ['SELECT'],
  },
  'events:operator': {
    genie_runtime_events: ['SELECT', 'INSERT'],
    genie_runtime_events_debug: ['SELECT', 'INSERT'],
    genie_runtime_events_audit: [],
  },
  'events:subscriber': {
    genie_runtime_events: ['SELECT'],
    genie_runtime_events_debug: [],
    genie_runtime_events_audit: [],
  },
  'events:audit': {
    genie_runtime_events: [],
    genie_runtime_events_debug: [],
    genie_runtime_events_audit: ['SELECT', 'INSERT'],
  },
};

/**
 * Channel prefixes a role is allowed to LISTEN on. Matches the LISTEN-channel
 * namespacing from migration 040 (`genie_events.<prefix>`).
 *
 * A subscriber token's `allowed_types` must be a subset of the role's prefixes
 * intersected with the caller's declared allowlist — i.e., the most restrictive
 * of (role default, token allowlist) wins.
 */
const CHANNEL_MATRIX: Record<Role, readonly string[]> = {
  'events:admin': [
    'genie_events.cli',
    'genie_events.agent',
    'genie_events.wish',
    'genie_events.hook',
    'genie_events.resume',
    'genie_events.executor',
    'genie_events.mailbox',
    'genie_events.error',
    'genie_events.state_transition',
    'genie_events.schema',
    'genie_events.session',
    'genie_events.tmux',
    'genie_events.cache',
    'genie_events.runbook',
    'genie_events.consumer',
    'genie_events.permissions',
    'genie_events.team',
    'genie_events.emitter',
    'genie_events.notify',
    'genie_events.stream',
    'genie_events.correlation',
    'genie_events.audit',
  ],
  'events:operator': [
    'genie_events.cli',
    'genie_events.agent',
    'genie_events.wish',
    'genie_events.hook',
    'genie_events.resume',
    'genie_events.executor',
    'genie_events.mailbox',
    'genie_events.error',
    'genie_events.state_transition',
    'genie_events.session',
    'genie_events.tmux',
    'genie_events.cache',
    'genie_events.runbook',
    'genie_events.consumer',
    'genie_events.permissions',
    'genie_events.team',
    'genie_events.emitter',
    'genie_events.notify',
    'genie_events.stream',
    'genie_events.correlation',
  ],
  'events:subscriber': [
    // Subscribers are deliberately restricted — no audit, no emitter meta, no
    // raw CLI payloads by default. Consumer agents opt in via token allowlist.
    'genie_events.mailbox',
    'genie_events.state_transition',
    'genie_events.error',
    'genie_events.runbook',
    'genie_events.agent',
    'genie_events.wish',
    'genie_events.session',
    'genie_events.executor',
    'genie_events.hook',
    'genie_events.resume',
    'genie_events.consumer',
    'genie_events.cache',
    'genie_events.tmux',
    'genie_events.permissions',
    'genie_events.team',
  ],
  'events:audit': ['genie_events.audit', 'genie_events.team', 'genie_events.permissions'],
};

/** Return true when the (role, table, privilege) combination is permitted. */
export function canAccessTable(role: Role, table: TableName, priv: Privilege): boolean {
  return TABLE_MATRIX[role][table].includes(priv);
}

/** The full (table → privileges) map for a role. */
export function tablePrivileges(role: Role): Record<TableName, readonly Privilege[]> {
  return TABLE_MATRIX[role];
}

/** The list of channels a role may LISTEN on (pre-token allowlist). */
export function allowedChannels(role: Role): readonly string[] {
  return CHANNEL_MATRIX[role];
}

/**
 * Validate a requested channel against the role default set. Throws a typed
 * RBACError on violation so callers can distinguish permission failure from
 * other errors.
 */
export class RBACError extends Error {
  readonly code: 'RBAC_DENIED';
  constructor(message: string) {
    super(message);
    this.code = 'RBAC_DENIED';
    this.name = 'RBACError';
  }
}

export function assertChannelAllowed(role: Role, channel: string): void {
  if (!allowedChannels(role).includes(channel)) {
    throw new RBACError(`role ${role} is not permitted to LISTEN on channel '${channel}'`);
  }
}

/**
 * Narrow a role's default channel set by a requested allowlist from a token.
 * Returns the intersection; throws if any requested channel is outside the
 * role default (attempted privilege escalation).
 */
export function resolveChannels(role: Role, requested: readonly string[]): readonly string[] {
  const defaults = allowedChannels(role);
  for (const ch of requested) {
    if (!defaults.includes(ch)) {
      throw new RBACError(`role ${role} cannot LISTEN on '${ch}' (outside role default set)`);
    }
  }
  return requested.length > 0 ? requested : defaults;
}

/**
 * Map a channel name (`genie_events.<prefix>`) to the set of registered event
 * types in that prefix. Used by token validation to ensure that `allowed_types`
 * are actually reachable given the requested channels.
 */
export function typesForChannel(channel: string): EventType[] {
  const prefix = channel.replace(/^genie_events\./, '');
  return listTypes().filter((t) => t.split('.')[0] === prefix) as EventType[];
}

/**
 * A token can carry a specific allowlist of event *types*. This returns true
 * if the type is reachable by the requested role + channels.
 */
export function typeReachable(role: Role, type: string, channels: readonly string[]): boolean {
  const prefix = type.split('.')[0];
  const channel = `genie_events.${prefix}`;
  if (!channels.includes(channel)) return false;
  return allowedChannels(role).includes(channel);
}

/** Full serializable snapshot of the matrix — returned by CLI `--explain`. */
export function describeMatrix(): {
  roles: readonly Role[];
  tables: Record<Role, Record<TableName, readonly Privilege[]>>;
  channels: Record<Role, readonly string[]>;
} {
  return { roles: ALL_ROLES, tables: TABLE_MATRIX, channels: CHANNEL_MATRIX };
}
