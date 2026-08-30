import type { Command } from 'commander';

export const UI_BRIDGE_RETIRED_DIAGNOSTIC =
  'Error: genie ui-bridge has been retired; the Orca integration is the supported UI surface, or roll back to a pre-retirement signed release.';

export function registerUiBridgeCommand(program: Command): void {
  program
    .command('ui-bridge')
    .description('Report that the legacy Genie UI bridge is retired')
    .action(() => {
      process.stderr.write(`${UI_BRIDGE_RETIRED_DIAGNOSTIC}\n`);
      process.exitCode = 1;
    });
}
