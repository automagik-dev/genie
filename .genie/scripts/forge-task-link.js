#!/usr/bin/env node

/**
 * forge-task-link.js
 *
 * Pre-commit hook: Automatically link Forge task → Wish when first commit happens in worktree
 *
 * Reverse-extraction algorithm:
 * 1. Get worktree directory name (e.g., 35a4-test-forge-metad)
 * 2. Extract attempt ID prefix (first 4 chars: 35a4)
 * 3. Extract task abbreviation (remainder: test-forge-metad)
 * 4. Search .genie/wishes/ for matching wish slug
 * 5. Update SESSION-STATE.md with linkage
 * 6. Invoke Forge task linking workflow (optional)
 *
 * Exit codes:
 * - 0: Successfully linked or already linked
 * - 1: Warning (couldn't find wish, but continue anyway)
 * - 2: Error (blocking issue)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class ForgeTaskLinker {
  constructor() {
    this.repoRoot = this.findRepoRoot();
    this.wishesDir = path.join(this.repoRoot, '.genie', 'wishes');
    this.sessionStateFile = path.join(this.repoRoot, '.genie', 'SESSION-STATE.md');
    this.warnings = [];
    this.errors = [];
  }

  log(color, emoji, msg) {
    const colors = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m'
    };
    console.log(`${colors[color] || ''}${emoji} ${msg}${colors.reset}`);
  }

  /**
   * Find repository root
   */
  findRepoRoot() {
    try {
      return execSync('git rev-parse --show-toplevel', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch {
      return process.cwd();
    }
  }

  /**
   * Detect if we're in a Forge worktree
   */
  isForgeWorktree() {
    try {
      const gitDir = execSync('git rev-parse --git-dir', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();

      // Forge worktrees have .git as a file (gitdir reference)
      const gitPath = path.join(this.repoRoot, gitDir);
      return fs.existsSync(gitPath) && fs.statSync(gitPath).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Get current branch
   */
  getCurrentBranch() {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
    } catch {
      return null;
    }
  }

  /**
   * Extract Forge metadata from branch name
   * Branch patterns:
   * - forge/<attempt-id-prefix>-<abbreviated-title> (Forge worktrees)
   * - feat/<abbreviated-title> (Manual feature branches)
   */
  extractForgeMetadata(branch) {
    // Try forge/ pattern first (Forge worktrees: forge/35a4-test-forge-metad)
    let match = branch.match(/^forge\/([a-f0-9]{4})-(.*?)$/);
    if (match) {
      return {
        attemptIdPrefix: match[1],
        taskAbbrev: match[2],
        fullBranchName: branch,
        isForgeBranch: true
      };
    }

    // Try feat/ pattern (Manual branches: feat/skills-prioritization)
    match = branch.match(/^feat\/(.+?)$/);
    if (match) {
      // Generate pseudo attempt ID from branch name (first 4 chars of first word)
      const taskName = match[1];
      const firstWord = taskName.split('-')[0];
      const pseudoId = firstWord.substring(0, 4).padEnd(4, '0').toLowerCase();

      return {
        attemptIdPrefix: `feat_${pseudoId}`,
        taskAbbrev: taskName,
        fullBranchName: branch,
        isForgeBranch: false
      };
    }

    return null;
  }

  /**
   * Find matching wish by abbreviation
   */
  findMatchingWish(taskAbbrev) {
    if (!fs.existsSync(this.wishesDir)) {
      this.warnings.push(`Wishes directory not found: ${this.wishesDir}`);
      return null;
    }

    const wishdirs = fs.readdirSync(this.wishesDir);

    // Exact match first
    if (wishdirs.includes(taskAbbrev)) {
      return taskAbbrev;
    }

    // Fuzzy match: check if wish slug contains parts of abbreviation
    const abbrevParts = taskAbbrev.split('-');
    for (const wishDir of wishdirs) {
      if (wishDir.startsWith('_')) continue; // Skip archives

      // Check if majority of abbreviation parts match wish slug
      const matches = abbrevParts.filter(part => wishDir.includes(part)).length;
      if (matches >= Math.ceil(abbrevParts.length * 0.7)) {
        return wishDir;
      }
    }

    return null;
  }

  /**
   * Check if task already linked in SESSION-STATE
   */
  isTaskAlreadyLinked(attemptIdPrefix) {
    if (!fs.existsSync(this.sessionStateFile)) {
      return false;
    }

    const content = fs.readFileSync(this.sessionStateFile, 'utf8');
    return content.includes(attemptIdPrefix);
  }

  /**
   * Update SESSION-STATE.md with Forge task linkage
   */
  updateSessionState(metadata, wishSlug) {
    if (!fs.existsSync(this.sessionStateFile)) {
      this.warnings.push(`SESSION-STATE.md not found: ${this.sessionStateFile}`);
      return false;
    }

    let content = fs.readFileSync(this.sessionStateFile, 'utf8');
    const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

    // Create new entry
    const entry = `
### Forge Task - ${wishSlug}
**Attempt ID Prefix:** \`${metadata.attemptIdPrefix}\`
**Wish:** ${wishSlug}
**Branch:** ${metadata.fullBranchName}
**Linked:** ${timestamp}
**Status:** active
**Next:** First commit detected - auto-linked
`;

    // Find Active Sessions section and insert after header
    const activeSection = '## 🎯 Active Sessions';
    const insertPos = content.indexOf(activeSection);

    if (insertPos === -1) {
      this.warnings.push('Could not find "## 🎯 Active Sessions" section');
      return false;
    }

    const lineEnd = content.indexOf('\n', insertPos) + 1;
    const insertAfter = content.indexOf('\n', lineEnd) + 1;

    content = content.slice(0, insertAfter) + entry + '\n' + content.slice(insertAfter);

    fs.writeFileSync(this.sessionStateFile, content);
    execSync('git add .genie/SESSION-STATE.md', { stdio: 'pipe' });

    return true;
  }

  /**
   * Run the linking workflow
   */
  async run() {
    this.log('cyan', '🧞', 'Forge task linking...\n');

    // Check if in Forge worktree
    if (!this.isForgeWorktree()) {
      // Not a Forge worktree, skip silently
      return 0;
    }

    // Get current branch
    const branch = this.getCurrentBranch();
    if (!branch) {
      this.warnings.push('Could not determine current branch');
      return 1;
    }

    // Extract Forge metadata
    const metadata = this.extractForgeMetadata(branch);
    if (!metadata) {
      // Not a Forge branch, skip silently
      return 0;
    }

    this.log('blue', 'ℹ️ ', `Detected Forge branch: ${branch}`);
    this.log('blue', 'ℹ️ ', `Attempt ID prefix: ${metadata.attemptIdPrefix}`);

    // Check if already linked
    if (this.isTaskAlreadyLinked(metadata.attemptIdPrefix)) {
      this.log('green', '✅', 'Task already linked in SESSION-STATE.md');
      return 0;
    }

    // Find matching wish
    const wishSlug = this.findMatchingWish(metadata.taskAbbrev);
    if (!wishSlug) {
      this.log('yellow', '⚠️ ', `Could not find matching wish for: ${metadata.taskAbbrev}`);
      this.warnings.push(`Task abbreviation "${metadata.taskAbbrev}" didn't match any wish`);
      return 1;
    }

    this.log('blue', 'ℹ️ ', `Found matching wish: ${wishSlug}`);

    // Update SESSION-STATE.md
    const linked = this.updateSessionState(metadata, wishSlug);
    if (linked) {
      this.log('green', '✅', `Linked Forge task to wish: ${wishSlug}`);
      this.log('green', '✅', 'Updated SESSION-STATE.md');
      return 0;
    } else {
      this.log('yellow', '⚠️ ', 'Could not update SESSION-STATE.md');
      return 1;
    }
  }
}

// Main
(async () => {
  try {
    const linker = new ForgeTaskLinker();
    const exitCode = await linker.run();
    process.exit(exitCode);
  } catch (e) {
    console.error('❌ Forge task linking error:', e.message);
    process.exit(2);
  }
})();
