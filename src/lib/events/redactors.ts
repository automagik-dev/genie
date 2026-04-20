/**
 * Field-level redaction helpers for the event registry.
 *
 * Tiers:
 *   A — secret / PII; drop or HMAC hash before write
 *   B — identifier / path; tokenize before write
 *   C — public / metric; write as-is
 *
 * All helpers are deterministic and side-effect free so Zod `.transform()`
 * pipelines can call them during schema parse.
 */

import { createHmac } from 'node:crypto';
import { homedir } from 'node:os';

/** Tier marker on a schema field (attached via `.describe()` metadata). */
export type Tier = 'A' | 'B' | 'C';

/**
 * HMAC-SHA256 of (key, value) truncated to 16 hex chars.
 *
 * Key is the redaction HMAC secret from `GENIE_REDACTION_KEY` — rotated via
 * `genie events rotate-redaction-keys`. In absence of the env var we fall back
 * to a process-local key so tests are deterministic but rotation is a no-op.
 */
export function hashEntity(namespace: string, value: string): string {
  const key = process.env.GENIE_REDACTION_KEY ?? 'genie-redaction-fallback';
  return `tier-a:${namespace}:${createHmac('sha256', key).update(value).digest('hex').slice(0, 16)}`;
}

/**
 * Regexes that match common secret shapes. Intentionally conservative —
 * false positives are preferable to leaking tokens into JSONB.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'anthropic-key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai-key', pattern: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws-secret', pattern: /(?<![A-Za-z0-9])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9])/g },
  { name: 'bearer-token', pattern: /(?:Bearer|bearer)\s+[A-Za-z0-9._\-~+/=]{20,}/g },
  { name: 'jwt', pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'pem-header', pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----/g },
  {
    // Absolute paths containing a sensitive subdirectory. Matches e.g.
    // `/home/tenant/.secrets/private_key.pem` and `/opt/app/.aws/credentials`.
    // Capture stops at whitespace, quotes, comma, semicolon, parentheses, colon.
    name: 'sensitive-path',
    pattern: /\/(?:[^\s"',;():]+\/)*\.(?:secrets|ssh|aws|gnupg|keys)(?:\/[^\s"',;():]*)?/g,
  },
];

/** Replace any secret-shaped substring with `<REDACTED:name>`. */
export function dropSecretShaped(text: string): string {
  let out = text;
  for (const { name, pattern } of SECRET_PATTERNS) {
    out = out.replace(pattern, `<REDACTED:${name}>`);
  }
  return out;
}

/**
 * Strip `KEY=value` pairs for any env var whose name looks sensitive.
 *
 * Matches `FOO_KEY=...`, `BAR_SECRET=...`, `BAZ_TOKEN=...`, `QUX_PASSWORD=...`,
 * `PG*_PASS=...`, `ANTHROPIC_API_KEY=...`.
 */
const SENSITIVE_ENV_NAME = '[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASS|_AUTH|_API_KEY)';
const ENV_ASSIGN = new RegExp(`\\b(${SENSITIVE_ENV_NAME})\\s*[=:]\\s*([^\\s"',;]+)`, 'g');
export function stripEnvVars(text: string): string {
  return text.replace(ENV_ASSIGN, (_m, name: string) => `${name}=<REDACTED>`);
}

/**
 * Tokenize filesystem paths so we keep shape but drop identity.
 *
 * - Absolute paths starting under $HOME become `~/<rest>`.
 * - Deep paths keep head + tail only (middle segments replaced with `…`).
 * - Worktree UUIDs / session ids ≥ 12 chars collapse to `<id>`.
 */
export function tokenizePath(p: string): string {
  const home = homedir();
  let out = p;
  if (home && out.startsWith(home)) {
    out = `~${out.slice(home.length)}`;
  }
  const segments = out.split('/').filter(Boolean);
  if (segments.length > 6) {
    const head = segments.slice(0, 3).join('/');
    const tail = segments.slice(-2).join('/');
    out = `${out.startsWith('/') ? '/' : ''}${head}/…/${tail}`;
  }
  out = out.replace(/\b[0-9a-f]{12,}\b/g, '<id>');
  return out;
}

/**
 * Compose the standard tier-A redaction cascade. Used by schema
 * `.transform()` pipelines for any free-form string field.
 */
export function redactFreeText(value: string): string {
  return stripEnvVars(dropSecretShaped(value));
}

/** Payload-size cap (64KB) enforced at emit-time; bigger payloads overflow. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;

export interface OverflowResult {
  overflow: boolean;
  content_hash?: string;
  body: unknown;
}

/**
 * Cap a payload to MAX_PAYLOAD_BYTES. Returns the original body when under
 * cap, or a sentinel `{overflow: true, content_hash}` when over.
 */
export function capPayload(body: unknown): OverflowResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { overflow: true, content_hash: 'unserializable', body: { overflow: true } };
  }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) {
    return { overflow: false, body };
  }
  const key = process.env.GENIE_REDACTION_KEY ?? 'genie-redaction-fallback';
  const digest = createHmac('sha256', key).update(serialized).digest('hex').slice(0, 16);
  return {
    overflow: true,
    content_hash: digest,
    body: { overflow: true, content_hash: digest, original_bytes: Buffer.byteLength(serialized, 'utf8') },
  };
}
