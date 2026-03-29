/**
 * Orchestration Guard Handler — PreToolUse:Bash
 *
 * Blocks agents from using tmux capture-pane or sleep+poll loops
 * to monitor workers. Redirects to structured genie primitives.
 *
 * Priority: 2 (runs after branch-guard, before identity-inject)
 */

import type { HandlerResult, HookPayload } from '../types.js';

interface BlockPattern {
  test: RegExp;
  reason: string;
}

const BLOCK_PATTERNS: BlockPattern[] = [
  {
    test: /tmux\s+capture-pane/,
    reason:
      'BLOCKED: tmux scraping detected. Use structured monitoring instead:\n' +
      '  genie status <slug>        — wish progress from PG\n' +
      '  genie agent list --json    — executor state machine\n' +
      '  genie events timeline <id> — structured event log\n' +
      '  genie agent send --to <a>  — PG-backed messaging\n' +
      'Load /genie for full orchestration guidance.',
  },
  {
    test: /sleep\s+\d+\s*&&\s*tmux/,
    reason:
      'BLOCKED: sleep+poll loop detected. Workers report via PG events — no need to poll terminals.\n' +
      '  genie status <slug>        — check progress\n' +
      '  genie agent send --to <a>  — communicate directly\n' +
      'Load /genie for full orchestration guidance.',
  },
  {
    test: /sleep\s+\d+\s*&&\s*.*(?:capture-pane|tmux\s+list)/,
    reason:
      'BLOCKED: terminal polling pattern detected. Use genie primitives:\n' +
      '  genie status <slug>\n' +
      '  genie events list --since 5m\n' +
      'Load /genie for full orchestration guidance.',
  },
];

export async function orchestrationGuard(payload: HookPayload): Promise<HandlerResult> {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') return undefined;

  for (const { test, reason } of BLOCK_PATTERNS) {
    if (test.test(command)) {
      return { decision: 'deny', reason };
    }
  }

  return undefined;
}
