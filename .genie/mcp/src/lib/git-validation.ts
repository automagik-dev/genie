/**
 * Git State Validation - Ensure clean working tree before spawning agents
 *
 * Critical Rule: wish, forge, review, and run cannot execute with unstaged or
 * unpushed changes. Fellow agents in separate worktrees won't see the context.
 *
 * This prevents context drift and ensures all agents work from the same state.
 */

import { execSync } from 'child_process';

export interface GitStateCheck {
  isClean: boolean;
  hasUnstagedChanges: boolean;
  hasUncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  message: string;
}

/**
 * Check if git working tree is clean and pushed
 */
export function checkGitState(): GitStateCheck {
  try {
    // Check for unstaged changes
    const statusOutput = execSync('git status --porcelain', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    const hasUnstagedChanges = statusOutput.length > 0;

    // Check for uncommitted changes (staged but not committed)
    const stagedOutput = execSync('git diff --cached --name-only', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();

    const hasUncommittedChanges = stagedOutput.length > 0;

    // Check for unpushed commits
    let hasUnpushedCommits = false;
    try {
      const unpushedOutput = execSync('git log @{u}.. --oneline', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();

      hasUnpushedCommits = unpushedOutput.length > 0;
    } catch (error) {
      // No upstream branch configured, treat as unpushed
      hasUnpushedCommits = true;
    }

    const isClean = !hasUnstagedChanges && !hasUncommittedChanges && !hasUnpushedCommits;

    let message = '';
    if (!isClean) {
      const issues: string[] = [];

      if (hasUnstagedChanges) {
        issues.push('❌ Unstaged changes detected');
      }

      if (hasUncommittedChanges) {
        issues.push('❌ Uncommitted changes detected (staged but not committed)');
      }

      if (hasUnpushedCommits) {
        issues.push('❌ Unpushed commits detected');
      }

      message = issues.join('\n');
    } else {
      message = '✅ Git working tree is clean and pushed';
    }

    return {
      isClean,
      hasUnstagedChanges,
      hasUncommittedChanges,
      hasUnpushedCommits,
      message
    };
  } catch (error: any) {
    // Not a git repository or git command failed
    return {
      isClean: false,
      hasUnstagedChanges: false,
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
      message: `⚠️  Git validation failed: ${error.message}`
    };
  }
}

/**
 * Format git state validation error message
 */
export function formatGitStateError(check: GitStateCheck): string {
  let error = `🚫 **Cannot start agent - Git working tree is not clean**\n\n`;
  error += `${check.message}\n\n`;
  error += `**Why this matters:**\n`;
  error += `Agents run in separate worktrees. If you have uncommitted or unpushed changes,\n`;
  error += `those agents won't see your latest work, causing context drift.\n\n`;
  error += `**Required steps:**\n`;

  if (check.hasUnstagedChanges) {
    error += `1. Stage your changes: \`git add .\`\n`;
  }

  if (check.hasUncommittedChanges || check.hasUnstagedChanges) {
    error += `2. Commit your changes: \`git commit -m "Your commit message"\`\n`;
  }

  if (check.hasUnpushedCommits || check.hasUncommittedChanges || check.hasUnstagedChanges) {
    error += `3. Push to remote: \`git push\`\n`;
  }

  error += `\nOnce your working tree is clean and pushed, retry this command.\n`;

  return error;
}

/**
 * Validate git state and throw if not clean
 */
export function validateGitStateOrThrow(): void {
  const check = checkGitState();

  if (!check.isClean) {
    throw new Error(formatGitStateError(check));
  }
}
