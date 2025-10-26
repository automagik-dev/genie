#!/usr/bin/env node

const { spawnSync, execSync } = require('child_process');
const path = require('path');

// Get git root directory (works from .git/hooks/)
const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();

function run(script) {
  const p = path.join(gitRoot, '.genie', 'scripts', script);
  const res = spawnSync('node', [p], { stdio: 'inherit' });
  return res.status || 0;
}

// TODO: Re-enable when `genie run` CLI is stable (currently causes instability in hooks)
// function runGenie(agent, prompt) {
//   // Run Genie workflow and capture session ID + wait for completion
//   const { execSync } = require('child_process');
//   const fs = require('fs');
//
//   try {
//     const genieCliPath = path.join(gitRoot, '.genie', 'cli', 'dist', 'genie-cli.js');
//     if (!fs.existsSync(genieCliPath)) {
//       return { sessionId: null, success: true, message: 'Genie CLI not built (skipping workflow)' };
//     }
//
//     console.log(`Running Genie workflow: ${agent}...`);
//
//     // Start workflow (fire and forget, non-blocking)
//     const spawn = require('child_process').spawn;
//     const proc = spawn('node', [genieCliPath, 'run', agent, prompt], {
//       cwd: gitRoot,
//       stdio: 'ignore',
//       detached: true
//     });
//     proc.unref();
//
//     // Return success - workflow runs in background
//     return { sessionId: null, success: true, message: `Workflow ${agent} started (runs in background)` };
//   } catch (e) {
//     console.log(`⚠️  Could not run workflow: ${e.message}`);
//     return { sessionId: null, success: true, message: 'Workflow skipped' };
//   }
// }

// Check if commit only contains files that don't require full hook validation
function shouldSkipHooks() {
  try {
    const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (stagedFiles.length === 0) return false;

    // ==============================================================================
    // SKIP PATTERNS (expand this list as needed for performance optimization)
    // ==============================================================================
    // Pattern 1: .genie/wishes/*.md - Wish documents that don't affect codebase
    // Pattern 2: [FUTURE] Documentation-only commits
    // Pattern 3: [FUTURE] Test fixtures or mock data
    // ==============================================================================

    const skipPatterns = [
      // Pattern 1: Wish files only
      (file) => file.startsWith('.genie/wishes/') && file.endsWith('.md'),

      // Add more patterns here as needed:
      // (file) => file.startsWith('.genie/docs/') && file.endsWith('.md'),
      // (file) => file.startsWith('test/fixtures/') && file.endsWith('.json'),
    ];

    // Skip hooks if ALL staged files match at least one skip pattern
    const allFilesSkippable = stagedFiles.every(file =>
      skipPatterns.some(pattern => pattern(file))
    );

    return allFilesSkippable;
  } catch (e) {
    return false; // On error, run hooks normally
  }
}

// Timing utility
function timeExecution(label, fn) {
  const start = Date.now();
  const result = fn();
  const duration = Date.now() - start;
  console.log(`  ⏱️  ${label}: ${duration}ms`);
  return result;
}

