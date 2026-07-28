/**
 * Shell quote masking — shared by every PreToolUse:Bash classifier.
 *
 * Mask the interior of single/double-quoted shell regions with spaces,
 * preserving string length so regex word-boundaries behave identically on the
 * remaining unmasked characters.
 *
 * Closes a class of over-matches where a blocked substring (`gh pr merge N`,
 * `git push origin main`, `git checkout main && git commit`) appearing inside
 * a `--body` / `--message` / `-m` argument triggered a false-positive deny.
 *
 * Live reproducer: opening PR #1264 (the branch-guard subprocess-diagnostics
 * fix) was blocked twice because the PR body described the very commands the
 * hook denies. Required a workaround — paraphrase every literal occurrence —
 * that doesn't generalize.
 *
 * Scope: handles single-quotes (no escapes), double-quotes with `\X` escapes,
 * unquoted `\X` escapes (a literal X — notably `\"`, which does *not* open a
 * quote region), and unterminated quotes (mask to end of string — safer than
 * the alternative of leaving a runaway region unmasked).
 *
 * The unquoted-escape case is load-bearing, not cosmetic: reading `\"` as a
 * quote opener made `git commit -m \"fix\" && git checkout main` mask from the
 * first `\"` to end of string — the closing `\"` was swallowed by the
 * double-quoted `\X` rule — so the guards saw no `&& git checkout main` and
 * allowed a command bash runs in full. Backtick command substitution and
 * heredocs are intentionally not parsed — they're rare in agent-issued
 * commands and falling back to fully unmasked treatment is fail-closed for
 * the original policy, which matches the hook's overall posture.
 */

type QuoteState = 'none' | 'single' | 'double';

interface MaskStep {
  out: string;
  next: QuoteState;
  consumed: number;
}

/** Unquoted char: pass through, or open a quote region. `\X` is a literal X, not a quote opener. */
function stepUnquoted(ch: string, next: string | undefined): MaskStep {
  if (ch === '\\' && next !== undefined) return { out: ch + next, next: 'none', consumed: 2 };
  if (ch === "'") return { out: ' ', next: 'single', consumed: 1 };
  if (ch === '"') return { out: ' ', next: 'double', consumed: 1 };
  return { out: ch, next: 'none', consumed: 1 };
}

/** Single-quoted char: always masked; `'` closes the region (no escapes in bash single-quotes). */
function stepSingleQuoted(ch: string): MaskStep {
  return { out: ' ', next: ch === "'" ? 'none' : 'single', consumed: 1 };
}

/** Double-quoted char: always masked; `\X` consumes two chars; `"` closes. */
function stepDoubleQuoted(ch: string, hasNext: boolean): MaskStep {
  if (ch === '\\' && hasNext) return { out: '  ', next: 'double', consumed: 2 };
  return { out: ' ', next: ch === '"' ? 'none' : 'double', consumed: 1 };
}

export function maskQuotedRegions(cmd: string): string {
  let out = '';
  let state: QuoteState = 'none';
  let i = 0;
  while (i < cmd.length) {
    const step: MaskStep =
      state === 'double'
        ? stepDoubleQuoted(cmd[i], i + 1 < cmd.length)
        : state === 'single'
          ? stepSingleQuoted(cmd[i])
          : stepUnquoted(cmd[i], cmd[i + 1]);
    out += step.out;
    state = step.next;
    i += step.consumed;
  }
  return out;
}
