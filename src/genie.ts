#!/usr/bin/env bun

/**
 * genie — Single entrypoint CLI (zero-daemon v5).
 *
 * Surviving surface after the v4 runtime demolition:
 *   Utilities:  setup, doctor, update, install, uninstall, shortcuts
 *   Lifecycle:  init (scaffold), context (spawn plan)
 *   State:      task, board  (SQLite-backed, .genie/genie.db)
 */

import { Command, Option } from 'commander';
import { doctorCommand } from './genie-commands/doctor.js';
import { type InstallPromoteCommandOptions, installPromoteCommand } from './genie-commands/install-promote.js';
import {
  INTEGRATION_SELECTIONS,
  type InstallOptions,
  InvalidIntegrationSelectionError,
  installCommand,
} from './genie-commands/install.js';
import { type SetupOptions, setupCommand } from './genie-commands/setup.js';
import {
  shortcutsInstallCommand,
  shortcutsShowCommand,
  shortcutsUninstallCommand,
} from './genie-commands/shortcuts.js';
import { uninstallCommand } from './genie-commands/uninstall.js';
import { updateCommand } from './genie-commands/update.js';
import { installWorkspaceCheck } from './lib/interactivity.js';
import { colorizeFor } from './lib/term-color.js';
import { printErr, runUnderBrokenPipeGuard, writeErr } from './lib/term-output.js';
import { VERSION } from './lib/version.js';
import { registerContextCommand } from './term-commands/context.js';
import { registerIdeaCommand } from './term-commands/idea.js';
import { registerInitCommand } from './term-commands/init.js';
import { registerMcpCommand } from './term-commands/mcp.js';
import { registerOmniCommands } from './term-commands/omni.js';
import { registerUiBridgeCommand } from './term-commands/ui-bridge.js';
import { registerV5BoardCommands } from './term-commands/v5-board.js';
import { registerV5TaskCommands } from './term-commands/v5-task.js';

const program = new Command();

program.name('genie').description('Genie CLI - AI-assisted development').version(VERSION);

