/**
 * Genie Shortcuts Commands
 *
 * Commands to install, uninstall, and show keyboard shortcuts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { printOut } from '../lib/term-output.js';
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
 * Whether prompting is forbidden outright.
 *
 * A prompt READS stdin, so a stdin that is not a terminal can never answer one.
 * Until the 2026-09-15 r2 dogfood this was decided per-target, downstream: the
 * question was rendered to stdout (`Add shortcuts to ~/.tmux.conf? [Y/n]`) and
 * only then did the run discover there was no answer and refuse. The decision
 * now happens here, before a single byte of any question is drawn.
 *
 * The cost is that piping answers (`printf 'y\ny\n' | genie shortcuts
 * install`) no longer selects targets one by one; the documented scripted route
 * is the whole-run default, `genie shortcuts install --yes`, which the refusal
 * names verbatim.
 */
function promptingForbidden(): boolean {
  if (process.argv.includes('--no-interactive')) return true;
  return !process.stdin.isTTY;
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

  printOut('Installation status:');

  if (isShortcutsInstalled(tmuxConf)) {
    printOut('  \x1b[32m✓\x1b[0m tmux.conf');
  } else {
    printOut('  \x1b[33m-\x1b[0m tmux.conf');
  }

  const shellRc = existsSync(zshrc) ? zshrc : bashrc;
  if (isShortcutsInstalled(shellRc)) {
    printOut(`  \x1b[32m✓\x1b[0m ${shellRc.replace(home, '~')}`);
  } else {
    printOut(`  \x1b[33m-\x1b[0m ${shellRc.replace(home, '~')}`);
  }

  printOut();
  printOut('Run \x1b[36mgenie shortcuts install\x1b[0m to install shortcuts.');
  printOut('Run \x1b[36mgenie shortcuts uninstall\x1b[0m to remove shortcuts.');
  printOut();
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
