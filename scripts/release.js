#!/usr/bin/env node

/**
 * Genie Release Promoter
 *
 * Promotes RC versions to stable and creates GitHub releases
 *
 * Usage:
 *   pnpm release:stable  → 2.1.0-rc.1 → 2.1.0 (publishes to @latest)
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
};

function log(color, emoji, message) {
  console.log(`${colors[color]}${emoji} ${message}${colors.reset}`);
}

function exec(cmd, silent = false) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
    return result ? result.trim() : '';
  } catch (error) {
    if (!silent) throw error;
    return '';
  }
}

// Pre-flight checks
function preflight() {
  log('blue', '🔍', 'Running pre-flight checks...');

  // Check git status
  const status = exec('git status --porcelain', true);
  if (status) {
    log('red', '❌', 'Working directory not clean. Commit or stash changes first.');
    process.exit(1);
  }

  log('green', '✅', 'Pre-flight checks passed');
}

// Parse RC version to stable
function rcToStable(version) {
  const rcMatch = version.match(/^(\d+)\.(\d+)\.(\d+)-rc\.\d+$/);
  if (!rcMatch) {
    log('red', '❌', `Current version ${version} is not an RC. Nothing to promote.`);
    log('yellow', '💡', 'Use pnpm bump:patch/minor/major to create a new RC first.');
    process.exit(1);
  }

  return `${rcMatch[1]}.${rcMatch[2]}.${rcMatch[3]}`;
}

// Main logic
function main() {
  const action = process.argv[2];

  if (action !== 'stable') {
    log('red', '❌', 'Usage: node scripts/release.js stable');
    process.exit(1);
  }

  preflight();

  // Read current version
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const currentVersion = pkg.version;
  const stableVersion = rcToStable(currentVersion);

  log('magenta', '🚀', `Promoting: ${currentVersion} → ${stableVersion}`);
  console.log('');

  // Confirmation prompt (optional, remove if you want full automation)
  log('yellow', '⚠️', 'This will:');
  console.log('  1. Update package.json to stable version');
  console.log('  2. Create git commit + tag');
  console.log('  3. Push to trigger CI publish to @latest');
  console.log('  4. Create GitHub release');
  console.log('');
  log('yellow', '❓', 'Continue? Press Ctrl+C to abort, or press Enter to continue...');

  // Wait for user input (remove these lines for full automation)
  const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  readline.question('', () => {
    readline.close();
    executeRelease(pkg, stableVersion);
  });
}

function executeRelease(pkg, stableVersion) {
  // Update package.json
  pkg.version = stableVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  log('green', '✅', 'Updated package.json');

  // Run tests before releasing
  log('blue', '🧪', 'Running tests...');
  try {
    exec('pnpm run test:all');
    log('green', '✅', 'Tests passed');
  } catch (error) {
    log('red', '❌', 'Tests failed. Aborting release.');
    // Revert package.json
    exec('git checkout package.json');
    process.exit(1);
  }

  // Git operations
  exec('git add package.json');

  const commitMessage = `chore: release v${stableVersion}

Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>`;

  exec(`git commit -m "${commitMessage}"`);
  log('green', '✅', 'Created commit');

  exec(`git tag v${stableVersion}`);
  log('green', '✅', `Tagged v${stableVersion}`);

  // Push to trigger CI
  log('blue', '📤', 'Pushing to remote...');
  exec('git push');
  exec('git push --tags');

  log('green', '🎉', 'Stable release created!');
  console.log('');
  log('blue', '📦', 'CI will publish: npm install automagik-genie@latest');
  log('blue', '🔗', 'Monitor CI: https://github.com/namastexlabs/automagik-genie/actions');
  console.log('');

  // Create GitHub release (triggers publish workflow automatically)
  log('blue', '🏷️', 'Creating GitHub release...');
  try {
    exec(`gh release create v${stableVersion} --generate-notes --title "v${stableVersion}"`);
    log('green', '✅', 'GitHub release created');
    log('green', '✅', 'Publish workflow triggered automatically');
    log('blue', '📦', 'CI will publish: npm install automagik-genie@latest');
    log('blue', '🔗', 'Monitor CI: https://github.com/namastexlabs/automagik-genie/actions');
  } catch (error) {
    log('yellow', '⚠️', 'Could not create GitHub release automatically');
    log('yellow', '💡', `Create manually: gh release create v${stableVersion} --generate-notes`);
    log('yellow', '💡', `Or trigger workflow: gh workflow run publish.yml --field tag=v${stableVersion}`);
  }

  console.log('');
  log('green', '🧞', 'Release complete! Your wish has been granted! ✨');
}

main();
