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

function autoSyncWithRemote(branch) {
  // Auto-sync with remote to prevent rejection due to automated commits (like RC version bumps)
  if (process.env.GENIE_SKIP_AUTO_SYNC) {
    console.log('⏭️  Auto-sync skipped (GENIE_SKIP_AUTO_SYNC set)');
    return false; // No rebase happened
  }

  console.log('🔄 Auto-syncing with remote...');

  try {
    // Fetch latest from remote
    execSync(`git fetch origin ${branch}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check if remote is ahead
    const localCommit = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const remoteCommit = execSync(`git rev-parse origin/${branch}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (localCommit === remoteCommit) {
      console.log('✅ Already in sync with remote');
      return false; // No rebase needed
    }

    // Check if we're behind
    const behindCount = execSync(`git rev-list --count HEAD..origin/${branch}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (parseInt(behindCount) > 0) {
      console.log(`📥 Remote is ${behindCount} commit(s) ahead, rebasing...`);

      // Rebase on remote
      const rebaseResult = spawnSync('git', ['rebase', `origin/${branch}`], {
        stdio: 'inherit'
      });

      if (rebaseResult.status !== 0) {
        console.error('❌ Auto-rebase failed - please resolve conflicts manually');
        console.error('   Run: git rebase --abort && git pull --rebase');
        process.exit(1);
      }

      console.log('✅ Successfully rebased on remote changes');
      return true; // Rebase happened, need to retry push
    } else {
      console.log('✅ Local is ahead of remote');
      return false; // No rebase needed
    }
  } catch (e) {
    console.warn(`⚠️  Auto-sync failed: ${e.message}`);
    console.warn('   Continuing with push (may be rejected if remote changed)');
    return false; // Error, let original push handle it
  }
}

function main() {
  console.log('🧞 Genie pre-push hook');
  const currentBranch = getCurrentBranch();
  const isForgeBranch = currentBranch.startsWith('forge/');
  const isFeatBranch = currentBranch.startsWith('feat/');
  const isWorkInProgress = isForgeBranch || isFeatBranch;

  console.log(`📍 Detected branch: ${currentBranch}`);

  // Early exit for forge worktrees (total isolation, full performance)
  try {
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
    const isWorktree = gitDir.includes('/worktrees/');

    if (isForgeBranch || isWorktree) {
      console.log('🔧 Forge worktree detected - skipping ALL hooks (full performance mode)');
      console.log('- Result: ✅ Pre-push validations skipped (forge isolation)');
      process.exit(0);
    }
  } catch (e) {
    // Continue with normal hooks on error
  }

  // Step 0: Auto-sync with remote (prevents rejection from automated commits)
  const didRebase = autoSyncWithRemote(currentBranch);

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
  let advisoryCode = 0;
  if (process.env.GENIE_ALLOW_MAIN_PUSH) {
    console.warn('⚠️  Commit advisory skipped (GENIE_ALLOW_MAIN_PUSH set)');
  } else {
    advisoryCode = runNodeScript('commit-advisory.cjs');

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
  }
  // Step 3: update changelog (non-blocking)
  const clCode = runNodeScript('update-changelog.cjs');
  if (clCode !== 0) {
    console.warn('⚠️  CHANGELOG update failed (non-blocking)');
  }

  // Step 4: change-reviewer agent (non-blocking, advisory only)
  // Quick sanity check: security issues, large changes, missing tests
  // Disabled for now - enable when genie run is stable in hooks
  // try {
  //   console.log('🔍 Running quick change review...');
  //   const reviewResult = execSync('genie run change-reviewer --quiet', {
  //     encoding: 'utf8',
  //     cwd: getWorktreeRoot(),
  //     stdio: 'inherit'
  //   });
  //   // Advisory only - never blocks (always exit 0)
  // } catch (e) {
  //   // Silently skip if genie run fails (non-blocking)
  // }

  console.log('✅ Pre-push hooks passed');

  // If we rebased, automatically retry the push
  if (didRebase && !process.env.GENIE_AUTO_PUSH_RETRY) {
    console.log('🔄 Auto-retrying push after rebase...');

    // Set env var to prevent infinite recursion
    process.env.GENIE_AUTO_PUSH_RETRY = '1';

    try {
      // Retry the push (this will trigger hooks again, but didRebase will be false)
      execSync(`git push origin ${currentBranch}`, {
        stdio: 'inherit'
      });

      console.log('\x1b[32m✅ Push succeeded after auto-rebase\x1b[0m');
      process.exit(0); // Success, tell original command to abort
    } catch (e) {
      console.error('❌ Auto-retry push failed');
      process.exit(1);
    }
  }
}

main();
