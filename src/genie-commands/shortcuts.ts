/**
 * Genie Shortcuts Commands
 *
 * Commands to install, uninstall, and show keyboard shortcuts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  displayShortcuts,
  installShortcuts,
  isShortcutsInstalled,
  uninstallShortcuts,
} from '../term-commands/shortcuts.js';

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
export async function shortcutsInstallCommand(): Promise<void> {
  await installShortcuts();
}

/**
 * Uninstall shortcuts from config files
 */
export async function shortcutsUninstallCommand(): Promise<void> {
  await uninstallShortcuts();
}
