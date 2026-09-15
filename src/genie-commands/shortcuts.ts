/**
 * Genie Shortcuts Commands
 *
 * Commands to install, uninstall, and show keyboard shortcuts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ShortcutsOutcome,
  displayShortcuts,
  installShortcuts,
  isShortcutsInstalled,
  uninstallShortcuts,
} from '../term-commands/shortcuts.js';

/** Commander options shared by `shortcuts install` and `shortcuts uninstall`. */
export interface ShortcutsCommandOptions {
  /** Accept every target without prompting — the documented non-interactive route. */
  yes?: boolean;
}

/**
 * `refused` (prompting forbidden, no `--yes`) and `unanswered` (stdin ran out
 * mid-run) both exit 2 — the code `genie --help` documents for
 * `--no-interactive`. Both already wrote their one stderr line. A silent exit 0
 * with nothing written is the one outcome this command must never produce.
 */
function applyShortcutsOutcome(outcome: ShortcutsOutcome): void {
  if (outcome === 'refused' || outcome === 'unanswered') process.exitCode = 2;
}

/**
 * Whether prompting is forbidden outright. Only the explicit global
 * `--no-interactive` counts: a merely non-TTY stdin is NOT a refusal, because
 * piping answers (`printf 'y\ny\n' | genie shortcuts install`) is a supported
 * scripted workflow. A pipe that runs out of answers is caught downstream as
 * the `unanswered` outcome, which also exits 2.
 */
function promptingForbidden(): boolean {
  return process.argv.includes('--no-interactive');
}

/**
 * Show shortcuts info (default action)
 */
export async function shortcutsShowCommand(): Promise<void> {
  displayShortcuts();

  // Also show installation status
  const home = homedir();
  const tmuxConf = join(home, '.tmux.conf');
  const zshrc = join(home, '.zshrc');
  const bashrc = join(home, '.bashrc');

  console.log('Installation status:');

  if (isShortcutsInstalled(tmuxConf)) {
    console.log('  \x1b[32m✓\x1b[0m tmux.conf');
  } else {
    console.log('  \x1b[33m-\x1b[0m tmux.conf');
  }

  const shellRc = existsSync(zshrc) ? zshrc : bashrc;
  if (isShortcutsInstalled(shellRc)) {
    console.log(`  \x1b[32m✓\x1b[0m ${shellRc.replace(home, '~')}`);
  } else {
    console.log(`  \x1b[33m-\x1b[0m ${shellRc.replace(home, '~')}`);
  }

  console.log();
  console.log('Run \x1b[36mgenie shortcuts install\x1b[0m to install shortcuts.');
  console.log('Run \x1b[36mgenie shortcuts uninstall\x1b[0m to remove shortcuts.');
  console.log();
}

/**
 * Install shortcuts to config files
 */
export async function shortcutsInstallCommand(options: ShortcutsCommandOptions = {}): Promise<void> {
  applyShortcutsOutcome(await installShortcuts({ yes: options.yes, canPrompt: !promptingForbidden() }));
}

/**
 * Uninstall shortcuts from config files
 */
export async function shortcutsUninstallCommand(options: ShortcutsCommandOptions = {}): Promise<void> {
  applyShortcutsOutcome(await uninstallShortcuts({ yes: options.yes, canPrompt: !promptingForbidden() }));
}
