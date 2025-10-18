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
    try {
      // Try to get commits relative to upstream
      try {
        const log = execSync('git log @{u}..HEAD --format="%H|%s"', {
          encoding: 'utf8',
          cwd: REPO_ROOT,
          stdio: ['pipe', 'pipe', 'ignore']
        });
        const commits = log.trim().split('\n').filter(l => l);
        if (commits.length === 0) throw new Error('No upstream commits');

        return commits.map(line => {
          const parts = line.split('|', 2);
          return {
            hash: parts[0] || '',
            subject: parts[1] || 'unknown',
            body: ''
          };
        });
      } catch {
        // Fallback: last 5 commits
        const log = execSync('git log -5 --format="%H|%s"', {
          encoding: 'utf8',
          cwd: REPO_ROOT
        });
        const commits = log.trim().split('\n').filter(l => l);
        if (commits.length === 0) {
          this.warnings.push('No commits found in recent history');
          return [];
        }

        return commits.map(line => {
          const parts = line.split('|', 2);
          return {
            hash: parts[0] || '',
            subject: parts[1] || 'unknown',
            body: ''
          };
        });
      }
    } catch (e) {
      this.errors.push(`Failed to get commits: ${e.message}`);
      return [];
    }
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
    const wishMatches = full.match(/wish:?\s*(\w[-\w]*)|\.genie\/wishes\/(\w[-\w]*)/gi) || [];
    wishMatches.forEach(m => {
      const slug = m.match(/\w[-\w]*/)[0];
      refs.wishes.push(slug);
      refs.hasWishRef = true;
    });

    // Look for GitHub issues: fixes #123, closes #456
    const issueMatches = full.match(/(fixes|closes)\s+#(\d+)/gi) || [];
    issueMatches.forEach(m => {
      const num = m.match(/\d+/)[0];
      refs.issues.push(num);
      refs.hasIssueRef = true;
      this.issues.add(num);
    });

    return refs;
  }

  /**
   * Check if commit is a bug fix
   */
  isBugFix(commit) {
    return /^fix:|^bug:|bug fix/i.test(commit.subject);
  }

  /**
   * Validate commits
   */
  validateCommits() {
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

    // Rule 2: Commit Traceability (BLOCKING)
    for (const commit of this.commits) {
      const refs = references.get(commit.hash);
      if (!refs.hasWishRef && !refs.hasIssueRef) {
        this.errors.push(
          `Commit "${commit.subject.substring(0, 50)}" (${commit.hash.substring(0, 8)}) not linked to wish or issue\n` +
          `     Fix: Add wish reference or GitHub issue link to commit message`
        );
      }
    }

    // Rule 3: Bug Commits Must Have Issues (BLOCKING)
    for (const commit of this.commits) {
      if (this.isBugFix(commit)) {
        const refs = references.get(commit.hash);
        if (!refs.hasIssueRef) {
          this.errors.push(
            `Bug fix commit "${commit.subject.substring(0, 50)}" must reference GitHub issue\n` +
            `     Fix: Add "fixes #NNN" to commit message`
          );
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
      this.warnings.push(
        `Pushing to "${branch}" branch directly\n` +
        `     Suggestion: Use feature branch (feat/wish-slug) for traced work\n` +
        `     Override: Set GENIE_ALLOW_MAIN_PUSH=1`
      );
    }
  }

  /**
   * Generate advisory report
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
        report.push(`${i + 1}. ${err}\n`);
      });
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
      this.log('yellow', '⚠️ ', 'No commits to analyze');
      return 0;
    }

    this.loadWishes();
    this.validateBranch();
    this.validateCommits();

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