function main() {
  const totalStart = Date.now();
  console.log('## Pre-Commit');

  // Early exit for .genie/wishes/*.md only commits
  if (shouldSkipHooks()) {
    console.log('✨ Fast-path: Only wish files detected, skipping hooks');
    console.log('- Result: ✅ Pre-commit validations skipped (wish-only commit)');
    process.exit(0);
  }

  let exitCode = 0;
  const validations = [
    'validate-user-files-not-committed.cjs',
    'validate-cross-references.cjs',
    'forge-task-link.cjs',  // Auto-link Forge tasks to wishes on first commit
  ];

  // Security validation (blocking)
  console.log('🔐 Checking for secrets in staged files...');
  const checkSecretsPath = path.join(gitRoot, '.genie', 'scripts', 'helpers', 'check-secrets.js');
  const secretsCheckCode = timeExecution('Secret detection', () => {
    const secretsCheck = spawnSync('node', [checkSecretsPath, '--staged'], { stdio: 'inherit' });
    return secretsCheck.status || 0;
  });
  if (secretsCheckCode !== 0) {
    exitCode = 1;
  }

  // Amendment #7: Git is source of truth - no auto-metadata generation
  // Disabled: update-genie-markdown-metadata.cjs (timestamps/versions duplicate git data)

  // Run worktree access prevention check (bash script)
  console.log('🔍 Checking for Forge worktree violations...');
  const worktreeCheckPath = path.join(gitRoot, '.genie', 'scripts', 'prevent-worktree-access.sh');
  const worktreeCheckCode = timeExecution('Worktree validation', () => {
    const worktreeCheck = spawnSync('bash', [worktreeCheckPath], { stdio: 'inherit' });
    return worktreeCheck.status || 0;
  });
  if (worktreeCheckCode !== 0) {
    exitCode = 1;
  }

  for (const v of validations) {
    const code = timeExecution(v.replace('.cjs', ''), () => run(v));
    if (code !== 0) exitCode = 1;
  }

  // Amendment #7: Removed generate-workspace-summary.cjs (redundant with hand-curated knowledge graph in AGENTS.md)

  // Migrate QA workflows from scenarios-from-bugs.md (auto-generate stubs)
  try {
    timeExecution('QA migration', () => {
      const migCode = run('migrate-qa-from-bugs.cjs');
      if (migCode !== 0) {
        console.warn('⚠️  QA migration script failed (non-blocking)');
      }
      return migCode;
    });
  } catch (e) {
    console.warn('⚠️  QA migration error (non-blocking)');
  }

  // Generate token usage and quality summary (non-blocking)
  try {
    timeExecution('Token counting', () => {
      spawnSync('node', [path.join(gitRoot, '.genie', 'scripts', 'token-efficiency', 'count-tokens.cjs')], { stdio: 'inherit' });
      return 0;
    });
  } catch (e) {
    console.warn('⚠️  Token usage script failed (non-blocking)');
  }
  try {
    timeExecution('Quality gate check', () => {
      spawnSync('node', [path.join(gitRoot, '.genie', 'scripts', 'token-efficiency', 'quality-gate.cjs')], { stdio: 'inherit' });
      return 0;
    });
  } catch (e) {
    console.warn('⚠️  Token quality gate error (non-blocking)');
  }

  // TODO: Re-enable Genie background advisory when `genie run` CLI is stable
  // Background advisory currently disabled for performance and reliability
  // Future: Async learning/analysis of commit patterns, wish alignment, etc.
  // const workflow = runGenie('neurons/git/commit-advisory', 'Pre-commit validation');
  // if (workflow.message) console.log(`- Note: ${workflow.message}`);

  // Commit message suggestion (non-blocking, advisory only)
  // Generates conventional commit message from staged diff
  // Disabled for now - enable when genie run is stable in hooks
  // try {
  //   const suggestion = execSync('genie run commit-suggester --raw --quiet', { encoding: 'utf8', cwd: gitRoot }).trim();
  //   if (suggestion) {
  //     const suggestedMsgPath = path.join(gitRoot, '.git', 'SUGGESTED_COMMIT');
  //     require('fs').writeFileSync(suggestedMsgPath, suggestion);
  //     console.log('💡 Commit message suggestion saved to .git/SUGGESTED_COMMIT');
  //     console.log('   Use: git commit -F .git/SUGGESTED_COMMIT');
  //   }
  // } catch (e) {
  //   // Silently skip if genie run fails (non-blocking)
  // }

  // Token-efficient summary
  const totalDuration = Date.now() - totalStart;
  if (exitCode === 0) {
    console.log('- Result: ✅ Pre-commit validations passed');
    console.log('- Reinforcer: Save tokens — keep outputs concise');
  } else {
    console.log('- Result: ❌ Some validations failed');
    console.log('- Next: Fix issues above and retry commit');
    console.log('- Reinforcer: Commit small and often; attach evidence paths when relevant');
  }
  console.log(`⏱️  Total pre-commit time: ${totalDuration}ms`);
  process.exit(exitCode);
}

main();
