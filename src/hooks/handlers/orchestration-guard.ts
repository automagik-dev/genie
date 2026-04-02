/**
 * Orchestration Guard Handler — PreToolUse:Bash
 *
 * Informational nudge when agents use tmux capture-pane or sleep+poll
 * loops to monitor workers. Suggests structured genie primitives but
 * does NOT block — people may legitimately use tmux directly.
 *
 * Uses hookSpecificOutput.additionalContext to inject the nudge into
 * Claude's context before the tool executes, with permissionDecision: "allow".
 *
 * Priority: 2 (runs after branch-guard, before identity-inject)
 */

import type { HandlerResult, HookPayload } from '../types.js';

interface NudgePattern {
  test: RegExp;
  message: string;
}

const NUDGE_PATTERNS: NudgePattern[] = [
  {
    test: /tmux\s+capture-pane/,
    message:
      "If you're checking genie agent progress, use structured monitoring instead:\n" +
      '  genie task status <slug>   — wish progress from PG\n' +
      '  genie agent list --json    — executor state machine\n' +
      '  genie events timeline <id> — structured event log\n' +
      '  genie agent send --to <a>  — PG-backed messaging',
  },
  {
    test: /sleep\s+\d+\s*&&\s*tmux/,
    message:
      'Workers report via PG events — polling terminals is not needed.\n' +
      '  genie task status <slug>   — check progress\n' +
      '  genie agent send --to <a>  — communicate directly',
  },
  {
    test: /sleep\s+\d+\s*&&\s*.*(?:capture-pane|tmux\s+list)/,
    message:
      'Consider using genie primitives instead of terminal polling:\n' +
      '  genie task status <slug>\n' +
      '  genie events list --since 5m',
  },
];

export async function orchestrationGuard(payload: HookPayload): Promise<HandlerResult> {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') return undefined;

  for (const { test, message } of NUDGE_PATTERNS) {
    if (test.test(command)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: `[orchestration-guard] ${message}`,
        },
      };
    }
  }

  return undefined;
}
