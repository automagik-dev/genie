#!/usr/bin/env node

/**
 * Commit Advisory Analyzer
 *
 * Validates every commit is traced to work items (wishes/GitHub issues)
 * and aligned with Genie framework.
 *
 * Exit codes:
 * - 0: All validations passed
 * - 1: Warnings only (user can override)
 * - 2: Blocking errors (push blocked)
 * - 3: Script error (git failed, etc)
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const WISHES_DIR = path.join(REPO_ROOT, '.genie', 'wishes');

class CommitAdvisory {
  constructor() {
    this.errors = [];
    this.warnings = [];
    this.passes = [];
    this.commits = [];
    this.wishes = new Map();
    this.issues = new Set();
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
   * Get commits to be pushed
   */
  getCommitsToPush() {
    const delimiter = '---COMMIT-BOUNDARY---';
    const format = `%H%n%s%n%b${delimiter}`;

    try {
      let log;

      // Strategy 1: Try to get commits relative to upstream (@{u})
      try {
        log = execSync(`git log @{u}..HEAD --format="${format}"`, {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        // Empty log = no new commits (everything pushed)
        // This is SUCCESS, not failure - return empty commits
        return this.parseCommitLog(log, delimiter);
      } catch {
        // Upstream doesn't exist yet (branch not pushed)
      }

      // Strategy 2: Try commits relative to origin/main
      try {
        log = execSync(`git log origin/main..HEAD --format="${format}"`, {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        if (log.trim()) {
          return this.parseCommitLog(log, delimiter);
        }
      } catch {
        // origin/main doesn't exist
      }

      // Strategy 3: Try commits relative to local main
      try {
        log = execSync(`git log main..HEAD --format="${format}"`, {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        if (log.trim()) {
          return this.parseCommitLog(log, delimiter);
        }
      } catch {
        // main doesn't exist
      }

      // Strategy 4: Find merge-base and get commits from there
      try {
        const mergeBase = execSync('git merge-base HEAD origin/main', {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        }).trim();

        if (mergeBase) {
          log = execSync(`git log ${mergeBase}..HEAD --format="${format}"`, {
            encoding: 'utf8',
            cwd: REPO_ROOT
          });
          if (log.trim()) {
            return this.parseCommitLog(log, delimiter);
          }
        }
      } catch {
        // merge-base failed
      }

      // Final fallback: last 5 commits (with warning)
      this.warnings.push('Could not determine base branch - checking last 5 commits only');
      log = execSync(`git log -5 --format="${format}"`, {
        encoding: 'utf8',
        cwd: REPO_ROOT
      });

      return this.parseCommitLog(log, delimiter);
    } catch (e) {
      this.errors.push(`Failed to get commits: ${e.message}`);
      return [];
    }
  }

  /**
   * Parse commit log output into commit objects
   */
  parseCommitLog(log, delimiter) {
    const entries = log.split(delimiter).filter(e => e.trim());
    if (entries.length === 0) {
      this.warnings.push('No commits found in recent history');
      return [];
    }

    return entries.map(entry => {
      const lines = entry.trim().split('\n');
      return {
        hash: lines[0] || '',
        subject: lines[1] || 'unknown',
        body: lines.slice(2).join('\n').trim()
      };
    });
  }

  /**
   * Get current branch
   */
  getCurrentBranch() {
    try {
      return execSync('git rev-parse --abbrev-ref HEAD', {
        encoding: 'utf8',
        cwd: REPO_ROOT
      }).trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get files changed in commits
   */
  getChangedFiles() {
    try {
      try {
        const files = execSync('git diff @{u}..HEAD --name-only', {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        return files.trim().split('\n').filter(f => f);
      } catch {
        // Fallback: changed files in working tree
        const files = execSync('git diff HEAD~5..HEAD --name-only', {
          encoding: 'utf8',
          cwd: REPO_ROOT
        });
        return files.trim().split('\n').filter(f => f);
      }
    } catch {
      return [];
    }
  }

  /**
   * Load all wishes from .genie/wishes/
   */
  loadWishes() {
    if (!fs.existsSync(WISHES_DIR)) {
      return;
    }

    const dirs = fs.readdirSync(WISHES_DIR);
    for (const dir of dirs) {
      if (dir.startsWith('_')) continue; // Skip archives

      const wishFile = path.join(WISHES_DIR, dir, `${dir}-wish.md`);
      if (fs.existsSync(wishFile)) {
        const content = fs.readFileSync(wishFile, 'utf8');
        this.wishes.set(dir, {
          path: wishFile,
          content,
          files: this.extractFilesFromWish(content)
        });
      }
    }
  }

  /**
   * Extract file list from wish document
   */
  extractFilesFromWish(content) {
    const files = new Set();

    // Look for sections: ## Scope, Files:, Modified:, Touched:
    const patterns = [
      /##\s+Scope[\s\S]*?(?=##|\Z)/,
      /Files:?\s*[\s\S]*?(?=##|\Z)/,
      /Modified:?\s*[\s\S]*?(?=##|\Z)/,
      /Touched:?\s*[\s\S]*?(?=##|\Z)/
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        // Extract file paths (common patterns)
        const lines = match[0].split('\n');
        for (const line of lines) {
          // Match: `src/foo.ts`, `- src/bar.js`, etc
          const fileMatch = line.match(/(?:[-*]?\s*)?(`?[\w/.@-]+\.\w+`?)/g);
          if (fileMatch) {
            fileMatch.forEach(f => {
              const clean = f.replace(/[-*`\s]/g, '').trim();
              if (clean && !clean.includes('##')) files.add(clean);
            });
          }
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Extract references from commit (wish:, fixes #, closes #, etc)
   */
  extractReferences(commit) {
    const full = `${commit.subject} ${commit.body}`;
    const refs = {
      wishes: [],
      issues: [],
      hasWishRef: false,
      hasIssueRef: false
    };

    // Look for wish references: wish: slug, .genie/wishes/slug
    // Require colon for "wish:" format to avoid false positives like "wish or"
    const wishPattern = /\bwish:\s*(\w[-\w]+)|\.genie\/wishes\/(\w[-\w]+)/gim;
    let wishMatch;
    while ((wishMatch = wishPattern.exec(full)) !== null) {
      const slug = wishMatch[1] || wishMatch[2];
      if (slug) {
        refs.wishes.push(slug);
        refs.hasWishRef = true;
      }
    }

    // Look for GitHub issues: fixes #123, closes #456
    const issuePattern = /(fixes|closes)\s+#(\d+)/gi;
    let issueMatch;
    while ((issueMatch = issuePattern.exec(full)) !== null) {
      const num = issueMatch[2];
      if (num) {
        refs.issues.push(num);
        refs.hasIssueRef = true;
        this.issues.add(num);
      }
    }

    return refs;
  }

  /**
   * Check if commit is a bug fix
   */
  isBugFix(commit) {
    return /^fix:|^bug:|bug fix/i.test(commit.subject);
  }

  /**
   * Check if commit is exempt from traceability requirements
   * Includes: automated commits, chores, and non-functional enhancements
   */
  isAutomatedCommit(commit) {
    const full = `${commit.subject} ${commit.body}`;

    // Patterns for automated commits and exempt commit types
    const patterns = [
      // Auto-generated commits
      /\(auto-generated\)/i,
      /\[skip ci\]/i,
      /\[auto\]/i,
      /agent graph/i,
      /\(automagik-forge\s+[a-f0-9-]+\)/i,  // Forge task references

      // Exempt commit types (don't require issues)
      /^chore:/i,           // All maintenance tasks
      /^perf:/i,            // Performance improvements (speed)
      /^refactor:/i,        // Code quality (reduce LOC, cleanup)
      /^style:/i,           // Formatting/style changes
      /^docs:/i,            // Documentation updates

      // Infrastructure/tooling fixes (hooks, scripts, CI/CD)
      /pre-push hook/i,
      /pre-commit hook/i,
      /\.genie\/scripts/i,
      /git hook/i,
      /hook warning/i,
      /commit advisory/i
    ];

    return patterns.some(pattern => pattern.test(full));
  }

  /**
   * Validate commits
   */
  validateCommits(isReleaseBranch = false) {
    if (this.commits.length === 0) {
      this.passes.push('No new commits to validate');
      return;
    }

    const references = new Map();

    // Extract all references first
    for (const commit of this.commits) {
      const refs = this.extractReferences(commit);
      references.set(commit.hash, refs);
    }

    // Release branch: Skip traceability check, add validation pass
    if (isReleaseBranch) {
      this.passes.push('Release branch - traceability validation skipped (expected for automated releases)');
      return;
    }

    // Rule 2: Commit Traceability (BLOCKING)
    let exemptCount = 0;
    for (const commit of this.commits) {
      // Skip automated/forge commits from traceability check
      if (this.isAutomatedCommit(commit)) {
        exemptCount++;
        continue;
      }

      const refs = references.get(commit.hash);
      if (!refs.hasWishRef && !refs.hasIssueRef) {
        this.errors.push({
          commit: commit.hash.substring(0, 8),
          subject: commit.subject.substring(0, 60),
          reason: 'Not linked to wish or GitHub issue',
          why: 'Every commit must trace to a work item (wish or issue) so we can track WHY code was written',
          fixes: [
            {
              label: 'Link to existing wish',
              command: `git commit --amend -m "${commit.subject.substring(0, 40)}\n\nwish: wish-slug"`,
              description: 'Replace "wish-slug" with an actual wish slug from .genie/wishes/'
            },
            {
              label: 'Link to GitHub issue',
              command: `git commit --amend -m "${commit.subject.substring(0, 40)}\n\nfixes #NNN"`,
              description: 'Replace NNN with actual GitHub issue number'
            }
          ]
        });
      }
    }

    // Report exempt commits
    if (exemptCount > 0) {
      this.passes.push(`${exemptCount} commit(s) exempt from traceability (chore/perf/refactor/style/docs/automated)`);
    }

    // Rule 3: Bug Commits Must Have Issues (BLOCKING)
    for (const commit of this.commits) {
      // Skip automated/forge commits from bug fix check
      if (this.isAutomatedCommit(commit)) {
        continue;
      }

      if (this.isBugFix(commit)) {
        const refs = references.get(commit.hash);
        if (!refs.hasIssueRef) {
          this.errors.push({
            commit: commit.hash.substring(0, 8),
            subject: commit.subject.substring(0, 60),
            reason: 'Bug fix without GitHub issue reference',
            why: 'Bug fixes must link to GitHub issues for traceability and audit trail',
            fixes: [
              {
                label: 'Create GitHub issue first',
                command: `gh issue create -t "Bug: ${commit.subject.substring(0, 40)}" -b "Description of the bug and fix"`,
                description: 'Create the issue, note the number (e.g., #42), then amend commit'
              },
              {
                label: 'Then link in commit',
                command: `git commit --amend -m "${commit.subject.substring(0, 40)}\n\nfixes #NNN"`,
                description: 'Replace NNN with the issue number from previous step'
              }
            ]
          });
        }
      }
    }

    // Rule 5: Multiple Wishes (WARNING)
    const wishSet = new Set();
    for (const refs of references.values()) {
      refs.wishes.forEach(w => wishSet.add(w));
    }
    if (wishSet.size > 1) {
      this.warnings.push(
        `Commits reference multiple wishes: ${Array.from(wishSet).join(', ')}\n` +
        `     Suggestion: Keep work focused to single wish per push`
      );
    }

    // Rule 4: Wish Alignment (WARNING)
    if (wishSet.size === 1) {
      const wishSlug = Array.from(wishSet)[0];
      const wish = this.wishes.get(wishSlug);
      if (wish) {
        const changedFiles = this.getChangedFiles();
        const wishFiles = wish.files;

        if (wishFiles.length > 0) {
          const overlap = changedFiles.filter(f =>
            wishFiles.some(wf => f.includes(wf) || wf.includes(f))
          ).length;

          const alignmentRatio = overlap / Math.max(wishFiles.length, 1);
          if (alignmentRatio < 0.3) {
            this.warnings.push(
              `Commits don't align well with wish "${wishSlug}" scope\n` +
              `     Files touched: ${changedFiles.length}, wish files: ${wishFiles.length}, overlap: ${overlap}\n` +
              `     Suggestion: Verify wish is current/active`
            );
          } else {
            this.passes.push(`Commits aligned with wish "${wishSlug}" (${Math.round(alignmentRatio * 100)}%)`);
          }
        }
      }
    }

    // Summary
    if (references.size > 0) {
      const allWishes = Array.from(wishSet);
      const allIssues = Array.from(this.issues);
      if (allWishes.length > 0) {
        this.passes.push(`Commits traced to wishes: ${allWishes.join(', ')}`);
      }
      if (allIssues.length > 0) {
        this.passes.push(`Commits traced to GitHub issues: ${allIssues.map(n => `#${n}`).join(', ')}`);
      }
    }
  }

  /**
   * Check branch safety
   */
  validateBranch() {
    const branch = this.getCurrentBranch();
    if (branch === 'main' || branch === 'master') {
      // Only warn if there are non-exempt commits (actual feature work)
      const hasNonExemptCommits = this.commits.some(c => !this.isAutomatedCommit(c));
      if (hasNonExemptCommits) {
        this.warnings.push(
          `Pushing to "${branch}" branch directly\n` +
          `     Suggestion: Use feature branch (feat/wish-slug) for traced work\n` +
          `     Override: Set GENIE_ALLOW_MAIN_PUSH=1`
        );
      }
    }
  }

  /**
   * Generate advisory report with remediation guide
   */
  generateReport(branch, commitCount) {
    let report = [];
    report.push('# Pre-Push Commit Advisory\n');
    report.push(`**Branch:** ${branch}`);
    report.push(`**Commits:** ${commitCount} new commit(s)`);
    report.push(`**Wishes Referenced:** ${Array.from(new Set(this.commits.flatMap(c =>
      this.extractReferences(c).wishes))).join(', ') || 'none'}`);
    report.push(`**GitHub Issues:** ${Array.from(this.issues).map(n => `#${n}`).join(', ') || 'none'}`);
    report.push('');

    if (this.errors.length > 0) {
      report.push(`## ❌ Blocking Issues (${this.errors.length})\n`);
      this.errors.forEach((err, i) => {
        if (typeof err === 'object') {
          report.push(`${i + 1}. **${err.reason}**`);
          report.push(`   Commit: \`${err.commit}\` - ${err.subject}`);
          report.push(`   WHY: ${err.why}`);
          report.push(`   HOW TO FIX (choose one):\n`);
          err.fixes.forEach((fix, j) => {
            report.push(`   **${fix.label}:**`);
            report.push(`   \`\`\``);
            report.push(`   ${fix.command}`);
            report.push(`   \`\`\``);
            report.push(`   ${fix.description}`);
          });
          report.push('');
        } else {
          report.push(`${i + 1}. ${err}\n`);
        }
      });

      // Add quick fix section
      report.push('## 📋 Quick Fix Steps\n');
      report.push('1. Choose ONE of the fix options above for each error');
      report.push('2. Run the command from that option');
      report.push('3. After amending: `git push`\n');
      report.push('**Need help?** See: `.genie/docs/commit-advisory-guide.md`\n');
    }

    if (this.warnings.length > 0) {
      report.push(`## ⚠️  Warnings (${this.warnings.length})\n`);
      this.warnings.forEach((warn, i) => {
        report.push(`${i + 1}. ${warn}\n`);
      });
    }

    if (this.passes.length > 0 && this.errors.length === 0) {
      report.push(`## ✅ Passed\n`);
      this.passes.forEach(pass => {
        report.push(`- ${pass}`);
      });
      report.push('');
    }

    report.push(`**Generated:** ${new Date().toISOString()}`);

    return report.join('\n');
  }

  /**
   * Determine exit code based on validation results
   */
  getExitCode() {
    if (this.errors.length > 0) return 2; // Blocking
    if (this.warnings.length > 0) return 1; // Warnings
    return 0; // Pass
  }

  /**
   * Run full analysis
   */
  async run() {
    this.log('cyan', '🧞', 'Running commit advisory...\n');

    const branch = this.getCurrentBranch();
    this.commits = this.getCommitsToPush();

    if (this.commits.length === 0) {
      this.passes.push('No commits to analyze (working tree clean).');
      const report = this.generateReport(branch, 0);
      console.log(report);
      this.log('yellow', '⚠️ ', 'No commits to analyze');
      return 0;
    }

    // Check if on release branch (feat/release-*)
    const isReleaseBranch = branch.startsWith('feat/release-');

    this.loadWishes();
    this.validateBranch();
    this.validateCommits(isReleaseBranch);

    const report = this.generateReport(branch, this.commits.length);
    console.log(report);

    const exitCode = this.getExitCode();

    if (exitCode === 0) {
      this.log('green', '✅', 'All validations passed\n');
    } else if (exitCode === 1) {
      this.log('yellow', '⚠️ ', 'Push has warnings (can override: GENIE_SKIP_WISH_CHECK=1 git push)\n');
    } else if (exitCode === 2) {
      this.log('red', '❌', 'Push blocked - fix errors before pushing\n');
    }

    return exitCode;
  }
}

// Main
(async () => {
  try {
    const advisory = new CommitAdvisory();
    const exitCode = await advisory.run();
    process.exit(exitCode);
  } catch (e) {
    console.error('❌ Advisory error:', e.message);
    process.exit(3);
  }
})();
