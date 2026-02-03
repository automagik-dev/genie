#!/usr/bin/env node
/**
 * Uninstall Script for automagik-genie
 *
 * Removes all installed components:
 * - CLI symlinks (genie, term)
 * - Version marker
 * - Plugin cache
 * - Plugin entry from installed_plugins.json
 *
 * Usage: node uninstall.js [--dry-run]
 */
import { existsSync, unlinkSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose') || DRY_RUN;

const HOME = homedir();
const GENIE_DIR = join(HOME, '.genie');
const MARKER = join(GENIE_DIR, '.install-version');
const BIN_DIR = join(HOME, '.local', 'bin');
const CLAUDE_DIR = join(HOME, '.claude');
const PLUGIN_CACHE = join(CLAUDE_DIR, 'plugins', 'cache', 'namastexlabs');
const INSTALLED_PLUGINS = join(CLAUDE_DIR, 'installed_plugins.json');

function log(msg) {
  console.log(msg);
}

function remove(path, description) {
  if (!existsSync(path)) {
    if (VERBOSE) log(`  [skip] ${description} - not found`);
    return false;
  }

  if (DRY_RUN) {
    log(`  [would remove] ${description}`);
    log(`                 ${path}`);
    return true;
  }

  try {
    rmSync(path, { recursive: true, force: true });
    log(`  [removed] ${description}`);
    if (VERBOSE) log(`            ${path}`);
    return true;
  } catch (error) {
    log(`  [error] ${description}: ${error.message}`);
    return false;
  }
}

function removeSymlink(name) {
  const linkPath = join(BIN_DIR, name);
  if (!existsSync(linkPath)) {
    if (VERBOSE) log(`  [skip] ${name} symlink - not found`);
    return false;
  }

  if (DRY_RUN) {
    log(`  [would remove] ${name} symlink`);
    log(`                 ${linkPath}`);
    return true;
  }

  try {
    unlinkSync(linkPath);
    log(`  [removed] ${name} symlink`);
    if (VERBOSE) log(`            ${linkPath}`);
    return true;
  } catch (error) {
    log(`  [error] ${name} symlink: ${error.message}`);
    return false;
  }
}

function removePluginEntry() {
  if (!existsSync(INSTALLED_PLUGINS)) {
    if (VERBOSE) log(`  [skip] plugin entry - installed_plugins.json not found`);
    return false;
  }

  try {
    const content = readFileSync(INSTALLED_PLUGINS, 'utf-8');
    const plugins = JSON.parse(content);

    // Find and remove automagik-genie entry
    const key = Object.keys(plugins).find(k =>
      k.includes('automagik-genie') || plugins[k]?.name === 'automagik-genie'
    );

    if (!key) {
      if (VERBOSE) log(`  [skip] plugin entry - not found in installed_plugins.json`);
      return false;
    }

    if (DRY_RUN) {
      log(`  [would remove] plugin entry: ${key}`);
      return true;
    }

    delete plugins[key];
    writeFileSync(INSTALLED_PLUGINS, JSON.stringify(plugins, null, 2) + '\n');
    log(`  [removed] plugin entry: ${key}`);
    return true;
  } catch (error) {
    log(`  [error] plugin entry: ${error.message}`);
    return false;
  }
}

// Main
log('');
log(DRY_RUN ? 'Uninstall (dry run) - no changes will be made' : 'Uninstalling automagik-genie...');
log('');

log('CLI symlinks:');
removeSymlink('genie');
removeSymlink('term');

log('');
log('Version marker:');
remove(MARKER, 'install version marker');

log('');
log('Plugin cache:');
remove(PLUGIN_CACHE, 'plugin cache directory');

log('');
log('Plugin registry:');
removePluginEntry();

log('');
if (DRY_RUN) {
  log('Dry run complete. Run without --dry-run to actually remove files.');
} else {
  log('Uninstall complete. Restart Claude Code and run:');
  log('  /plugin install namastexlabs/automagik-genie');
}
log('');
