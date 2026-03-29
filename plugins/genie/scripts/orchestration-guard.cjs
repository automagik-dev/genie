#!/usr/bin/env node
"use strict";

/**
 * orchestration-guard — PreToolUse:Bash informational nudge.
 *
 * When agents use tmux capture-pane or sleep+poll loops, suggests
 * structured genie primitives instead. Does NOT block — people may
 * legitimately use tmux directly.
 *
 * Outputs suggestion to stderr (agent sees it), exits 0 (allows).
 */

const PATTERNS = [
  {
    pattern: /tmux\s+capture-pane/,
    message: `If you're checking genie agent progress, use structured monitoring instead:
  genie task status <slug>   — wish progress from PG
  genie agent list --json    — executor state machine
  genie events timeline <id> — structured event log
  genie agent send --to <a>  — PG-backed messaging`
  },
  {
    pattern: /sleep\s+\d+\s*&&\s*tmux/,
    message: `Workers report via PG events — polling terminals is not needed.
  genie task status <slug>   — check progress
  genie agent send --to <a>  — communicate directly`
  },
  {
    pattern: /sleep\s+\d+\s*&&\s*.*(?:capture-pane|tmux\s+list)/,
    message: `Consider using genie primitives instead of terminal polling:
  genie task status <slug>
  genie events list --since 5m`
  }
];

async function main() {
  let input = '';
  try {
    input = require('fs').readFileSync(0, 'utf-8').trim();
  } catch {
    process.exit(0);
  }

  if (!input) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  if (payload.tool_name !== 'Bash') process.exit(0);

  const command = payload.tool_input?.command;
  if (!command) process.exit(0);

  for (const { pattern, message } of PATTERNS) {
    if (pattern.test(command)) {
      // Informational — log to stderr, exit 0 to allow
      console.error(`[orchestration-guard] ${message}`);
      process.exit(0);
    }
  }

  process.exit(0);
}

main();
