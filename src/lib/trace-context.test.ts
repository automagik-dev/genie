/**
 * Unit tests for the 4-channel trace correlation primitive (Group 3).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  TOKEN_MAX_AGE_MS,
  TRACE_ENV_VAR,
  TRACE_ID_ENV_VAR,
  TRACE_SECRET_ENV_VAR,
  adoptFromEnv,
  extractPromptPreamble,
  getAmbient,
  injectPromptPreamble,
  mintToken,
  newSpanId,
  newTraceId,
  parseToken,
  propagateEnv,
  setAmbient,
} from './trace-context.js';

describe('trace-context — mint/parse', () => {
  beforeEach(() => {
    process.env[TRACE_SECRET_ENV_VAR] = 'fixed-secret-for-tests-0123456789';
    setAmbient(null);
  });
  afterEach(() => {
    delete process.env[TRACE_SECRET_ENV_VAR];
    setAmbient(null);
  });

  test('mintToken produces verifiable tokens', () => {
    const ctx = { trace_id: newTraceId(), parent_span_id: newSpanId(), tenant_id: 'default' };
    const token = mintToken(ctx);
    const parsed = parseToken(token);
    expect(parsed.ok).toBe(true);
    expect(parsed.ctx?.trace_id).toBe(ctx.trace_id);
    expect(parsed.ctx?.parent_span_id).toBe(ctx.parent_span_id);
    expect(parsed.ctx?.tenant_id).toBe(ctx.tenant_id);
  });

  // TODO(#1314): pg-test-perf wish flagged this as a potential CI flake.
  // Inspection found purely logical assertions (no timing budgets, no async
  // waits) — no source patch applied. Reopen the issue if a real failure
  // surfaces in CI logs.
  test('parseToken rejects tampered signatures', () => {
    const ctx = { trace_id: newTraceId() };
    const token = mintToken(ctx);
    const [payload, sig] = token.split('.');
    // Guarantee the replacement differs from the original: HMAC-SHA256 → 43
    // base64url chars where the last 2 chars equal "AA" ~1/1024 runs; without
    // this guard, the "tampered" signature is byte-identical to the original
    // and the assertion fails (#1314).
    const replacement = sig.endsWith('AA') ? 'BB' : 'AA';
    const tampered = `${payload}.${sig.slice(0, -2)}${replacement}`;
    const parsed = parseToken(tampered);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('signature');
  });

  test('parseToken rejects malformed tokens', () => {
    expect(parseToken('').ok).toBe(false);
    expect(parseToken(undefined).ok).toBe(false);
    expect(parseToken('no-dot').ok).toBe(false);
    expect(parseToken('.').ok).toBe(false);
  });

  test('parseToken rejects expired tokens', () => {
    const ctx = { trace_id: newTraceId() };
    const token = mintToken(ctx);
    const future = Date.now() + TOKEN_MAX_AGE_MS + 10_000;
    const parsed = parseToken(token, future);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('expired');
  });

  test('parseToken rejects tokens from the distant future', () => {
    const ctx = { trace_id: newTraceId() };
    const token = mintToken(ctx);
    const past = Date.now() - TOKEN_MAX_AGE_MS - 10_000;
    const parsed = parseToken(token, past);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('future-dated');
  });

  test('forged signature with different secret fails', () => {
    const ctx = { trace_id: newTraceId() };
    process.env[TRACE_SECRET_ENV_VAR] = 'secret-alpha-0123456789abcd';
    const token = mintToken(ctx);
    process.env[TRACE_SECRET_ENV_VAR] = 'secret-beta-0123456789abcde';
    const parsed = parseToken(token);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe('signature');
  });
});

describe('trace-context — env propagation', () => {
  beforeEach(() => {
    process.env[TRACE_SECRET_ENV_VAR] = 'fixed-secret-for-tests-0123456789';
    setAmbient(null);
    delete process.env[TRACE_ENV_VAR];
    delete process.env[TRACE_ID_ENV_VAR];
  });
  afterEach(() => {
    delete process.env[TRACE_SECRET_ENV_VAR];
    delete process.env[TRACE_ENV_VAR];
    delete process.env[TRACE_ID_ENV_VAR];
    setAmbient(null);
  });

  test('adoptFromEnv picks up a signed token', () => {
    const ctx = { trace_id: newTraceId() };
    const token = mintToken(ctx);
    const adopted = adoptFromEnv({ [TRACE_ENV_VAR]: token });
    expect(adopted?.trace_id).toBe(ctx.trace_id);
    expect(getAmbient()?.trace_id).toBe(ctx.trace_id);
  });

  test('adoptFromEnv ignores invalid token but picks up legacy GENIE_TRACE_ID', () => {
    const legacy = 'a'.repeat(32);
    const adopted = adoptFromEnv({
      [TRACE_ENV_VAR]: 'invalid.token',
      [TRACE_ID_ENV_VAR]: legacy,
    });
    expect(adopted?.trace_id).toBe(legacy);
  });

  test('propagateEnv emits both envs for children', () => {
    const ctx = { trace_id: newTraceId() };
    const env = propagateEnv(ctx, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env[TRACE_ID_ENV_VAR]).toBe(ctx.trace_id);
    const parsed = parseToken(env[TRACE_ENV_VAR]);
    expect(parsed.ok).toBe(true);
    expect(parsed.ctx?.trace_id).toBe(ctx.trace_id);
  });

  test('propagateEnv is a no-op when there is no ambient context', () => {
    const env = propagateEnv(null, { FOO: 'bar' });
    expect(env.FOO).toBe('bar');
    expect(env[TRACE_ENV_VAR]).toBeUndefined();
  });
});

describe('trace-context — prompt preamble', () => {
  beforeEach(() => {
    process.env[TRACE_SECRET_ENV_VAR] = 'fixed-secret-for-tests-0123456789';
    setAmbient(null);
  });
  afterEach(() => {
    delete process.env[TRACE_SECRET_ENV_VAR];
    setAmbient(null);
  });

  test('injectPromptPreamble prepends a verifiable marker', () => {
    const ctx = { trace_id: newTraceId() };
    const out = injectPromptPreamble('hello', ctx);
    expect(out.startsWith('<genie-trace token="')).toBe(true);
    const { ctx: recovered, rest } = extractPromptPreamble(out);
    expect(recovered?.trace_id).toBe(ctx.trace_id);
    expect(rest).toBe('hello');
  });

  test('injectPromptPreamble is idempotent if already present', () => {
    const ctx = { trace_id: newTraceId() };
    const once = injectPromptPreamble('body', ctx);
    const twice = injectPromptPreamble(once, ctx);
    expect(twice).toBe(once);
  });

  test('injectPromptPreamble is a no-op without context', () => {
    expect(injectPromptPreamble('body', null)).toBe('body');
  });

  test('extractPromptPreamble strips forged preambles', () => {
    const forged = '<genie-trace token="forged.signature" />\nhello';
    const { ctx, rest } = extractPromptPreamble(forged);
    expect(ctx).toBeNull();
    expect(rest).toBe('hello');
  });

  test('extractPromptPreamble returns null ctx when preamble absent', () => {
    const { ctx, rest } = extractPromptPreamble('plain prompt');
    expect(ctx).toBeNull();
    expect(rest).toBe('plain prompt');
  });
});
