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
  // Bun.which returns undefined if not found
  // @ts-ignore
  return typeof (Bun as any).which === 'function' ? Boolean((Bun as any).which('bd')) : true;
}

async function runBd(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await $`bd ${args}`.quiet();
    return { stdout: result.stdout.toString().trim(), exitCode: 0 };
  } catch (error: any) {
    return {
      stdout: error.stdout?.toString().trim() || error.message,
      exitCode: error.exitCode || 1,
    };
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
        return { id: task.id, title: task.title, status: task.status, description: task.description, blockedBy: task.blockedBy };
      },
      async get(id) {
        const task = await local.getTask(repoPath, id);
        return task ? { id: task.id, title: task.title, status: task.status, description: task.description, blockedBy: task.blockedBy } : null;
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
        return task ? { id: task.id, title: task.title, status: task.status, description: task.description, blockedBy: task.blockedBy } : null;
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
      if (options.status) {
        args.push('--status', options.status);
      }
      if (options.title) {
        args.push('--title', options.title);
      }
      if (options.blockedBy && options.blockedBy.length > 0) {
        // Replace blocked-by list
        args.push('--blocked-by', options.blockedBy.join(','));
      }
      if (options.addBlockedBy && options.addBlockedBy.length > 0) {
        // Add to blocked-by (bd may not support this directly, so we get current and merge)
        const current = await this.get(id);
        if (current) {
          const existing = new Set(current.blockedBy || []);
          for (const dep of options.addBlockedBy) {
            existing.add(dep);
          }
          args.push('--blocked-by', Array.from(existing).join(','));
        }
      }
      const { exitCode } = await runBd(args);
      if (exitCode !== 0) return null;
      return this.get(id);
    },
    async queue() {
      const ready: string[] = [];
      const blocked: string[] = [];

      try {
        const { stdout, exitCode } = await runBd(['ready', '--json']);
        if (exitCode === 0 && stdout) {
          try {
            const issues = JSON.parse(stdout);
            for (const issue of issues) ready.push(`${issue.id}`);
          } catch {
            const lines = stdout.split('\n').filter(l => l.trim());
            for (const line of lines) {
              const match = line.match(/^(bd-\d+)/);
              if (match) ready.push(match[1]);
            }
          }
        }
      } catch {}

      try {
        const { stdout, exitCode } = await runBd(['list', '--json']);
        if (exitCode === 0 && stdout) {
          const issues = JSON.parse(stdout);
          for (const issue of issues) {
            if (issue.blockedBy && issue.blockedBy.length > 0) {
              blocked.push(`${issue.id} (blocked by ${issue.blockedBy.join(', ')})`);
            }
          }
        }
      } catch {}

      return { ready, blocked };
    },
  };
}
