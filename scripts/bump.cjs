#!/usr/bin/env node

/**
 * Genie Release Bumper
 *
 * Creates RC (release candidate) versions and pushes to trigger CI publish to @latest
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

  // Update our own .genie/state/version.json (we're the master, not a consumer)
  const versionJsonPath = path.join(__dirname, '..', '.genie', 'state', 'version.json');
  const versionJsonDir = path.dirname(versionJsonPath);

  // Ensure directory exists
  if (!fs.existsSync(versionJsonDir)) {
    fs.mkdirSync(versionJsonDir, { recursive: true });
  }

  const versionData = {
    version: newVersion,
    installedAt: fs.existsSync(versionJsonPath)
      ? JSON.parse(fs.readFileSync(versionJsonPath, 'utf8')).installedAt
      : new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2) + '\n');
  log('green', '✅', 'Updated .genie/state/version.json');

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

  // Archive old reports on minor bumps (keeps repo lean)
  let archivedFiles = [];
  if (BUMP_TYPE === 'minor') {
    try {
      log('blue', '📦', 'Archiving old reports (>3 days)...');
      require('child_process').execSync(
        `node ${path.join(__dirname, 'archive-old-reports.cjs')}`,
        { stdio: 'inherit' }
      );
      log('green', '✅', 'Old reports archived');

      // Stage deleted report files
      const gitStatus = exec('git status --porcelain .genie/reports/', true);
      if (gitStatus) {
        archivedFiles = gitStatus.split('\n')
          .filter(line => line.trim().startsWith('D '))
          .map(line => line.trim().substring(2).trim());

        if (archivedFiles.length > 0) {
          exec('git add .genie/reports/');
          log('green', '✅', `Staged ${archivedFiles.length} archived files for deletion`);
        }
      }
    } catch (e) {
      log('yellow', '⚠️', 'Report archiving failed; continuing without archiving');
    }
  }

  // Git operations (force add version.json since .genie/state/ is gitignored with exception)
  exec('git add package.json CHANGELOG.md');
  exec('git add -f .genie/state/version.json');

  let commitMessage = `chore: pre-release v${newVersion}`;

  if (archivedFiles.length > 0) {
    commitMessage += `\n\nArchived ${archivedFiles.length} old reports to ~/.genie-archives/`;
  }

  commitMessage += `\n\nCo-authored-by: Automagik Genie 🧞 <genie@namastex.ai>`;

  exec(`git commit --no-verify -m "${commitMessage}"`);
  log('green', '✅', 'Created commit');

  exec(`git tag v${newVersion}`);
  log('green', '✅', `Tagged v${newVersion}`);

  // Push to trigger CI (unless --no-push flag is set)
  if (!NO_PUSH) {
    log('blue', '📤', 'Pushing to remote...');

    // Fetch remote to update refs for --force-with-lease
    exec('git fetch origin main', true);

    // Pull first to handle any remote changes (e.g., auto-sync workflow)
    try {
      exec('git pull --rebase --no-verify origin main', true);
    } catch (e) {
      log('yellow', '⚠️', 'Pull failed, attempting force push with lease...');
    }

    exec('git push --no-verify --force-with-lease');
    exec('git push --no-verify --tags');

    log('green', '🎉', 'Release candidate created!');
    console.log('');

    // GitHub release and npm publish handled by unified-release.cjs in CI
    log('blue', '📦', `CI will publish: npm install automagik-genie@latest`);
    log('blue', '🔗', 'Monitor CI: https://github.com/namastexlabs/automagik-genie/actions');
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
