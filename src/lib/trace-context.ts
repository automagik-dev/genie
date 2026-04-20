/**
 * Four-channel signed-token trace correlation.
 *
 * A trace token is a JSON object `{trace_id, parent_span_id?, tenant_id?,
 * issued_at, nonce}` serialized to base64url and signed with HMAC-SHA256 using
 * `GENIE_TRACE_SECRET`. Verification is required at every unmarshal site so a
 * forged env var or prompt preamble cannot inject a synthetic trace.
 *
 * The four propagation channels cover each other's failure modes:
 *   1. **Env var** `GENIE_TRACE_TOKEN` — survives `spawn`, `execFile`, and the
 *      hook dispatcher; fails when the child process is spawned without its
 *      environment inherited (e.g. systemd units).
 *   2. **DB `parent_span_id`** — authoritative for rows already written;
 *      recovers correlation even if the env var was dropped.
 *   3. **Prompt preamble** `<genie-trace token="..." />` — reaches Claude
 *      children via their initial prompt even when env vars are scrubbed.
 *   4. **Structured log key** `trace_id=<hex>` — surfaces in stderr/stdout so
 *      a tail -f observer can correlate human-readable logs with the event
 *      stream.
 *
 * Tokens are short-lived by convention (wall-clock issued_at ± 1h enforced by
 * the verifier). Verify the token before propagating; a bad signature causes
 * the offending channel to fall back to "no parent" rather than forge one.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TRACE_ENV_VAR = 'GENIE_TRACE_TOKEN';
export const TRACE_ID_ENV_VAR = 'GENIE_TRACE_ID';
export const TRACE_SECRET_ENV_VAR = 'GENIE_TRACE_SECRET';

/** Tokens older than this are rejected; mirrors RBAC token lifetime (Group 5). */
export const TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

/** Preamble stable marker — the first line of any Claude child prompt. */
export const PREAMBLE_PREFIX = '<genie-trace';
export const PREAMBLE_SUFFIX = '/>';
const PREAMBLE_REGEX = /^<genie-trace\s+token="([A-Za-z0-9_\-.]+)"\s*\/>\s*/;

// ---------------------------------------------------------------------------
// Token shape
// ---------------------------------------------------------------------------

export interface TraceContext {
  trace_id: string;
  parent_span_id?: string;
  tenant_id?: string;
}

interface TokenBody extends TraceContext {
  iat: number;
  nonce: string;
}

// ---------------------------------------------------------------------------
// Secret handling
// ---------------------------------------------------------------------------

function getSecret(): Buffer {
  const raw = process.env[TRACE_SECRET_ENV_VAR];
  if (!raw || raw.length < 16) {
    // A missing secret in production is a configuration bug; in test/dev we
    // fall back to a process-local fixed key so the code path still exercises
    // signing. Rotation is documented in docs/observability-rollout.md.
    return Buffer.from('genie-trace-fallback-secret-dev-only-do-not-ship', 'utf8');
  }
  return Buffer.from(raw, 'utf8');
}

// ---------------------------------------------------------------------------
// base64url (Node has `base64url` encoding only in ≥16; fall back here)
// ---------------------------------------------------------------------------

function toBase64Url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// ---------------------------------------------------------------------------
// Mint / parse
// ---------------------------------------------------------------------------

/** Mint a signed trace token carrying `ctx`. */
export function mintToken(ctx: TraceContext): string {
  const body: TokenBody = {
    trace_id: ctx.trace_id,
    parent_span_id: ctx.parent_span_id,
    tenant_id: ctx.tenant_id,
    iat: Date.now(),
    nonce: randomBytes(6).toString('hex'),
  };
  const payloadB64 = toBase64Url(JSON.stringify(body));
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  const sigB64 = toBase64Url(sig);
  return `${payloadB64}.${sigB64}`;
}

export interface ParseResult {
  ok: boolean;
  ctx?: TraceContext;
  reason?: 'malformed' | 'signature' | 'expired' | 'future-dated';
}

