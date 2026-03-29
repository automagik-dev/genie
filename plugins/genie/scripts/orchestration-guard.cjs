#!/usr/bin/env node
"use strict";

/**
 * orchestration-guard — PreToolUse:Bash hook that catches orchestration anti-patterns.
 *
 * Intercepts bash commands that bypass genie's structured monitoring primitives:
 * - tmux capture-pane for worker monitoring (use genie status/events instead)
 * - sleep+poll loops for terminal scraping (use genie send/events instead)
 *
 * Returns JSON to Claude Code hook system:
 * - { "decision": "block", "reason": "..." } to prevent execution
 * - Exits 0 with no output to allow
 *
 * Payload on stdin (PreToolUse:Bash):
 * { "tool_name": "Bash", "tool_input": { "command": "..." }, ... }
 */

const PATTERNS = [
  {
    // tmux capture-pane used for monitoring worker output
    pattern: /tmux\s+capture-pane/,
    message: `🚫 **Orchestration guard: tmux scraping blocked**

You're using \`tmux capture-pane\` to read a worker's terminal. This is screen-scraping — use genie's structured primitives instead:

| Need | Command |
|------|---------|
| Wish progress | \`genie status <slug>\` |
| Worker state | \`genie ls --json\` |
| Event timeline | \`genie events timeline <entity-id>\` |
| Send message | \`genie send '<msg>' --to <agent>\` |
| Error patterns | \`genie events errors\` |

**Why:** tmux scraping is opaque to PG, metrics, and diagnostics. Structured state persists across sessions.`
  },
  {
    // sleep+tmux polling pattern (sleep followed by tmux in same command)
    pattern: /sleep\s+\d+\s*&&\s*tmux/,
    message: `🚫 **Orchestration guard: sleep+poll loop blocked**

You're using a \`sleep && tmux\` polling loop to watch a worker. This is an anti-pattern.

**Instead:** Use \`genie status <slug>\` to check progress, or \`genie send\` to communicate. Workers report back via PG events — you don't need to poll their terminals.

**Post-dispatch flow:**
1. Dispatch → \`genie team create\` or \`genie spawn\`
2. Trust → workers execute autonomously
3. Check → \`genie status <slug>\`
4. Communicate → \`genie send '<msg>' --to <agent>\`
5. Review → when done, review the output`
  },
  {
    // sleep used as a polling delay for monitoring (broader catch)
    pattern: /sleep\s+\d+\s*&&\s*.*(?:capture-pane|genie\s+ls|tmux\s+list)/,
    message: `⚠️ **Orchestration guard: polling pattern detected**

You're using \`sleep\` to poll for status. Consider using structured genie primitives instead:

- \`genie status <slug>\` — wish progress from PG
- \`genie events list --since 5m\` — recent events
- \`genie send '<msg>' --to <agent>\` — direct communication`
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

  // Only intercept Bash tool calls
  if (payload.tool_name !== 'Bash') process.exit(0);

  const command = payload.tool_input?.command;
  if (!command) process.exit(0);

  // Check each pattern
  for (const { pattern, message } of PATTERNS) {
    if (pattern.test(command)) {
      // Output block decision
      console.log(JSON.stringify({
        decision: 'block',
        reason: message
      }));
      process.exit(0);
    }
  }

  // Allow — no output means proceed
  process.exit(0);
}

main();
