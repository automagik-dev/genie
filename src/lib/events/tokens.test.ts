/**
 * Unit tests for the subscription-token layer.
 *
 * These tests stay PG-free: `verifyToken` accepts a pre-computed
 * `revokedTokenIds` set so the DB probe path is never exercised here. The
 * rbac-matrix.sh integration script covers the real PG round-trip.
 *
 * Wish: genie-serve-structured-observability, Group 5.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_ROLES, RBACError, type Role, allowedChannels } from './rbac.js';
import { TokenError, mintToken, verifyToken } from './tokens.js';

const TEST_SECRET = 'test-secret-group-5-unit';

beforeEach(() => {
  process.env.GENIE_EVENTS_TOKEN_SECRET = TEST_SECRET;
});

describe('mintToken', () => {
  test('mints a valid token for each role', async () => {
    for (const role of ALL_ROLES) {
      const { token, payload } = mintToken({
        role,
        allowed_types: [],
        allowed_channels: [],
        subscriber_id: `sub-${role}`,
      });

      expect(token.split('.').length).toBe(3);
      expect(payload.role).toBe(role);
      expect(payload.subscriber_id).toBe(`sub-${role}`);
      expect(payload.exp).toBeGreaterThan(payload.iat);
      expect(payload.allowed_channels.length).toBeGreaterThan(0);

      // Round-trip verify — no revocation check (empty set).
      const verified = await verifyToken(token, { revokedTokenIds: new Set() });
      expect(verified.role).toBe(role);
      expect(verified.token_id).toBe(payload.token_id);
    }
  });

  test('rejects an unknown role', () => {
    expect(() => mintToken({ role: 'bogus' as Role })).toThrow(RBACError);
  });

  test('rejects channel outside role default set', () => {
    expect(() =>
      mintToken({
        role: 'events:subscriber',
        allowed_channels: ['genie_events.audit'],
      }),
    ).toThrow(RBACError);
  });

  test('rejects type not reachable via the requested channels', () => {
    expect(() =>
      mintToken({
        role: 'events:subscriber',
        allowed_channels: ['genie_events.mailbox'],
        allowed_types: ['error.raised'],
      }),
    ).toThrow(RBACError);
  });

  test('clamps TTL to the 24h ceiling and 60s floor', () => {
    const long = mintToken({ role: 'events:admin', ttl_seconds: 999_999, now: 1_700_000_000_000 });
    expect(long.payload.exp - long.payload.iat).toBe(24 * 3600);

    const short = mintToken({ role: 'events:admin', ttl_seconds: 1, now: 1_700_000_000_000 });
    expect(short.payload.exp - short.payload.iat).toBe(60);
  });
});

describe('verifyToken', () => {
  test('rejects a malformed token', async () => {
    await expect(verifyToken('not.a.jwt.extra', { revokedTokenIds: new Set() })).rejects.toBeInstanceOf(TokenError);
    await expect(verifyToken('abcdef', { revokedTokenIds: new Set() })).rejects.toBeInstanceOf(TokenError);
  });

  test('rejects a tampered signature', async () => {
    const { token } = mintToken({ role: 'events:operator' });
    const [h, p] = token.split('.');
    const tampered = `${h}.${p}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    await expect(verifyToken(tampered, { revokedTokenIds: new Set() })).rejects.toMatchObject({
      code: 'TOKEN_SIGNATURE_INVALID',
    });
  });

  test('rejects an expired token', async () => {
    const { token } = mintToken({
      role: 'events:operator',
      ttl_seconds: 60,
      now: 1_700_000_000_000,
    });
    await expect(
      verifyToken(token, { revokedTokenIds: new Set(), now: 1_700_000_000_000 + 120_000 }),
    ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  test('rejects a forged payload with out-of-role channel', async () => {
    // Build a token payload for events:subscriber but claim an audit channel.
    // We smuggle the claim in by minting as admin then editing the role.
    const secret = TEST_SECRET;
    const { mintToken: mt } = await import('./tokens.js');
    const { token } = mt({
      role: 'events:admin',
      allowed_channels: ['genie_events.audit'],
      secret,
    });
    // Swap role in the decoded payload — signature will then mismatch (correctly).
    const [h, p, _sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
    payload.role = 'events:subscriber';
    const newP = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const forged = `${h}.${newP}.${_sig}`;
    await expect(verifyToken(forged, { revokedTokenIds: new Set() })).rejects.toMatchObject({
      code: 'TOKEN_SIGNATURE_INVALID',
    });
  });

  test('rejects a token whose token_id is in the revocation set', async () => {
    const { token, payload } = mintToken({ role: 'events:operator' });
    await expect(verifyToken(token, { revokedTokenIds: new Set([payload.token_id]) })).rejects.toMatchObject({
      code: 'TOKEN_REVOKED',
    });
  });

  test('rejects tenant mismatch when expectedTenantId supplied', async () => {
    const { token } = mintToken({ role: 'events:operator', tenant_id: 'tenant-a' });
    await expect(
      verifyToken(token, { revokedTokenIds: new Set(), expectedTenantId: 'tenant-b' }),
    ).rejects.toMatchObject({ code: 'TOKEN_TENANT_MISMATCH' });
  });

  test('rejects empty allowlist after mint-layer bypass', async () => {
    // Craft a payload with empty allow-lists, re-sign correctly.
    const { createHmac } = await import('node:crypto');
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'GEVT' })).toString('base64url');
    const payload = {
      role: 'events:operator' as Role,
      allowed_types: [],
      allowed_channels: [],
      tenant_id: 'default',
      subscriber_id: 'sub-empty',
      token_id: 'bogus-empty',
      iat: now,
      exp: now + 3600,
    };
    const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', TEST_SECRET).update(`${header}.${p}`).digest('base64url');
    const forged = `${header}.${p}.${sig}`;
    await expect(verifyToken(forged, { revokedTokenIds: new Set() })).rejects.toMatchObject({
      code: 'TOKEN_ALLOWLIST_EMPTY',
    });
  });
});

describe('role channel defaults', () => {
  test('subscriber does not include audit or emitter meta channels', () => {
    const channels = allowedChannels('events:subscriber');
    expect(channels).not.toContain('genie_events.audit');
    expect(channels).not.toContain('genie_events.emitter');
  });

  test('audit role has audit channel', () => {
    const channels = allowedChannels('events:audit');
    expect(channels).toContain('genie_events.audit');
  });

  test('admin has all channels including audit', () => {
    const channels = allowedChannels('events:admin');
    expect(channels).toContain('genie_events.audit');
    expect(channels).toContain('genie_events.emitter');
    expect(channels).toContain('genie_events.cli');
  });
});
