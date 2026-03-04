import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { $ } from 'bun';

export interface WorktreeInfo {
  path: string;
  branch: string;
  commitHash?: string;
  createdAt?: Date;
  size?: number;
}

export interface WorktreeMetadata {
  worktrees: {
    [sanitizedName: string]: {
      branch: string;
      createdAt: string;
    };
  };
}

export interface WorktreeManagerConfig {
  /** Base directory for worktrees (default: .worktrees) */
  baseDir: string;
  /** Path to the main git repository */
  repoPath: string;
}

/**
 * Sanitizes a branch name for use as a directory name.
 * Converts feature/auth to feature-auth, etc.
 */
export function sanitizeBranchName(branchName: string): string {
  return branchName
    .replace(/\//g, '-')
    .replace(/\\/g, '-')
    .replace(/[^a-zA-Z0-9-_.]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parses a timeframe string like "7d", "2w", "1m", "24h" into milliseconds.
 */
export function parseTimeframe(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([hdwm])$/i);
  if (!match) {
    throw new Error(`Invalid timeframe format: ${timeframe}. Use format like 7d, 2w, 1m, 24h`);
  }

  const value = Number.parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  const multipliers: Record<string, number> = {
    h: 60 * 60 * 1000, // hours
    d: 24 * 60 * 60 * 1000, // days
    w: 7 * 24 * 60 * 60 * 1000, // weeks
    m: 30 * 24 * 60 * 60 * 1000, // months (approximate)
  };

  return value * multipliers[unit];
}

/**
 * Formats a duration in milliseconds to human-readable format.
 */
export function formatAge(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;

  if (days > 0) {
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return `${hours}h`;
}

/**
 * Formats bytes to human-readable size.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Manages Git worktrees for branch isolation.
 */
export class WorktreeManager {
  private baseDir: string;
  private repoPath: string;
  private metadataPath: string;

  constructor(config: WorktreeManagerConfig) {
    this.baseDir = config.baseDir;
    this.repoPath = config.repoPath;
    this.metadataPath = join(this.baseDir, '.metadata.json');
  }

  /**
   * Loads worktree metadata from disk.
   */
  private async loadMetadata(): Promise<WorktreeMetadata> {
    try {
      const content = await readFile(this.metadataPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return { worktrees: {} };
    }
  }

  /**
   * Saves worktree metadata to disk.
   */
  private async saveMetadata(metadata: WorktreeMetadata): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(this.metadataPath, JSON.stringify(metadata, null, 2));
  }

  /**
   * Creates a new worktree for a branch.
   * @param branchName - Git branch name
   * @param createBranch - If true, create a new branch
   * @param baseBranch - Base branch for new branch (only with createBranch)
   */
  async createWorktree(branchName: string, createBranch = false, baseBranch?: string): Promise<WorktreeInfo> {
    const sanitizedName = sanitizeBranchName(branchName);
    const worktreePath = join(this.baseDir, sanitizedName);

    // Ensure base directory exists
    await mkdir(this.baseDir, { recursive: true });

    // Check if worktree already exists
    try {
      await access(worktreePath);
      throw new Error(`Worktree already exists at ${worktreePath}`);
    } catch (e) {
      const errCode = e instanceof Error && 'code' in e ? (e as NodeJS.ErrnoException).code : undefined;
      if (errCode !== 'ENOENT') throw e;
    }

    if (createBranch) {
      if (baseBranch) {
        // Create new branch from base and add worktree
        await $`git -C ${this.repoPath} worktree add -b ${branchName} ${worktreePath} ${baseBranch}`.quiet();
      } else {
        // Create new branch from HEAD and add worktree
        await $`git -C ${this.repoPath} worktree add -b ${branchName} ${worktreePath}`.quiet();
      }
    } else {
      // Check if branch exists
      const branchExists = await this.branchExists(branchName);
      if (!branchExists) {
        throw new Error(`Branch '${branchName}' does not exist. Use -b to create a new branch.`);
      }
      // Add worktree for existing branch
      await $`git -C ${this.repoPath} worktree add ${worktreePath} ${branchName}`.quiet();
    }

    // Save metadata
    const metadata = await this.loadMetadata();
    metadata.worktrees[sanitizedName] = {
      branch: branchName,
      createdAt: new Date().toISOString(),
    };
    await this.saveMetadata(metadata);

    // Get commit hash
    const commitHash = await this.getCommitHash(worktreePath);

    return {
      path: worktreePath,
      branch: branchName,
      commitHash,
      createdAt: new Date(),
    };
  }

  /**
   * Removes a worktree by branch name.
   */
  async removeWorktree(branchName: string): Promise<void> {
    const sanitizedName = sanitizeBranchName(branchName);
    const worktreePath = join(this.baseDir, sanitizedName);

    // Remove from git worktree list
    try {
      await $`git -C ${this.repoPath} worktree remove ${worktreePath} --force`.quiet();
    } catch {
      // If git worktree remove fails, try removing the directory manually
      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // Directory doesn't exist
      }
    }

    // Ensure directory is gone
    try {
      await access(worktreePath);
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // Directory doesn't exist, which is expected
    }

    // Remove from metadata
    const metadata = await this.loadMetadata();
    delete metadata.worktrees[sanitizedName];
    await this.saveMetadata(metadata);
  }

  /**
   * Lists all worktrees in the base directory.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await $`git -C ${this.repoPath} worktree list --porcelain`.quiet();
    const output = result.stdout.toString();

    const worktrees: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};

    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) {
          worktrees.push(current as WorktreeInfo);
        }
        current = { path: line.slice(9) };
      } else if (line.startsWith('HEAD ')) {
        current.commitHash = line.slice(5);
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).replace('refs/heads/', '');
      }
    }

    if (current.path) {
      worktrees.push(current as WorktreeInfo);
    }

    // Filter to only include worktrees in our base directory
    const filtered = worktrees.filter((wt) => wt.path.startsWith(this.baseDir));

    // Load metadata for creation times
    const metadata = await this.loadMetadata();

    // Enrich with metadata and size
    for (const wt of filtered) {
      const sanitizedName = basename(wt.path);
      const meta = metadata.worktrees[sanitizedName];
      if (meta) {
        wt.createdAt = new Date(meta.createdAt);
      }
      wt.size = await this.getDiskUsage(wt.path);
    }

    return filtered;
  }

  /**
   * Cleans up worktrees older than the specified timeframe.
   * @param timeframe - Timeframe string like "7d", "2w", "1m"
   * @param dryRun - If true, only report what would be removed
   * @returns List of removed (or would-be-removed) worktrees
   */
  async cleanup(timeframe: string, dryRun = false): Promise<WorktreeInfo[]> {
    const maxAge = parseTimeframe(timeframe);
    const now = Date.now();
    const worktrees = await this.listWorktrees();

    const toRemove: WorktreeInfo[] = [];

    for (const wt of worktrees) {
      if (wt.createdAt) {
        const age = now - wt.createdAt.getTime();
        if (age > maxAge) {
          toRemove.push(wt);
        }
      }
    }

    if (!dryRun) {
      for (const wt of toRemove) {
        await this.removeWorktree(wt.branch);
      }
    }

    return toRemove;
  }

  /**
   * Prunes stale worktree references.
   */
  async prune(): Promise<void> {
    await $`git -C ${this.repoPath} worktree prune`.quiet();
  }

  /**
   * Gets disk usage for a directory.
   */
  async getDiskUsage(dirPath: string): Promise<number> {
    try {
      const result = await $`du -sb ${dirPath}`.quiet();
      const output = result.stdout.toString().trim();
      const size = Number.parseInt(output.split('\t')[0], 10);
      return Number.isNaN(size) ? 0 : size;
    } catch {
      return 0;
    }
  }

  /**
   * Gets the path for a worktree by branch name.
   */
  getWorktreePath(branchName: string): string {
    const sanitizedName = sanitizeBranchName(branchName);
    return join(this.baseDir, sanitizedName);
  }

  /**
   * Checks if a worktree exists for a branch.
   */
  async worktreeExists(branchName: string): Promise<boolean> {
    const sanitizedName = sanitizeBranchName(branchName);
    const worktreePath = join(this.baseDir, sanitizedName);
    try {
      await access(worktreePath);
      return true;
    } catch {
      return false;
    }
  }

  private async branchExists(branchName: string): Promise<boolean> {
    try {
      await $`git -C ${this.repoPath} rev-parse --verify ${branchName}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  private async getCommitHash(worktreePath: string): Promise<string> {
    const result = await $`git -C ${worktreePath} rev-parse HEAD`.quiet();
    return result.stdout.toString().trim();
  }
}

/**
 * Creates a WorktreeManager with default configuration.
 */
export function createWorktreeManager(options?: Partial<WorktreeManagerConfig>): WorktreeManager {
  const baseDir = options?.baseDir || join(process.cwd(), '.worktrees');
  const repoPath = options?.repoPath || process.cwd();

  return new WorktreeManager({ baseDir, repoPath });
}
