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

const ORCHESTRATION_RULES_PATH = join(homedir(), '.claude', 'rules', 'genie-orchestration.md');
import { confirm } from '@inquirer/prompts';
import { hookScriptExists, removeHookScript } from '../lib/claude-settings.js';
import { contractPath, getGenieDir } from '../lib/genie-config.js';

const LOCAL_BIN = join(homedir(), '.local', 'bin');

// Symlinks that may have been created by source install
const SYMLINKS = ['genie', 'term'];

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

/** Try an uninstall step, logging success or warning on failure. */
function tryRemoveStep(label: string, successMsg: string, fn: () => void): void {
  console.log(`\x1b[2m${label}\x1b[0m`);
  try {
    fn();
    console.log(`  \x1b[32m+\x1b[0m ${successMsg}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  \x1b[33m!\x1b[0m ${label.replace('...', '')} failed: ${message}`);
  }
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
    tryRemoveStep('Removing hook script...', 'Hook script removed', () => removeHookScript());
  }

  if (existingSymlinks.length > 0) {
    console.log('\x1b[2mRemoving symlinks...\x1b[0m');
    const removed = removeSymlinks();
    if (removed.length > 0) {
      console.log(`  \x1b[32m+\x1b[0m Removed: ${removed.join(', ')}`);
    }
  }

  if (existsSync(ORCHESTRATION_RULES_PATH)) {
    tryRemoveStep(
      'Removing orchestration rules...',
      'Orchestration rules removed (~/.claude/rules/genie-orchestration.md)',
      () => unlinkSync(ORCHESTRATION_RULES_PATH),
    );
  }

  if (hasGenieDir) {
    tryRemoveStep('Removing genie directory...', 'Directory removed', () =>
      rmSync(genieDir, { recursive: true, force: true }),
    );
  }
}

export async function uninstallCommand(): Promise<void> {
  console.log();
  console.log('\x1b[1m\x1b[33m Uninstall Genie CLI\x1b[0m');
  console.log();

  const genieDir = getGenieDir();
  const hasGenieDir = existsSync(genieDir);
  const hasHookScript = hookScriptExists();
  const hasOrchestrationRules = existsSync(ORCHESTRATION_RULES_PATH);
  const existingSymlinks = SYMLINKS.filter((name) => isGenieSymlink(join(LOCAL_BIN, name)));

  console.log('\x1b[2mThis will remove:\x1b[0m');
  if (hasHookScript) console.log('  \x1b[31m-\x1b[0m Hook script (~/.claude/hooks/genie-bash-hook.sh)');
  if (hasOrchestrationRules)
    console.log('  \x1b[31m-\x1b[0m Orchestration rules (~/.claude/rules/genie-orchestration.md)');
  if (hasGenieDir) console.log(`  \x1b[31m-\x1b[0m Genie directory (${contractPath(genieDir)})`);
  if (existingSymlinks.length > 0)
    console.log(`  \x1b[31m-\x1b[0m Symlinks from ~/.local/bin: ${existingSymlinks.join(', ')}`);
  console.log();

  if (!hasGenieDir && !hasHookScript && !hasOrchestrationRules && existingSymlinks.length === 0) {
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
