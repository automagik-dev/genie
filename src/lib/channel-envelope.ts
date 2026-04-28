/**
 * Channel envelope — format/parse `<channel …>body</channel>` wrappers.
 *
 * The genie mailbox carries optional source attribution (`agent`, `whatsapp`,
 * `system`, future external adapters). When a message is delivered into a
 * Claude Code native inbox, non-default sources get rendered as a structured
 * tag so the receiving agent can react to the origin without parsing free
 * text:
 *
 *   <channel source="whatsapp" from="+5511…" phone="+5511…">body</channel>
 *
 * Pure functions only — no I/O, no PG, no fs. Easy to unit test and reuse
 * across the deliver path (PRs C/D), the codex hook (PR B), and external
 * channel adapters (PR F+).
 */

const DEFAULT_SOURCE = 'agent';

const TAG_OPEN_RE = /^<channel\s+([^>]*)>([\s\S]*)<\/channel>\s*$/;
const ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_-]*)="((?:\\.|[^"\\])*)"/g;

export interface FormatEnvelopeInput {
  /** Channel source tag. Defaults to `'agent'` (back-compat plain body). */
  source?: string;
  /** Sender identifier surfaced as `from="…"` when provided. */
  from?: string;
  /** Free-form attribute map; non-string values are stringified. */
  meta?: Record<string, unknown>;
  /** Message body text — embedded verbatim inside the tag. */
  body: string;
}

export interface ParsedEnvelope {
  source: string;
  from?: string;
  meta: Record<string, string>;
  body: string;
}

/**
 * Render a channel envelope for `body`. When `source` resolves to the default
 * (`'agent'`), the body is returned unchanged — Claude Code peers expect a
 * plain string in their native inbox today, and PR A keeps that invariant.
 */
export function formatEnvelope(input: FormatEnvelopeInput): string {
  const source = input.source && input.source.length > 0 ? input.source : DEFAULT_SOURCE;
  if (source === DEFAULT_SOURCE) return input.body;

  const attrs: string[] = [`source="${escapeAttr(source)}"`];
  if (input.from) attrs.push(`from="${escapeAttr(input.from)}"`);

  if (input.meta) {
    for (const [key, value] of Object.entries(input.meta)) {
      if (!isValidAttrName(key)) continue;
      if (value === undefined || value === null) continue;
      attrs.push(`${key}="${escapeAttr(stringifyAttr(value))}"`);
    }
  }

  return `<channel ${attrs.join(' ')}>${input.body}</channel>`;
}

/**
 * Best-effort parse of a channel envelope. Returns `null` for input that
 * doesn't match the `<channel attr="val" …>body</channel>` shape — callers
 * should treat that as a plain `'agent'` body.
 *
 * Whitespace tolerance: leading whitespace before `<channel` is permitted by
 * trimming the input first. Trailing whitespace after `</channel>` is also
 * tolerated. Bodies are returned verbatim (including any embedded markup) so
 * round-tripping with {@link formatEnvelope} is lossless for well-formed
 * inputs.
 */
export function parseEnvelope(text: string): ParsedEnvelope | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trimStart();
  const match = TAG_OPEN_RE.exec(trimmed);
  if (!match) return null;

  const attrBlob = match[1];
  const body = match[2];

  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let attrMatch: RegExpExecArray | null = ATTR_RE.exec(attrBlob);
  while (attrMatch !== null) {
    const [, name, rawValue] = attrMatch;
    attrs[name] = unescapeAttr(rawValue);
    attrMatch = ATTR_RE.exec(attrBlob);
  }

  const source = attrs.source ?? DEFAULT_SOURCE;
  const from = attrs.from;
  const meta: Record<string, string> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'source' || key === 'from') continue;
    meta[key] = value;
  }

  return { source, from, meta, body };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeAttr(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function isValidAttrName(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name);
}

function stringifyAttr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
