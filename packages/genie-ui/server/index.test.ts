// Guards the ws trust boundary (README "Trust boundary" decision): the Origin
// allowlist that keeps a cross-origin browser drive-by out of the live shells.
import { describe, expect, it } from 'bun:test';
import type http from 'node:http';
import { verifyClient } from './index';

const reqWith = (host?: string) => ({ headers: { host } }) as unknown as http.IncomingMessage;

describe('verifyClient', () => {
  it('accepts a same-origin browser connection (Origin host === page host)', () => {
    expect(verifyClient({ origin: 'http://localhost:8787', req: reqWith('localhost:8787') })).toBe(true);
  });

  it('accepts any LAN hostname as long as Origin matches the Host header', () => {
    expect(verifyClient({ origin: 'http://192.168.1.5:8787', req: reqWith('192.168.1.5:8787') })).toBe(true);
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