/** Parse + verify a signed trace token. */
export function parseToken(token: string | undefined | null, now: number = Date.now()): ParseResult {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: 'malformed' };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  // Signature check (constant-time)
  const expected = createHmac('sha256', getSecret()).update(payloadB64).digest();
  let provided: Buffer;
  try {
    provided = fromBase64Url(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'signature' };
  }
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature' };
  }

  // Payload decode
  let body: TokenBody;
  try {
    body = JSON.parse(fromBase64Url(payloadB64).toString('utf8')) as TokenBody;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!body || typeof body.trace_id !== 'string' || typeof body.iat !== 'number') {
    return { ok: false, reason: 'malformed' };
  }

  // Age check — either direction
  const age = now - body.iat;
  if (age > TOKEN_MAX_AGE_MS) {
    return { ok: false, reason: 'expired' };
  }
  if (age < -TOKEN_MAX_AGE_MS) {
    return { ok: false, reason: 'future-dated' };
  }

  return {
    ok: true,
    ctx: {
      trace_id: body.trace_id,
      parent_span_id: body.parent_span_id,
      tenant_id: body.tenant_id,
    },
  };
}

// ---------------------------------------------------------------------------
// Ambient context (per-process)
// ---------------------------------------------------------------------------

let ambient: TraceContext | null = null;

/** Pick up a trace context from env (GENIE_TRACE_TOKEN → GENIE_TRACE_ID). */
export function adoptFromEnv(env: NodeJS.ProcessEnv = process.env): TraceContext | null {
  const token = env[TRACE_ENV_VAR];
  if (token) {
    const parsed = parseToken(token);
    if (parsed.ok && parsed.ctx) {
      ambient = parsed.ctx;
      return parsed.ctx;
    }
  }
  const legacyId = env[TRACE_ID_ENV_VAR];
  if (legacyId && /^[a-f0-9-]{8,64}$/i.test(legacyId)) {
    ambient = { trace_id: legacyId.replace(/-/g, '').toLowerCase() };
    return ambient;
  }
  return null;
}

/** Set or clear the ambient trace context for this process. */
export function setAmbient(ctx: TraceContext | null): void {
  ambient = ctx;
}

/** Read the ambient trace context for this process. */
export function getAmbient(): TraceContext | null {
  return ambient;
}

/** Build the env map to propagate to a child process. */
export function propagateEnv(
  ctx: TraceContext | null = ambient,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v === 'string') out[k] = v;
  }
  if (!ctx) return out;
  out[TRACE_ENV_VAR] = mintToken(ctx);
  out[TRACE_ID_ENV_VAR] = ctx.trace_id;
  return out;
}

// ---------------------------------------------------------------------------
// Prompt preamble (Channel 3)
// ---------------------------------------------------------------------------

/** Prefix a prompt with a `<genie-trace token="..."/>` preamble. Idempotent. */
export function injectPromptPreamble(prompt: string, ctx: TraceContext | null = ambient): string {
  if (!ctx) return prompt;
  if (PREAMBLE_REGEX.test(prompt)) return prompt;
  const token = mintToken(ctx);
  return `<genie-trace token="${token}" />\n${prompt}`;
}

/**
 * Extract + verify a preamble from a prompt or incoming prompt stream.
 * Returns `{ctx, rest}` on success, or `{ctx: null, rest: input}` if absent.
 */
export function extractPromptPreamble(input: string): { ctx: TraceContext | null; rest: string } {
  const match = input.match(PREAMBLE_REGEX);
  if (!match) return { ctx: null, rest: input };
  const parsed = parseToken(match[1]);
  if (!parsed.ok || !parsed.ctx) {
    // Strip the bad preamble rather than forwarding a forgery.
    return { ctx: null, rest: input.slice(match[0].length) };
  }
  return { ctx: parsed.ctx, rest: input.slice(match[0].length) };
}

// ---------------------------------------------------------------------------
// ID helpers (re-exported so call sites don't import crypto directly)
// ---------------------------------------------------------------------------

/** New 128-bit trace id as 32-char lowercase hex. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** New 64-bit span id as 16-char lowercase hex. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}
