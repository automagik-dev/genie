/**
 * `genie metrics learn` — the seam for the learning-loop report (meter wish, Group 4).
 *
 * `registerMetricsCommand` calls this once, so the report lands here without another edit to
 * `metrics.ts`. Until it does, the verb is hidden from help and refuses with exit 2, writing nothing.
 */

import type { Command } from 'commander';
import { printErr } from '../lib/term-output.js';

export function registerMetricsLearnSubcommand(metrics: Command): void {
  metrics
    .command('learn', { hidden: true })
    .description('The learning-loop report over the usage meter (not available yet)')
    .argument('[args...]')
    .allowUnknownOption()
    .action(() => {
      printErr('Error (genie metrics learn): not available yet; nothing was read or written.');
      process.exitCode = 2;
    });
}
