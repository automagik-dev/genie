#!/usr/bin/env node

/**
 * Unified Release Script
 * Handles all release scenarios: RC bump, stable promotion, changelog generation
 *
 * Usage:
 *   node scripts/unified-release.cjs [options]
 *
 * Options:
 *   --bump rc|patch|minor|major   Auto-bump version
 *   --promote                      Promote RC to stable (2.1.0-rc.1 → 2.1.0)
 *   --tag v1.2.3                   Manual tag (skip bump)
 *   --publish                      Publish to npm
 *   --github-release               Create GitHub release
 *   --skip-tests                   Skip test execution
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PKG_PATH = path.join(__dirname, '..', 'package.json');
const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const log = (color, emoji, msg) => console.log(`${COLORS[color]}${emoji} ${msg}${COLORS.reset}`);
const exec = (cmd, silent = false) => {
  try {
    const result = execSync(cmd, { encoding: 'utf8', stdio: silent ? 'pipe' : 'inherit' });
    return result ? result.trim() : '';
  } catch (e) {
    if (!silent) throw e;
    return '';
  }
};

// Parse arguments
const args = process.argv.slice(2);
const opts = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg.startsWith('--')) {
    const key = arg.replace(/^--/, '');
    const nextArg = args[i + 1];
    // Check if next arg is a value (doesn't start with --) or end of args
    if (nextArg && !nextArg.startsWith('--')) {
      opts[key] = nextArg;
      i++; // Skip next arg since we consumed it as a value
    } else {
      opts[key] = true; // Boolean flag
    }
  }
}

async function main() {
  log('cyan', '🚀', 'Unified Release Flow');

  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  let version = pkg.version;
  let bumpType = null;

  // Determine version
  if (opts['promote']) {
    bumpType = 'promote';
    version = promoteRcToStable(version);
    log('magenta', '📌', `Promoting RC → Stable: ${pkg.version} → ${version}`);
  } else if (opts['bump']) {
    bumpType = opts['bump'];
    exec(`pnpm run bump:${bumpType}`);
    version = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8')).version;
    log('magenta', '📌', `Bumped to: ${version}`);
  } else if (opts['tag']) {
    version = opts['tag'].replace(/^v/, '');
    log('magenta', '📌', `Using version: ${version}`);
  }

  // Generate mechanical changelog
  log('blue', '📝', 'Generating changelog...');
  const changelogContent = generateMechanicalChangelog(version);

  // Run tests
  if (!opts['skip-tests']) {
    log('blue', '🧪', 'Running tests...');
    try {
      exec('GENIE_SKIP_IDENTITY_SMOKE=1 pnpm run test:all');
      log('green', '✅', 'Tests passed');
    } catch (e) {
      log('red', '❌', 'Tests failed. Aborting release.');
      process.exit(1);
    }
  }

  // Publish to npm
  if (opts['publish']) {
    log('blue', '📦', 'Publishing to npm...');
    const tag = version.includes('-rc.') ? 'next' : 'latest';
    exec(`npm publish --tag ${tag} --access public`, false);
    log('green', '✅', `Published to @${tag}`);
  }

  // Create GitHub release
  if (opts['github-release']) {
    log('blue', '🏷️', 'Creating GitHub release...');
    createGitHubRelease(version, changelogContent);
  }

  log('green', '🎉', `Release v${version} complete!`);
}

function promoteRcToStable(version) {
  const match = version.match(/^(\d+\.\d+\.\d+)-rc\.\d+$/);
  if (!match) {
    log('red', '❌', `Version ${version} is not an RC`);
    process.exit(1);
  }
  return match[1];
}

function generateMechanicalChangelog(version) {
  // Get previous tag
  let prevTag = '';
  try {
    prevTag = exec(`git describe --tags --abbrev=0 2>/dev/null || echo ""`, true);
  } catch (e) {
    prevTag = '';
  }

  // Generate changelog using conventional-changelog via npx
  const changelogCmd = prevTag
    ? `npx conventional-changelog-cli@latest -r 0 -p angular --lerna-root . "${prevTag}..HEAD" 2>/dev/null || echo ""`
    : `npx conventional-changelog-cli@latest -i CHANGELOG.md -s -p angular 2>/dev/null || echo ""`;

  let changelog = '';
  try {
    changelog = exec(changelogCmd, true).trim();
  } catch (e) {
    // Fallback: manual commit analysis
    changelog = generateFallbackChangelog(version, prevTag);
  }

  if (!changelog) {
    changelog = generateFallbackChangelog(version, prevTag);
  }

  return changelog;
}

function generateFallbackChangelog(version, prevTag) {
  // Fallback: Extract commits and generate summary
  const range = prevTag ? `${prevTag}..HEAD` : `--all`;
  const commits = exec(`git log ${range} --pretty=format:"%h|%s|%an" 2>/dev/null || echo ""`, true).split('\n').filter(Boolean);

  if (commits.length === 0) {
    return `## [${version}]\n\nRelease ${version}`;
  }

  const features = commits.filter(c => c.includes('feat:')).length;
  const fixes = commits.filter(c => c.includes('fix:')).length;
  const other = commits.length - features - fixes;

  let changelog = `## [${version}]\n\n`;
  changelog += `**${new Date().toISOString().split('T')[0]}**\n\n`;

  if (features > 0) changelog += `### ✨ Features\n- ${features} feature${features > 1 ? 's' : ''}\n\n`;
  if (fixes > 0) changelog += `### 🐛 Bug Fixes\n- ${fixes} fix${fixes > 1 ? 's' : ''}\n\n`;
  if (other > 0) changelog += `### 📚 Other Changes\n- ${other} commit${other > 1 ? 's' : ''}\n\n`;

  changelog += `### 📊 Statistics\n`;
  changelog += `- **Total Commits**: ${commits.length}\n`;
  changelog += `- **Contributors**: ${new Set(commits.map(c => c.split('|')[2])).size}\n`;

  return changelog;
}

function createGitHubRelease(version, changelog) {
  const isRc = version.includes('-rc.');
  const prerelease = isRc ? '--prerelease' : '';

  const notesFile = path.join(os.tmpdir(), `release-notes-${Date.now()}.md`);
  fs.writeFileSync(notesFile, changelog);

  try {
    exec(`gh release create v${version} -F "${notesFile}" --title "v${version}" ${prerelease}`);
    log('green', '✅', 'GitHub release created');
  } catch (e) {
    log('yellow', '⚠️', 'GitHub release creation failed (may already exist)');
  } finally {
    try { fs.unlinkSync(notesFile); } catch (e) {}
  }
}

// Get temp dir
const os = require('os');

main().catch(e => {
  log('red', '❌', e.message);
  process.exit(1);
});
