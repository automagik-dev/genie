/**
 * Subscription-token layer for the observability event substrate.
 *
 * Token format is a compact JWT-style string `header.payload.signature`, all
 * three segments base64url-encoded. The signature is HMAC-SHA256 over
 * `header.payload` keyed by `GENIE_EVENTS_TOKEN_SECRET`. No external JWT
 * library is pulled in — keeping genie's runtime dependency footprint small
 * is a stated architectural rule in the wish.
 *
 * Payload claims (`TokenPayload`):
 *   - `role`           — one of the four RBAC roles
 *   - `allowed_types`  — explicit event-type allowlist (subset of role defaults)
 *   - `allowed_channels` — LISTEN channels this token may subscribe to
 *   - `tenant_id`      — matches RLS tenant; 'default' in single-tenant mode
 *   - `subscriber_id`  — stable id for the consumer agent (audit grouping)
 *   - `token_id`       — per-token uuid, used by the revocation list
 *   - `iat`, `exp`     — issued-at / expires-at epoch seconds (1h default)
 *
 * `verifyToken()` runs the full validation pipeline:
 *   signature → expiry → role known → tenant match → allowlist non-empty →
 *   revocation-list check (PG query, caller may pass a cached set for tests).
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { ALL_ROLES, RBACError, type Role, allowedChannels, resolveChannels } from './rbac.js';

export interface TokenPayload {
  role: Role;
  allowed_types: string[];
  allowed_channels: string[];
  tenant_id: string;
  subscriber_id: string;
  token_id: string;
  iat: number;
  exp: number;
}

export interface MintOptions {
  role: Role;
  /** Requested event-type allowlist. Empty array means "all defaults for the role". */
  allowed_types?: readonly string[];
  /** Requested LISTEN channel allowlist. Subset of role defaults; empty → role defaults. */
  allowed_channels?: readonly string[];
  tenant_id?: string;
  subscriber_id?: string;
  /** Time-to-live in seconds. Default 3600 (1h). Hard-capped at 24h. */
  ttl_seconds?: number;
  /** Override secret for tests; default reads from env. */
  secret?: string;
  /** Override `now` for tests. */
  now?: number;
}

export interface VerifyOptions {
  /** Override secret for tests; default reads from env. */
  secret?: string;
  /** Override `now` for tests. */
  now?: number;
  /** Precomputed revocation set for tests — skips the PG query when provided. */
  revokedTokenIds?: Set<string>;
  /** Expected tenant; if set, mismatch is a rejection. */
  expectedTenantId?: string;
}

export class TokenError extends Error {
  readonly code:
    | 'TOKEN_MALFORMED'
    | 'TOKEN_SIGNATURE_INVALID'
    | 'TOKEN_EXPIRED'
    | 'TOKEN_ROLE_UNKNOWN'
    | 'TOKEN_TENANT_MISMATCH'
    | 'TOKEN_REVOKED'
    | 'TOKEN_ALLOWLIST_EMPTY';
  constructor(code: TokenError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'TokenError';
  }
}

// ---------------------------------------------------------------------------
// Base64url helpers — no dependency on `Buffer.toString('base64url')` which
// is present in Node 16+ / bun but absent in the bun bundler's older targets.
// ---------------------------------------------------------------------------

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// ---------------------------------------------------------------------------
// Secret resolution
// ---------------------------------------------------------------------------

const DEV_FALLBACK_SECRET = 'genie-events-token-fallback-dev-only';

