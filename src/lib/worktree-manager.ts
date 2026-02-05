/**
 * Worktree Manager - Unified interface for git worktree management
 *
 * Provides two implementations:
 * - GitWorktreeManager: Direct git worktree commands (fallback, always works)
 * - BeadsWorktreeManager: Uses bd worktree commands when available
 *
 * Worktrees are created in .genie/worktrees/<wish-id>/ with branch work/<wish-id>
 */

import { $ } from 'bun';
import { mkdir, rm, access, writeFile } from 'fs/promises';
import { join, basename } from 'path';

// ============================================================================
// Types
// ============================================================================

/**
 * Information about a worktree
 */
export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Git branch name (e.g., work/wish-1) */
  branch: string;
  /** Wish ID (e.g., wish-1) */
  wishId: string;
  /** Git commit hash (optional) */
  commitHash?: string;
  /** When the worktree was created (optional) */
  createdAt?: Date;
}

/**
 * Unified interface for worktree management
 */
export interface WorktreeManagerInterface {
  /**
   * Create a new worktree for a wish
   * @param wishId - The wish identifier (e.g., "wish-1")
   * @param repoPath - Path to the git repository
   * @returns Information about the created worktree
   */
  create(wishId: string, repoPath: string): Promise<WorktreeInfo>;

  /**
   * Remove a worktree
   * @param wishId - The wish identifier
   */
  remove(wishId: string): Promise<void>;

  /**
   * List all worktrees managed by this instance
   * @returns Array of worktree information
   */
  list(): Promise<WorktreeInfo[]>;

  /**
   * Get information about a specific worktree
   * @param wishId - The wish identifier
   * @returns Worktree info or null if not found
   */
  get(wishId: string): Promise<WorktreeInfo | null>;
}

// ============================================================================
// Constants
// ============================================================================

const WORKTREE_DIR_NAME = '.genie/worktrees';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if bd CLI is available on PATH
 */
export async function isBdAvailable(): Promise<boolean> {
  try {
    // Use Bun.which if available, otherwise try running bd
    if (typeof (Bun as any).which === 'function') {
      return Boolean((Bun as any).which('bd'));
    }
    await $`bd --version`.quiet();
    return true;
  } catch {
    return false;
  }
}

/**
 * Run bd command and parse output
 */
async function runBd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() || '',
      stderr: error.stderr?.toString().trim() || '',
      exitCode: error.exitCode || 1,
    };
  }
}

/**
 * Parse JSON safely
 */
function parseJson<T>(output: string): T | null {
  if (!output) return null;
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

/**
 * Get worktree base directory for a repo
 */
function getWorktreeBaseDir(repoPath: string): string {
  return join(repoPath, WORKTREE_DIR_NAME);
}

/**
 * Get worktree path for a wish
 */
function getWorktreePath(repoPath: string, wishId: string): string {
  return join(getWorktreeBaseDir(repoPath), wishId);
}

/**
 * Get branch name for a wish
 */
export function getBranchName(wishId: string): string {
  return `work/${wishId}`;
}

// ============================================================================
// GitWorktreeManager - Direct git worktree implementation
// ============================================================================

/**
 * Git-based worktree manager (fallback implementation)
 *
 * Uses `git worktree add -b work/<wish-id>` directly.
 * Worktrees are created in .genie/worktrees/<wish-id>/ under the target repo.
 * Creates a redirect file so bd commands work in the worktree.
 */
export class GitWorktreeManager implements WorktreeManagerInterface {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  /**
   * Create a new worktree for a wish
   */
  async create(wishId: string, repoPath: string): Promise<WorktreeInfo> {
    const worktreePath = getWorktreePath(repoPath, wishId);
    const branchName = getBranchName(wishId);

    // Ensure .genie/worktrees directory exists
    await mkdir(getWorktreeBaseDir(repoPath), { recursive: true });

    // Check if worktree already exists
    try {
      await access(worktreePath);
      // Worktree exists, return info
      return await this.getWorktreeInfo(wishId, repoPath) as WorktreeInfo;
    } catch {
      // Doesn't exist, will create
    }

    // Check if branch already exists
    let branchExists = false;
    try {
      await $`git -C ${repoPath} rev-parse --verify ${branchName}`.quiet();
      branchExists = true;
    } catch {
      // Branch doesn't exist
    }

    // Create worktree with new or existing branch
    if (branchExists) {
      // Use existing branch
      await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();
    } else {
      // Create new branch
      await $`git -C ${repoPath} worktree add -b ${branchName} ${worktreePath}`.quiet();
    }

    // Create .genie/redirect file so bd commands work in the worktree
    const genieDir = join(worktreePath, '.genie');
    await mkdir(genieDir, { recursive: true });
    await writeFile(join(genieDir, 'redirect'), join(repoPath, '.genie'));

    // Get commit hash
    let commitHash: string | undefined;
    try {
      const result = await $`git -C ${worktreePath} rev-parse HEAD`.quiet();
      commitHash = result.stdout.toString().trim();
    } catch {
      // Ignore
    }

    return {
      path: worktreePath,
      branch: branchName,
      wishId,
      commitHash,
      createdAt: new Date(),
    };
  }

  /**
   * Remove a worktree
   */
  async remove(wishId: string): Promise<void> {
    const worktreePath = getWorktreePath(this.repoPath, wishId);

    try {
      // Remove worktree via git
      await $`git -C ${this.repoPath} worktree remove ${worktreePath} --force`.quiet();
    } catch {
      // Try manual cleanup if git fails
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore - may not exist
      }
    }

    // Prune stale worktree references
    try {
      await $`git -C ${this.repoPath} worktree prune`.quiet();
    } catch {
      // Ignore
    }
  }

  /**
   * List all worktrees
   */
  async list(): Promise<WorktreeInfo[]> {
    const result = await $`git -C ${this.repoPath} worktree list --porcelain`.quiet();
    const output = result.stdout.toString();
    const baseDir = getWorktreeBaseDir(this.repoPath);

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path && current.path.startsWith(baseDir)) {
          // Extract wishId from path
          current.wishId = basename(current.path);
          worktrees.push(current as WorktreeInfo);
        }
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        current.commitHash = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      }
    }

    // Don't forget the last worktree
    if (current.path && current.path.startsWith(baseDir)) {
      current.wishId = basename(current.path);
      worktrees.push(current as WorktreeInfo);
    }

    return worktrees;
  }

  /**
   * Get information about a specific worktree
   */
  async get(wishId: string): Promise<WorktreeInfo | null> {
    return this.getWorktreeInfo(wishId, this.repoPath);
  }

  /**
   * Internal helper to get worktree info
   */
  private async getWorktreeInfo(wishId: string, repoPath: string): Promise<WorktreeInfo | null> {
    const worktreePath = getWorktreePath(repoPath, wishId);

    // Check if path exists
    try {
      await access(worktreePath);
    } catch {
      return null;
    }

    // Get branch name
    let branch = getBranchName(wishId);
    try {
      const result = await $`git -C ${worktreePath} branch --show-current`.quiet();
      branch = result.stdout.toString().trim() || branch;
    } catch {
      // Use default branch name
    }

    // Get commit hash
    let commitHash: string | undefined;
    try {
      const result = await $`git -C ${worktreePath} rev-parse HEAD`.quiet();
      commitHash = result.stdout.toString().trim();
    } catch {
      // Ignore
    }

    return {
      path: worktreePath,
      branch,
      wishId,
      commitHash,
    };
  }
}

