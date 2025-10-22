#!/usr/bin/env node

const { spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function getWorktreeRoot() {
  try {
    // Get the top-level directory of the current worktree
    const result = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    return result;
  } catch (e) {
    // Fallback to current directory if git command fails
    return process.cwd();
  }
}

function runNodeScript(script, args = []) {
  const worktreeRoot = getWorktreeRoot();
  const p = path.join(worktreeRoot, '.genie', 'scripts', script);
  const res = spawnSync('node', [p, ...args], {
    stdio: 'inherit',
    cwd: worktreeRoot  // Run from worktree root, not main repo
  });
  return res.status || 0;
}

function getCurrentBranch() {
  try {
    // Try to get branch from current working directory context
    // This works correctly in worktrees when git push is executed
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return result;
  } catch (e) {
    // Fallback: try reading HEAD file directly
    try {
      const gitDir = process.env.GIT_DIR || path.join(__dirname, '..');
      const headFile = path.join(gitDir, 'HEAD');

      if (fs.existsSync(headFile)) {
        const head = fs.readFileSync(headFile, 'utf8').trim();
        if (head.startsWith('ref: refs/heads/')) {
          return head.replace('ref: refs/heads/', '');
        }
      }
    } catch {}

    return '';
  }
}

function main() {
  console.log('🧞 Genie pre-push hook');
  const currentBranch = getCurrentBranch();
  const isForgeBranch = currentBranch.startsWith('forge/');
  const isFeatBranch = currentBranch.startsWith('feat/');
  const isWorkInProgress = isForgeBranch || isFeatBranch;

  console.log(`📍 Detected branch: ${currentBranch}`);

  // Step 1: tests (skip if GENIE_SKIP_TESTS is set)
  if (process.env.GENIE_SKIP_TESTS) {
    console.warn('⚠️  Tests skipped (GENIE_SKIP_TESTS set)');
  } else {
    const testsCode = runNodeScript('run-tests.cjs');
    if (testsCode !== 0) {
      console.error('❌ Pre-push blocked - tests failed');
      process.exit(1);
    }
  }
  // Step 2: commit advisory (validates traceability)
  const advisoryCode = runNodeScript('commit-advisory.cjs');

  // Block on main branch, warn on dev/feature branches
  if (advisoryCode === 2) {
    if (currentBranch === 'main' || currentBranch === 'master') {
      console.error('❌ Pre-push blocked - fix commit validation errors before pushing to main');
      console.error('    See output above for details');
      process.exit(1);
    } else {
      console.warn('⚠️  Commit validation issues detected (blocking at PR approval)');
      console.warn('    See output above for details');
    }
  }
  if (advisoryCode === 1 && !process.env.GENIE_SKIP_WISH_CHECK) {
    console.warn('⚠️  Commit advisory warnings (will be checked at PR approval)');
  }
  // Step 3: update changelog (non-blocking)
  const clCode = runNodeScript('update-changelog.cjs');
  if (clCode !== 0) {
    console.warn('⚠️  CHANGELOG update failed (non-blocking)');
  }
  console.log('✅ Pre-push hooks passed');
}

main();
