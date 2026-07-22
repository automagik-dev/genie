// Guards the ws trust boundary (README "Trust boundary" decision): the loopback-Host
// same-origin gate plus the GENIE_UI_ALLOWED_ORIGINS allowlist that together keep a
// cross-origin browser drive-by AND a DNS-rebinding attack out of the live shells.
import { describe, expect, it } from 'bun:test';
import type http from 'node:http';
import { verifyClient } from './index';

const reqWith = (host?: string) => ({ headers: { host } }) as unknown as http.IncomingMessage;

describe('verifyClient', () => {
  it('accepts a same-origin browser connection (Origin host === page host)', () => {
    expect(verifyClient({ origin: 'http://localhost:8787', req: reqWith('localhost:8787') })).toBe(true);
  });

  it('accepts a same-origin loopback IP connection (127.0.0.1)', () => {
    expect(verifyClient({ origin: 'http://127.0.0.1:8787', req: reqWith('127.0.0.1:8787') })).toBe(true);
  });

  it('accepts a same-origin IPv6 loopback connection ([::1])', () => {
    expect(verifyClient({ origin: 'http://[::1]:8787', req: reqWith('[::1]:8787') })).toBe(true);
  });

  it('rejects a non-loopback LAN host even when Origin matches the Host header', () => {
    // Same-origin alone is NOT enough for a non-loopback Host: without an allowlist
    // entry a LAN host must be rejected (this is the anti-rebinding contract).
    expect(verifyClient({ origin: 'http://192.168.1.5:8787', req: reqWith('192.168.1.5:8787') })).toBe(false);
  });

  it('rejects a DNS-rebinding attack where Origin === Host are both attacker-controlled (evil.com)', () => {
    // Classic DNS rebinding: attacker page on evil.com:8787 rebinds evil.com -> 127.0.0.1.
    // The browser sends Origin: http://evil.com:8787 AND Host: evil.com:8787, so a naive
    // same-origin check (Origin.host === Host) passes. The real Host is still the
    // non-loopback evil.com, so the loopback-Host gate falls through to the allowlist
    // and rejects. This test permanently owns that regression.
    expect(verifyClient({ origin: 'http://evil.com:8787', req: reqWith('evil.com:8787') })).toBe(false);
  });

  it('accepts a LAN host when its Origin is in GENIE_UI_ALLOWED_ORIGINS (the escape hatch)', () => {
    const prev = process.env.GENIE_UI_ALLOWED_ORIGINS;
    process.env.GENIE_UI_ALLOWED_ORIGINS = 'http://192.168.1.5:8787';
    try {
      // Re-import a fresh module so the allowlist is read from the mutated env.
      if (require.cache) Reflect.deleteProperty(require.cache, require.resolve('./index'));
      const { verifyClient: fresh } = require('./index');
      expect(fresh({ origin: 'http://192.168.1.5:8787', req: reqWith('192.168.1.5:8787') })).toBe(true);
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, 'GENIE_UI_ALLOWED_ORIGINS');
      else process.env.GENIE_UI_ALLOWED_ORIGINS = prev;
    }
  });

  it('rejects a cross-origin drive-by (open website -> ws://localhost)', () => {
    expect(verifyClient({ origin: 'https://evil.example', req: reqWith('localhost:8787') })).toBe(false);
  });

  it('rejects a mismatched port on the same host', () => {
    expect(verifyClient({ origin: 'http://localhost:9999', req: reqWith('localhost:8787') })).toBe(false);
  });

  it('rejects a malformed Origin instead of throwing', () => {
    expect(verifyClient({ origin: 'not a url', req: reqWith('localhost:8787') })).toBe(false);
  });

  it('allows non-browser clients that send no Origin (gated by loopback bind)', () => {
    expect(verifyClient({ origin: undefined, req: reqWith('localhost:8787') })).toBe(true);
  });
});
