/**
 * Genie directory helpers
 *
 * For the "macro" repo (e.g. /home/genie/workspace/blanco), we want a git-tracked
 * .genie/ folder to hold living state.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export const GENIE_DIR_NAME = '.genie';

/**
 * Get the git common directory (main repo) if we're in a worktree.
 * Returns null if not in a git repo or not in a worktree.
 */
function getGitCommonDir(repoPath: string): string | null {
  try {
    // git rev-parse --git-common-dir returns the path to the shared .git directory
    const result = execSync('git rev-parse --git-common-dir', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // If it returns just '.git', we're in the main repo, not a worktree
    if (result === '.git' || result === join(repoPath, '.git')) {
      return null;
    }

    // The common dir is typically <main-repo>/.git
    // We want <main-repo> so we go up one level
    if (result.endsWith('/.git') || result.endsWith('\\.git')) {
      return result.slice(0, -5);
    }

    // Handle bare repos or other edge cases - go up from .git
    const mainRepo = join(result, '..');
    if (existsSync(join(mainRepo, GENIE_DIR_NAME))) {
      return mainRepo;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Returns repo-local .genie directory path.
 * If inside a worktree, returns the main repo's .genie directory for shared state.
 * Also follows redirect files for backwards compatibility.
 */
export function getRepoGenieDir(repoPath: string): string {
  const localDir = join(repoPath, GENIE_DIR_NAME);

  // 1. Check for explicit redirect file (legacy/manual worktree setup)
  const redirectPath = join(localDir, 'redirect');
  if (existsSync(redirectPath)) {
    try {
      const target = readFileSync(redirectPath, 'utf-8').trim();
      if (target && existsSync(target)) {
        return target;
      }
    } catch {
      // Fall through to next check
    }
  }

  // 2. Check if we're in a git worktree and use main repo's .genie
  const mainRepoDir = getGitCommonDir(repoPath);
  if (mainRepoDir) {
    const mainGenieDir = join(mainRepoDir, GENIE_DIR_NAME);
    if (existsSync(mainGenieDir)) {
      return mainGenieDir;
    }
  }

  return localDir;
}

/**
 * Heuristic: treat repo as "local-backend capable" if it has (or intends to have)
 * a tracked .genie/ directory.
 */
export function hasRepoGenieDir(repoPath: string): boolean {
  return existsSync(getRepoGenieDir(repoPath));
}
