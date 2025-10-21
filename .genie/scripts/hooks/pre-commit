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

function runGenie(agent, prompt) {
  // Run Genie workflow and capture session ID + wait for completion
  const { execSync } = require('child_process');
  const fs = require('fs');

  try {
    const genieCliPath = path.join(gitRoot, '.genie', 'cli', 'dist', 'genie-cli.js');
    if (!fs.existsSync(genieCliPath)) {
      return { sessionId: null, success: true, message: 'Genie CLI not built (skipping workflow)' };
    }

    console.log(`Running Genie workflow: ${agent}...`);

    // Start workflow (fire and forget, non-blocking)
    const spawn = require('child_process').spawn;
    const proc = spawn('node', [genieCliPath, 'run', agent, prompt], {
      cwd: gitRoot,
      stdio: 'ignore',
      detached: true
    });
    proc.unref();

    // Return success - workflow runs in background
    return { sessionId: null, success: true, message: `Workflow ${agent} started (runs in background)` };
  } catch (e) {
    console.log(`⚠️  Could not run workflow: ${e.message}`);
    return { sessionId: null, success: true, message: 'Workflow skipped' };
  }
}

function main() {
  console.log('## Pre-Commit');
  let exitCode = 0;
  const validations = [
    'validate-user-files-not-committed.js',
    'validate-cross-references.js',
    'forge-task-link.js',  // Auto-link Forge tasks to wishes on first commit
  ];

  // Run worktree access prevention check (bash script)
  console.log('🔍 Checking for Forge worktree violations...');
  const worktreeCheckPath = path.join(gitRoot, '.genie', 'scripts', 'prevent-worktree-access.sh');
  const worktreeCheck = spawnSync('bash', [worktreeCheckPath], { stdio: 'inherit' });
  if (worktreeCheck.status !== 0) {
    exitCode = 1;
  }
  for (const v of validations) {
    const code = run(v);
    if (code !== 0) exitCode = 1;
  }

  // Generate/update workspace summary tree (staged automatically by the script)
  try {
    const genCode = run('generate-workspace-summary.js');
    if (genCode !== 0) {
      console.warn('⚠️  Workspace summary generation failed (non-blocking)');
    }
  } catch (e) {
    console.warn('⚠️  Workspace summary generation error (non-blocking)');
  }

  // Migrate QA workflows from scenarios-from-bugs.md (auto-generate stubs)
  try {
    const migCode = run('migrate-qa-from-bugs.js');
    if (migCode !== 0) {
      console.warn('⚠️  QA migration script failed (non-blocking)');
    }
  } catch (e) {
    console.warn('⚠️  QA migration error (non-blocking)');
  }

  // Generate token usage and quality summary (non-blocking)
  try {
    spawnSync('node', [path.join(gitRoot, '.genie', 'scripts', 'token-efficiency', 'count-tokens.js')], { stdio: 'inherit' });
  } catch (e) {
    console.warn('⚠️  Token usage script failed (non-blocking)');
  }
  try {
    spawnSync('node', [path.join(gitRoot, '.genie', 'scripts', 'token-efficiency', 'quality-gate.js')], { stdio: 'inherit' });
  } catch (e) {
    console.warn('⚠️  Token quality gate error (non-blocking)');
  }

  // Background advisory (non-blocking)
  const workflow = runGenie('neurons/git/commit-advisory', 'Pre-commit validation');
  if (workflow.message) console.log(`- Note: ${workflow.message}`);

  // Token-efficient summary
  if (exitCode === 0) {
    console.log('- Result: ✅ Pre-commit validations passed');
    console.log('- Reinforcer: Save tokens — keep outputs concise');
  } else {
    console.log('- Result: ❌ Some validations failed');
    console.log('- Next: Fix issues above and retry commit');
    console.log('- Reinforcer: Commit small and often; attach evidence paths when relevant');
  }
  process.exit(exitCode);
}

main();
