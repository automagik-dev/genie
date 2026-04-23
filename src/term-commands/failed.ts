/**
 * `genie failed --reason "..."` — close the current turn with outcome='failed'.
 * Requires GENIE_EXECUTOR_ID (set by every spawn path).
 */

import { turnClose } from '../lib/turn-close.js';

interface FailedActionDeps {
  turnCloseFn?: typeof turnClose;
}

export async function failedAction(options: { reason?: string }, deps: FailedActionDeps = {}): Promise<void> {
  const reason = options.reason?.trim();
  if (!reason) {
    console.error('❌ genie failed requires --reason "<message>"');
    process.exit(2);
  }

  const fn = deps.turnCloseFn ?? turnClose;
  const result = await fn({ outcome: 'failed', reason });
  if (result.noop) {
    console.log(`ℹ️  Executor ${result.executorId} already closed — no-op.`);
  } else {
    console.log(`🛑 Turn closed: outcome=failed, executor=${result.executorId}`);
    console.log(`   Reason: ${reason}`);
  }
}
