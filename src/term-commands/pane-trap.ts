/**
 * `genie pane-trap` — internal verb invoked by the tmux `pane-died`
 * hook and the inline shell `EXIT` trap.
 *
 * This is part of the turn-session contract safety net (Group 5). It
 * never fails loudly: a dying pane is already an error surface, and
 * throwing here would clobber tmux's cleanup sequence.
 */

import { type TrapReason, trapPaneExit } from '../lib/pane-trap.js';

interface PaneTrapCliOpts {
  paneId?: string;
  executorId?: string;
  reason?: string;
}

function normalizeReason(raw: string | undefined): TrapReason {
  return raw === 'shell_exit' ? 'shell_exit' : 'pane_died';
}

export async function paneTrapAction(opts: PaneTrapCliOpts): Promise<void> {
  const result = await trapPaneExit({
    executorId: opts.executorId,
    paneId: opts.paneId,
    reason: normalizeReason(opts.reason),
  });

  if (result.executorId === null) {
    // No executor resolved — nothing to terminalize. This is common when
    // the trap fires on a pane that never had an executor bound (e.g.
    // a bare shell). Exit silently.
    return;
  }

  if (result.noop) {
    console.error(`[pane-trap] no-op for ${result.executorId} (already closed)`);
    return;
  }

  console.error(
    `[pane-trap] terminalized executor=${result.executorId} outcome=${result.outcome} reason=${result.reason}`,
  );
}
