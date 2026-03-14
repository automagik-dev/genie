/**
 * Worktree Manager - Git worktree management
 *
 * Worktrees are created in .genie/worktrees/<wish-id>/ with branch work/<wish-id>
 */

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { $ } from 'bun';

// ============================================================================
// Types
// ============================================================================

export interface WorktreeInfo {
  path: string;
  branch: string;
  wishId: string;
  commitHash?: string;
  createdAt?: Date;
}

interface WorktreeManagerInterface {
  create(wishId: string, repoPath: string): Promise<WorktreeInfo>;
  remove(wishId: string): Promise<void>;
  list(): Promise<WorktreeInfo[]>;
  get(wishId: string): Promise<WorktreeInfo | null>;
}

// ============================================================================
// Constants
// ============================================================================

const WORKTREE_DIR_NAME = '.genie/worktrees';

// ============================================================================
// Helper Functions
// ============================================================================

function getWorktreeBaseDir(repoPath: string): string {
  return join(repoPath, WORKTREE_DIR_NAME);
}

function getWorktreePath(repoPath: string, wishId: string): string {
  return join(getWorktreeBaseDir(repoPath), wishId);
}

function getBranchName(wishId: string): string {
  return `work/${wishId}`;
}

// ============================================================================
// GitWorktreeManager
// ============================================================================

export class GitWorktreeManager implements WorktreeManagerInterface {
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async create(wishId: string, repoPath: string): Promise<WorktreeInfo> {
    const worktreePath = getWorktreePath(repoPath, wishId);
    const branchName = getBranchName(wishId);

    await mkdir(getWorktreeBaseDir(repoPath), { recursive: true });

    try {
      await access(worktreePath);
      return (await this.getWorktreeInfo(wishId, repoPath)) as WorktreeInfo;
    } catch {
      // Doesn't exist, will create
    }

    let branchExists = false;
    try {
      await $`git -C ${repoPath} rev-parse --verify ${branchName}`.quiet();
      branchExists = true;
    } catch {
      // Branch doesn't exist
    }

    if (branchExists) {
      await $`git -C ${repoPath} worktree add ${worktreePath} ${branchName}`.quiet();
    } else {
      await $`git -C ${repoPath} worktree add -b ${branchName} ${worktreePath}`.quiet();
    }

    const genieDir = join(worktreePath, '.genie');
    await mkdir(genieDir, { recursive: true });
    await writeFile(join(genieDir, 'redirect'), join(repoPath, '.genie'));

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

  async remove(wishId: string): Promise<void> {
    const worktreePath = getWorktreePath(this.repoPath, wishId);

    try {
      await $`git -C ${this.repoPath} worktree remove ${worktreePath} --force`.quiet();
    } catch {
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }

    try {
      await $`git -C ${this.repoPath} worktree prune`.quiet();
    } catch {
      // Ignore
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    const result = await $`git -C ${this.repoPath} worktree list --porcelain`.quiet();
    const output = result.stdout.toString();
    const baseDir = getWorktreeBaseDir(this.repoPath);

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path?.startsWith(baseDir)) {
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

    if (current.path?.startsWith(baseDir)) {
      current.wishId = basename(current.path);
      worktrees.push(current as WorktreeInfo);
    }

    return worktrees;
  }

  async get(wishId: string): Promise<WorktreeInfo | null> {
    return this.getWorktreeInfo(wishId, this.repoPath);
  }

  private async getWorktreeInfo(wishId: string, repoPath: string): Promise<WorktreeInfo | null> {
    const worktreePath = getWorktreePath(repoPath, wishId);

    try {
      await access(worktreePath);
    } catch {
      return null;
    }

    let branch = getBranchName(wishId);
    try {
      const result = await $`git -C ${worktreePath} branch --show-current`.quiet();
      branch = result.stdout.toString().trim() || branch;
    } catch {
      // Use default
    }

    let commitHash: string | undefined;
    try {
      const result = await $`git -C ${worktreePath} rev-parse HEAD`.quiet();
      commitHash = result.stdout.toString().trim();
    } catch {
      // Ignore
    }

    return { path: worktreePath, branch, wishId, commitHash };
  }
}

// ============================================================================
// Factory
// ============================================================================

export async function getWorktreeManager(repoPath: string): Promise<WorktreeManagerInterface> {
  return new GitWorktreeManager(repoPath);
}
