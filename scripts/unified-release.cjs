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
const os = require('os');

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
    // Update package.json with stable version
    pkg.version = version;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n');
    log('green', '✅', `Updated package.json to ${version}`);
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
  // Get previous tag - for stable releases, find the last stable (not RC)
  let prevTag = '';
  try {
    if (!version.includes('-rc.')) {
      // Stable release: compare against last stable, not last RC
      prevTag = exec(`git tag --sort=-creatordate | grep -v 'rc' | grep -v '^v${version}$' | head -1`, true);
    } else {
      // RC release: compare against previous tag (could be RC or stable)
      prevTag = exec(`git describe --tags --abbrev=0 2>/dev/null || echo ""`, true);
    }
  } catch (e) {
    prevTag = '';
  }

  // Always use fallback changelog (concise summary, not full conventional-changelog)
  const changelog = generateFallbackChangelog(version, prevTag);

  // Enforce GitHub's 125,000 character limit
  const MAX_GITHUB_BODY = 120000; // 120k to leave buffer
  if (changelog.length > MAX_GITHUB_BODY) {
    log('yellow', '⚠️', `Changelog too long (${changelog.length} chars), truncating...`);
    return changelog.substring(0, MAX_GITHUB_BODY) + '\n\n---\n\n*Changelog truncated due to length. See full diff at the compare URL above.*';
  }

  return changelog;
}

function generateFallbackChangelog(version, prevTag) {
  // Extract commits and generate summary
  const range = prevTag ? `${prevTag}..HEAD` : `--all`;
  const commits = exec(`git log ${range} --pretty=format:"%h|%s|%an" 2>/dev/null || echo ""`, true).split('\n').filter(Boolean);

  if (commits.length === 0) {
    return `## v${version}\n\n**Release Date:** ${new Date().toISOString().split('T')[0]}\n\nRelease ${version}`;
  }

  // Categorize commits
  const features = commits.filter(c => c.toLowerCase().includes('feat:') || c.toLowerCase().includes('feature:'));
  const fixes = commits.filter(c => c.toLowerCase().includes('fix:'));
  const chores = commits.filter(c => c.toLowerCase().includes('chore:'));
  const docs = commits.filter(c => c.toLowerCase().includes('docs:'));
  const refactors = commits.filter(c => c.toLowerCase().includes('refactor:'));

  // Build changelog
  let changelog = `## v${version}\n\n`;
  changelog += `**Release Date:** ${new Date().toISOString().split('T')[0]}\n\n`;

  if (features.length > 0) {
    changelog += `### ✨ Features (${features.length})\n\n`;
    features.slice(0, 20).forEach(c => {
      const [hash, ...msgParts] = c.split('|');
      const msg = msgParts.slice(0, -1).join('|').replace(/^feat:\s*/i, '').replace(/^feature:\s*/i, '');
      changelog += `- ${msg} (${hash})\n`;
    });
    if (features.length > 20) changelog += `- ...and ${features.length - 20} more features\n`;
    changelog += `\n`;
  }

  if (fixes.length > 0) {
    changelog += `### 🐛 Bug Fixes (${fixes.length})\n\n`;
    fixes.slice(0, 20).forEach(c => {
      const [hash, ...msgParts] = c.split('|');
      const msg = msgParts.slice(0, -1).join('|').replace(/^fix:\s*/i, '');
      changelog += `- ${msg} (${hash})\n`;
    });
    if (fixes.length > 20) changelog += `- ...and ${fixes.length - 20} more fixes\n`;
    changelog += `\n`;
  }

  if (refactors.length > 0) {
    changelog += `### 🔧 Refactoring (${refactors.length})\n\n`;
    refactors.slice(0, 10).forEach(c => {
      const [hash, ...msgParts] = c.split('|');
      const msg = msgParts.slice(0, -1).join('|').replace(/^refactor:\s*/i, '');
      changelog += `- ${msg} (${hash})\n`;
    });
    if (refactors.length > 10) changelog += `- ...and ${refactors.length - 10} more refactorings\n`;
    changelog += `\n`;
  }

  if (docs.length > 0) {
    changelog += `### 📚 Documentation (${docs.length})\n\n`;
    if (docs.length > 5) {
      changelog += `- ${docs.length} documentation updates\n\n`;
    } else {
      docs.forEach(c => {
        const [hash, ...msgParts] = c.split('|');
        const msg = msgParts.slice(0, -1).join('|').replace(/^docs:\s*/i, '');
        changelog += `- ${msg} (${hash})\n`;
      });
      changelog += `\n`;
    }
  }

  // Statistics
  changelog += `### 📊 Statistics\n\n`;
  changelog += `- **Total Commits**: ${commits.length}\n`;
  changelog += `- **Contributors**: ${new Set(commits.map(c => c.split('|')[2])).size}\n`;
  if (prevTag) {
    changelog += `\n**Full Changelog**: https://github.com/namastexlabs/automagik-genie/compare/${prevTag}...v${version}\n`;
  }

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

main().catch(e => {
  log('red', '❌', e.message);
  process.exit(1);
});