// ============================================================================
// BeadsWorktreeManager - bd worktree implementation
// ============================================================================

/**
 * Beads-based worktree manager
 *
 * Uses `bd worktree create/remove/list` when bd is available.
 * Wraps beads-registry functions for worktree management.
 */
export class BeadsWorktreeManager implements WorktreeManagerInterface {
  /**
   * Create a new worktree for a wish
   */
  async create(wishId: string, repoPath: string): Promise<WorktreeInfo> {
    const { stdout, exitCode, stderr } = await runBd(['worktree', 'create', wishId, '--json']);

    if (exitCode !== 0) {
      throw new Error(`bd worktree create failed: ${stderr || stdout}`);
    }

    const info = parseJson<{ path: string; branch: string; name: string }>(stdout);

    if (!info) {
      throw new Error('Failed to parse bd worktree create output');
    }

    // FIX: Ensure branch uses work/ prefix
    const expectedBranch = getBranchName(wishId);
    if (info.branch !== expectedBranch) {
      console.log(`🔧 Fixing branch name: ${info.branch} → ${expectedBranch}`);
      await $`git -C ${info.path} branch -m ${expectedBranch}`.quiet();
      info.branch = expectedBranch;
    }

    return {
      path: info.path,
      branch: info.branch,
      wishId,
    };
  }

  /**
   * Remove a worktree
   */
  async remove(wishId: string): Promise<void> {
    const { exitCode, stderr } = await runBd(['worktree', 'remove', wishId]);

    if (exitCode !== 0) {
      throw new Error(`bd worktree remove failed: ${stderr}`);
    }
  }

  /**
   * List all worktrees
   */
  async list(): Promise<WorktreeInfo[]> {
    const { stdout, exitCode } = await runBd(['worktree', 'list', '--json']);

    if (exitCode !== 0 || !stdout) {
      return [];
    }

    const worktrees = parseJson<Array<{ path: string; branch: string; name: string }>>(stdout);

    if (!worktrees) {
      return [];
    }

    return worktrees.map(wt => ({
      path: wt.path,
      branch: wt.branch,
      wishId: wt.name,
    }));
  }

  /**
   * Get information about a specific worktree
   */
  async get(wishId: string): Promise<WorktreeInfo | null> {
    const worktrees = await this.list();
    return worktrees.find(
      wt => wt.wishId === wishId || wt.branch === wishId || wt.branch === getBranchName(wishId)
    ) || null;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Get the appropriate worktree manager for the given repo
 *
 * Returns BeadsWorktreeManager if bd is available, otherwise GitWorktreeManager.
 *
 * @param repoPath - Path to the git repository
 * @returns The appropriate WorktreeManager implementation
 */
export async function getWorktreeManager(repoPath: string): Promise<WorktreeManagerInterface> {
  if (await isBdAvailable()) {
    return new BeadsWorktreeManager();
  }
  return new GitWorktreeManager(repoPath);
}

/**
 * Create a GitWorktreeManager directly (for cases where git is always preferred)
 */
export function createGitWorktreeManager(repoPath: string): GitWorktreeManager {
  return new GitWorktreeManager(repoPath);
}
