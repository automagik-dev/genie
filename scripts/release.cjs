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

  // Check git status (ignore submodules)
  const status = exec('git status --porcelain --ignore-submodules', true);
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

  // Update CHANGELOG for stable (promote RC section or add stable section) via Node script
  try {
    log('blue', '📝', 'Updating CHANGELOG.md...');
    exec(`node ${path.join(__dirname, '..', '.genie', 'scripts', 'update-changelog.js')} stable ${stableVersion}`);
    log('green', '✅', 'CHANGELOG updated');
  } catch (e) {
    log('yellow', '⚠️', 'CHANGELOG update failed; continuing without changelog change');
  }

  // Run tests before releasing
  log('blue', '🧪', 'Running tests...');
  try {
    exec('GENIE_SKIP_IDENTITY_SMOKE=1 pnpm run test:all');
    log('green', '✅', 'Tests passed');
  } catch (error) {
    log('red', '❌', 'Tests failed. Aborting release.');
    // Revert package.json
    exec('git checkout package.json');
    process.exit(1);
  }

  // Git operations
  exec('git add package.json CHANGELOG.md');

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

  // Create GitHub release with changelog content
  log('blue', '🏷️', 'Creating GitHub release...');
  try {
    const changelogSection = extractChangelogSection(stableVersion);
    let releaseBody = changelogSection || generateStableReleaseNotes(stableVersion);

    // GitHub has an effective limit of ~125k characters for release body
    const MAX_GITHUB_BODY = 120000; // Leave buffer below GitHub's limit
    if (releaseBody.length > MAX_GITHUB_BODY) {
      log('yellow', '⚠️', `Release body too long (${releaseBody.length} chars), truncating to ${MAX_GITHUB_BODY}...`);
      releaseBody = releaseBody.substring(0, MAX_GITHUB_BODY) + '\n\n---\n\n*Changelog truncated due to length. See full CHANGELOG.md for details.*';
    }

    exec(`gh release create v${stableVersion} --title "v${stableVersion}" --notes "${releaseBody}" --latest`, true);
    log('green', '✅', 'GitHub release created with changelog content');
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

// Extract changelog section for a version
function extractChangelogSection(version) {
  try {
    const changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
    if (!fs.existsSync(changelogPath)) return null;

    const changelog = fs.readFileSync(changelogPath, 'utf8');
    const lines = changelog.split('\n');

    // Find the section for this version
    let startIdx = -1;
    let endIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith(`## [${version}]`)) {
        startIdx = i + 1; // Skip the header line
        continue;
      }
      if (startIdx !== -1 && lines[i].startsWith('## [')) {
        endIdx = i;
        break;
      }
    }

    if (startIdx === -1) return null;
    if (endIdx === -1) endIdx = lines.length;

    const section = lines.slice(startIdx, endIdx).join('\n').trim();
    return section || null;
  } catch (error) {
    return null;
  }
}

// Generate fallback release notes for stable
function generateStableReleaseNotes(version) {
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  return `## 🎉 Stable Release v${version}

This is a stable release of ${pkg.name}.

**Install:**
\`\`\`bash
npm install -g ${pkg.name}@latest
\`\`\`

See [CHANGELOG.md](https://github.com/namastexlabs/automagik-genie/blob/main/CHANGELOG.md) for full details.`;
}

main();
