/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hook script from ~/.claude/hooks
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import { existsSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import { hookScriptExists, removeHookScript } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'claudio', 'term'];

/**
 * Check if a path is a symlink pointing to genie bin
 */
function isGenieSymlink(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) return false;
    // We don't need to check target - if it's our binary name, remove it
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove genie symlinks from ~/.local/bin
 */
function removeSymlinks(): string[] {
  const removed: string[] = [];

  for (const name of SYMLINKS) {
    const symlinkPath = join(LOCAL_BIN, name);
    if (isGenieSymlink(symlinkPath)) {
      try {
        unlinkSync(symlinkPath);
        removed.push(name);
      } catch {
        // Ignore errors - may not have permission
      }
    }
  }

  return removed;
}

/**
 * Uninstall Genie CLI entirely
 */
function performUninstall(
  hasHookScript: boolean,
  existingSymlinks: string[],
  genieDir: string,
  hasGenieDir: boolean,
): void {
  if (hasHookScript) {
    console.log('\x1b[2mRemoving hook script...\x1b[0m');
    try {
      removeHookScript();
      console.log('  \x1b[32m+\x1b[0m Hook script removed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  \x1b[33m!\x1b[0m Could not remove hook script: ${message}`);
    }
  }

  if (existingSymlinks.length > 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const removed = removeSymlinks();
    if (removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed: ${removed.join(', ')}`);
    }
  }

  if (hasGenieDir) {
    console.log('\x1b[2mRemoving genie directory...\x1b[0m');
    try {
      rmSync(genieDir, { recursive: true, force: true });
      console.log('  \x1b[32m+\x1b[0m Directory removed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  \x1b[33m!\x1b[0m Could not remove directory: ${message}`);
    }
  }
}

export async function uninstallCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  const genieDir = getGenieDir();
  const hasGenieDir = existsSync(genieDir);
  const hasHookScript = hookScriptExists();
  const existingSymlinks = SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name)));

  console.log('\x1b[2mThis will remove:\x1b[0m');
  if (hasHookScript) console.log('  \x1b[31m-\x1b[0m Hook script (~/.claude/hooks/genie-bash-hook.sh)');
  if (hasGenieDir) console.log(`  \x1b[31m-\x1b[0m Genie directory (${contractPath(genieDir)})`);
  if (existingSymlinks.length > 0)
    console.log(`  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ${existingSymlinks.join(', ')}`);
  console.log();

  if (!hasGenieDir && !hasHookScript && existingSymlinks.length === 0) {
    console.log('\x1b[33mNothing to uninstall.\x1b[0m');
    console.log();
    return;
  }

  const proceed = await confirm({ message: 'Are you sure you want to uninstall Genie CLI?', default: false });
  if (!proceed) {
    console.log();
    console.log('\x1b[2mUninstall cancelled.\x1b[0m');
    console.log();
    return;
  }

  console.log();
  performUninstall(hasHookScript, existingSymlinks, genieDir, hasGenieDir);

  console.log();
  console.log('\x1b[32m+\x1b[0m Genie CLI uninstalled.');
  console.log();
  console.log('\x1b[2mNote: If you installed via npm/bun, also run:\x1b[0m');
  console.log('  \x1b[36mbun remove -g @automagik/genie\x1b[0m');
  console.log('  \x1b[2mor\x1b[0m');
  console.log('  \x1b[36mnpm uninstall -g @automagik/genie\x1b[0m');
  console.log();
}
