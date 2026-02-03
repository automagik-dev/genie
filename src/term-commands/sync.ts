/**
 * Sync command - Sync plugin to ~/.claude/plugins using symlink
 *
 * Auto-detects genie-cli source location and creates a symlink
 * from ~/.claude/plugins/automagik-genie to the source plugin directory.
 *
 * Usage:
 *   term sync          - Auto-detect source and sync
 *   term sync --build  - Build plugin before syncing
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import {
  detectSourcePath,
  setSourcePath,
  contractPath,
  getStoredSourcePath,
} from '../lib/genie-config.js';

export interface SyncOptions {
  build?: boolean;
  verbose?: boolean;
}

const PLUGIN_NAME = 'automagik-genie';
const PLUGINS_DIR = join(homedir(), '.claude', 'plugins');
const INSTALLED_PLUGIN_PATH = join(PLUGINS_DIR, PLUGIN_NAME);

/**
 * Get plugin version from plugin.json
 */
function getPluginVersion(pluginDir: string): string | null {
  try {
    const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch {
    return null;
  }
}

/**
 * Check if a path is a symlink
 */
function isSymlink(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Check if a symlink points to a valid target
 */
function isValidSymlink(path: string): boolean {
  if (!isSymlink(path)) return false;
  try {
    // Check if target exists by trying to access it
    return existsSync(path);
  } catch {
    return false;
  }
}

/**
 * Get the target of a symlink
 */
function getSymlinkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Build the plugin
 */
function buildPlugin(sourcePath: string): boolean {
  console.log('Building plugin...');
  try {
    execSync('npm run build:plugin', {
      cwd: sourcePath,
      stdio: 'inherit',
    });
    return true;
  } catch (error: any) {
    console.error(`Failed to build plugin: ${error.message}`);
    return false;
  }
}

/**
 * Sync the plugin by creating a symlink
 */
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    // Detect source path
    const sourcePath = detectSourcePath();

    if (!sourcePath) {
      console.error('Could not find genie-cli source directory.');
      console.error('');
      console.error('Tried:');
      console.error('  1. Walking up from current directory');

      const storedPath = getStoredSourcePath();
      if (storedPath) {
        console.error(`  2. Stored path in config: ${storedPath} (not found or invalid)`);
      } else {
        console.error('  2. No stored path in ~/.genie/config.json');
      }
      console.error('  3. Known paths like ~/workspace/*/code/genie-cli');
      console.error('');
      console.error('To fix:');
      console.error('  1. Run this command from inside the genie-cli source directory, or');
      console.error('  2. Clone genie-cli and run `term sync` from there');
      process.exit(1);
    }

    // Save source path for future runs
    await setSourcePath(sourcePath);

    const pluginSourceDir = join(sourcePath, 'plugins', PLUGIN_NAME);

    // Validate plugin source exists
    if (!existsSync(pluginSourceDir)) {
      console.error(`Plugin source not found at ${contractPath(pluginSourceDir)}`);
      console.error('');
      console.error('The plugin directory should be at: plugins/automagik-genie/');
      console.error('Make sure you have the complete genie-cli repository.');
      process.exit(1);
    }

    // Optionally build before sync
    if (options.build) {
      if (!buildPlugin(sourcePath)) {
        process.exit(1);
      }
    }

    // Get plugin version for display
    const version = getPluginVersion(pluginSourceDir);

    // Ensure plugins directory exists
    mkdirSync(PLUGINS_DIR, { recursive: true });

    // Check current state
    const linkExists = existsSync(INSTALLED_PLUGIN_PATH) || isSymlink(INSTALLED_PLUGIN_PATH);
    const isLink = isSymlink(INSTALLED_PLUGIN_PATH);
    const currentTarget = isLink ? getSymlinkTarget(INSTALLED_PLUGIN_PATH) : null;

    if (options.verbose) {
      console.log(`Source: ${contractPath(sourcePath)}`);
      console.log(`Plugin source: ${contractPath(pluginSourceDir)}`);
      console.log(`Target: ${contractPath(INSTALLED_PLUGIN_PATH)}`);
      console.log(`Current state: ${linkExists ? (isLink ? `symlink -> ${currentTarget}` : 'directory') : 'not installed'}`);
    }

    // Handle existing installation
    if (linkExists) {
      if (isLink) {
        // Already a symlink
        if (currentTarget === pluginSourceDir) {
          // Already correct
          console.log(`Already synced: ${contractPath(INSTALLED_PLUGIN_PATH)} -> ${contractPath(pluginSourceDir)}`);
          if (version) {
            console.log(`Version: ${version}`);
          }
          return;
        }

        // Wrong target, update symlink
        console.log(`Updating symlink (was: ${currentTarget})`);
        rmSync(INSTALLED_PLUGIN_PATH);
      } else {
        // Regular directory (copy-based install), replace with symlink
        console.log('Replacing copy-based install with symlink...');
        rmSync(INSTALLED_PLUGIN_PATH, { recursive: true, force: true });
      }
    }

    // Create symlink
    symlinkSync(pluginSourceDir, INSTALLED_PLUGIN_PATH);

    console.log(`Synced: ${contractPath(INSTALLED_PLUGIN_PATH)} -> ${contractPath(pluginSourceDir)}`);
    if (version) {
      console.log(`Version: ${version}`);
    }
    console.log('');
    console.log('Plugin is now linked to source. Changes will be reflected immediately.');
    console.log('For TypeScript changes, rebuild with: npm run build:plugin');

  } catch (error: any) {
    console.error(`Sync failed: ${error.message}`);
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}