program
  .command('__install-promote', { hidden: true })
  .option('--staging-root <path>')
  .option('--expected-version <version>')
  .option('--self-test')
  .action((options: InstallPromoteCommandOptions) => {
    try {
      installPromoteCommand(options);
    } catch (error) {
      // Preflight/link failures are operator-fixable environment problems
      // (e.g. a group-writable ~/.local/bin); print the remedy, never a stack.
      const name = error instanceof Error ? error.name : '';
      if (name === 'CanonicalInstallLinkError' || name === 'InstallPromoteCommandError') {
        printErr(`\u2716 ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

// Global --no-interactive flag: disables all interactive prompts (scripting safety)
program.option('--no-interactive', 'Disable interactive prompts (exit 2 instead of prompting)');

program.configureHelp({
  sortSubcommands: true,
  showGlobalOptions: true,
});

program.configureOutput({
  // Commander writes this to stderr. Colour is gated on the STDERR stream (plus
  // NO_COLOR / TERM=dumb): a redirected or piped diagnostic must be plain text,
  // never `\x1b[31m` smuggled into a log file. Commander's own `write` callback
  // is deliberately unused — every genie line leaves through the one sink in
  // src/lib/term-output.ts, which is where the escapes are stripped.
  outputError: (str) => {
    const cmd = program.commands.find((c) => process.argv.slice(2, 6).includes(c.name()));
    const prefix = cmd ? `genie ${cmd.name()}` : 'genie';
    writeErr(`${colorizeFor('stderr', '\x1b[31m', `Error (${prefix}): ${str}`)}\n`);
  },
});

// ============================================================================
// Utility commands
// ============================================================================

program
  .command('setup')
  .description('Configure genie settings')
  .option('--quick', 'Accept all defaults')
  .option('--shortcuts', 'Only configure keyboard shortcuts')
  .option('--terminal', 'Only configure terminal defaults')
  .option('--session', 'Only configure session settings')
  .addOption(
    new Option('--orchestration-mode <mode>', 'Select lifecycle authority explicitly')
      .choices(['standalone', 'orca'])
      .conflicts(['quick', 'shortcuts', 'terminal', 'session', 'reset', 'show']),
  )
  .option('--reset', 'Reset configuration to defaults')
  .option('--show', 'Show current configuration')
  .action(async (options: SetupOptions) => {
    await setupCommand(options);
  });

program
  .command('doctor')
  .description('Run diagnostic checks on genie installation')
  .option('--json', 'Emit JSON instead of human output')
  .option(
    '--fix',
    'Backup/remove proven v4 residue and merged clean `genie launch` worktrees; tighten registered-worktree files only from wider modes to their index modes and dirs only from 0775/0777 to 0755; refuse replacements, symlinks, and non-wider or ambiguous modes (idempotent)',
  )
  .action(doctorCommand);

program
  .command('update')
  .description('Update Genie CLI to the latest version (GitHub Releases)')
  .option('--dev', 'Switch to dev (pre-release) channel (.well-known/dev.json)')
  .option('--next', 'Deprecated alias for --dev (will be removed in a future release)')
  .option('--stable', 'Switch to stable channel (.well-known/latest.json)')
  .option('-y, --yes', 'Skip the TTY confirmation prompt (or set GENIE_UPDATE_YES=1)')
  .option('--no-restart', 'Skip the post-update binary verify probe')
  .option('--no-verify', 'Skip the post-update binary verify probe')
  .option('--skip-maintenance', 'Skip the post-update binary verify probe (or set GENIE_UPDATE_SKIP_MAINTENANCE=1)')
  .addOption(
    new Option('--rollback', 'Check legacy rollback state and print signed-version reinstall guidance').conflicts(
      'syncOnly',
    ),
  )
  .addOption(
    new Option(
      '--sync-only',
      'Converge agent integrations only — no manifest fetch or binary swap (GENIE_UPDATE_SYNC_ONLY=1)',
    ).conflicts('rollback'),
  )
  .addOption(
    new Option('--post-delivery-converge')
      .hideHelp()
      .conflicts([
        'rollback',
        'syncOnly',
        'dev',
        'next',
        'stable',
        'yes',
        'restart',
        'verify',
        'skipMaintenance',
        'publishLocalDelivery',
      ]),
  )
  .addOption(new Option('--print-update-capabilities').hideHelp())
  .addOption(new Option('--json').hideHelp())
  .addOption(
    new Option('--publish-local-delivery <request>')
      .hideHelp()
      .conflicts([
        'rollback',
        'syncOnly',
        'postDeliveryConverge',
        'printUpdateCapabilities',
        'json',
        'dev',
        'next',
        'stable',
        'yes',
        'restart',
        'verify',
        'skipMaintenance',
      ]),
  )
  .action(updateCommand);

program
  .command('install')
  .description('Post-install finishing step — invoked by install.sh after the binary is linked')
  .option('--skip-v4-cleanup', 'Leave v4-era leftovers in place (orchestration rules, orphaned plugin caches)')
  // `.choices()` (not a bare `.option()`) so an unknown mode is refused at parse
  // time with a one-line Commander error that NAMES the allowed values and exits
  // 1 — never the Bun stack trace `resolveIntegrationSelection` used to produce.
  .addOption(
    new Option('--integrations <mode>', 'Consent scope for the skills channel: auto, codex, claude, all, or none')
      .choices([...INTEGRATION_SELECTIONS])
      .default('auto'),
  )
  .option('--skip-integrations', 'Alias for --integrations none')
  .action(async (options: InstallOptions) => {
    // Second gate: `--skip-integrations` and programmatic callers bypass
    // `.choices()`. Operator input still gets one line and exit 1, no stack.
    try {
      await installCommand(options);
    } catch (error) {
      if (error instanceof InvalidIntegrationSelectionError) {
        printErr(colorizeFor('stderr', '\x1b[31m', `Error (genie install): ${error.message}`));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });

program
  .command('uninstall')
  .description('Remove Genie CLI, plugins, marker-owned agents, and hooks')
  .option('--remove-marketplace', 'Also remove the shared Automagik marketplace registrations')
  .action(uninstallCommand);

const shortcuts = program.command('shortcuts').description('Manage tmux keyboard shortcuts');
shortcuts.action(shortcutsShowCommand);
shortcuts.command('show').description('Show available shortcuts and installation status').action(shortcutsShowCommand);
shortcuts
  .command('install')
  .description('Install shortcuts to config files (~/.tmux.conf, shell rc)')
  .option('-y, --yes', 'Accept every target without prompting (the non-interactive route)')
  .action(shortcutsInstallCommand);
shortcuts
  .command('uninstall')
  .description('Remove shortcuts from config files')
  .option('-y, --yes', 'Accept every target without prompting (the non-interactive route)')
  .action(shortcutsUninstallCommand);

// ============================================================================
// Bare task/board — thin commands over the zero-daemon SQLite state engine.
// ============================================================================

registerInitCommand(program);
registerMcpCommand(program);
registerUiBridgeCommand(program);
registerV5TaskCommands(program);
registerV5BoardCommands(program);
registerContextCommand(program);
registerIdeaCommand(program);
registerOmniCommands(program);

// ============================================================================
// Universal workspace check — ensures workspace exists before commands that need it
// ============================================================================

installWorkspaceCheck(program);

// One process-level broken-pipe guard for the whole CLI. `genie task status
// <id> | head -1` closes the reader before the producer is done; without this
// the EPIPE surfaced as an uncaught Bun stack trace and exit 1, so a claim that
// had already been committed read as a failure (2026-09-15 dogfood r2 §3.2 C).
await runUnderBrokenPipeGuard(() => program.parseAsync(process.argv).then(() => undefined));
