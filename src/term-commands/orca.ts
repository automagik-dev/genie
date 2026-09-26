/**
 * genie orca — a one-release retirement stub.
 *
 * The Orca integration is retired (wish `retire-orca-integration`): the plugin,
 * the adapter and the one-way card mirror are gone. The verb stays registered
 * and VISIBLE for one release so a host script calling `genie orca mirror …`
 * gets a named notice instead of Commander's `unknown command`, and so the
 * top-level command count does not move. It accepts any subcommand and flags,
 * writes nothing, spawns nothing, and exits 2 — genie's "the operator must act"
 * code. The follow-up release removes the verb.
 */

import type { Command } from 'commander';
import { printErr } from '../lib/term-output.js';

export const ORCA_RETIRED_NOTICE =
  'genie orca is retired: the Orca integration (plugin, adapter and card mirror) was removed, and nothing was written. Remove this call; genie keeps lifecycle state on its own board.';

export function registerOrcaCommands(program: Command): void {
  program
    .command('orca')
    .description('Retired: the Orca integration was removed')
    .argument('[args...]')
    .allowUnknownOption()
    .allowExcessArguments()
    .helpOption(false)
    .action(() => {
      printErr(ORCA_RETIRED_NOTICE);
      process.exitCode = 2;
    });
}
