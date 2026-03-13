/**
 * Task backend abstraction.
 *
 * - Beads backend (bd) for repo-level issues
 * - Local backend (.genie tracked) for macro repo (blanco)
 */

import { $ } from 'bun';
import * as local from './local-tasks.js';

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  description?: string;
  blockedBy?: string[];
}

export interface QueueStatus {
  ready: string[];
  blocked: string[];
}

export interface UpdateTaskOptions {
  status?: string;
  title?: string;
  blockedBy?: string[];
  addBlockedBy?: string[];
}

export interface TaskBackend {
  kind: 'beads' | 'local';
  create(title: string, options?: { description?: string; parent?: string }): Promise<TaskSummary>;
  get(id: string): Promise<TaskSummary | null>;
  claim(id: string): Promise<boolean>; // in_progress
  markDone(id: string): Promise<boolean>;
  update(id: string, options: UpdateTaskOptions): Promise<TaskSummary | null>;
  queue(): Promise<QueueStatus>;
}

function hasBd(): boolean {
  const BunExt = Bun as unknown as { which?: (name: string) => string | null };
  return typeof BunExt.which === 'function' ? Boolean(BunExt.which('bd')) : true;
}

async function runBd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return { stdout: result.stdout.toString().trim(), exitCode: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const shellErr = error as { stdout?: Buffer; exitCode?: number };
    return {
      stdout: shellErr.stdout?.toString().trim() || message,
      exitCode: shellErr.exitCode || 1,
    };
  }
}

type BdRunner = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

async function parseReadyIssues(run: BdRunner): Promise<string[]> {
  try {
    const { stdout, exitCode } = await run(['ready', '--json']);
    if (exitCode !== 0 || !stdout) return [];
    try {
      return JSON.parse(stdout).map((issue: { id: string }) => `${issue.id}`);
    } catch {
      return stdout
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => l.match(/^(bd-\d+)/)?.[1])
        .filter(Boolean) as string[];
    }
  } catch {
    return [];
  }
}

async function parseBlockedIssues(run: BdRunner): Promise<string[]> {
  try {
    const { stdout, exitCode } = await run(['list', '--json']);
    if (exitCode !== 0 || !stdout) return [];
    return JSON.parse(stdout)
      .filter((issue: { blockedBy?: string[] }) => issue.blockedBy?.length)
      .map((issue: { id: string; blockedBy: string[] }) => `${issue.id} (blocked by ${issue.blockedBy.join(', ')})`);
  } catch {
    return [];
  }
}

export function getBackend(repoPath: string): TaskBackend {
  const useLocal = local.isLocalTasksEnabled(repoPath) || !hasBd();

  if (useLocal) {
    return {
      kind: 'local',
      async create(title, options) {
        const task = await local.createWishTask(repoPath, title, {
          description: options?.description,
          parent: options?.parent,
        });
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          description: task.description,
          blockedBy: task.blockedBy,
        };
      },
      async get(id) {
        const task = await local.getTask(repoPath, id);
        return task
          ? {
              id: task.id,
              title: task.title,
              status: task.status,
              description: task.description,
              blockedBy: task.blockedBy,
            }
          : null;
      },
      async claim(id) {
        return local.claimTask(repoPath, id);
      },
      async markDone(id) {
        return local.markDone(repoPath, id);
      },
      async update(id, options) {
        const task = await local.updateTask(repoPath, id, {
          status: options.status as local.LocalTaskStatus | undefined,
          title: options.title,
          blockedBy: options.blockedBy,
          addBlockedBy: options.addBlockedBy,
        });
        return task
          ? {
              id: task.id,
              title: task.title,
              status: task.status,
              description: task.description,
              blockedBy: task.blockedBy,
            }
          : null;
      },
      async queue() {
        return local.getQueue(repoPath);
      },
    };
  }

  // beads backend
  return {
    kind: 'beads',
    async create(title, options) {
      const args = ['create', title];
      if (options?.description) args.push('--description', options.description);
      const { stdout, exitCode } = await runBd(args);
      if (exitCode !== 0) throw new Error(stdout);
      const idMatch = stdout.match(/bd-\d+/);
      const issueId = idMatch ? idMatch[0] : null;
      if (!issueId) throw new Error(stdout || 'Failed to parse created id');
      if (options?.parent) {
        await runBd(['update', issueId, '--blocked-by', options.parent]);
      }
      const issue = await this.get(issueId);
      return issue || { id: issueId, title, status: 'ready' };
    },
    async get(id) {
      const { stdout, exitCode } = await runBd(['show', id, '--json']);
      if (exitCode !== 0 || !stdout) return null;
      try {
        const parsed = JSON.parse(stdout);
        const issue = Array.isArray(parsed) ? parsed[0] : parsed;
        if (!issue) return null;
        return {
          id: issue.id,
          title: issue.title || issue.description?.substring(0, 50) || 'Untitled',
          status: issue.status,
          description: issue.description,
          blockedBy: issue.blockedBy || [],
        };
      } catch {
        return null;
      }
    },
    async claim(id) {
      const { exitCode } = await runBd(['update', id, '--status', 'in_progress']);
      return exitCode === 0;
    },
    async markDone(id) {
      // close happens elsewhere; we can mark done if beads supports update status
      const { exitCode } = await runBd(['update', id, '--status', 'done']);
      return exitCode === 0;
    },
    async update(id, options) {
      const args = ['update', id];
      if (options.status) args.push('--status', options.status);
      if (options.title) args.push('--title', options.title);
      if (options.blockedBy?.length) args.push('--blocked-by', options.blockedBy.join(','));
      if (options.addBlockedBy?.length) {
        const current = await this.get(id);
        if (current) {
          const merged = new Set([...(current.blockedBy || []), ...options.addBlockedBy]);
          args.push('--blocked-by', Array.from(merged).join(','));
        }
      }
      const { exitCode } = await runBd(args);
      return exitCode === 0 ? this.get(id) : null;
    },
    async queue() {
      return { ready: await parseReadyIssues(runBd), blocked: await parseBlockedIssues(runBd) };
    },
  };
}
