/**
 * genie config — read the resolved genie configuration.
 *
 * Read-only by design. The config file (`<GENIE_HOME>/config.json`) is edited
 * by `genie setup` and by hand; this verb exists so a skill, a runbook, or an
 * operator can ask what a knob actually resolves to instead of restating the
 * constant in prose and drifting from it.
 *
 *   config get <dotted.key>   e.g. `genie config get budgets.maxEscalationsPerGroup`
 */

import type { Command } from 'commander';
import { UnknownConfigKeyError, resolveConfigKey } from '../lib/genie-config.js';
import { printErr, printOut } from '../lib/term-output.js';

/** Human rendering of a resolved value: strings bare, everything else as JSON. */
export function formatConfigValue(value: unknown): string {
  if (value === undefined) return '(unset)';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

interface ConfigGetOptions {
  json?: boolean;
}

async function handleConfigGet(key: string, options: ConfigGetOptions): Promise<void> {
  try {
    const resolved = await resolveConfigKey(key);
    if (options.json) {
      printOut(
        JSON.stringify({
          key: resolved.key,
          value: resolved.value === undefined ? null : resolved.value,
          source: resolved.source,
        }),
      );
      return;
    }
    printOut(formatConfigValue(resolved.value));
  } catch (error) {
    if (error instanceof UnknownConfigKeyError) {
      // Stable operator diagnostic: naming the key is what makes a typo in a
      // runbook or a skill's command line self-evident.
      printErr(`Error (genie config get): unknown config key: ${error.key}`);
      process.exitCode = 1;
      return;
    }
    printErr(`Error (genie config get): ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function registerConfigCommand(program: Command): void {
  const config = program.command('config').description('Read the resolved genie configuration');
  config
    .command('get <key>')
    .description('Print the resolved value of one dotted config key (e.g. budgets.maxEscalationsPerGroup)')
    .option('--json', 'Emit {"key","value","source"} instead of the bare value')
    .action(async (key: string, options: ConfigGetOptions) => {
      await handleConfigGet(key, options);
    });
}
