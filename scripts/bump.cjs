#!/usr/bin/env node

/**
 * Genie Release Bumper
 *
 * Creates RC (release candidate) versions and pushes to trigger CI publish to @next
 *
 * Usage:
 *   pnpm bump:patch  → 2.0.1 → 2.0.2-rc.1
 *   pnpm bump:minor  → 2.0.1 → 2.1.0-rc.1
 *   pnpm bump:major  → 2.0.1 → 3.0.0-rc.1
 *   pnpm bump:rc     → 2.1.0-rc.1 → 2.1.0-rc.2
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BUMP_TYPE = process.argv[2];
const NO_PUSH = process.argv[3] === '--no-push' || process.env.SKIP_PUSH === 'true';
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

  // Check git status (ignore submodules)
  const status = exec('git status --porcelain --ignore-submodules', true);
  if (status) {
    log('red', '❌', 'Working directory not clean. Commit or stash changes first.');
    process.exit(1);
  }

  // Check on main/master branch
  const branch = exec('git branch --show-current', true);
  if (branch !== 'main' && branch !== 'master') {
    log('yellow', '⚠️', `You're on branch '${branch}', not main/master. Continue? (Ctrl+C to abort)`);
  }

  log('green', '✅', 'Pre-flight checks passed');
}

// Parse current version
function parseVersion(version) {
  const rcMatch = version.match(/^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/);
  if (rcMatch) {
    return {
      major: parseInt(rcMatch[1]),
      minor: parseInt(rcMatch[2]),
      patch: parseInt(rcMatch[3]),
      rc: parseInt(rcMatch[4]),
      isRC: true,
    };
  }

  const stableMatch = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (stableMatch) {
    return {
      major: parseInt(stableMatch[1]),
      minor: parseInt(stableMatch[2]),
      patch: parseInt(stableMatch[3]),
      rc: 0,
      isRC: false,
    };
  }

  throw new Error(`Invalid version format: ${version}`);
}

// Calculate new version
function calculateNewVersion(current, bumpType) {
  const parsed = parseVersion(current);

  switch (bumpType) {
    case 'patch':
      return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}-rc.1`;

    case 'minor':
      return `${parsed.major}.${parsed.minor + 1}.0-rc.1`;

    case 'major':
      return `${parsed.major + 1}.0.0-rc.1`;

    case 'rc-increment':
      if (!parsed.isRC) {
        log('red', '❌', `Current version ${current} is not an RC. Use bump:patch/minor/major instead.`);
        process.exit(1);
      }
      return `${parsed.major}.${parsed.minor}.${parsed.patch}-rc.${parsed.rc + 1}`;

    default:
      throw new Error(`Invalid bump type: ${bumpType}`);
  }
}

// Main logic
function main() {
  if (!['patch', 'minor', 'major', 'rc-increment'].includes(BUMP_TYPE)) {
    log('red', '❌', 'Usage: node scripts/bump.js <patch|minor|major|rc-increment>');
    process.exit(1);
  }

  preflight();

  // Read current version
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const currentVersion = pkg.version;
  const newVersion = calculateNewVersion(currentVersion, BUMP_TYPE);

  log('magenta', '🎯', `Bumping: ${currentVersion} → ${newVersion}`);

  // Update package.json
  pkg.version = newVersion;
  fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
  log('green', '✅', 'Updated package.json');

  // Update CHANGELOG for this RC (move Unreleased → new RC section) via Node script
  try {
    log('blue', '📝', 'Updating CHANGELOG.md...');
    require('child_process').execSync(
      `node ${path.join(__dirname, '..', '.genie', 'scripts', 'update-changelog.cjs')} rc ${newVersion}`,
      { stdio: 'inherit' }
    );
    log('green', '✅', 'CHANGELOG updated');
  } catch (e) {
    log('yellow', '⚠️', 'CHANGELOG update failed; continuing without changelog move');
  }

  // Git operations
  exec('git add package.json CHANGELOG.md');

  const commitMessage = `chore: pre-release v${newVersion}

Co-authored-by: Automagik Genie 🧞 <genie@namastex.ai>`;

  exec(`git commit --no-verify -m "${commitMessage}"`);
  log('green', '✅', 'Created commit');

  exec(`git tag v${newVersion}`);
  log('green', '✅', `Tagged v${newVersion}`);

  // Push to trigger CI (unless --no-push flag is set)
  if (!NO_PUSH) {
    log('blue', '📤', 'Pushing to remote...');
    exec('git push --no-verify');
    exec('git push --no-verify --tags');

    log('green', '🎉', 'Release candidate created!');
    console.log('');

    // Trigger publish workflow
    log('blue', '🚀', 'Triggering publish workflow...');
    const workflowResult = exec(`gh workflow run publish.yml --field tag=v${newVersion}`, true);

    if (workflowResult === null || workflowResult === '') {
      log('green', '✅', 'Publish workflow triggered');
      log('blue', '📦', `CI will publish: npm install automagik-genie@next`);
      log('blue', '🔗', 'Monitor CI: https://github.com/namastexlabs/automagik-genie/actions');
    } else {
      log('yellow', '⚠️', 'Could not trigger workflow automatically');
      log('yellow', '💡', `Run manually: gh workflow run publish.yml --field tag=v${newVersion}`);
    }

    console.log('');
    log('yellow', '💡', `When ready: pnpm release:stable`);
  } else {
    log('green', '🎉', 'Release candidate created locally!');
    log('yellow', '💡', `Tag: v${newVersion} (not pushed)`);
    console.log('');
    log('blue', '💡', 'Next: Push tag and create GitHub release');
  }
}

main();
