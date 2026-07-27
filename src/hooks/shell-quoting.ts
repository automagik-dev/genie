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
 * and unterminated quotes (mask to end of string — safer than the alternative
 * of leaving a runaway region unmasked). Backtick command substitution and
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

/** Unquoted char: pass through, or open a quote region. */
function stepUnquoted(ch: string): MaskStep {
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
          : stepUnquoted(cmd[i]);
    out += step.out;
    state = step.next;
    i += step.consumed;
  }
  return out;
}
