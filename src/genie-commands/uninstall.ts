/**
 * Genie Uninstall Command
 *
 * Removes Genie CLI entirely:
 * - Remove hooks from Claude Code (migration cleanup)
 * - Delete ~/.genie directory
 * - Remove symlinks from ~/.local/bin
 */

import { confirm } from '@inquirer/prompts';
import { existsSync, rmSync, unlinkSync, lstatSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import {
  loadClaudeSettings,
  saveClaudeSettings,
  isGenieHookInstalled,
  removeGenieHook,
  hookScriptExists,
  removeHookScript,
} from '../lib/claude-settings.js';
import { getGenieDir, contractPath } from '../lib/genie-config.js';

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'term', 'claudio'];

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
export async function uninstallCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  const genieDir = getGenieDir();
  const hasGenieDir = existsSync(genieDir);
  const hasHookScript = hookScriptExists();

  // Check what will be removed
  const settings = await loadClaudeSettings();
  const hasHookRegistered = isGenieHookInstalled(settings);

  // Count symlinks
  const existingSymlinks = SYMLINKS.filter((name) =>
    isGenieSymlink(join(LOCAL_BIN, name))
  );

  // Show what will be removed
  console.log('\x1b[2mThis will remove:\x1b[0m');
  if (hasHookRegistered) {
    console.log('  \x1b[31m-\x1b[0m Hook registration from Claude Code');
  }
  if (hasHookScript) {
    console.log('  \x1b[31m-\x1b[0m Hook script (~/.claude/hooks/genie-bash-hook.sh)');
  }
  if (hasGenieDir) {
    console.log('  \x1b[31m-\x1b[0m Genie directory (' + contractPath(genieDir) + ')');
  }
  if (existingSymlinks.length > 0) {
    console.log('  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ' + existingSymlinks.join(', '));
  }
  console.log();

  if (!hasGenieDir && !hasHookScript && !hasHookRegistered && existingSymlinks.length === 0) {
    console.log('\x1b[33mNothing to uninstall.\x1b[0m');
    console.log();
    return;
  }

  // Confirm with user
  const proceed = await confirm({
    message: 'Are you sure you want to uninstall Genie CLI?',
    default: false,
  });

  if (!proceed) {
    console.log();
    console.log('\x1b[2mUninstall cancelled.\x1b[0m');
    console.log();
    return;
  }

  console.log();

  // 1. Remove hooks from Claude Code
  if (hasHookRegistered) {
    console.log('\x1b[2mRemoving hook from Claude Code...\x1b[0m');
    try {
      const updatedSettings = removeGenieHook(settings);
      await saveClaudeSettings(updatedSettings);
      console.log('  \x1b[32m+\x1b[0m Hook unregistered');
    } catch (error: any) {
      console.log('  \x1b[33m!\x1b[0m Could not unregister hook: ' + error.message);
    }
  }

  // 2. Remove hook script
  if (hasHookScript) {
    console.log('\x1b[2mRemoving hook script...\x1b[0m');
    try {
      removeHookScript();
      console.log('  \x1b[32m+\x1b[0m Hook script removed');
    } catch (error: any) {
      console.log('  \x1b[33m!\x1b[0m Could not remove hook script: ' + error.message);
    }
  }

  // 3. Remove symlinks
  if (existingSymlinks.length > 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const removed = removeSymlinks();
    if (removed.length > 0) {
      console.log('  \x1b[32m+\x1b[0m Removed: ' + removed.join(', '));
    }
  }

  // 4. Delete ~/.genie directory
  if (hasGenieDir) {
    console.log('\x1b[2mRemoving genie directory...\x1b[0m');
    try {
      rmSync(genieDir, { recursive: true, force: true });
      console.log('  \x1b[32m+\x1b[0m Directory removed');
    } catch (error: any) {
      console.log('  \x1b[33m!\x1b[0m Could not remove directory: ' + error.message);
    }
  }

  console.log();
  console.log('\x1b[32m+\x1b[0m Genie CLI uninstalled.');
  console.log();

  // Note about npm/bun global package
  console.log('\x1b[2mNote: If you installed via npm/bun, also run:\x1b[0m');
  console.log('  \x1b[36mbun remove -g @automagik/genie\x1b[0m');
  console.log('  \x1b[2mor\x1b[0m');
  console.log('  \x1b[36mnpm uninstall -g @automagik/genie\x1b[0m');
  console.log();
}
