#!/usr/bin/env node

/**
 * Genie Release Status Checker
 *
 * Shows current version status across local, git tags, and npm
 *
 * Usage:
 *   pnpm status
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');

// Colors
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function log(color, emoji, message) {
  console.log(`${colors[color]}${emoji} ${message}${colors.reset}`);
}

function exec(cmd, silent = true) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' }).trim();
  } catch (error) {
    return null;
  }
}

function main() {
  console.log('');
  log('cyan', '🧞', 'Automagik Genie Release Status');
  console.log('═'.repeat(50));

  // Local version
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const localVersion = pkg.version;
  const isRC = localVersion.includes('-rc.');

  log('blue', '📦', `Local package.json: ${localVersion}${isRC ? ' (RC)' : ' (Stable)'}`);

  // Git tags
  const latestTag = exec('git describe --tags --abbrev=0');
  const allTags = exec('git tag -l --sort=-version:refname')?.split('\n').slice(0, 5);

  if (latestTag) {
    log('blue', '🏷️', `Latest git tag: ${latestTag}`);
  }

  if (allTags && allTags.length > 1) {
    console.log('');
    log('cyan', '📜', 'Recent tags:');
    allTags.forEach((tag) => {
      if (tag) {
        const isRCTag = tag.includes('-rc.');
        console.log(`   ${tag}${isRCTag ? ' (RC)' : ''}`);
      }
    });
  }

  // NPM versions
  console.log('');
  log('cyan', '📡', 'NPM Registry:');

  const npmLatest = exec('npm view automagik-genie@latest version');
  const npmNext = exec('npm view automagik-genie@latest version');

  if (npmLatest) {
    log('green', '  @latest:', npmLatest);
  } else {
    log('yellow', '  @latest:', 'Not found');
  }

  if (npmNext) {
    log('yellow', '  @latest:', npmNext);
  } else {
    log('yellow', '  @latest:', 'Not found');
  }

  // Git status
  console.log('');
  const gitStatus = exec('git status --porcelain');
  if (gitStatus) {
    log('yellow', '⚠️', 'Working directory has uncommitted changes');
  } else {
    log('green', '✅', 'Working directory clean');
  }

  // Version sync check
  console.log('');
  log('cyan', '🔍', 'Version Sync:');

  const tagVersion = latestTag?.replace('v', '');
  if (tagVersion === localVersion) {
    log('green', '✅', 'package.json matches latest tag');
  } else {
    log('yellow', '⚠️', `package.json (${localVersion}) ≠ latest tag (${tagVersion})`);
  }

  // Next steps
  console.log('');
  console.log('═'.repeat(50));
  log('cyan', '💡', 'Quick Commands:');
  console.log('');

  if (isRC) {
    console.log('  pnpm bump:rc          - Increment RC version (rc.1 → rc.2)');
    console.log('  pnpm release:stable   - Promote to stable release');
  } else {
    console.log('  pnpm bump:patch       - Create patch RC (2.0.1 → 2.0.2-rc.1)');
    console.log('  pnpm bump:minor       - Create minor RC (2.0.1 → 2.1.0-rc.1)');
    console.log('  pnpm bump:major       - Create major RC (2.0.1 → 3.0.0-rc.1)');
  }

  console.log('');
}

main();
