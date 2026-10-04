/**
 * genie metrics — the operator's switch for opt-in lifecycle capture.
 *
 *   metrics enable    create <GENIE_HOME>/metrics/capture.on (the one switch)
 *   metrics disable   remove the switch; the ledger is kept
 *   metrics status    what is on, where the ledger is, which runtime session this shell is in
 *
 * Capture is OFF until `enable` runs: a host that never runs it sees no new
 * file, directory, latency or network call. Enabling sends nothing anywhere —
 * the ledger is machine-local metadata (`src/lib/metrics-capture.ts`).
 */

import type { Command } from 'commander';
import { type CaptureStatus, captureStatus, disableCapture, enableCapture } from '../lib/metrics-capture.js';
import { printErr, printOut } from '../lib/term-output.js';

interface JsonOption {
  json?: boolean;
}

function renderStatus(status: CaptureStatus): string {
  const state = status.enabled ? 'on' : status.disabledByEnv ? 'off (GENIE_METRICS=off in this environment)' : 'off';
  const session = status.session.source
    ? `${status.session.source} ${status.session.id ?? '(no id)'}`
    : 'none detected';
  const ledger = status.ledgerBytes === null ? 'not created' : `${status.ledgerBytes} bytes`;
  return [
    `capture: ${state}`,
    `switch:  ${status.signal}`,
    `ledger:  ${status.ledger} (${ledger})`,
    `session: ${session}`,
  ].join('\n');
}

export function registerMetricsCommand(program: Command): void {
  const metrics = program
    .command('metrics')
    .description('Opt-in lifecycle capture: a machine-local metadata ledger, off until enabled');

  metrics
    .command('enable')
    .description('Turn capture on for this GENIE_HOME (writes the switch; sends nothing anywhere)')
    .action(() => {
      try {
        enableCapture();
      } catch (error) {
        printErr(`Error (genie metrics enable): ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }
      printOut(renderStatus(captureStatus()));
    });

  metrics
    .command('disable')
    .description('Turn capture off (removes the switch; the ledger is kept)')
    .action(() => {
      const removed = disableCapture();
      printOut(removed ? 'capture: off' : 'capture: already off');
    });

  metrics
    .command('status')
    .description('Show whether capture is on, where the ledger is, and the runtime session of this shell')
    .option('--json', 'Emit the status as JSON')
    .action((options: JsonOption) => {
      const status = captureStatus();
      printOut(options.json ? JSON.stringify(status) : renderStatus(status));
    });
}
