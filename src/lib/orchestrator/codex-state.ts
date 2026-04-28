/**
 * Codex pane-content state detector.
 *
 * Mirrors the patterns Claude's `state-detector.ts` uses for claude-code,
 * but tuned to codex's TUI shell:
 *   - permission prompts: "Press enter to confirm or esc to cancel"
 *   - active processing: spinner glyphs + "esc to interrupt" affordance
 *   - idle: `›` prompt at start of a tail line (status bar below it)
 *
 * Also serves as the canonical source for the OTel relay's inline
 * detector. The relay script in `agents.ts:ensureOtelRelay` carries a
 * copy of these patterns; if you change them here, mirror them in the
 * relay or extract patterns into a shared JSON.
 *
 * Group 1 of codex-provider-parity wish.
 */

import type { ExecutorState } from '../executor-types.js';

/**
 * Result type — broader than ExecutorState so callers can distinguish
 * permission/question/idle/working without losing nuance. Map to
 * ExecutorState via `mapToExecutorState` when the consumer expects
 * that narrower set.
 */
export type CodexStateType = 'idle' | 'working' | 'permission' | 'unknown';

export interface CodexStateResult {
  type: CodexStateType;
  /** Optional human-readable detail for logs/UI. */
  detail?: string;
}

/**
 * Detect codex state from pane scrollback / capture.
 *
 * Inputs the last N lines of the codex tmux pane (typically 50).
 * Returns the most-specific recognized state; falls through to
 * 'working' when nothing matches (codex's idle is a `›` prompt;
 * no prompt + non-empty tail = still processing).
 */
export function detectCodexState(output: string): CodexStateResult {
  if (!output || !output.trim()) {
    return { type: 'unknown', detail: 'empty pane' };
  }

  const lines = output.split('\n').filter((l) => l.trim());
  const tail = lines.slice(-8).join('\n');

  // Permission prompts — codex is awaiting user approval. Highest priority.
  if (/Press enter to confirm or esc to cancel/.test(tail)) {
    return { type: 'permission', detail: 'enter-or-esc gate' };
  }
  if (/Would you like to run/.test(tail)) {
    return { type: 'permission', detail: 'run-confirmation' };
  }

  // Working indicators MUST be checked BEFORE idle. Codex's `›` prompt
  // placeholder is visible even while the agent is actively processing,
  // so spinner glyphs / "esc to interrupt" hint take precedence.
  if (/[◦◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(tail)) {
    return { type: 'working', detail: 'spinner glyph' };
  }
  if (/esc to interrupt/.test(tail)) {
    return { type: 'working', detail: 'esc-to-interrupt affordance' };
  }

  // Idle — codex prompt waiting for input. The status bar
  // (`gpt-5.3-codex · ~/path`) appears below the prompt.
  if (/^\s*[>›]\s/m.test(tail)) {
    return { type: 'idle', detail: 'prompt detected' };
  }

  // No prompt + non-empty tail + no spinner: codex is between turns,
  // mid-render. Treat as working — when the next render lands either
  // the prompt or the spinner will surface.
  return { type: 'working', detail: 'between-turns render' };
}

/**
 * Translate `CodexStateResult.type` into the narrower `ExecutorState`
 * union the orchestrator's executor table uses. `permission` becomes
 * `idle` (codex is waiting on the operator, just like a non-codex idle
 * worker). `unknown` falls through to `idle` rather than blocking.
 */
export function mapCodexToExecutorState(state: CodexStateType): ExecutorState {
  switch (state) {
    case 'working':
      return 'working';
    case 'permission':
      return 'permission';
    case 'idle':
      return 'idle';
    default:
      return 'idle';
  }
}
