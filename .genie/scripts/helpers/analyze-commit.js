#!/usr/bin/env node

/**
 * Analyze Commit Helper
 *
 * Parse commit metadata using deterministic rules (no LLM).
 * Extracts: type, scope, breaking, issue refs, wish refs.
 *
 * Usage:
 *   genie helper analyze-commit [commit-hash]
 *   genie helper analyze-commit --staged (analyze staged diff)
 *
 * Output: JSON
 */

const { execSync } = require('child_process');

// Conventional commit type patterns
const COMMIT_TYPES = {
  feat: { name: 'Feature', requiresIssue: true, category: 'feature' },
  fix: { name: 'Bug Fix', requiresIssue: true, category: 'feature' },
  docs: { name: 'Documentation', requiresIssue: false, category: 'maintenance' },
  style: { name: 'Style', requiresIssue: false, category: 'maintenance' },
  refactor: { name: 'Refactor', requiresIssue: false, category: 'maintenance' },
  perf: { name: 'Performance', requiresIssue: false, category: 'maintenance' },
  test: { name: 'Test', requiresIssue: false, category: 'maintenance' },
  build: { name: 'Build', requiresIssue: false, category: 'maintenance' },
  ci: { name: 'CI/CD', requiresIssue: false, category: 'maintenance' },
  chore: { name: 'Chore', requiresIssue: false, category: 'maintenance' },
  revert: { name: 'Revert', requiresIssue: false, category: 'special' },
};

function parseConventionalCommit(message) {
  // Format: type(scope)!: subject
  const pattern = /^(\w+)(?:\(([^)]+)\))?(!)?\s*:\s*(.+)$/;
  const match = message.match(pattern);

  if (!match) {
    return {
      type: null,
      scope: null,
      breaking: false,
      subject: message,
      conventional: false,
    };
  }

  const [, type, scope, breaking, subject] = match;

  return {
    type: type.toLowerCase(),
    scope: scope || null,
    breaking: !!breaking,
    subject: subject.trim(),
    conventional: true,
    typeInfo: COMMIT_TYPES[type.toLowerCase()] || null,
  };
}

function extractReferences(message) {
  const refs = {
    issues: [],
    wishes: [],
    closes: [],
    fixes: [],
    related: [],
  };

  // GitHub issues: fixes #123, closes #456
  const closePattern = /(fixes|closes)\s+#(\d+)/gi;
  let match;
  while ((match = closePattern.exec(message)) !== null) {
    const num = match[2];
    refs.issues.push(num);
    refs.closes.push(num);
  }

  // Related issues: related: #789, see #999
  const relatedPattern = /(related|see):\s+#(\d+)/gi;
  while ((match = relatedPattern.exec(message)) !== null) {
    const num = match[2];
    if (!refs.issues.includes(num)) {
      refs.issues.push(num);
      refs.related.push(num);
    }
  }

  // Wish references: wish: slug, .genie/wishes/slug
  const wishPattern = /\bwish:\s*([\w-]+)|\.genie\/wishes\/([\w-]+)/gi;
  while ((match = wishPattern.exec(message)) !== null) {
    const slug = match[1] || match[2];
    if (slug && !refs.wishes.includes(slug)) {
      refs.wishes.push(slug);
    }
  }

  return refs;
}

function getCommitMessage(commitHash) {
  try {
    const format = commitHash ? '%s%n%b' : '%s%n%b';
    const cmd = commitHash
      ? `git log -1 --format="${format}" ${commitHash}`
      : `git log -1 --format="${format}" HEAD`;

    return execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (e) {
    return null;
  }
}

function getStagedMessage() {
  // Read COMMIT_EDITMSG if available, or use git status
  try {
    const fs = require('fs');
    const path = require('path');
    const gitDir = execSync('git rev-parse --git-dir', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const commitMsgPath = path.join(gitDir, 'COMMIT_EDITMSG');
    if (fs.existsSync(commitMsgPath)) {
      return fs.readFileSync(commitMsgPath, 'utf8').trim();
    }
  } catch (e) {
    // Fallback to empty
  }

  return '';
}

function analyzeCommit(message) {
  const lines = message.split('\n');
  const subject = lines[0];
  const body = lines.slice(1).join('\n').trim();

  const parsed = parseConventionalCommit(subject);
  const refs = extractReferences(message);

  const requiresIssue = parsed.typeInfo?.requiresIssue ?? true; // Default: require issue
  const hasIssue = refs.issues.length > 0;
  const hasWish = refs.wishes.length > 0;
  const hasTraceability = hasIssue || hasWish;

  return {
    subject,
    body,
    ...parsed,
    references: refs,
    traceability: {
      required: requiresIssue,
      hasIssue,
      hasWish,
      satisfied: !requiresIssue || hasTraceability,
    },
    metadata: {
      category: parsed.typeInfo?.category || 'untyped',
      requiresIssue,
    },
  };
}

function main() {
  const args = process.argv.slice(2);

  let message;

  if (args.includes('--staged')) {
    message = getStagedMessage();
  } else if (args.length > 0) {
    message = getCommitMessage(args[0]);
  } else {
    message = getCommitMessage('HEAD');
  }

  if (!message) {
    console.error('Error: No commit message found');
    process.exit(1);
  }

  const analysis = analyzeCommit(message);
  console.log(JSON.stringify(analysis, null, 2));
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { analyzeCommit, parseConventionalCommit, extractReferences };