function resolveSecret(override?: string): string {
  if (override) return override;
  const env = process.env.GENIE_EVENTS_TOKEN_SECRET;
  if (env && env.length > 0) return env;
  return DEV_FALLBACK_SECRET;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

const HEADER = { alg: 'HS256', typ: 'GEVT' } as const;

function sign(input: string, secret: string): string {
  return b64urlEncode(createHmac('sha256', secret).update(input).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

const MAX_TTL_SECONDS = 24 * 3600;

/**
 * Mint a signed subscription token. Validates requested allowlists against the
 * role's default scope and throws {@link RBACError} on escalation attempts.
 */
export function mintToken(opts: MintOptions): { token: string; payload: TokenPayload } {
  if (!(ALL_ROLES as readonly string[]).includes(opts.role)) {
    throw new RBACError(`unknown role '${opts.role}'`);
  }

  // Resolve channel allowlist against role defaults — throws RBACError on
  // out-of-scope request.
  const channels = resolveChannels(opts.role, opts.allowed_channels ?? []);

  // allowed_types must be reachable via at least one of the allowed channels.
  // An empty array means "all types visible through the channels".
  const types = (opts.allowed_types ?? []).slice();
  for (const t of types) {
    const prefix = t.split('.')[0];
    if (!channels.some((c) => c === `genie_events.${prefix}`)) {
      throw new RBACError(`type '${t}' is not reachable via the requested channels for role ${opts.role}`);
    }
  }

  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const ttl = Math.min(Math.max(opts.ttl_seconds ?? 3600, 60), MAX_TTL_SECONDS);
  const payload: TokenPayload = {
    role: opts.role,
    allowed_types: types,
    allowed_channels: [...channels],
    tenant_id: opts.tenant_id ?? 'default',
    subscriber_id: opts.subscriber_id ?? `sub-${randomUUID().slice(0, 12)}`,
    token_id: randomUUID(),
    iat: now,
    exp: now + ttl,
  };

  const secret = resolveSecret(opts.secret);
  const encodedHeader = b64urlEncode(JSON.stringify(HEADER));
  const encodedPayload = b64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return { token: `${signingInput}.${signature}`, payload };
}

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

/**
 * Validate a signed subscription token. Returns the payload on success;
 * throws {@link TokenError} with a typed code otherwise.
 *
 * Revocation check: if `revokedTokenIds` is supplied the caller handles
 * revocation lookup. Otherwise this function imports db.ts lazily and runs a
 * single-row probe against `genie_events_revocations`. The lazy import keeps
 * the module load cheap for tests that only exercise signing.
 */
function decodeAndVerifyPayload(token: string, secret: string): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new TokenError('TOKEN_MALFORMED', 'token is not a three-segment JWT');
  }
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
  if (!safeEqual(expected, signature)) {
    throw new TokenError('TOKEN_SIGNATURE_INVALID', 'signature mismatch');
  }
  try {
    return JSON.parse(b64urlDecode(encodedPayload).toString('utf8')) as TokenPayload;
  } catch {
    throw new TokenError('TOKEN_MALFORMED', 'payload is not valid JSON');
  }
}

function assertPayloadClaims(payload: TokenPayload, opts: VerifyOptions): void {
  if (!(ALL_ROLES as readonly string[]).includes(payload.role)) {
    throw new TokenError('TOKEN_ROLE_UNKNOWN', `unknown role '${payload.role}'`);
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (nowSec >= payload.exp) {
    throw new TokenError('TOKEN_EXPIRED', `token expired at ${payload.exp} (now=${nowSec})`);
  }
  if (opts.expectedTenantId !== undefined && payload.tenant_id !== opts.expectedTenantId) {
    throw new TokenError(
      'TOKEN_TENANT_MISMATCH',
      `token tenant ${payload.tenant_id} does not match expected ${opts.expectedTenantId}`,
    );
  }
  const hasTypes = Array.isArray(payload.allowed_types) && payload.allowed_types.length > 0;
  const hasChannels = Array.isArray(payload.allowed_channels) && payload.allowed_channels.length > 0;
  if (!hasTypes && !hasChannels) {
    throw new TokenError('TOKEN_ALLOWLIST_EMPTY', 'token must carry at least one of allowed_types / allowed_channels');
  }
  const roleDefaults = allowedChannels(payload.role);
  for (const ch of payload.allowed_channels) {
    if (!roleDefaults.includes(ch)) {
      throw new TokenError('TOKEN_ROLE_UNKNOWN', `channel ${ch} outside role ${payload.role} defaults`);
    }
  }
}

async function assertNotRevoked(payload: TokenPayload, opts: VerifyOptions): Promise<void> {
  const revoked = opts.revokedTokenIds ? opts.revokedTokenIds.has(payload.token_id) : await isRevoked(payload.token_id);
  if (revoked) throw new TokenError('TOKEN_REVOKED', `token_id ${payload.token_id} revoked`);
}

export async function verifyToken(token: string, opts: VerifyOptions = {}): Promise<TokenPayload> {
  const secret = resolveSecret(opts.secret);
  const payload = decodeAndVerifyPayload(token, secret);
  assertPayloadClaims(payload, opts);
  await assertNotRevoked(payload, opts);
  return payload;
}

/** Persist a revocation entry for a token_id. Idempotent on duplicate id. */
export async function revokeToken(args: {
  token_id: string;
  subscriber_id?: string;
  tenant_id?: string;
  revoked_by: string;
  reason: string;
}): Promise<void> {
  const { getConnection } = await import('../db.js');
  const sql = await getConnection();
  await sql`
    INSERT INTO genie_events_revocations (token_id, subscriber_id, tenant_id, revoked_by, reason)
    VALUES (${args.token_id}, ${args.subscriber_id ?? null}, ${args.tenant_id ?? 'default'}, ${args.revoked_by}, ${args.reason})
    ON CONFLICT (token_id) DO NOTHING
  `;
}

/** Return revoked token_ids for a tenant — used by a long-lived stream to cache. */
export async function listRevokedTokenIds(tenantId = 'default'): Promise<Set<string>> {
  const { getConnection } = await import('../db.js');
  const sql = await getConnection();
  const rows = (await sql`
    SELECT token_id FROM genie_events_revocations WHERE tenant_id = ${tenantId}
  `) as Array<{ token_id: string }>;
  return new Set(rows.map((r) => r.token_id));
}

async function isRevoked(tokenId: string): Promise<boolean> {
  try {
    const { getConnection } = await import('../db.js');
    const sql = await getConnection();
    const rows = (await sql`
      SELECT 1 FROM genie_events_revocations WHERE token_id = ${tokenId} LIMIT 1
    `) as unknown[];
    return rows.length > 0;
  } catch {
    // If PG is unreachable we fail closed — a signed token with no
    // revocation-list fallback cannot be verified safely.
    throw new TokenError('TOKEN_REVOKED', 'revocation list unreachable; failing closed');
  }
}
