/**
 * `genie events subscribe --role <role> --types <csv> [--channels <csv>] [--ttl <dur>]`
 *
 * Mints a signed JWT-style subscription token for a consumer agent. The token
 * must be presented via `GENIE_EVENTS_TOKEN` env var by `genie events stream
 * --follow` (enforced when GENIE_EVENTS_TOKEN_REQUIRED is set).
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { ALL_ROLES, RBACError, type Role, allowedChannels } from '../lib/events/rbac.js';
import { type TokenPayload, mintToken } from '../lib/events/tokens.js';
import { color } from '../lib/term-format.js';

export interface SubscribeOptions {
  role?: string;
  types?: string;
  channels?: string;
  ttl?: string; // e.g. '1h', '30m', '24h'
  tenant?: string;
  subscriberId?: string;
  json?: boolean;
}

function parseDuration(dur: string | undefined, defaultSeconds: number): number {
  if (!dur) return defaultSeconds;
  const match = dur.match(/^(\d+)([smhd])$/);
  if (!match) {
    const n = Number.parseInt(dur, 10);
    return Number.isFinite(n) ? n : defaultSeconds;
  }
  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';
  const mult = { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
  return amount * mult;
}

function parseCsv(csv: string | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function validateRole(role: string | undefined): Role {
  if (!role || !(ALL_ROLES as readonly string[]).includes(role)) {
    throw new Error(`--role is required and must be one of: ${ALL_ROLES.join(', ')}`);
  }
  return role as Role;
}

/**
 * Mint a token and print it. Returns the token for programmatic callers.
 */
export async function subscribeCommand(options: SubscribeOptions): Promise<{ token: string; payload: TokenPayload }> {
  const role = validateRole(options.role);
  const types = parseCsv(options.types);
  const channels = parseCsv(options.channels);
  const ttlSeconds = parseDuration(options.ttl, 3600);

  // If caller only passed --types, derive the minimum set of channels from
  // them so the token's `allowed_channels` is explicit and audit-loggable.
  const derivedChannels =
    channels.length > 0
      ? channels
      : types.length > 0
        ? Array.from(new Set(types.map((t) => `genie_events.${t.split('.')[0]}`)))
        : [...allowedChannels(role)];

  try {
    const { token, payload } = mintToken({
      role,
      allowed_types: types,
      allowed_channels: derivedChannels,
      tenant_id: options.tenant,
      subscriber_id: options.subscriberId,
      ttl_seconds: ttlSeconds,
    });

    if (options.json) {
      console.log(JSON.stringify({ token, payload }, null, 2));
    } else {
      console.log(color('dim', `# genie events subscribe --role ${role}`));
      console.log(color('brightCyan', `subscriber_id: ${payload.subscriber_id}`));
      console.log(color('dim', `token_id:      ${payload.token_id}`));
      console.log(color('dim', `role:          ${payload.role}`));
      console.log(color('dim', `tenant_id:     ${payload.tenant_id}`));
      console.log(
        color(
          'dim',
          `allowed_types: ${payload.allowed_types.length > 0 ? payload.allowed_types.join(',') : '(role default)'}`,
        ),
      );
      console.log(color('dim', `channels:      ${payload.allowed_channels.join(',')}`));
      console.log(color('dim', `expires_at:    ${new Date(payload.exp * 1000).toISOString()}`));
      console.log('');
      console.log(color('green', 'export GENIE_EVENTS_TOKEN=\\'));
      console.log(token);
    }
    return { token, payload };
  } catch (err) {
    if (err instanceof RBACError) {
      console.error(color('red', `RBAC denied: ${err.message}`));
      process.exit(2);
    }
    throw err;
  }
}
