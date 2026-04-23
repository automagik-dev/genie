/**
 * `genie blocked --reason "..."` — close the current turn with outcome='blocked'.
 * Requires GENIE_EXECUTOR_ID (set by every spawn path).
 */

import { turnClose } from '../lib/turn-close.js';

interface BlockedActionDeps {
  turnCloseFn?: typeof turnClose;
}

export async function blockedAction(options: { reason?: string }, deps: BlockedActionDeps = {}): Promise<void> {
  const reason = options.reason?.trim();
  if (!reason) {
    console.error('❌ genie blocked requires --reason "<message>"');
    process.exit(2);
  }

  const fn = deps.turnCloseFn ?? turnClose;
  const result = await fn({ outcome: 'blocked', reason });
  if (result.noop) {
    console.log(`ℹ️  Executor ${result.executorId} already closed — no-op.`);
  } else {
    console.log(`🔒 Turn closed: outcome=blocked, executor=${result.executorId}`);
    console.log(`   Reason: ${reason}`);
  }
}
