/**
 * Token-shape redaction for the hook fallback log.
 *
 * Matches well-known credential prefixes and broad hex-secret shapes, substituting
 * them with `[REDACTED:<kind>]`. Applied at write time only so the on-disk log
 * never contains live credentials regardless of who reads it. Sentinel finding
 * 2026-05-05: `~/.genie/hook-fallback.log` was world-readable with full bash
 * command lines including a token-bearing `gh pr create`.
 *
 * Operator opt-out: set `GENIE_HOOK_REDACTION=off` to skip redaction (debugging
 * only — leaves credentials on disk).
 */

interface Pattern {
  kind: string;
  re: RegExp;
}

// Order matters: prefix patterns run first; the broad hex catch runs last so
// it doesn't clip inside an already-redacted span.
const PATTERNS: Pattern[] = [
  { kind: 'gh-token', re: /gh[ps]_[A-Za-z0-9]{30,}/g },
  { kind: 'sk-token', re: /sk-[A-Za-z0-9-]{20,}/g },
  { kind: 'glpat', re: /glpat-[A-Za-z0-9_-]{20,}/g },
  // Broad catch for sha-shaped or hex-secret-shaped strings (40+ hex chars).
  // Word-boundary keeps this from clipping inside larger tokens already redacted.
  { kind: 'hex', re: /\b[a-f0-9]{40,}\b/g },
];

export function redactTokenShapes(text: string | null | undefined): string | null {
  if (text == null) return null;
  if (process.env.GENIE_HOOK_REDACTION === 'off') return String(text);
  let out = String(text);
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, `[REDACTED:${kind}]`);
  }
  return out;
}
