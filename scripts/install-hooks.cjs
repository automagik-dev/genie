#!/usr/bin/env node
/**
 * Install git hooks - Advanced feature, opt-in only
 *
 * Warning: This modifies your .git/hooks/ directory.
 * Only install if you understand what git hooks do.
 *
 * Hooks installed:
 * - pre-commit: Validates commits (worktree access, cross-refs, token efficiency)
 * - pre-push: Runs tests and validations before push
 * - prepare-commit-msg: Adds Genie co-author attribution
 */

const fs = require('fs');
const path = require('path');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';

/**
 * Install git hooks with proper error handling and user feedback
 */
function installGitHooks() {
  console.log(`${BLUE}🧞 Genie Git Hooks Installer${RESET}`);
  console.log('');

  const gitDir = path.join(__dirname, '..', '.git');
  const hooksSourceDir = path.join(__dirname, '..', '.genie', 'scripts', 'hooks');

  // Check if we're in a git repository
  if (!fs.existsSync(gitDir)) {
    console.error(`${RED}✗ Error: Not a git repository${RESET}`);
    console.log('  Run this command from the root of your Genie project.');
    process.exit(1);
  }

  // Check if .git is a file (worktree) or directory (main repo)
  const gitDirStats = fs.statSync(gitDir);
  let gitHooksDir;
  let isWorktree = false;

  if (gitDirStats.isFile()) {
    // Worktree: read the gitdir path from .git file
    isWorktree = true;
    const gitDirContent = fs.readFileSync(gitDir, 'utf8');
    const match = gitDirContent.match(/gitdir:\s*(.+)/);
    if (match) {
      const worktreeGitDir = path.resolve(path.dirname(gitDir), match[1].trim());
      // For worktrees, hooks are in the main .git/hooks directory
      const mainGitDir = worktreeGitDir.replace(/\/worktrees\/[^/]+$/, '');
      gitHooksDir = path.join(mainGitDir, 'hooks');
    }
  } else {
    // Main repository
    gitHooksDir = path.join(gitDir, 'hooks');
  }

  if (!gitHooksDir || !fs.existsSync(gitHooksDir)) {
    console.error(`${RED}✗ Error: Cannot find .git/hooks directory${RESET}`);
    process.exit(1);
  }

  // Check if hook templates exist
  if (!fs.existsSync(hooksSourceDir)) {
    console.error(`${RED}✗ Error: Hook templates not found${RESET}`);
    console.log(`  Expected: ${hooksSourceDir}`);
    process.exit(1);
  }

  console.log(`${YELLOW}⚠  Advanced Feature Warning${RESET}`);
  console.log('');
  console.log('  Git hooks will modify your commit/push workflow:');
  console.log('  - pre-commit: Validates worktree access, cross-refs, token usage');
  console.log('  - pre-push: Runs tests before pushing');
  console.log('  - prepare-commit-msg: Adds Genie co-author attribution');
  console.log('');
  console.log(`  Hooks will be installed to: ${gitHooksDir}`);
  if (isWorktree) {
    console.log(`  ${YELLOW}Note: You're in a worktree - hooks install to main repo${RESET}`);
  }
  console.log('');

  // Define hooks to install
  const hooks = [
    { name: 'pre-commit', extension: '.cjs', runtime: 'node' },
    { name: 'pre-push', extension: '.cjs', runtime: 'node' },
    { name: 'prepare-commit-msg', extension: '', runtime: 'python3' }
  ];

  let installed = 0;
  let skipped = 0;
  let errors = [];

  for (const hook of hooks) {
    const source = path.join(hooksSourceDir, hook.name + hook.extension);
    const dest = path.join(gitHooksDir, hook.name);

    if (!fs.existsSync(source)) {
      console.log(`${YELLOW}⊘${RESET} Skipping ${hook.name} (template not found)`);
      skipped++;
      continue;
    }

    try {
      // Check if hook already exists
      if (fs.existsSync(dest)) {
        // Read existing hook to see if it's our wrapper
        const existingContent = fs.readFileSync(dest, 'utf8');
        if (existingContent.includes(source)) {
          console.log(`${BLUE}↻${RESET} ${hook.name} (already installed, updating)`);
        } else {
          console.log(`${YELLOW}⚠${RESET} ${hook.name} (existing hook found, overwriting)`);
        }
      }

      // Create shell wrapper that points to the actual hook script
      if (hook.runtime === 'node') {
        const wrapper = `#!/bin/sh\nexec node "${source}" "$@"\n`;
        fs.writeFileSync(dest, wrapper, { mode: 0o755 });
      } else if (hook.runtime === 'python3') {
        const wrapper = `#!/bin/sh\nexec python3 "${source}" "$@"\n`;
        fs.writeFileSync(dest, wrapper, { mode: 0o755 });
      }

      console.log(`${GREEN}✓${RESET} ${hook.name} installed`);
      installed++;
    } catch (err) {
      console.error(`${RED}✗${RESET} ${hook.name} failed: ${err.message}`);
      errors.push({ hook: hook.name, error: err.message });
    }
  }

  console.log('');
  console.log(`${GREEN}═══════════════════════════════════════${RESET}`);
  console.log(`${GREEN}Results:${RESET}`);
  console.log(`  ${GREEN}✓${RESET} Installed: ${installed}`);
  if (skipped > 0) {
    console.log(`  ${YELLOW}⊘${RESET} Skipped: ${skipped}`);
  }
  if (errors.length > 0) {
    console.log(`  ${RED}✗${RESET} Errors: ${errors.length}`);
  }
  console.log('');

  if (errors.length > 0) {
    console.error(`${RED}Errors encountered:${RESET}`);
    errors.forEach(e => console.error(`  - ${e.hook}: ${e.error}`));
    console.log('');
    process.exit(1);
  }

  if (installed > 0) {
    console.log(`${GREEN}✓ Hooks installed successfully!${RESET}`);
    console.log('');
    console.log(`${BLUE}Next steps:${RESET}`);
    console.log('  - Hooks will now run automatically on commit/push');
    console.log('  - To bypass hooks temporarily: git commit --no-verify');
    console.log('  - To disable co-author: export GENIE_DISABLE_COAUTHOR=1');
    console.log('  - To skip tests on push: export GENIE_SKIP_TESTS=1');
    console.log('');
  } else {
    console.log(`${YELLOW}⚠ No hooks were installed${RESET}`);
    process.exit(1);
  }
}

// Run the installer
installGitHooks();
